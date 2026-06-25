const { GLib, Gio } = imports.gi;
const { is_flatpak, get_wpctl_cmd, get_pactl_cmd, strip_tree_chars } = imports.utils;
const config_mgr = imports.config_mgr;
const wp_monitor = imports.wp_monitor;
const bt_profiles = imports.bt_profiles;
const pactl_parser = imports.pactl_parser;
const C = imports.constants;
const log = imports.log;

print('[Daemon] module loaded');

const _BT_NODE_RE = /bluez_(?:output|input)\.([0-9A-Fa-f_:]{17})(?:\..*)?$/;
const _ROUTING_COOLDOWN = C.ROUTING_COOLDOWN_S;
const _CAPTURE_DEBOUNCE_MS = C.CAPTURE_DEBOUNCE_MS;
const _CAPTURE_START_DEBOUNCE_MS = C.CAPTURE_START_DEBOUNCE_MS;

const _VALID_BT_PROFILES = new Set([
    'a2dp-sink-aac',
    'a2dp-sink-ldac',
    'a2dp-sink-aptx',
    'a2dp-sink-aptx_hd',
    'a2dp-sink-sbc_xq',
    'a2dp-sink',
    'a2dp-sink-sbc',
    'handsfree-headset',
    'headset-head-unit',
    '',
]);

