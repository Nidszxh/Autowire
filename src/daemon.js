const { GLib, Gio } = imports.gi;
const { is_flatpak, get_wpctl_cmd, get_pactl_cmd } = imports.utils;
const config_mgr = imports.config_mgr;
const wp_monitor = imports.wp_monitor;

print('[Daemon] module loaded');

function _spawn_sync_with_timeout(argv) {
    try {
        const [ok, stdout, stderr] = GLib.spawn_sync(
            null, argv, null,
            GLib.SpawnFlags.SEARCH_PATH, null
        );
        const exitStatus = ok ? 0 : 1;
        return [ok, stdout || new Uint8Array(0), stderr || new Uint8Array(0), exitStatus];
    } catch (e) {
        return [false, null, null, 1];
    }
}


const _BT_NODE_RE = /bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})\..+/;

const _last_routed = {};
const _ROUTING_COOLDOWN = 5.0;
const _CAPTURE_DEBOUNCE_MS = 3000;
const _CAPTURE_START_DEBOUNCE_MS = 1500;
const _capture_timers = {};
const _capture_start_timer = 0;
let _capture_start_card = '';
const _active_capture_nodes = new Set();
const _restoring_cards = new Set();

/**
 * @param {string} node_name
 * @returns {string|null}
 */
function _bt_card_name(node_name) {
    const m = _BT_NODE_RE.exec(node_name);
    if (m) {
        return `bluez_card.${m[1]}`;
    }
    return null;
}

function _has_active_capture_on_card(card_name) {
    for (const node_name of _active_capture_nodes) {
        if (_bt_card_name(node_name) === card_name) return true;
    }
    return false;
}

