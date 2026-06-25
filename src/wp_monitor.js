const { GLib, GObject, Gio } = imports.gi;
const { get_wpctl_cmd, strip_tree_chars, spawn_sync_with_timeout } = imports.utils;
const C = imports.constants;

let Wp = null;
try {
    imports.gi.versions.Wp = '0.5';
    Wp = imports.gi.Wp;
} catch (e) {
    print('[WpMonitor] Wp typelib not available, running in poll-only mode');
}


print('[WpMonitor] module loaded');

const _POLL_INTERVAL_MS = C.POLL_INTERVAL_MS;

var WpMonitor = GObject.registerClass({
    Signals: {
        'node-added': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING] },
        'node-removed': { param_types: [GObject.TYPE_STRING] },
        'device-added': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_INT, GObject.TYPE_STRING] },
        'device-removed': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_INT, GObject.TYPE_STRING] },
        'capture-started': { param_types: [GObject.TYPE_STRING] },
        'capture-stopped': { param_types: [GObject.TYPE_STRING] },
        'ready': {},
    },
}, class AutowireWpMonitor extends GObject.Object {
    constructor() {
        super();
        this._core = null;
        this._poll_id = 0;
        this._polling = false;
        this._nodes = {};
        this._devices = {};
        this._capture_counts = {};
        this._desc_to_id = {};
        this._id_to_node = {};
        this._ready = false;
    }

    start() {
        if (!Wp) {
            print('[WpMonitor] Wp not available, starting poll directly');
            this._poll();
            this._poll_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _POLL_INTERVAL_MS, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }
        this._core = Wp.Core.new(null, null, null);
        GObject.signal_connect(this._core, 'connected', () => this._on_core_connected());
        GObject.signal_connect(this._core, 'disconnected', () => {
            print('[WpMonitor] Core disconnected, reconnecting in 5s…');
            if (this._poll_id > 0) {
                GLib.source_remove(this._poll_id);
                this._poll_id = 0;
            }
            this._ready = false;
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, C.RECONNECT_DELAY_S, () => {
                if (this._core) {
                    print('[WpMonitor] Attempting reconnection…');
                    this._core.connect();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this._core.connect();
    }

    stop() {
        if (this._poll_id > 0) {
            GLib.source_remove(this._poll_id);
            this._poll_id = 0;
        }
        if (this._core) {
            this._core.disconnect();
            this._core = null;
        }
        this._nodes = {};
        this._devices = {};
        this._capture_counts = {};
        this._desc_to_id = {};
        this._id_to_node = {};
        this._ready = false;
    }

    _on_core_connected() {
        print('[WpMonitor] Core connected, starting poll…');
        this._poll();
        this._poll_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _POLL_INTERVAL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get_audio_nodes() {
        return Object.values(this._nodes);
    }

    get_devices() {
        const seen = new Set();
        return Object.values(this._devices).filter(d => {
            if (seen.has(d['global_id'])) return false;
            seen.add(d['global_id']);
            return true;
        });
    }

    get_device_global_id(device_name) {
        const dev = this._devices[device_name];
        return dev ? dev['global_id'] : null;
    }

    /**
     * Resolve a device name to a global ID, with wpctl status fallback.
     * @param {string} device_name
     * @returns {number|null}
     */
    resolveDeviceGlobalId(device_name) {
        const id = this.get_device_global_id(device_name);
        if (id) return id;
        // Fallback: parse Devices section from wpctl status directly in case
        // the poll hasn't reached this device yet.
        const devices = _fetch_devices_from_wpctl();
        for (const dev of devices) {
            if (dev['pw_name'] === device_name) {
                this._devices[device_name] = dev;
                return dev['global_id'];
            }
        }
        return null;
    }

    get_capture_nodes() {
        return Object.entries(this._capture_counts)
            .filter(([, count]) => count > 0)
            .map(([name]) => name);
    }

    _poll() {
        if (this._polling) return;
        this._polling = true;
        const fail_safe_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.STATUS_TIMEOUT_MS + 1000, () => {
            if (this._polling) {
                print('[WpMonitor] Poll fail-safe: resetting _polling flag');
                this._polling = false;
            }
            return GLib.SOURCE_REMOVE;
        });
        _fetch_wpctl_status_async(status_text => {
            if (fail_safe_id > 0) GLib.source_remove(fail_safe_id);
            this._polling = false;
            if (!status_text) {
                print('[WpMonitor] Poll skipped: wpctl status failed or timed out');
                return;
            }
            this._poll_devices(status_text);
            this._poll_nodes(status_text);
            this._poll_streams(status_text);
            if (!this._ready) {
                this._ready = true;
                this.emit('ready');
            }
        });
    }

    _poll_nodes(status_text) {
        const current = _fetch_nodes_from_wpctl(status_text, this._nodes);
        const current_names = new Set(current.map(n => n['name']));
        const prev_names = new Set(Object.keys(this._nodes));

        // Rebuild maps each poll to avoid stale entries and description collisions.
        this._desc_to_id = {};
        this._id_to_node = {};

        for (const node of current) {
            if (node['id']) {
                this._id_to_node[node['id']] = node;
            }
            if (node['description']) {
                this._desc_to_id[node['description']] = node['id'];
            }
            // Map node.name → id for stream resolution by name
            this._desc_to_id[node['name']] = node['id'];

            if (!prev_names.has(node['name'])) {
                this._nodes[node['name']] = node;
                print(`[WpMonitor] Node added: ${node['name']} (${node['media_class']})`);
                this.emit('node-added', node['name'], node['description'], node['media_class']);
            }
        }

        for (const name of prev_names) {
            if (!current_names.has(name)) {
                delete this._nodes[name];
                print(`[WpMonitor] Node removed: ${name}`);
                this.emit('node-removed', name);
            }
        }
    }

    _poll_devices(status_text) {
        const current = _fetch_devices_from_wpctl(status_text, this._devices);
        const current_names = new Set(current.map(d => d['pw_name']));
        const prev_names = new Set(Object.keys(this._devices));

        for (const dev of current) {
            if (!prev_names.has(dev['pw_name'])) {
                this._devices[dev['pw_name']] = dev;
                print(`[WpMonitor] Device added: ${dev['name']} (${dev['pw_name']}) global_id=${dev['global_id']}`);
                this.emit('device-added', dev['name'], dev['description'], dev['global_id'], dev['pw_name']);
            }
        }

        const removed_ids = new Set();
        for (const name of prev_names) {
            if (!current_names.has(name)) {
                const dev = this._devices[name];
                if (dev && !removed_ids.has(dev['global_id'])) {
                    removed_ids.add(dev['global_id']);
                    print(`[WpMonitor] Device removed: ${dev['name']}`);
                    this.emit('device-removed', dev['name'], dev['description'], dev['global_id'], dev['pw_name']);
                }
                delete this._devices[name];
            }
        }
    }

    _poll_streams(status_text) {
        const capture_by_target = _fetch_capture_streams(status_text);

        const new_counts = {};
        for (const [target_desc, count] of Object.entries(capture_by_target)) {
            const node_id = this._desc_to_id[target_desc];
            const node = node_id ? this._id_to_node[node_id] : null;
            // Skip VU meter and loopback streams on sink nodes.
            // Only bluez_input.* (Audio/Source) captures trigger BT switching.
            if (node && node['media_class'] === 'Audio/Sink') continue;
            const node_name = node ? node['name'] : target_desc;
            new_counts[node_name] = count;
        }

        const all_names = new Set([...Object.keys(this._capture_counts), ...Object.keys(new_counts)]);

        for (const name of all_names) {
            const prev = this._capture_counts[name] || 0;
            const curr = new_counts[name] || 0;

            if (prev === 0 && curr > 0) {
                print(`[WpMonitor] Capture started on: ${name}`);
                this.emit('capture-started', name);
            } else if (prev > 0 && curr === 0) {
                print(`[WpMonitor] Capture stopped on: ${name}`);
                this.emit('capture-stopped', name);
            }
        }

        this._capture_counts = new_counts;
    }
});

function _fetch_wpctl_status() {
    try {
        const [ok, stdout] = spawn_sync_with_timeout(get_wpctl_cmd().concat(['status']), 5000);
        if (!ok) return '';
        return stdout;
    } catch (e) {
        return '';
    }
}

function _fetch_wpctl_status_async(callback) {
    try {
        const proc = Gio.Subprocess.new(
            get_wpctl_cmd().concat(['status']),
            Gio.SubprocessFlags.STDOUT_PIPE
        );

        let timed_out = false;
        const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.STATUS_TIMEOUT_MS, () => {
            timed_out = true;
            print('[WpMonitor] wpctl status timed out');
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, null, (p, res) => {
            if (timed_out) {
                callback('');
                return;
            }
            GLib.source_remove(timeout_id);
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                callback(stdout || '');
            } catch (e) {
                callback('');
            }
        });
    } catch (e) {
        callback('');
    }
}

function _fetch_capture_streams(status_text) {
    if (!status_text) status_text = _fetch_wpctl_status();
    const lines = status_text.split('\n');
    const capture_by_target = {};

    let in_streams = false;

    for (const line of lines) {
        const stripped = line.trim();

        const clean = strip_tree_chars(stripped);

        if (clean === 'Streams:' || clean === '├─ Streams:' || clean === '└─ Streams:') {
            in_streams = true;
            continue;
        }

        if (!in_streams) continue;

        if (!stripped) continue;

        if (stripped.endsWith(':') && !stripped.match(/^\d+\.\s/)) {
            in_streams = false;
            continue;
        }

        const dir_m = clean.match(/^\d+\.\s+([\w-]+)\s+([<>])\s+(.+?)\s+\[.*\]$/);
        if (!dir_m) continue;

        const port_name = dir_m[1];
        const arrow = dir_m[2];
        const right_side = dir_m[3].trim();

        // PW <1.6 uses >, PW >=1.6 uses < for input ports; handle both.
        if (port_name.startsWith('input_') && (arrow === '<' || arrow === '>')) {
            // Extract device description from "description:port_name".
            const last_colon = right_side.lastIndexOf(':');
            const target = last_colon > 0 ? right_side.substring(0, last_colon).trim() : right_side;
            if (target) {
                capture_by_target[target] = (capture_by_target[target] || 0) + 1;
            }
        }
    }

    return capture_by_target;
}

function _fetch_nodes_from_wpctl(status_text, known_nodes) {
    if (!status_text) status_text = _fetch_wpctl_status();
    const results = [];
    const seen_ids = new Set();

    let in_sinks = false;
    let in_sources = false;

    const known_by_id = {};
    if (known_nodes) {
        for (const node of Object.values(known_nodes)) {
            if (node['id']) known_by_id[node['id']] = node;
        }
    }

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        const clean = strip_tree_chars(stripped);
        if (clean === 'Sinks:' || clean === '├─ Sinks:' || clean === '└─ Sinks:') {
            in_sinks = true;
            in_sources = false;
            continue;
        }
        if (clean === 'Sources:' || clean === '├─ Sources:' || clean === '└─ Sources:') {
            in_sources = true;
            in_sinks = false;
            continue;
        }
        if (clean === 'Devices:' || clean === '├─ Devices:' || clean === '└─ Devices:' ||
            clean === 'Filters:' || clean === '├─ Filters:' || clean === '└─ Filters:' ||
            clean === 'Streams:' || clean === '├─ Streams:' || clean === '└─ Streams:') {
            in_sinks = false;
            in_sources = false;
            continue;
        }

        if (!line.startsWith(' │')) {
            in_sinks = false;
            in_sources = false;
            continue;
        }

        if (!(in_sinks || in_sources)) continue;

        if (/\boff\b/.test(line)) continue;

        const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+(.+?)(?:\s+\[.*\])?$/);
        if (!m) continue;

        const node_id = parseInt(m[1], 10);
        if (seen_ids.has(node_id)) continue;
        seen_ids.add(node_id);

        let description = m[2].trim();
        const media_class = in_sinks ? 'Audio/Sink' : 'Audio/Source';
        let name = description;

        const cached = known_by_id[node_id];
        if (cached) {
            name = cached['name'];
            description = cached['description'] || name;
            results.push({
                id: node_id,
                name: name,
                description: description,
                media_class: media_class,
            });
            continue;
        }

        try {
            const [ok2, inspect_stdout] = spawn_sync_with_timeout(get_wpctl_cmd().concat(['inspect', String(node_id)]), 2000);
            if (ok2) {
                for (const iline of inspect_stdout.split('\n')) {
                    if (iline.includes('node.name')) {
                        const parts = iline.split('=');
                        name = (parts[1] || '').trim().replace(/^"(.*)"$/, '$1');
                        break;
                    }
                    if (iline.includes('node.description') && !description) {
                        const parts = iline.split('=');
                        description = (parts[1] || '').trim().replace(/^"(.*)"$/, '$1');
                    }
                }
            }
        } catch (e) {
            print(`[WpMonitor] inspect failed for node ${node_id}: ${e.message || e}`);
        }

        results.push({
            id: node_id,
            name: name,
            description: description,
            media_class: media_class,
        });
    }

    return results;
}

