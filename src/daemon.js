const { GLib } = imports.gi;

print('[Daemon] module loaded');

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

function _resolve_node_id(node_name) {
    let status_text;
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null, ['wpctl', 'status'],
            null, GLib.SpawnFlags.SEARCH_PATH, null
        );
        if (!ok) return null;
        status_text = new TextDecoder().decode(stdout);
    } catch (e) {
        return null;
    }

    const candidate_ids = [];
    let in_sinks = false;
    let in_sources = false;
    let in_audio = false;

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        if (stripped === 'Audio') { in_audio = true; continue; }
        if (!in_audio) continue;

        if (['Sinks:', '├─ Sinks:', '└─ Sinks:'].includes(stripped)) {
            in_sinks = true; in_sources = false; continue;
        }
        if (['Sources:', '├─ Sources:', '└─ Sources:'].includes(stripped)) {
            in_sources = true; in_sinks = false; continue;
        }
        if (['Devices:', '├─ Devices:', '└─ Devices:', 'Filters:', '├─ Filters:', '└─ Filters:',
             'Streams:', '├─ Streams:', '└─ Streams:'].includes(stripped)) {
            in_sinks = false; in_sources = false; continue;
        }

        if (!(in_sinks || in_sources)) continue;
        if (!line.startsWith(' │')) { in_sinks = false; in_sources = false; continue; }

        const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+/);
        if (m) candidate_ids.push(parseInt(m[1], 10));
    }

    for (const id of candidate_ids) {
        try {
            const [ok, out] = GLib.spawn_sync(
                null, ['wpctl', 'inspect', String(id)],
                null, GLib.SpawnFlags.SEARCH_PATH, null
            );
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

function set_system_default(node_name) {
    if (!node_name) {
        return false;
    }
    const node_id = _resolve_node_id(node_name);
    if (node_id === null) {
        print(`[Daemon] Could not resolve node ID for: ${node_name}`);
        return false;
    }
    try {
        const [ok, stdout, stderr, exitStatus] = GLib.spawn_sync(
            null,
            ['wpctl', 'set-default', String(node_id)],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
        if (ok && exitStatus === 0) {
            print(`[Daemon] Default set to: ${node_name} (id=${node_id})`);
            return true;
        }
        const errMsg = stderr ? new TextDecoder().decode(stderr).trim() : `exit code ${exitStatus}`;
        print(`[Daemon] wpctl error for ${node_name} (id=${node_id}): ${errMsg}`);
        return false;
    } catch (e) {
        if (e.matches && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            print('[Daemon] ERROR: wpctl not found. Is WirePlumber installed?');
        } else {
            print(`[Daemon] wpctl error for ${node_name}: ${e.message || e}`);
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
        const [ok, stdout, stderr, exitStatus] = GLib.spawn_sync(
            null,
            ['wpctl', 'set-profile', String(device_global_id), profile_name],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
        if (ok && exitStatus === 0) {
            print(`[Daemon] BT profile set: device=${device_global_id} profile=${profile_name}`);
            return true;
        }
        const errMsg = stderr ? new TextDecoder().decode(stderr).trim() : `exit code ${exitStatus}`;
        print(`[Daemon] wpctl set-profile error: ${errMsg}`);
        return false;
    } catch (e) {
        if (e.matches && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            print('[Daemon] ERROR: wpctl not found. Is WirePlumber installed?');
        } else {
            print(`[Daemon] wpctl set-profile error: ${e.message || e}`);
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
    const config_mgr = imports.config_mgr;
    let profile = config_mgr.get_active_profile(node_name);
    if (profile) return profile;

    const card = _bt_card_name(node_name);
    if (!card) return null;

    const profiles = config_mgr.load_profiles();
    for (const p of profiles) {
        if (p['is_active'] && _bt_card_name(p['trigger_device_name']) === card) {
            return p;
        }
    }
    return null;
}

function check_and_route_device(connected_node_name, monitor) {
    const now = GLib.get_monotonic_time() / 1000000;
    const last = _last_routed[connected_node_name] || 0;
    if (now - last < _ROUTING_COOLDOWN) {
        print(`[Daemon] Cooldown active for ${connected_node_name}, skipping.`);
        return false;
    }

    const config_mgr = imports.config_mgr;
    const profiles = config_mgr.load_profiles();
    let matched = false;

    for (const profile of profiles) {
        if (profile['trigger_device_name'] !== connected_node_name) {
            continue;
        }
        if (!profile['is_active']) {
            continue;
        }

        matched = true;
        print(`[Daemon] Matched profile: ${profile['profile_name']}`);
        const actions = profile['actions'] || {};

        const sink = actions['default_sink'] || '';
        const source = actions['default_source'] || '';
        let bt_profile = actions['bt_profile'] || '';
        if (actions['auto_switch'] && _any_active_capture_for(connected_node_name)) {
            bt_profile = actions['bt_profile_call'] || bt_profile;
        }

        if (sink) {
            set_system_default(sink);
        } else if (bt_profile && monitor) {
            const bt_card = _bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Sink'
                        && _bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT output: ${node['name']}`);
                        set_system_default(node['name']);
                        break;
                    }
                }
            }
        }
        if (source) {
            set_system_default(source);
        } else if (bt_profile && monitor) {
            const bt_card = _bt_card_name(connected_node_name);
            if (bt_card) {
                for (const node of monitor.get_audio_nodes()) {
                    if (node['media_class'] === 'Audio/Source'
                        && _bt_card_name(node['name']) === bt_card) {
                        print(`[Daemon] Auto-routing BT input: ${node['name']}`);
                        set_system_default(node['name']);
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

    if (matched) {
        _last_routed[connected_node_name] = now;
    }
    return matched;
}

function handle_capture_started(node_name, monitor) {
    if (_capture_timers[node_name]) {
        GLib.source_remove(_capture_timers[node_name]);
        delete _capture_timers[node_name];
    }
    _active_capture_nodes.add(node_name);

    const profile = _get_active_profile_for(node_name);
    if (!profile) {
        print(`[Daemon] Capture started on ${node_name}, but no matching profile found.`);
        return;
    }

    const actions = profile['actions'] || {};
    if (!actions['auto_switch']) return;

    const call_profile = actions['bt_profile_call'] || '';
    if (!call_profile) return;

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
                set_system_default(node['name']);
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
                    set_system_default(node['name']);
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
    const WpMonitor = imports.wp_monitor.WpMonitor;
    const monitor = new WpMonitor();
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