function _resolve_node_id(node_name, monitor) {
    if (monitor) {
        for (const node of monitor.get_audio_nodes()) {
            if (node['name'] === node_name && node['id']) {
                return node['id'];
            }
        }
    }

    let status_text;
    try {
        const [ok, stdout] = _spawn_sync_with_timeout(get_wpctl_cmd().concat(['status']));
        if (!ok) return null;
        status_text = new TextDecoder().decode(stdout);
    } catch (e) {
        return null;
    }

    const candidate_ids = [];
    let in_sinks = false;
    let in_sources = false;
    let in_audio = false;

    function _clean_section(s) {
        return s.replace(/^[│├└─\s]+/, '');
    }

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        const clean = _clean_section(stripped);
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
            const [ok, out] = _spawn_sync_with_timeout(get_wpctl_cmd().concat(['inspect', String(id)]));
            if (!ok) continue;
            const text = new TextDecoder().decode(out);
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

function set_system_default(node_name, monitor) {
    if (!node_name) {
        return false;
    }
    const node_id = _resolve_node_id(node_name, monitor);
    if (node_id === null) {
        const msg = `Could not resolve node ID for: ${node_name}`;
        print(`[Daemon] ${msg}`);
        config_mgr.write_error(msg);
        return false;
    }
    try {
        const [ok, stdout, stderr, exitStatus] = _spawn_sync_with_timeout(get_wpctl_cmd().concat(['set-default', String(node_id)]));
        if (ok && exitStatus === 0) {
            print(`[Daemon] Default set to: ${node_name} (id=${node_id})`);
            return true;
        }
        const errMsg = stderr ? new TextDecoder().decode(stderr).trim() : `exit code ${exitStatus}`;
        const msg = `wpctl set-default failed for ${node_name}: ${errMsg}`;
        print(`[Daemon] ${msg}`);
        config_mgr.write_error(msg);
        return false;
    } catch (e) {
        if (e.matches && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            const msg = 'wpctl not found. Is WirePlumber installed?';
            print(`[Daemon] ERROR: ${msg}`);
            config_mgr.write_error(msg);
        } else {
            const msg = `wpctl set-default error for ${node_name}: ${e.message || e}`;
            print(`[Daemon] ${msg}`);
            config_mgr.write_error(msg);
        }
        return false;
    }
}

// A2DP sink profiles ordered best → worst. Used to pick the highest-quality
// profile the device actually supports (no hardcoded per-profile fallback
// table — we just ask `pactl list cards` what's there and pick from this list).
const _A2DP_QUALITY = [
    'a2dp-sink-ldac',
    'a2dp-sink-aptx_hd',
    'a2dp-sink-aptx',
    'a2dp-sink-aac',
    'a2dp-sink',
    'a2dp-sink-sbc_xq',
    'a2dp-sink-sbc',
];
const _HSP_HFP = ['handsfree-headset', 'headset-head-unit'];

/**
 * @returns {string} current bluez5 profile for the device, e.g. "a2dp-sink"
 *                    or "off". Empty string on failure. We use
 *                    `pactl list cards` because `wpctl inspect` exposes only
 *                    the card's saved profile, which can read "off" even while
 *                    the device is actively streaming.
 */
function _get_current_bt_profile(card_pw_name) {
    if (!card_pw_name) return '';
    const [ok, stdout] = _spawn_sync_with_timeout(get_pactl_cmd().concat(['list', 'cards']));
    if (!ok) return '';
    const text = new TextDecoder().decode(stdout);
    let current = null;
    for (const raw_line of text.split('\n')) {
        const line = raw_line.trim();
        if (line.startsWith('Name: ')) {
            current = line.substring(6).trim();
        } else if (current === card_pw_name && line.startsWith('Active Profile: ')) {
            const rest = line.substring('Active Profile: '.length).trim();
            return rest;
        }
    }
    return '';
}

/**
 * @returns {Set<string>} profile names exposed by `pactl list cards` for the
 *                         bluez card whose pw_name is `card_pw_name`. Empty
 *                         set on failure.
 */
function _list_card_profiles_for_card(card_pw_name) {
    const out = new Set();
    if (!card_pw_name) return out;
    const [ok, stdout] = _spawn_sync_with_timeout(get_pactl_cmd().concat(['list', 'cards']));
    if (!ok) return out;
    const text = new TextDecoder().decode(stdout);
    let current = null;
    let in_profiles = false;
    for (const raw_line of text.split('\n')) {
        const line = raw_line.trim();
        if (line.startsWith('Name: ')) {
            current = line.substring(6).trim();
            in_profiles = false;
        } else if (current === card_pw_name && line === 'Profiles:') {
            in_profiles = true;
        } else if (current === card_pw_name && in_profiles && line && !line.startsWith('Active Profile:')) {
            const m = line.match(/^([\w\-+.]+):\s/);
            if (m) {
                out.add(m[1]);
            } else if (line === '') {
                in_profiles = false;
            }
        }
    }
    return out;
}

/**
 * Pick the best profile the device actually supports for the user's intent.
 * - If `desired` is a real profile the card exposes, use it as-is.
 * - If not, pick the best A2DP sink (or HSP/HFP) the card exposes, ranked by
 *   _A2DP_QUALITY / _HSP_HFP. No hardcoded per-profile mapping.
 * - Returns '' only if the card exposes nothing useful.
 */
function _pick_best(available_set, desired) {
    const is_call = desired && _HSP_HFP.includes(desired);
    const ladder = is_call ? _HSP_HFP : _A2DP_QUALITY;
    for (const cand of ladder) {
        if (available_set.has(cand)) return cand;
    }
    return '';
}

function _resolve_bt_profile(desired, card_pw_name) {
    if (!card_pw_name) return desired || '';
    const available = _list_card_profiles_for_card(card_pw_name);
    if (available.size === 0) return '';
    if (desired && available.has(desired)) return desired;
    return _pick_best(available, desired);
}

/**
 * Set a BT card's profile ONLY IF the requested profile (or a valid fallback)
 * is one the device actually exposes. Skips when the card is already in the
 * target profile. Never blindly calls `wpctl set-profile` with a name the
 * device doesn't have — that's what drops the card into the `off` state and
 * silences the user's headset.
 *
 * @param {number} device_global_id
 * @param {string} profile_name  the desired profile (e.g. "a2dp-sink-aac")
 * @param {string} [card_pw_name]  bluez_card pw_name, used to look up
 *                                  available profiles via pactl
 * @returns {boolean} true if the profile is set (or already was)
 */
function set_bt_profile(device_global_id, profile_name, card_pw_name) {
    if (!profile_name || device_global_id <= 0) {
        return false;
    }
    const target = card_pw_name
        ? _resolve_bt_profile(profile_name, card_pw_name)
        : profile_name;
    if (!target) {
        print(`[Daemon] Skipping set-profile: device=${device_global_id} exposes none of '${profile_name}' or its fallbacks`);
        return false;
    }
    if (target !== profile_name) {
        print(`[Daemon] Substituting '${profile_name}' → '${target}' for device=${device_global_id}`);
    }
    const current = _get_current_bt_profile(card_pw_name);
    if (current === target) {
        print(`[Daemon] BT profile already ${target} on device=${device_global_id}, skipping set`);
        return true;
    }
    try {
        const [ok, stdout, stderr, exitStatus] = _spawn_sync_with_timeout(get_wpctl_cmd().concat(['set-profile', String(device_global_id), target]));
        if (ok && exitStatus === 0) {
            print(`[Daemon] BT profile set: device=${device_global_id} profile=${target}`);
            return true;
        }
        const errMsg = stderr ? new TextDecoder().decode(stderr).trim() : `exit code ${exitStatus}`;
        const msg = `wpctl set-profile failed (device=${device_global_id}, profile=${target}): ${errMsg}`;
        print(`[Daemon] ${msg}`);
        config_mgr.write_error(msg);
        return false;
    } catch (e) {
        if (e.matches && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            const msg = 'wpctl not found. Is WirePlumber installed?';
            print(`[Daemon] ERROR: ${msg}`);
            config_mgr.write_error(msg);
        } else {
            const msg = `wpctl set-profile error: ${e.message || e}`;
            print(`[Daemon] ${msg}`);
            config_mgr.write_error(msg);
        }
        return false;
    }
}

/**
 * @param {string} connected_node_name
 * @param {WpMonitor|null} monitor
 * @returns {boolean}
 */
function _get_active_profile_for(node_name) {
    let profile = config_mgr.get_active_profile(node_name);
    if (profile) {
        print(`[Daemon] Exact match for ${node_name}: ${profile['profile_name']}`);
        return profile;
    }

    const card = _bt_card_name(node_name);
    if (!card) return null;

    const profiles = config_mgr.load_profiles();
    for (const p of profiles) {
        if (p['is_active'] && _bt_card_name(p['trigger_device_name']) === card) {
            print(`[Daemon] BT card fallback: ${node_name} (card=${card}) → profile '${p['profile_name']}'`);
            return p;
        }
    }
    return null;
}

const _VALID_BT_PROFILES = new Set([
    'a2dp-sink-aac',
    'a2dp-sink-ldac',
    'a2dp-sink-aptx',
    'a2dp-sink-aptx_hd',
    'a2dp-sink-sbc_xq',
    'a2dp-sink',
    'a2dp-sink-sbc',
    'handsfree-headset',
    '',
]);

// Cards we've already attempted to activate this session. Prevents double-fires
// when both 'device-added' and the 'ready' handler see the same bluez_card.
const _activated_bt_cards = new Set();

function _validate_profile(profile) {
    if (!profile || typeof profile !== 'object') {
        print('[Daemon] Skipping invalid profile (not an object)');
        return false;
    }
    if (typeof profile['profile_name'] !== 'string' || !profile['profile_name']) {
        print('[Daemon] Skipping profile with missing or invalid name');
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

function check_and_route_device(connected_node_name, monitor, force) {
    const now = GLib.get_monotonic_time() / 1000000;
    if (!force) {
        const last = _last_routed[connected_node_name] || 0;
        if (now - last < _ROUTING_COOLDOWN) {
            print(`[Daemon] Cooldown active for ${connected_node_name}, skipping.`);
            return false;
        }
    }

    const profiles = config_mgr.load_profiles();
    let matched = false;
    let found_trigger = false;

    for (const profile of profiles) {
        if (!_validate_profile(profile)) {
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
        const actions = profile['actions'] || {};

        const sink = actions['default_sink'] || '';
        const source = actions['default_source'] || '';
        let bt_profile = actions['bt_profile'] || '';

        if (sink) {
            set_system_default(sink, monitor);
        } else if (bt_profile && monitor) {
            const bt_card = _bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Sink'
                        && _bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT output: ${node['name']}`);
                        set_system_default(node['name'], monitor);
                        break;
                    }
                }
            }
        }
        if (source) {
            set_system_default(source, monitor);
        } else if (bt_profile && monitor) {
            const bt_card = _bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Source'
                        && _bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT input: ${node['name']}`);
                        set_system_default(node['name'], monitor);
                        break;
                    }
                }
            }
        }

        if (bt_profile && monitor) {
            const card_name = _bt_card_name(connected_node_name);
            if (card_name) {
                if (_has_active_capture_on_card(card_name)) {
                    print(`[Daemon] Capture active on ${card_name}, deferring to capture handler`);
                } else {
                    const global_id = monitor.get_device_global_id(card_name);
                    if (global_id && global_id > 0) {
                        set_bt_profile(global_id, bt_profile, card_name);
                    }
                }
            }
        }
    }

    if (found_trigger) {
        _last_routed[connected_node_name] = now;
    }
    return matched;
}