function _fetch_devices_from_wpctl(status_text, known_devices) {
    if (!status_text) status_text = _fetch_wpctl_status();
    const results = [];

    const known_by_id = {};
    if (known_devices) {
        for (const dev of Object.values(known_devices)) {
            if (dev['global_id']) known_by_id[dev['global_id']] = dev;
        }
    }

    let in_devices = false;

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        const clean = strip_tree_chars(stripped);
        if (clean === 'Devices:' || clean === '├─ Devices:' || clean === '└─ Devices:') {
            in_devices = true;
            continue;
        }

        if (!in_devices) continue;

        if (!line.startsWith(' │')) {
            in_devices = false;
            continue;
        }

        const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+(.+?)(?:\s+\[.*\])?$/);
        if (!m) continue;

        const device_name = m[2].trim();
        const global_id = parseInt(m[1], 10);

        const cached = known_by_id[global_id];
        if (cached) {
            results.push(cached);
            continue;
        }

        let pw_name = device_name;
        try {
            const [ok, stdout] = spawn_sync_with_timeout(get_wpctl_cmd().concat(['inspect', String(global_id)]), 2000);
            if (ok) {
                for (const iline of stdout.split('\n')) {
                    if (iline.includes('device.name')) {
                        const parts = iline.split('=');
                        pw_name = (parts[1] || '').trim().replace(/^"(.*)"$/, '$1');
                        break;
                    }
                }
            }
        } catch (e) {
            print(`[WpMonitor] inspect failed for device ${global_id}: ${e.message || e}`);
        }

        results.push({
            name: device_name,
            description: device_name,
            pw_name: pw_name,
            global_id: global_id,
        });
    }

    return results;
}

// Sync getter removed — UI must stay non-blocking

/**
 * Asynchronously fetch all audio nodes. Calls callback with the node array
 * (or empty array on failure/timeout).
 * @param {function(Array): void} callback
 */
function get_audio_nodes_async(callback) {
    if (typeof callback !== 'function') return;
    let timed_out = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.STATUS_TIMEOUT_MS + 1000, () => {
        timed_out = true;
        callback([]);
        return GLib.SOURCE_REMOVE;
    });
    try {
        const proc = Gio.Subprocess.new(
            get_wpctl_cmd().concat(['status']),
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.source_remove(timer);
            if (timed_out) return;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                callback(_fetch_nodes_from_wpctl(stdout));
            } catch (e) {
                callback([]);
            }
        });
    } catch (e) {
        GLib.source_remove(timer);
        if (!timed_out) callback([]);
    }
}