var DaemonEngine = class {
    constructor() {
        this._last_routed = new Map();
        this._capture_timers = new Map();
        this._capture_start_timers = new Map();
        this._active_capture_nodes = new Set();
        this._restoring_cards = new Set();
        this._activated_bt_cards = new Set();
        this._retry_timers = new Map();
        this._sink_reassert_timers = new Map();
    }

    _notify(summary, body) {
        try {
            const safe_summary = String(summary).replace(/[\x00-\x1f]/g, '').substring(0, 200);
            const safe_body = String(body || '').replace(/[\x00-\x1f]/g, '').substring(0, 200);
            Gio.Subprocess.new(
                ['notify-send', '--app-name=Autowire', safe_summary, safe_body],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            // notify-send may be missing; ignore
        }
    }

    /**
     * Clear all routing and capture state on Wp.Core reconnect.
     * Stale node names and IDs from the previous session would cause
     * routing against non-existent nodes.
     */
    clear_state() {
        for (const tid of this._capture_timers.values()) {
            GLib.source_remove(tid);
        }
        for (const tid of this._capture_start_timers.values()) {
            GLib.source_remove(tid);
        }
        for (const tid of this._retry_timers.values()) {
            GLib.source_remove(tid);
        }
        for (const tid of this._sink_reassert_timers.values()) {
            GLib.source_remove(tid);
        }
        this._last_routed.clear();
        this._capture_timers.clear();
        this._capture_start_timers.clear();
        this._retry_timers.clear();
        this._sink_reassert_timers.clear();
        this._active_capture_nodes.clear();
        this._restoring_cards.clear();
        print('[Daemon] Engine state cleared for reconnect');
    }

    _spawn_sync_with_timeout(argv, timeout_ms = 5000) {
        return imports.utils.spawn_sync_with_timeout(argv, timeout_ms);
    }

    _bt_card_name(node_name) {
        const m = _BT_NODE_RE.exec(node_name);
        if (m) {
            return `bluez_card.${m[1].replace(/:/g, '_')}`;
        }
        return null;
    }

    _has_active_capture_on_card(card_name) {
        for (const node_name of this._active_capture_nodes) {
            if (this._bt_card_name(node_name) === card_name) return true;
        }
        return false;
    }

    _has_pending_restore(card_name) {
        for (const [node_name] of this._capture_timers) {
            if (this._bt_card_name(node_name) === card_name) return true;
        }
        return false;
    }

    /**
     * NOTE: Runs a nested MainLoop — signals fired during subprocess wait
     * may re-enter the engine. The _restoring_cards guard tolerates this,
     * but new re-entrant call paths need careful review.
     */
    _resolve_node_id(node_name, monitor) {
        if (monitor && !node_name.startsWith('bluez_')) {
            for (const node of monitor.get_audio_nodes()) {
                if (node['name'] === node_name && node['id']) {
                    return node['id'];
                }
            }
        }

        let status_text;
        try {
            const [ok, stdout] = this._spawn_sync_with_timeout(get_wpctl_cmd().concat(['status']));
            if (!ok) return null;
            status_text = stdout;
        } catch (e) {
            return null;
        }

        const candidate_ids = [];
        let in_sinks = false;
        let in_sources = false;
        let in_audio = false;

        for (const line of status_text.split('\n')) {
            const stripped = line.trim();
            const clean = strip_tree_chars(stripped);
            if (clean === 'Audio') { in_audio = true; continue; }
            if (!in_audio) continue;

            if (['Sinks:', '├─ Sinks:', '└─ Sinks:'].includes(clean)) {
                in_sinks = true; in_sources = false; continue;
            }
            if (['Sources:', '├─ Sources:', '└─ Sources:'].includes(clean)) {
                in_sources = true; in_sinks = false; continue;
            }
            if (['Devices:', '├─ Devices:', '└─ Devices:', 'Filters:', '├─ Filters:', '└─ Filters:',
                 'Streams:', '├─ Streams:', '└─ Streams:'].includes(clean)) {
                in_sinks = false; in_sources = false; continue;
            }

            if (!(in_sinks || in_sources)) continue;
            if (!line.startsWith(' │')) { in_sinks = false; in_sources = false; continue; }

            const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+/);
            if (m) candidate_ids.push(parseInt(m[1], 10));
        }

        for (const id of candidate_ids) {
            try {
                const [ok, out] = this._spawn_sync_with_timeout(get_wpctl_cmd().concat(['inspect', String(id)]));
                if (!ok) continue;
                const text = out;
                for (const iline of text.split('\n')) {
                    if (iline.includes('node.name')) {
                        const m2 = iline.match(/=\s*"(.*)"/);
                        const val = m2 ? m2[1] : iline.split('=')[1].trim();
                        if (val === node_name) return id;
                        break;
                    }
                }
            } catch (e) { /* skip */ }
        }
        return null;
    }

    /**
     * Set the default sink or source by PW node name.
     * Resolves the name to a numeric ID via wpctl inspect.
     * @param {string} node_name
     * @param {WpMonitor|null} monitor
     * @returns {boolean}
     */
    set_system_default(node_name, monitor) {
        if (!node_name) {
            return false;
        }
        const node_id = this._resolve_node_id(node_name, monitor);
        if (node_id === null) {
            const msg = `Could not resolve node ID for: ${node_name}`;
            print(`[Daemon] ${msg}`);
            config_mgr.write_error(msg);
            return false;
        }
        const [ok, stdout, stderr, exitStatus] = this._spawn_sync_with_timeout(get_wpctl_cmd().concat(['set-default', String(node_id)]));
        if (ok && exitStatus === 0) {
            print(`[Daemon] Default set to: ${node_name} (id=${node_id})`);
            return true;
        }
        const errMsg = stderr ? stderr.trim() : `exit code ${exitStatus}`;
        const msg = `wpctl set-default failed for ${node_name}: ${errMsg}`;
        print(`[Daemon] ${msg}`);
        config_mgr.write_error(msg);
        return false;
    }

    /**
     * Get current BT profile via pactl (not wpctl, which can show stale "off").
     * @returns {string} profile name, or '' on failure
     */
    _get_current_bt_profile(card_pw_name) {
        return pactl_parser.getActiveProfile(card_pw_name);
    }

    /**
     * @returns {Set<string>} profiles the BT card exposes, or empty on failure
     */
    _list_card_profiles_for_card(card_pw_name) {
        return pactl_parser.getCardProfiles(card_pw_name);
    }

    /**
     * Pick the best available profile for the user's intent.
     * Falls back to the A2DP or HSP/HFP ladder if the desired profile is absent.
     */
    _pick_best(available_set, desired) {
        return bt_profiles.pickBest(available_set, desired);
    }

    _resolve_bt_profile(desired, card_pw_name) {
        if (!card_pw_name) return desired || '';
        const available = this._list_card_profiles_for_card(card_pw_name);
        if (available.size === 0) return '';
        if (desired && available.has(desired)) return desired;
        return this._pick_best(available, desired);
    }

    /**
     * Set a BT card's profile only if the device actually supports it.
     * Blind set-profile with an unsupported name drops the card to "off".
     *
     * @param {number} device_global_id
     * @param {string} profile_name
     * @param {string} [card_pw_name] used to check available profiles via pactl
     * @returns {boolean} true if profile is set or already active
     */
    set_bt_profile(device_global_id, profile_name, card_pw_name) {
        if (!profile_name || !device_global_id) {
            return false;
        }
        const target = card_pw_name
            ? this._resolve_bt_profile(profile_name, card_pw_name)
            : profile_name;
        if (!target) {
            log.warn('daemon', `skipping set-profile: device=${device_global_id} exposes none of '${profile_name}' or its fallbacks`);
            return false;
        }
        if (target !== profile_name) {
            print(`[Daemon] Substituting '${profile_name}' -> '${target}' for device=${device_global_id}`);
        }
        const current = this._get_current_bt_profile(card_pw_name);
        if (current === target) {
            print(`[Daemon] BT profile already ${target} on device=${device_global_id}, skipping set`);
            return true;
        }
        const [ok, stdout, stderr, exitStatus] = this._spawn_sync_with_timeout(get_wpctl_cmd().concat(['set-profile', String(device_global_id), target]));
        if (ok && exitStatus === 0) {
            print(`[Daemon] BT profile set: device=${device_global_id} profile=${target}`);
            pactl_parser.clearCardsCache();
            return true;
        }
        const errMsg = stderr ? stderr.trim() : `exit code ${exitStatus}`;
        const msg = `wpctl set-profile failed (device=${device_global_id}, profile=${target}): ${errMsg}`;
        log.error('daemon', msg);
        config_mgr.write_error(msg);
        return false;
    }

    /**
     * @param {string} node_name
     * @param {WpMonitor|null} monitor
     * @returns {Object|null}
     */
    _find_active_profile_for(node_name) {
        const profiles = config_mgr.load_profiles_readonly();

        for (const p of profiles) {
            if (p['trigger_device_name'] === node_name && p['is_active']) {
                print(`[Daemon] Exact match for ${node_name}: ${p['profile_name']}`);
                return p;
            }
        }

        const card = this._bt_card_name(node_name);
        if (!card) return null;

        for (const p of profiles) {
            if (p['is_active'] && this._bt_card_name(p['trigger_device_name']) === card) {
                print(`[Daemon] BT card fallback: ${node_name} (card=${card}) -> profile '${p['profile_name']}'`);
                return p;
            }
        }
        return null;
    }

    _validate_profile(profile) {
        if (!profile || typeof profile !== 'object') {
            log.warn('daemon', 'Skipping invalid profile (not an object)');
            return false;
        }
        if (typeof profile['profile_name'] !== 'string' || !profile['profile_name']) {
            log.warn('daemon', `Skipping profile '${profile['profile_name']}': missing or invalid name`);
            return false;
        }
        if (typeof profile['trigger_device_name'] !== 'string' || !profile['trigger_device_name']) {
            print(`[Daemon] Skipping profile '${profile['profile_name']}': missing trigger_device_name`);
            return false;
        }
        const actions = profile['actions'];
        if (actions && typeof actions === 'object') {
            if (actions['bt_profile'] && !_VALID_BT_PROFILES.has(actions['bt_profile'])) {
                print(`[Daemon] Skipping profile '${profile['profile_name']}': invalid bt_profile '${actions['bt_profile']}'`);
                return false;
            }
            if (actions['bt_profile_call'] && !_VALID_BT_PROFILES.has(actions['bt_profile_call']) && actions['bt_profile_call'] !== '') {
                print(`[Daemon] Skipping profile '${profile['profile_name']}': invalid bt_profile_call '${actions['bt_profile_call']}'`);
                return false;
            }
        }
        return true;
    }

    /**
     * Apply a matched profile: set default sink/source and BT profile.
     * @param {string} connected_node_name
     * @param {Object} profile
     * @param {WpMonitor|null} monitor
     */
    _apply_profile_actions(connected_node_name, profile, monitor) {
        const actions = profile['actions'] || {};
        const sink = actions['default_sink'] || '';
        const source = actions['default_source'] || '';
        const bt_profile = actions['bt_profile'] || '';

        // Set default sink
        if (sink) {
            this.set_system_default(sink, monitor);
        } else if (bt_profile && monitor) {
            const bt_card = this._bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Sink'
                        && this._bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT output: ${node['name']}`);
                        this.set_system_default(node['name'], monitor);
                        break;
                    }
                }
            }
        }

        // Set default source
        if (source) {
            this.set_system_default(source, monitor);
        } else if (bt_profile && monitor) {
            const bt_card = this._bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Source'
                        && this._bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT input: ${node['name']}`);
                        this.set_system_default(node['name'], monitor);
                        break;
                    }
                }
            }
        }

        // Set BT profile
        if (bt_profile && monitor) {
            const card_name = this._bt_card_name(connected_node_name);
            if (card_name) {
                if (this._has_active_capture_on_card(card_name)) {
                    print(`[Daemon] Capture active on ${card_name}, deferring to capture handler`);
                } else {
                    const global_id = monitor.resolveDeviceGlobalId(card_name);
                    if (global_id) {
                        this.set_bt_profile(global_id, bt_profile, card_name);
                        this._activated_bt_cards.add(card_name);
                        this._bt_activate_after_delay(global_id, card_name, bt_profile, C.BT_RETRY_DELAY_MS);
                        this._notify(`BT profile: ${bt_profile}`, `${card_name}`);
                    } else {
                            log.warn('daemon', `could not resolve global ID for ${card_name}, BT profile not set`);
                    }
                }
            }
        }
    }

    /**
     * Match a connected node against profiles and apply the active one.
     * @param {string} connected_node_name
     * @param {WpMonitor|null} monitor
     * @param {boolean} [force=false] bypass cooldown
     * @returns {boolean}
     */
    check_and_route_device(connected_node_name, monitor, force) {
        const now = GLib.get_monotonic_time() / 1000000;
        if (!force) {
            const last = this._last_routed.get(connected_node_name) || 0;
            if (now - last < _ROUTING_COOLDOWN) {
                print(`[Daemon] Cooldown active for ${connected_node_name}, skipping.`);
                return false;
            }
        }

        const profiles = config_mgr.load_profiles_readonly();
        let matched = false;
        let found_trigger = false;

        for (const profile of profiles) {
            if (!this._validate_profile(profile)) {
                continue;
            }
            if (profile['trigger_device_name'] !== connected_node_name) {
                continue;
            }
            found_trigger = true;

            if (!profile['is_active']) {
                continue;
            }

            matched = true;
            print(`[Daemon] Matched profile: ${profile['profile_name']}`);
            this._apply_profile_actions(connected_node_name, profile, monitor);
        }

        if (found_trigger) {
            this._last_routed.set(connected_node_name, now);
            if (this._last_routed.size > 16) {
                const threshold = now - 300;
                for (const [name, ts] of this._last_routed) {
                    if (ts < threshold) this._last_routed.delete(name);
                }
            }
        }
        return matched;
    }

    /**
     * Switch BT card to call profile when a capture stream appears.
     * @param {string} node_name
     * @param {WpMonitor} monitor
     */
    handle_capture_started(node_name, monitor) {
        // Only respond to BT input captures (bluez_input.*), not
        // playback monitors or A2DP sink streams.
        if (!node_name || !node_name.startsWith('bluez_input.')) return;

        // Don't cancel pending stop timer — PW recreates the BT input node
        // during HSP/HFP transitions (node flap). Cancelling would strand
        // the card in HSP/HFP. The restore's finally block re-evaluates.

        const profile = this._find_capture_profile(node_name);
        if (!profile || !this._validate_profile(profile)) {
            print(`[Daemon] Capture started on ${node_name}, but no matching profile found.`);
            return;
        }

        const actions = profile['actions'] || {};
        if (!actions['auto_switch']) return;

        const call_profile = actions['bt_profile_call'] || '';
        if (!call_profile) return;

        this._active_capture_nodes.add(node_name);

        const card_name = this._bt_card_name(node_name) || this._bt_card_name(profile['trigger_device_name']);
        if (!card_name) return;

        // Defer to pending restore to prevent A2DP ↔ HSP/HFP oscillation.
        if (this._has_pending_restore(card_name)) {
            print(`[Daemon] Capture started on ${node_name}, but ${card_name} has a pending restore, deferring`);
            return;
        }

        const global_id = monitor.resolveDeviceGlobalId(card_name);
        if (!global_id) {
            log.warn('daemon', `could not resolve global ID for ${card_name}, call profile not activated`);
            return;
        }

        // Debounce rapid starts — apps like Discord enumerate devices on init.
        if (this._capture_start_timers.has(card_name)) {
            print(`[Daemon] Capture started on ${node_name}, but ${card_name} was just switched (debounce)`);
            return;
        }

        // Defer if restore is in progress — the finally block will re-evaluate.
        if (this._restoring_cards.has(card_name)) {
            print(`[Daemon] Capture started on ${node_name}, but ${card_name} is currently being restored. Deferring.`);
            return;
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _CAPTURE_START_DEBOUNCE_MS, () => {
            this._capture_start_timers.delete(card_name);
            return GLib.SOURCE_REMOVE;
        });
        this._capture_start_timers.set(card_name, id);

        print(`[Daemon] Capture started on ${node_name}, switching ${card_name} to call profile: ${call_profile}`);

        // Cancel stale retry — capture handler is authoritative now.
        if (this._retry_timers.has(card_name)) {
            GLib.source_remove(this._retry_timers.get(card_name));
            this._retry_timers.delete(card_name);
        }

        this._notify(`Capture active — switching to call profile`, `${card_name}: ${call_profile}`);
        this.set_bt_profile(global_id, call_profile, card_name);
    }

    /**
     * Find an auto_switch profile for a capture stream.
     * Only matches BT input node captures — non-BT monitors are ignored.
     * @param {string} node_name
     * @returns {Object|null}
     */
    _find_capture_profile(node_name) {
        let profile = this._find_active_profile_for(node_name);
        if (profile && this._validate_profile(profile)) return profile;

        // Reject non-BT captures — Spotify monitor streams must not trigger HSP/HFP.
        return null;
    }

    _reassert_default_sink(card_name, monitor) {
        for (const node of monitor.get_audio_nodes()) {
            if (node['media_class'] === 'Audio/Sink'
                && this._bt_card_name(node['name']) === card_name) {
                this.set_system_default(node['name'], monitor);
                this._migrate_streams_to_bt(node['name']);
                return true;
            }
        }
        const pactl_name = this._resolve_bt_sink_name(card_name);
        if (pactl_name) {
            this.set_system_default(pactl_name, monitor);
            this._migrate_streams_to_bt(pactl_name);
            return true;
        }
        return false;
    }

    _resolve_bt_sink_name(card_name) {
        const [ok, out] = this._spawn_sync_with_timeout(
            get_pactl_cmd().concat(['list', 'sinks']), 2000);
        if (!ok) return null;
        for (const line of out.split('\n')) {
            const m = line.match(/^\s+Name:\s+(bluez_output\.[A-Fa-f0-9_]+\.[0-9]+)/);
            if (m && this._bt_card_name(m[1]) === card_name) {
                return m[1];
            }
        }
        return null;
    }

    _migrate_streams_to_bt(bt_sink_name) {
        const [sinks_ok, sinks_out] = this._spawn_sync_with_timeout(
            get_pactl_cmd().concat(['list', 'sinks']), 2000);
        if (!sinks_ok) return;

        const sink_map = new Map();
        let cur_idx = null;
        for (const line of sinks_out.split('\n')) {
            const idx_m = line.match(/^Sink\s+#(\d+)/);
            if (idx_m) { cur_idx = parseInt(idx_m[1], 10); continue; }
            const name_m = cur_idx !== null && line.match(/^\s+Name:\s+(.+)/);
            if (name_m) { sink_map.set(cur_idx, name_m[1].trim()); cur_idx = null; }
        }

        let bt_idx = null;
        for (const [idx, name] of sink_map) {
            if (name === bt_sink_name) { bt_idx = idx; break; }
        }
        if (bt_idx === null) return;

        const [inputs_ok, inputs_out] = this._spawn_sync_with_timeout(
            get_pactl_cmd().concat(['list', 'sink-inputs']), 2000);
        if (!inputs_ok) return;

        let input_id = null;
        let input_sink = null;
        let moved = 0;
        for (const line of inputs_out.split('\n')) {
            const id_m = line.match(/^Sink Input #(\d+)/);
            if (id_m) {
                if (input_id !== null && input_sink !== null && input_sink !== bt_idx) {
                    this._spawn_sync_with_timeout(
                        get_pactl_cmd().concat(['move-sink-input', String(input_id), String(bt_idx)]), 1000);
                    moved++;
                }
                input_id = parseInt(id_m[1], 10);
                input_sink = null;
                continue;
            }
            const sink_m = line.match(/^\s+Sink:\s+(\d+)/);
            if (sink_m) input_sink = parseInt(sink_m[1], 10);
        }
        if (input_id !== null && input_sink !== null && input_sink !== bt_idx) {
            this._spawn_sync_with_timeout(
                get_pactl_cmd().concat(['move-sink-input', String(input_id), String(bt_idx)]), 1000);
            moved++;
        }
        print(`[Daemon] Migrated ${moved} stream(s) to BT sink: ${bt_sink_name}`);
    }

    _schedule_sink_reassert(card_name, monitor, attempt) {
        if (attempt >= 8) {
            print(`[Daemon] Giving up re-asserting default sink for ${card_name} after ${attempt} attempts`);
            this._sink_reassert_timers.delete(card_name);
            return;
        }
        const delay = attempt === 0 ? 400 : 600;
        const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._sink_reassert_timers.delete(card_name);
            if (!this._activated_bt_cards.has(card_name)) {
                return GLib.SOURCE_REMOVE;
            }
            if (this._reassert_default_sink(card_name, monitor)) {
                return GLib.SOURCE_REMOVE;
            }
            this._schedule_sink_reassert(card_name, monitor, attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
        this._sink_reassert_timers.set(card_name, tid);
    }

    /**
     * Restore BT card to normal profile when capture stops (debounced).
     * @param {string} node_name
     * @param {WpMonitor} monitor
     */
    handle_capture_stopped(node_name, monitor) {
        if (!node_name || !node_name.startsWith('bluez_input.')) return;

        if (this._capture_timers.has(node_name)) {
            GLib.source_remove(this._capture_timers.get(node_name));
        }

        // Guard re-entrant capture-stopped during nested MainLoop (set_bt_profile).
        // Starting a new timer here could fire after _restoring_cards is cleared.
        const early_card = this._bt_card_name(node_name) || null;
        if (early_card && this._restoring_cards.has(early_card)) {
            print(`[Daemon] Capture stopped on ${node_name}, but ${early_card} restore already in progress (early guard)`);
            return;
        }

        this._capture_timers.set(node_name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, _CAPTURE_DEBOUNCE_MS, () => {
            this._capture_timers.delete(node_name);
            this._active_capture_nodes.delete(node_name);

            const card_name = this._bt_card_name(node_name) || null;
            // Keep call profile if another capture on the same card is still active.
            if (card_name && this._has_active_capture_on_card(card_name)) {
                print(`[Daemon] Capture stopped on ${node_name}, but other captures still active on ${card_name}, keeping call profile`);
                return GLib.SOURCE_REMOVE;
            }

            // Prevent concurrent restores bouncing the card to 'off'.
            if (card_name && this._restoring_cards.has(card_name)) {
                print(`[Daemon] Capture stopped on ${node_name}, but ${card_name} restore already in progress`);
                return GLib.SOURCE_REMOVE;
            }

            // Don't restore on a removed device (cleared by device-removed signal).
            if (card_name && !this._activated_bt_cards.has(card_name)) {
                print(`[Daemon] Capture stopped on ${node_name}, but ${card_name} is no longer connected, skipping restore`);
                return GLib.SOURCE_REMOVE;
            }

            const profile = this._find_capture_profile(node_name);
            if (!profile) return GLib.SOURCE_REMOVE;

            const actions = profile['actions'] || {};
            if (!actions['auto_switch']) return GLib.SOURCE_REMOVE;

            const normal_profile = actions['bt_profile'] || '';
            if (!normal_profile) return GLib.SOURCE_REMOVE;

            if (!card_name) return GLib.SOURCE_REMOVE;
            print(`[Daemon] Capture stopped on ${node_name}, restoring ${card_name} to profile: ${normal_profile}`);

            // Cancel stale retries — restore is authoritative.
            if (this._retry_timers.has(card_name)) {
                GLib.source_remove(this._retry_timers.get(card_name));
                this._retry_timers.delete(card_name);
            }
            if (this._sink_reassert_timers.has(card_name)) {
                GLib.source_remove(this._sink_reassert_timers.get(card_name));
                this._sink_reassert_timers.delete(card_name);
            }

            this._notify(`Capture stopped — restoring normal profile`, `${card_name}: ${normal_profile}`);
            this._restoring_cards.add(card_name);
            try {
                const global_id = monitor.resolveDeviceGlobalId(card_name);
                if (global_id) {
                    this.set_bt_profile(global_id, normal_profile, card_name);
                } else {
                        log.warn('daemon', `could not resolve global ID for ${card_name}, normal profile not restored`);
                }

                // Re-assert default sink after restore. PW may not have created the
                // new A2DP sink node yet — retry on subsequent poll cycles.
                if (!this._reassert_default_sink(card_name, monitor)) {
                    this._schedule_sink_reassert(card_name, monitor, 0);
                }

                // Schedule delayed migration to allow pipewire-pulse to register
                // the new BT sink before moving streams off ALSA.
                // Query pactl directly (real-time) instead of monitor cache,
                // because the monitor may not have re-polled yet.
                const mig_card = card_name;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    const sink_name = this._resolve_bt_sink_name(mig_card);
                    if (sink_name) {
                        this._migrate_streams_to_bt(sink_name);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } finally {
                this._restoring_cards.delete(card_name);
                if (this._has_active_capture_on_card(card_name)) {
                    print(`[Daemon] Capture started while restoring ${card_name}. Re-evaluating capture state.`);
                    for (const active_node of this._active_capture_nodes) {
                        if (this._bt_card_name(active_node) === card_name) {
                            this.handle_capture_started(active_node, monitor);
                            break;
                        }
                    }
                }
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    /**
     * Activate a BT card if it's 'off' and an active profile targets it.
     * Safe to call from device-added or ready signal paths.
     */
    activate_bt_card(global_id, card_name, monitor) {
        if (!global_id || !card_name || !card_name.startsWith('bluez_card.')) return;
        if (this._activated_bt_cards.has(card_name)) return;

        const profiles = config_mgr.load_profiles_readonly();
        let target_profile = '';
        let from_profile = false;
        for (const profile of profiles) {
            if (profile['is_active'] && this._bt_card_name(profile['trigger_device_name']) === card_name && this._validate_profile(profile)) {
                target_profile = (profile['actions'] || {})['bt_profile'] || '';
                if (target_profile) from_profile = true;
                break;
            }
        }

        if (!from_profile) {
            print(`[Daemon] BT card ${card_name} has no active profile, leaving it alone`);
            return;
        }

        this._activated_bt_cards.add(card_name);

        const pid = target_profile;
        const gid = global_id;
        const card = card_name;
        const mon = monitor;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            const current = this._get_current_bt_profile(card);
            const available = this._list_card_profiles_for_card(card);
            if (available.size === 0) {
                print(`[Daemon] BT card ${card} has no profiles yet (transitioning?), deferring activation`);
                this._activated_bt_cards.delete(card);
                return GLib.SOURCE_REMOVE;
            }
            const resolved = available.has(pid) ? pid : this._pick_best(available, pid);
            if (!resolved) {
                print(`[Daemon] BT card ${card} exposes no usable profiles, skipping activation`);
                return GLib.SOURCE_REMOVE;
            }
            if (current && current === resolved && resolved !== 'off') {
                print(`[Daemon] BT card ${card} already in ${current}, skipping auto-profile`);
                return GLib.SOURCE_REMOVE;
            }
            print(`[Daemon] Activating BT card ${card}: current=${current || '?'} -> target=${resolved} (from profile)`);
            this.set_bt_profile(gid, resolved, card);
            this._bt_activate_after_delay(gid, card, resolved, C.BT_RETRY_DELAY_MS);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @returns {WpMonitor}
     */
    build_monitor() {
        const monitor = new wp_monitor.WpMonitor();
        monitor.connect('node-added', (mon, name, description, media_class) => {
            this.check_and_route_device(name, mon);
        });
        monitor.connect('device-added', (mon, name, description, global_id, pw_name) => {
            if (pw_name && pw_name.startsWith('bluez_card.')) {
                print(`[Daemon] Bluetooth device detected: ${pw_name} global_id=${global_id}`);
                this.activate_bt_card(global_id, pw_name, mon);
                // Re-apply auto_switch — the original capture-started event
                // may have missed this card (different poll cycles).
                for (const cap_name of mon.get_capture_nodes()) {
                    this.handle_capture_started(cap_name, mon);
                }
            }
        });
        monitor.connect('device-removed', (_mon, _name, _desc, global_id, pw_name) => {
            if (pw_name && this._activated_bt_cards.has(pw_name)) {
                print(`[Daemon] Bluetooth device removed: ${pw_name}, clearing activation cache`);
                this._activated_bt_cards.delete(pw_name);
            }
        });
        monitor.connect('node-removed', (_mon, name) => {
            // Clean up pending timers for removed nodes.
            if (this._capture_timers.has(name)) {
                GLib.source_remove(this._capture_timers.get(name));
                this._capture_timers.delete(name);
            }
            this._active_capture_nodes.delete(name);
        });
        return monitor;
    }

    /**
     * Fall back to a2dp-sink if the requested profile leaves the card in 'off'.
     */
    _bt_activate_after_delay(global_id, card_name, attempted_profile, delay_ms) {
        // Cancel existing retry timer
        if (this._retry_timers.has(card_name)) {
            GLib.source_remove(this._retry_timers.get(card_name));
        }
        const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay_ms, () => {
            this._retry_timers.delete(card_name);
            try {
                const current = this._get_current_bt_profile(card_name);
                if (current !== 'off') {
                    return GLib.SOURCE_REMOVE;
                }
                print(`[Daemon] Card ${card_name} is still in 'off' after setting ${attempted_profile}, falling back to ${C.FALLBACK_BT_PROFILE}`);
                this.set_bt_profile(global_id, C.FALLBACK_BT_PROFILE, card_name);
            } catch (e) {
                print(`[Daemon] _bt_activate_after_delay error: ${e.message || e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._retry_timers.set(card_name, tid);
    }
};
