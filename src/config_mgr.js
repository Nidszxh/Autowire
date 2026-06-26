// SPDX-License-Identifier: GPL-3.0-or-later

const { GLib } = imports.gi;
const log = imports.log;

print('[Config] module loaded');

const _XDG_CONFIG_HOME = GLib.getenv('XDG_CONFIG_HOME') || GLib.build_filenamev([GLib.getenv('HOME') || '', '.config']);
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
 * Internal: parse + clean profiles array from raw file content.
 * No filesystem side effects.
 * @param {Uint8Array} content
 * @returns {{profiles: Array, cleaned: boolean, migrated: boolean}}
 */
function _parse_profiles(content) {
    const data = JSON.parse(new TextDecoder().decode(content));
    const profiles = data['profiles'] || [];

    let cleaned = false;
    for (let i = profiles.length - 1; i >= 0; i--) {
        const p = profiles[i];
        if (typeof p['profile_name'] !== 'string' || typeof p['trigger_device_name'] !== 'string') {
            print(`[Config] Dropping corrupt profile entry: ${JSON.stringify(p).substring(0, 80)}...`);
            profiles.splice(i, 1);
            cleaned = true;
            continue;
        }
        if (p['is_active'] !== undefined && typeof p['is_active'] !== 'boolean') {
            p['is_active'] = Boolean(p['is_active']);
        }
        const actions = p['actions'];
        if (actions && typeof actions === 'object') {
            if (typeof actions['bt_profile'] !== 'string') {
                actions['bt_profile'] = '';
            }
            if (typeof actions['default_sink'] !== 'string') {
                actions['default_sink'] = '';
            }
            if (typeof actions['default_source'] !== 'string') {
                actions['default_source'] = '';
            }
            if (typeof actions['bt_profile_call'] !== 'string') {
                actions['bt_profile_call'] = '';
            }
        }
    }

    let has_active_field = false;
    for (const p of profiles) {
        if ('is_active' in p) {
            has_active_field = true;
        }
    }

    for (const p of profiles) {
        if (p['is_active'] === undefined) {
            p['is_active'] = false;
        }
    }

    let migrated = false;
    if (!has_active_field) {
        const triggers = [...new Set(profiles.map(p => p['trigger_device_name']))];
        for (const trigger of triggers) {
            const group = profiles.filter(p => p['trigger_device_name'] === trigger);
            if (group.length > 0 && !group.some(p => p['is_active'])) {
                group[0]['is_active'] = true;
                migrated = true;
            }
        }
    }

    return { profiles, cleaned, migrated };
}

/**
 * @returns {Array} list of profile dicts, or [] on any error
 */
function load_profiles() {
    initialize_config();

    try {
        const [, content] = GLib.file_get_contents(CONFIG_FILE);
        const { profiles, cleaned, migrated } = _parse_profiles(content);
        if (cleaned || migrated) {
            _write_atomic({ profiles });
        }
        return profiles;
    } catch (e) {
        log.warn('config_mgr', `Corrupted config file, replacing with empty: ${e.message || e}`);
        _backup_corrupted();
        _write_atomic({ profiles: [] });
        return [];
    }
}

/**
 * Read profiles without any filesystem side effects.
 * - Does NOT call initialize_config() (no dir/file creation)
 * - Does NOT back up or write on corruption
 * - Does NOT persist migration — safe for daemon's read-only use
 * @returns {Array}
 */
function load_profiles_readonly() {
    try {
        if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) return [];
        const [, content] = GLib.file_get_contents(CONFIG_FILE);
        const { profiles } = _parse_profiles(content);
        return profiles;
    } catch (e) {
        log.warn('config_mgr', `Could not read config (read-only): ${e.message || e}`);
        return [];
    }
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
 * @param {Object} opts
 * @param {string} opts.name       profile_name
 * @param {string} opts.trigger    trigger_device_name
 * @param {string} opts.sink       default_sink
 * @param {string} opts.source     default_source
 * @param {string} [opts.btProfile]      bt_profile
 * @param {boolean} [opts.isActive]      is_active
 * @param {string} [opts.btProfileCall]  bt_profile_call
 * @param {boolean} [opts.autoSwitch]    auto_switch
 * @param {string} [opts.display]        trigger_device_display
 * @param {string|null} [opts.originalName]     original profile_name (for rename)
 * @param {string|null} [opts.originalTrigger]  original trigger_device_name (for rename)
 */
