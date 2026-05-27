const { GLib } = imports.gi;

print('[Config] module loaded');

var _XDG_CONFIG_HOME = GLib.getenv('XDG_CONFIG_HOME') || GLib.build_filenamev([GLib.getenv('HOME') || '', '.config']);
var CONFIG_DIR = GLib.build_filenamev([_XDG_CONFIG_HOME, 'autowire']);
var CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'profiles.json']);
var ERROR_FILE = GLib.build_filenamev([CONFIG_DIR, 'last_error.json']);

/** @returns {boolean} */
function _ensure_config_dir() {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        return true;
    } catch (e) {
        return false;
    }
}

function initialize_config() {
    _ensure_config_dir();
    if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
        _write_atomic({ profiles: [] });
    }
}

/**
 * @returns {Array} list of profile dicts, or [] on any error
 */
function load_profiles() {
    initialize_config();

    if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
        return [];
    }

    let content;
    try {
        [, content] = GLib.file_get_contents(CONFIG_FILE);
    } catch (e) {
        return [];
    }

    let data;
    try {
        data = JSON.parse(new TextDecoder().decode(content));
    } catch (e) {
        return [];
    }

    const profiles = data['profiles'] || [];

    for (const p of profiles) {
        if (p['is_active'] === undefined) {
            p['is_active'] = false;
        }
    }

    const triggers = [...new Set(profiles.map(p => p['trigger_device_name']))];
    let migrated = false;
    for (const trigger of triggers) {
        const group = profiles.filter(p => p['trigger_device_name'] === trigger);
        if (group.length > 0 && !group.some(p => p['is_active'])) {
            group[0]['is_active'] = true;
            migrated = true;
        }
    }
    if (migrated) {
        _write_atomic({ profiles });
    }

    return profiles;
}

/**
 * @param {string} trigger_device_name
 * @param {string} profile_name
 * @returns {Object|null}
 */
function get_profile(trigger_device_name, profile_name) {
    for (const p of load_profiles()) {
        if (p['trigger_device_name'] === trigger_device_name && p['profile_name'] === profile_name) {
            return p;
        }
    }
    return null;
}

/**
 * @param {string} trigger_device_name
 * @returns {Array}
 */
function get_profiles_for_trigger(trigger_device_name) {
    return load_profiles().filter(p => p['trigger_device_name'] === trigger_device_name);
}

/**
 * @param {string} trigger_device_name
 * @returns {Object|null}
 */
function get_active_profile(trigger_device_name) {
    for (const p of load_profiles()) {
        if (p['trigger_device_name'] === trigger_device_name && p['is_active']) {
            return p;
        }
    }
    return null;
}

/**
 * @param {string} trigger_device_name
 * @param {string} profile_name
 */
function set_active_profile(trigger_device_name, profile_name) {
    const profiles = load_profiles();
    for (const p of profiles) {
        if (p['trigger_device_name'] === trigger_device_name) {
            p['is_active'] = p['profile_name'] === profile_name;
        }
    }
    _write_atomic({ profiles });
}

/**
 * @param {string} profile_name
 * @param {string} trigger_device
 * @param {string} default_sink
 * @param {string} default_source
 * @param {string} bt_profile
 * @param {boolean} is_active
 */
function save_profile(profile_name, trigger_device, default_sink, default_source, bt_profile = '', is_active = false, bt_profile_call = '', auto_switch = false, trigger_device_display = '') {
    const profiles = load_profiles();

    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        if (p['trigger_device_name'] === trigger_device && p['profile_name'] === profile_name) {
            profiles[i] = {
                profile_name,
                trigger_device_name: trigger_device,
                trigger_device_display,
                is_active,
                actions: {
                    default_sink,
                    default_source,
                    bt_profile,
                    bt_profile_call,
                    auto_switch,
                },
            };
            if (is_active) {
                for (let j = 0; j < profiles.length; j++) {
                    if (j !== i && profiles[j]['trigger_device_name'] === trigger_device) {
                        profiles[j]['is_active'] = false;
                    }
                }
            }
            _write_atomic({ profiles });
            print(`[Config] Updated profile: '${profile_name}' for '${trigger_device}'`);
            return;
        }
    }

    if (is_active) {
        for (const p of profiles) {
            if (p['trigger_device_name'] === trigger_device) {
                p['is_active'] = false;
            }
        }
    }

    profiles.push({
        profile_name,
        trigger_device_name: trigger_device,
        trigger_device_display,
        is_active,
        actions: {
            default_sink,
            default_source,
            bt_profile,
            bt_profile_call,
            auto_switch,
        },
    });

    _write_atomic({ profiles });
    print(`[Config] Saved profile: '${profile_name}' for '${trigger_device}'`);
}

