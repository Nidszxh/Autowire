const { GLib, Gio } = imports.gi;

const _is_flatpak = imports.gi.GLib.file_test('/.flatpak-info', imports.gi.GLib.FileTest.EXISTS);
function _get_wpctl_cmd() {
    return _is_flatpak ? ['flatpak-spawn', '--host', 'wpctl'] : ['wpctl'];
}

const config_mgr = imports.config_mgr;
const wp_monitor = imports.wp_monitor;

print('[Daemon] module loaded');

function _spawn_sync_with_timeout(argv, timeout_ms = 4000) {
    let stdoutStr = '';
    let stderrStr = '';
    let exitStatus = 1;
    let ok = false;
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const loop = GLib.MainLoop.new(null, false);
        let timed_out = false;
        const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout_ms, () => {
            timed_out = true;
            proc.force_exit();
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (!timed_out) {
                GLib.source_remove(timeout_id);
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    stdoutStr = out || '';
                    stderrStr = err || '';
                    exitStatus = p.get_successful() ? 0 : 1;
                    ok = true;
                } catch (e) {}
                loop.quit();
            }
        });
        loop.run();
        return [ok && !timed_out, new TextEncoder().encode(stdoutStr), new TextEncoder().encode(stderrStr), exitStatus];
    } catch (e) {
        return [false, null, null, 1];
    }
}


const _BT_NODE_RE = /bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})\..+/;

const _last_routed = {};
const _ROUTING_COOLDOWN = 5.0;
const _CAPTURE_DEBOUNCE_MS = 3000;
const _capture_timers = {};
const _active_capture_nodes = new Set();

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
        const [ok, stdout] = _spawn_sync_with_timeout(_get_wpctl_cmd().concat(['status']));
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
            const [ok, out] = _spawn_sync_with_timeout(_get_wpctl_cmd().concat(['inspect', String(id)]));
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
        const [ok, stdout, stderr, exitStatus] = _spawn_sync_with_timeout(_get_wpctl_cmd().concat(['set-default', String(node_id)]));
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

/**
 * @param {number} device_global_id
 * @param {string} profile_name
 * @returns {boolean}
 */
function set_bt_profile(device_global_id, profile_name) {
    if (!profile_name || device_global_id <= 0) {
        return false;
    }
    try {
        const [ok, stdout, stderr, exitStatus] = _spawn_sync_with_timeout(_get_wpctl_cmd().concat(['set-profile', String(device_global_id), profile_name]));
        if (ok && exitStatus === 0) {
            print(`[Daemon] BT profile set: device=${device_global_id} profile=${profile_name}`);
            return true;
        }
        const errMsg = stderr ? new TextDecoder().decode(stderr).trim() : `exit code ${exitStatus}`;
        const msg = `wpctl set-profile failed (device=${device_global_id}, profile=${profile_name}): ${errMsg}`;
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
function _bt_card_equal(a, b) {
    if (!a || !b) return false;
    const ca = _bt_card_name(a);
    const cb = _bt_card_name(b);
    if (!ca || !cb) return false;
    return ca === cb;
}

function _any_active_capture_for(node_name) {
    if (_active_capture_nodes.has(node_name)) return true;
    for (const captured of _active_capture_nodes) {
        if (_bt_card_equal(captured, node_name)) return true;
    }
    return false;
}

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
    'a2dp-sink-sbc',
    'handsfree-headset',
]);

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
                const global_id = monitor.get_device_global_id(card_name);
                if (global_id && global_id > 0) {
                    set_bt_profile(global_id, bt_profile);
                }
            }
        }
    }

    if (found_trigger) {
        _last_routed[connected_node_name] = now;
    }
    return matched;
}

function handle_capture_started(node_name, monitor) {
    if (_capture_timers[node_name]) {
        GLib.source_remove(_capture_timers[node_name]);
        delete _capture_timers[node_name];
    }

    const profile = _get_active_profile_for(node_name);
    if (!profile || !_validate_profile(profile)) {
        print(`[Daemon] Capture started on ${node_name}, but no matching profile found.`);
        return;
    }

    const actions = profile['actions'] || {};
    if (!actions['auto_switch']) return;

    const call_profile = actions['bt_profile_call'] || '';
    if (!call_profile) return;

    _active_capture_nodes.add(node_name);

    print(`[Daemon] Capture started on ${node_name}, switching to call profile: ${call_profile}`);

    const card_name = _bt_card_name(node_name);
    if (card_name) {
        const global_id = monitor.get_device_global_id(card_name);
        if (global_id && global_id > 0) {
            set_bt_profile(global_id, call_profile);
        }

        for (const node of monitor.get_audio_nodes()) {
            if (node['media_class'] === 'Audio/Source'
                && _bt_card_name(node['name']) === card_name) {
                set_system_default(node['name'], monitor);
                break;
            }
        }
    }
}

function handle_capture_stopped(node_name, monitor) {
    if (_capture_timers[node_name]) {
        GLib.source_remove(_capture_timers[node_name]);
    }

    _capture_timers[node_name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _CAPTURE_DEBOUNCE_MS, () => {
        delete _capture_timers[node_name];
        _active_capture_nodes.delete(node_name);

        const profile = _get_active_profile_for(node_name);
        if (!profile) return GLib.SOURCE_REMOVE;

        const actions = profile['actions'] || {};
        if (!actions['auto_switch']) return GLib.SOURCE_REMOVE;

        const normal_profile = actions['bt_profile'] || '';
        if (!normal_profile) return GLib.SOURCE_REMOVE;

        print(`[Daemon] Capture stopped on ${node_name}, restoring profile: ${normal_profile}`);

        const card_name = _bt_card_name(node_name);
        if (card_name) {
            const global_id = monitor.get_device_global_id(card_name);
            if (global_id && global_id > 0) {
                set_bt_profile(global_id, normal_profile);
            }

            for (const node of monitor.get_audio_nodes()) {
                if (node['media_class'] === 'Audio/Sink'
                    && _bt_card_name(node['name']) === card_name) {
                    set_system_default(node['name'], monitor);
                    break;
                }
            }
        }

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
    monitor.connect('device-added', (mon, name, description, global_id) => {
        if (name.startsWith('bluez_card.')) {
            print(`[Daemon] Bluetooth device detected: ${name}`);
        }
    });
    monitor.connect('capture-started', (mon, node_name) => {
        handle_capture_started(node_name, mon);
    });
    monitor.connect('capture-stopped', (mon, node_name) => {
        handle_capture_stopped(node_name, mon);
    });
    return monitor;
}