function _has_active_capture_on_card(card_name) {
    for (const node_name of _active_capture_nodes) {
        if (_bt_card_name(node_name) === card_name) return true;
    }
    return false;
}

function handle_capture_started(node_name, monitor) {
    if (_capture_timers[node_name]) {
        GLib.source_remove(_capture_timers[node_name]);
        delete _capture_timers[node_name];
    }

    const profile = _find_capture_profile(node_name, monitor);
    if (!profile || !_validate_profile(profile)) {
        print(`[Daemon] Capture started on ${node_name}, but no matching profile found.`);
        return;
    }

    const actions = profile['actions'] || {};
    if (!actions['auto_switch']) return;

    const call_profile = actions['bt_profile_call'] || '';
    if (!call_profile) return;

    _active_capture_nodes.add(node_name);

    const card_name = _bt_card_name(node_name) || _bt_card_name(profile['trigger_device_name']);
    if (!card_name) return;

    const global_id = monitor.get_device_global_id(card_name);
    if (!global_id || global_id <= 0) return;

    // Debounce rapid capture start events: if we recently switched this card
    // to the call profile, don't re-switch. Discord (and other apps) may
    // enumerate audio devices during init, causing multiple 0→1 transitions.
    if (_capture_start_card === card_name && _capture_start_timer > 0) {
        print(`[Daemon] Capture started on ${node_name}, but ${card_name} was just switched (debounce)`);
        return;
    }

    if (_capture_start_timer > 0) {
        GLib.source_remove(_capture_start_timer);
    }
    _capture_start_card = card_name;
    _capture_start_timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _CAPTURE_START_DEBOUNCE_MS, () => {
        _capture_start_timer = 0;
        _capture_start_card = '';
        return GLib.SOURCE_REMOVE;
    });

    print(`[Daemon] Capture started on ${node_name}, switching ${card_name} to call profile: ${call_profile}`);

    set_bt_profile(global_id, call_profile, card_name);
    for (const node of monitor.get_audio_nodes()) {
        if (node['media_class'] === 'Audio/Source'
            && _bt_card_name(node['name']) === card_name) {
            set_system_default(node['name'], monitor);
            break;
        }
    }
}

