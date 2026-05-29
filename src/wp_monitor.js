const { GLib, GObject, Gio } = imports.gi;

let Wp = null;
try {
    imports.gi.versions.Wp = '0.5';
    Wp = imports.gi.Wp;
} catch (e) {
    print('[WpMonitor] Wp typelib not available, running in poll-only mode');
}

const _is_flatpak = imports.gi.GLib.file_test('/.flatpak-info', imports.gi.GLib.FileTest.EXISTS);
function _get_wpctl_cmd() {
    return _is_flatpak ? ['flatpak-spawn', '--host', 'wpctl'] : ['wpctl'];
}


print('[WpMonitor] module loaded');

const _POLL_INTERVAL_MS = 3000;

var WpMonitor = GObject.registerClass({
    Signals: {
        'node-added': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING] },
        'node-removed': { param_types: [GObject.TYPE_STRING] },
        'device-added': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_INT] },
        'device-removed': { param_types: [GObject.TYPE_STRING] },
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
        this._desc_to_name = {};
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
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
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
        this._desc_to_name = {};
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
        return Object.values(this._devices);
    }

    get_device_global_id(device_name) {
        const dev = this._devices[device_name];
        return dev ? dev['global_id'] : null;
    }

    get_capture_nodes() {
        return Object.entries(this._capture_counts)
            .filter(([, count]) => count > 0)
            .map(([name]) => name);
    }

    _poll() {
        if (this._polling) return;
        this._polling = true;
        _fetch_wpctl_status_async(status_text => {
            this._polling = false;
            if (!status_text) {
                print('[WpMonitor] Poll skipped: wpctl status failed or timed out');
                return;
            }
            this._poll_nodes(status_text);
            this._poll_devices(status_text);
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

        this._desc_to_name = {};
        for (const node of current) {
            this._desc_to_name[node['description']] = node['name'];
            this._desc_to_name[node['name']] = node['name'];

            if (!prev_names.has(node['name'])) {
                this._nodes[node['name']] = node;
                print(`[WpMonitor] Node added: ${node['name']} (${node['media_class']})`);
                this.emit('node-added', node['name'], node['description'], node['media_class']);
            }
        }

        for (const name of prev_names) {
            if (!current_names.has(name)) {
                delete this._nodes[name];
                delete this._capture_counts[name];
                print(`[WpMonitor] Node removed: ${name}`);
                this.emit('node-removed', name);
            }
        }
    }

    _poll_devices(status_text) {
        const current = _fetch_devices_from_wpctl(status_text);
        const current_names = new Set(current.map(d => d['name']));
        const prev_names = new Set(Object.keys(this._devices));

        for (const dev of current) {
            if (!prev_names.has(dev['name'])) {
                this._devices[dev['name']] = dev;
                print(`[WpMonitor] Device added: ${dev['name']} global_id=${dev['global_id']}`);
                this.emit('device-added', dev['name'], dev['description'], dev['global_id']);
            }
        }

        for (const name of prev_names) {
            if (!current_names.has(name)) {
                delete this._devices[name];
                print(`[WpMonitor] Device removed: ${name}`);
                this.emit('device-removed', name);
            }
        }
    }

    _poll_streams(status_text) {
        const capture_by_target = _fetch_capture_streams(status_text);

        const new_counts = {};
        for (const [target_desc, count] of Object.entries(capture_by_target)) {
            const node_name = this._desc_to_name[target_desc] || target_desc;
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

function _strip_tree_chars(s) {
    return s.replace(/^[│├└─\s]+/, '');
}

function _fetch_wpctl_status() {
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null, _get_wpctl_cmd().concat(['status']),
            null, GLib.SpawnFlags.SEARCH_PATH, null
        );
        if (!ok) return '';
        return new TextDecoder().decode(stdout);
    } catch (e) {
        return '';
    }
}

function _fetch_wpctl_status_async(callback) {
    try {
        const proc = Gio.Subprocess.new(
            _get_wpctl_cmd().concat(['status']),
            Gio.SubprocessFlags.STDOUT_PIPE
        );

        let timed_out = false;
        const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            timed_out = true;
            print('[WpMonitor] wpctl status timed out');
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        proc.wait_async(null, () => {
            GLib.source_remove(timeout_id);
            if (timed_out) {
                callback('');
                return;
            }
            try {
                const [, stdout] = proc.communicate_utf8(null, null);
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
    const port_re = /\d+\.\s+(\S+)\s*>\s*(.+?):\S+\s+\[(active|init)\]/;

    for (const line of lines) {
        const stripped = line.trim();

        const clean = _strip_tree_chars(stripped);

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

        const port_m = clean.match(port_re);
        if (port_m) {
            const port_name = port_m[1];
            if (port_name.startsWith('input_')) {
                const target = port_m[2].trim();
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
        const clean = _strip_tree_chars(stripped);
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
            const [ok2, inspect_stdout] = GLib.spawn_sync(
                null,
                _get_wpctl_cmd().concat(['inspect', String(node_id)]),
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            if (ok2) {
                for (const iline of new TextDecoder().decode(inspect_stdout).split('\n')) {
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

function _fetch_devices_from_wpctl(status_text) {
    if (!status_text) status_text = _fetch_wpctl_status();
    const results = [];

    let in_devices = false;

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        const clean = _strip_tree_chars(stripped);
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

        results.push({
            name: device_name,
            description: device_name,
            global_id: global_id,
        });
    }

    return results;
}

var get_audio_nodes_sync = function() {
    return _fetch_nodes_from_wpctl();
};

function get_audio_nodes_async(callback) {
    if (typeof callback !== 'function') return;
    try {
        const proc = Gio.Subprocess.new(
            _get_wpctl_cmd().concat(['status']),
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                callback(_fetch_nodes_from_wpctl(stdout));
            } catch (e) {
                callback([]);
            }
        });
    } catch (e) {
        callback([]);
    }
}
