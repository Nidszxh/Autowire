const { GLib } = imports.gi;

print('[Config] module loaded');

const _XDG_CONFIG_HOME = GLib.getenv('XDG_CONFIG_HOME') || GLib.build_filenamev([GLib.getenv('HOME') || '', '.config']);
const CONFIG_DIR = GLib.build_filenamev([_XDG_CONFIG_HOME, 'autowire']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'profiles.json']);

/** @returns {boolean} */
function _ensure_config_dir() {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * @returns {Array} list of profile dicts, or [] on any error
 */
function load_profiles() {
    _ensure_config_dir();

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

    const hasActive = profiles.some(p => p['is_active']);
    if (profiles.length > 0 && !hasActive) {
        profiles[0]['is_active'] = true;
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
function save_profile(profile_name, trigger_device, default_sink, default_source, bt_profile = '', is_active = false) {
    const profiles = load_profiles();

    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        if (p['trigger_device_name'] === trigger_device && p['profile_name'] === profile_name) {
            profiles[i] = {
                profile_name,
                trigger_device_name: trigger_device,
                is_active,
                actions: {
                    default_sink,
                    default_source,
                    bt_profile,
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
        is_active,
        actions: {
            default_sink,
            default_source,
            bt_profile,
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
    _write_atomic({ profiles });
    print(`[Config] Deleted profile: '${profile_name}' for '${trigger_device_name}'`);
    return true;
}

/**
 * @param {Object} data
 */
function _write_atomic(data) {
    _ensure_config_dir();
    const tmp_dir = GLib.dir_make_tmp('autowire_profiles_XXXXXX');
    const tmp_path = GLib.build_filenamev([tmp_dir, 'profiles.json']);

    try {
        const json = new TextEncoder().encode(JSON.stringify(data, null, 2));
        GLib.file_set_contents(tmp_path, json);
        GLib.rename(tmp_path, CONFIG_FILE);
    } catch (e) {
        try {
            GLib.unlink(tmp_path);
        } catch (unlinkErr) { /* ignore */ }
        throw e;
    } finally {
        try {
            GLib.rmdir(tmp_dir);
        } catch (e) { /* ignore */ }
    }
}