function _connected_bt_card_names(monitor) {
    const out = [];
    for (const dev of monitor.get_devices()) {
        const pw = dev['pw_name'] || '';
        if (pw.startsWith('bluez_card.')) {
            out.push(pw);
        }
    }
    return out;
}

// Resolve a capture stream to an active auto_switch profile. Tries:
//   1. exact trigger match
//   2. BT card fallback (bluez input → same card as profile trigger)
//   3. any connected BT card with an active auto_switch profile (covers the
//      case where the user takes a call on a non-BT mic while a BT headset
//      is the speaker)
function _find_capture_profile(node_name, monitor) {
    let profile = _get_active_profile_for(node_name);
    if (profile && _validate_profile(profile)) return profile;

    const cards = _connected_bt_card_names(monitor);
    if (cards.length === 0) return profile;

    const profiles = config_mgr.load_profiles();
    for (const p of profiles) {
        if (!p['is_active'] || !_validate_profile(p)) continue;
        const p_card = _bt_card_name(p['trigger_device_name']);
        if (p_card && cards.includes(p_card) && p['actions'] && p['actions']['auto_switch']) {
            print(`[Daemon] Capture on ${node_name} (non-BT) → using profile '${p['profile_name']}' for card ${p_card}`);
            return p;
        }
    }
    return null;
}

