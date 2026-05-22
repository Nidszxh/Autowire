const { GLib } = imports.gi;

print('[Daemon] module loaded');

const _BT_NODE_RE = /bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})\..+/;

const _last_routed = {};
const _ROUTING_COOLDOWN = 5.0;

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

/**
 * @param {string} node_name
 * @returns {boolean}
 */
function set_system_default(node_name) {
    if (!node_name) {
        return false;
    }
    try {
        GLib.subprocess_new_sync(['wpctl', 'set-default', node_name], GLib.SubprocessFlags.NONE);
        print(`[Daemon] Default set to: ${node_name}`);
        return true;
    } catch (e) {
        print(`[Daemon] wpctl error for ${node_name}: ${e}`);
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
        GLib.subprocess_new_sync(
            ['wpctl', 'set-profile', String(device_global_id), profile_name],
            GLib.SubprocessFlags.NONE
        );
        print(`[Daemon] BT profile set: device=${device_global_id} profile=${profile_name}`);
        return true;
    } catch (e) {
        print(`[Daemon] wpctl set-profile error: ${e}`);
        return false;
    }
}

/**
 * @param {string} connected_node_name
 * @param {WpMonitor|null} monitor
 * @returns {boolean}
 */
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

        if (sink) {
            set_system_default(sink);
        }
        if (source) {
            set_system_default(source);
        }

        const bt_profile = actions['bt_profile'] || '';
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
    return monitor;
}