function save_profile(opts) {
    const {
        name: profile_name,
        trigger: trigger_device,
        sink: default_sink,
        source: default_source,
        btProfile: bt_profile = '',
        isActive: is_active = false,
        btProfileCall: bt_profile_call = '',
        autoSwitch: auto_switch = false,
        display: trigger_device_display = '',
        originalName: original_profile_name = null,
        originalTrigger: original_trigger_device = null,
    } = opts;

    const profiles = load_profiles();

    // Find by original key first to preserve position on rename.
    // If the new key already exists, the existing profile keeps its position.
    let found_idx = -1;
    let existing_idx = -1;

    // 1. Search by original key
    if (original_profile_name !== null && original_trigger_device !== null) {
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            if (p['trigger_device_name'] === original_trigger_device && p['profile_name'] === original_profile_name) {
                found_idx = i;
                break;
            }
        }
    }

    // 2. Search by new key (skip the entry we already matched by original key)
    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        if (i !== found_idx && p['trigger_device_name'] === trigger_device && p['profile_name'] === profile_name) {
            existing_idx = i;
            break;
        }
    }

    // 3. Overwrite scenario: original key differs from existing target key
    if (found_idx >= 0 && existing_idx >= 0) {
        profiles.splice(found_idx, 1);
        if (existing_idx > found_idx) existing_idx--;
        profiles[existing_idx] = {
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
                if (j !== existing_idx && profiles[j]['trigger_device_name'] === trigger_device) {
                    profiles[j]['is_active'] = false;
                }
            }
        }
        _write_atomic({ profiles });
        print(`[Config] Updated profile (overwrite): '${profile_name}' for '${trigger_device}'`);
        return;
    }

    // 4. Simple update: found by original key (rename, no target conflict)
    if (found_idx >= 0) {
        profiles[found_idx] = {
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
                if (j !== found_idx && profiles[j]['trigger_device_name'] === trigger_device) {
                    profiles[j]['is_active'] = false;
                }
            }
        }
        _write_atomic({ profiles });
        print(`[Config] Updated profile: '${profile_name}' for '${trigger_device}'`);
        return;
    }

    // 5. Update existing by new key (add dialog, no original, key already exists)
    if (existing_idx >= 0) {
        profiles[existing_idx] = {
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
                if (j !== existing_idx && profiles[j]['trigger_device_name'] === trigger_device) {
                    profiles[j]['is_active'] = false;
                }
            }
        }
        _write_atomic({ profiles });
        print(`[Config] Updated profile: '${profile_name}' for '${trigger_device}'`);
        return;
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
 * Back up a corrupted config file before replacing it.
 */
function _backup_corrupted() {
    try {
        const now = GLib.DateTime.new_now_local().format('%Y%m%d_%H%M%S');
        const backup_path = CONFIG_FILE + '.corrupted.' + now;
        GLib.rename(CONFIG_FILE, backup_path);
        log.warn('config_mgr', `Corrupted config backed up to: ${backup_path}`);
    } catch (e) {
        log.warn('config_mgr', `Could not back up corrupted config: ${e.message || e}`);
    }
}

/**
 * @param {Object} data
 * @returns {boolean}
 */
function _write_atomic(data) {
    _ensure_config_dir();

    try {
        const json = new TextEncoder().encode(JSON.stringify(data, null, 2));
        GLib.file_set_contents(CONFIG_FILE, json);
        return true;
    } catch (e) {
        print(`[Config] Atomic write failed: ${e.message || e}`);
        return false;
    }
}

/**
 * Write a structured error to last_error.json for the UI to display.
 * @param {string} message
 */
function write_error(message) {
    _ensure_config_dir();
    const data = JSON.stringify({ timestamp: Date.now(), message }, null, 2);
    try {
        GLib.file_set_contents(ERROR_FILE, new TextEncoder().encode(data));
    } catch (e) {
        print(`[Config] Failed to write error: ${e}`);
    }
}

/**
 * @returns {Object|null} the last error object {timestamp, message}, or null
 */
function read_error() {
    try {
        if (!GLib.file_test(ERROR_FILE, GLib.FileTest.EXISTS)) return null;
        const [, content] = GLib.file_get_contents(ERROR_FILE);
        return JSON.parse(new TextDecoder().decode(content));
    } catch (e) {
        print(`[Config] Failed to read last_error.json: ${e.message || e}`);
        return null;
    }
}

/** Remove the last_error.json file if it exists. */
function clear_error() {
    try {
        GLib.unlink(ERROR_FILE);
    } catch (e) { /* ignore */ }
}

/**
 * Export profiles to an external file path.
 * @param {string} file_path
 * @returns {boolean}
 */
function export_profiles(file_path) {
    const profiles = load_profiles();
    try {
        GLib.file_set_contents(file_path, new TextEncoder().encode(JSON.stringify({ profiles }, null, 2)));
        print(`[Config] Exported ${profiles.length} profiles to ${file_path}`);
        return true;
    } catch (e) {
        log.warn('config_mgr', `Export failed: ${e.message || e}`);
        return false;
    }
}

/**
 * Import profiles from an external file, replacing all current profiles.
 * Validates that the file contains a non-empty profiles array with valid entries.
 * @param {string} file_path
 * @returns {boolean}
 */
function import_profiles(file_path) {
    try {
        const [, content] = GLib.file_get_contents(file_path);
        const data = JSON.parse(new TextDecoder().decode(content));
        if (!data['profiles'] || !Array.isArray(data['profiles'])) {
            log.warn('config_mgr', 'Import file has no valid profiles array');
            return false;
        }
        for (const p of data['profiles']) {
            if (typeof p['profile_name'] !== 'string' || typeof p['trigger_device_name'] !== 'string') {
                log.warn('config_mgr', 'Import file contains invalid profile entries');
                return false;
            }
        }
        _write_atomic(data);
        print(`[Config] Imported ${data['profiles'].length} profiles from ${file_path}`);
        return true;
    } catch (e) {
        log.warn('config_mgr', `Import failed: ${e.message || e}`);
        return false;
    }
}

/**
 * Move a profile one position up within its trigger group.
 * @param {string} trigger_device_name
 * @param {string} profile_name
 * @returns {boolean}
 */
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

/**
 * Move a profile one position down within its trigger group.
 * @param {string} trigger_device_name
 * @param {string} profile_name
 * @returns {boolean}
 */
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