function handle_capture_stopped(node_name, monitor) {
    if (_capture_timers[node_name]) {
        GLib.source_remove(_capture_timers[node_name]);
    }

    _capture_timers[node_name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _CAPTURE_DEBOUNCE_MS, () => {
        delete _capture_timers[node_name];
        _active_capture_nodes.delete(node_name);

        const card_name = _bt_card_name(node_name) || null;
        // Don't restore if another capture is still active on the same BT card.
        // Multiple capture streams (e.g. Discord enumerating devices) can stop
        // one at a time; restoring mid-init would toggle the profile and
        // disconnect the headset.
        if (card_name && _has_active_capture_on_card(card_name)) {
            print(`[Daemon] Capture stopped on ${node_name}, but other captures still active on ${card_name}, keeping call profile`);
            return GLib.SOURCE_REMOVE;
        }

        // Don't restore if another capture-stopped timer is already restoring
        // this card. Multiple capture-stopped events can fire at the same time
        // and each would independently call wpctl set-profile, bouncing the
        // card into 'off' state.
        if (card_name && _restoring_cards.has(card_name)) {
            print(`[Daemon] Capture stopped on ${node_name}, but ${card_name} restore already in progress`);
            return GLib.SOURCE_REMOVE;
        }

        const profile = _find_capture_profile(node_name, monitor);
        if (!profile) return GLib.SOURCE_REMOVE;

        const actions = profile['actions'] || {};
        if (!actions['auto_switch']) return GLib.SOURCE_REMOVE;

        const normal_profile = actions['bt_profile'] || '';
        if (!normal_profile) return GLib.SOURCE_REMOVE;

        if (!card_name) return GLib.SOURCE_REMOVE;
        print(`[Daemon] Capture stopped on ${node_name}, restoring ${card_name} to profile: ${normal_profile}`);

        _restoring_cards.add(card_name);

        {
            const global_id = monitor.get_device_global_id(card_name);
            if (global_id && global_id > 0) {
                set_bt_profile(global_id, normal_profile, card_name);
            }

            for (const node of monitor.get_audio_nodes()) {
                if (node['media_class'] === 'Audio/Sink'
                    && _bt_card_name(node['name']) === card_name) {
                    set_system_default(node['name'], monitor);
                    break;
                }
            }
        }

        _restoring_cards.delete(card_name);
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Try to activate a Bluetooth card if it is currently in the 'off' state and
 * an active profile in profiles.json targets it. Safe to call repeatedly and
 * from either the 'device-added' or 'ready' signal paths.
 */
function activate_bt_card(global_id, card_name, monitor) {
    if (!global_id || !card_name || !card_name.startsWith('bluez_card.')) return;
    if (_activated_bt_cards.has(card_name)) return;
    _activated_bt_cards.add(card_name);

    const profiles = config_mgr.load_profiles();
    let target_profile = '';
    let from_profile = false;
    for (const profile of profiles) {
        if (profile['is_active'] && _bt_card_name(profile['trigger_device_name']) === card_name && _validate_profile(profile)) {
            target_profile = (profile['actions'] || {})['bt_profile'] || '';
            if (target_profile) from_profile = true;
            break;
        }
    }

    if (!target_profile) {
        target_profile = 'a2dp-sink-aac';
        from_profile = false;
    }

    const pid = target_profile;
    const gid = global_id;
    const card = card_name;
    const mon = monitor;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
        // Skip the activation entirely if the card is already in a working
        // profile (e.g. user just opened the app while the earbuds were
        // already playing). Asking `pactl` for the true active profile
        // avoids the `wpctl inspect` quirk where the card reads "off" even
        // while a sink node is streaming.
        const current = _get_current_bt_profile(card);
        const available = _list_card_profiles_for_card(card);
        if (available.size === 0) {
            print(`[Daemon] BT card ${card} has no profiles yet (transitioning?), deferring activation`);
            _activated_bt_cards.delete(card);
            return GLib.SOURCE_REMOVE;
        }
        const resolved = available.has(pid) ? pid : _pick_best(available, pid);
        if (!resolved) {
            print(`[Daemon] BT card ${card} exposes no usable profiles, skipping activation`);
            return GLib.SOURCE_REMOVE;
        }
        if (current && current === resolved) {
            print(`[Daemon] BT card ${card} already in ${current}, skipping auto-profile`);
            return GLib.SOURCE_REMOVE;
        }
        if (current && current !== 'off' && resolved === pid) {
            // Card is already in a non-off profile and the user's desired
            // profile matches what's set; do nothing so we never barge in
            // on a working connection.
            print(`[Daemon] BT card ${card} already active in ${current}, skipping auto-profile`);
            return GLib.SOURCE_REMOVE;
        }
        print(`[Daemon] Activating BT card ${card}: current=${current || '?'} → target=${resolved}${from_profile ? ' (from profile)' : ' (auto)'}`);
        set_bt_profile(gid, resolved, card);
        _bt_activate_after_delay(gid, card, resolved, 1500);
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * @returns {WpMonitor}
 */
function build_monitor() {
    const monitor = new wp_monitor.WpMonitor();
    monitor.connect('node-added', (mon, name, description, media_class) => {
        check_and_route_device(name, mon);
    });
    monitor.connect('device-added', (mon, name, description, global_id, pw_name) => {
        if (pw_name && pw_name.startsWith('bluez_card.')) {
            print(`[Daemon] Bluetooth device detected: ${pw_name} global_id=${global_id}`);
            activate_bt_card(global_id, pw_name, mon);
            // Re-apply auto_switch for any active capture: when a BT card comes
            // online after a capture has already started, the original
            // capture-started event may not have seen this card in
            // `monitor.get_devices()` yet (different poll cycles).
            for (const cap_name of mon.get_capture_nodes()) {
                handle_capture_started(cap_name, mon);
            }
        }
    });
    monitor.connect('device-removed', (_mon, _name, _desc, global_id, pw_name) => {
        if (pw_name && _activated_bt_cards.has(pw_name)) {
            print(`[Daemon] Bluetooth device removed: ${pw_name}, clearing activation cache`);
            _activated_bt_cards.delete(pw_name);
        }
    });
    return monitor;
}

// If the configured BT profile is rejected by the device (e.g. the user
// selected 'a2dp-sink-aac' but the JLab GO Air Pop only exposes 'a2dp-sink'
// for AAC), the card can be left in 'off' state with no audio node. After a
// short delay, re-check the card state and fall back to 'a2dp-sink' (codec
// auto) which works on virtually every A2DP-capable device.
function _bt_activate_after_delay(global_id, card_name, attempted_profile, delay_ms) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay_ms, () => {
        try {
            const current = _get_current_bt_profile(card_name);
            if (current !== 'off') {
                return GLib.SOURCE_REMOVE;
            }
            print(`[Daemon] Card ${card_name} is still in 'off' after setting ${attempted_profile}, falling back to a2dp-sink`);
            set_bt_profile(global_id, 'a2dp-sink', card_name);
        } catch (e) {
            print(`[Daemon] _bt_activate_after_delay error: ${e.message || e}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}