/**
 * @param {string} trigger_device_name
 * @param {string} profile_name
 * @returns {boolean}
 */
function delete_profile(trigger_device_name, profile_name) {
    const profiles = load_profiles();
    const filtered = profiles.filter(p =>
        !(p['trigger_device_name'] === trigger_device_name && p['profile_name'] === profile_name)
    );
    if (filtered.length === profiles.length) {
        return false;
    }
    _write_atomic({ profiles: filtered });
    print(`[Config] Deleted profile: '${profile_name}' for '${trigger_device_name}'`);
    return true;
}

/**
 * @param {Object} data
 */
function _write_atomic(data) {
    _ensure_config_dir();
    const tmp_path = CONFIG_FILE + '.tmp';

    try {
        const json = new TextEncoder().encode(JSON.stringify(data, null, 2));
        GLib.file_set_contents(tmp_path, json);
        GLib.rename(tmp_path, CONFIG_FILE);
    } catch (e) {
        try {
            GLib.unlink(tmp_path);
        } catch (unlinkErr) { /* ignore */ }
        throw e;
    }
}

function write_error(message) {
    _ensure_config_dir();
    const data = JSON.stringify({ timestamp: Date.now(), message }, null, 2);
    try {
        GLib.file_set_contents(ERROR_FILE, new TextEncoder().encode(data));
    } catch (e) {
        print(`[Config] Failed to write error: ${e}`);
    }
}

function read_error() {
    try {
        if (!GLib.file_test(ERROR_FILE, GLib.FileTest.EXISTS)) return null;
        const [, content] = GLib.file_get_contents(ERROR_FILE);
        return JSON.parse(new TextDecoder().decode(content));
    } catch (e) {
        return null;
    }
}

function clear_error() {
    try {
        GLib.unlink(ERROR_FILE);
    } catch (e) { /* ignore */ }
}

function move_profile_up(trigger_device_name, profile_name) {
    const profiles = load_profiles();
    const idx = profiles.findIndex(p =>
        p['trigger_device_name'] === trigger_device_name &&
        p['profile_name'] === profile_name
    );
    if (idx <= 0) return false;
    let prev_idx = -1;
    for (let i = idx - 1; i >= 0; i--) {
        if (profiles[i]['trigger_device_name'] === trigger_device_name) {
            prev_idx = i;
            break;
        }
    }
    if (prev_idx < 0) return false;
    [profiles[idx], profiles[prev_idx]] = [profiles[prev_idx], profiles[idx]];
    _write_atomic({ profiles });
    return true;
}

function move_profile_down(trigger_device_name, profile_name) {
    const profiles = load_profiles();
    const idx = profiles.findIndex(p =>
        p['trigger_device_name'] === trigger_device_name &&
        p['profile_name'] === profile_name
    );
    if (idx < 0 || idx >= profiles.length - 1) return false;
    let next_idx = -1;
    for (let i = idx + 1; i < profiles.length; i++) {
        if (profiles[i]['trigger_device_name'] === trigger_device_name) {
            next_idx = i;
            break;
        }
    }
    if (next_idx < 0) return false;
    [profiles[idx], profiles[next_idx]] = [profiles[next_idx], profiles[idx]];
    _write_atomic({ profiles });
    return true;
}