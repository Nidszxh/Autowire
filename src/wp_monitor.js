imports.gi.versions.Wp = '0.5';
const { GLib, GObject, Wp } = imports.gi;

print('[WpMonitor] module loaded');

const _AUDIO_MEDIA_CLASSES = new Set([
    'Audio/Sink',
    'Audio/Source',
    'Audio/Duplex',
]);

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
        this._nodes = {};
        this._devices = {};
        this._capture_counts = {};
        this._desc_to_name = {};
        this._ready = false;
    }

    start() {
        this._core = Wp.Core.new(null, null, null);
        GObject.signal_connect(this._core, 'connected', () => this._on_core_connected());
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

    _on_core_connected() {
        print('[WpMonitor] Core connected, starting poll…');
        this._poll();
        this._poll_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, _POLL_INTERVAL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _poll() {
        this._poll_nodes();
        this._poll_devices();
        this._poll_streams();
        if (!this._ready) {
            this._ready = true;
            this.emit('ready');
        }
    }

    _poll_nodes() {
        const current = get_audio_nodes_sync();
        const current_names = new Set(current.map(n => n['name']));
        const prev_names = new Set(Object.keys(this._nodes));

        this._desc_to_name = {};
        for (const node of current) {
            this._desc_to_name[node['description']] = node['name'];

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

    _poll_devices() {
        const current = _fetch_devices_from_wpctl();
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

    _poll_streams() {
        const capture_by_target = _fetch_capture_streams();

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

function _fetch_streams_status() {
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null, ['wpctl', 'status'],
            null, GLib.SpawnFlags.SEARCH_PATH, null
        );
        if (!ok) return [];
        return new TextDecoder().decode(stdout).split('\n');
    } catch (e) {
        return [];
    }
}

function _fetch_capture_streams() {
    const lines = _fetch_streams_status();
    const capture_by_target = {};

    let in_streams = false;

    for (const line of lines) {
        const stripped = line.trim();

        if (['Streams:', '├─ Streams:', '└─ Streams:'].includes(stripped)) {
            in_streams = true;
            continue;
        }

        if (!in_streams) continue;

        if (!line.startsWith(' │')) {
            in_streams = false;
            continue;
        }

        const sub_m = line.match(/\s+│\s+\d+\.\s+(input_\S+)\s.*>\s(.+?):\S+\s+\[(active|init)\]/);
        if (sub_m) {
            const target_desc = sub_m[2].trim();
            capture_by_target[target_desc] = (capture_by_target[target_desc] || 0) + 1;
        }
    }

    return capture_by_target;
}

function _fetch_nodes_from_wpctl() {
    const results = [];
    const seen_ids = new Set();

    let status_text;
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null,
            ['wpctl', 'status'],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
        if (!ok) return results;
        status_text = new TextDecoder().decode(stdout);
    } catch (e) {
        return results;
    }

    let in_sinks = false;
    let in_sources = false;

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        if (['Sinks:', '├─ Sinks:', '└─ Sinks:'].includes(stripped)) {
            in_sinks = true;
            in_sources = false;
            continue;
        }
        if (['Sources:', '├─ Sources:', '└─ Sources:'].includes(stripped)) {
            in_sources = true;
            in_sinks = false;
            continue;
        }

        if (!line.startsWith(' │')) {
            in_sinks = false;
            in_sources = false;
            continue;
        }

        const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+(.+?)(?:\s+\[.*\])?$/);
        if (!m) continue;

        const node_id = parseInt(m[1], 10);
        if (seen_ids.has(node_id)) continue;
        seen_ids.add(node_id);

        let description = m[2].trim();
        const media_class = in_sinks ? 'Audio/Sink' : 'Audio/Source';
        let name = description;

        try {
            const [ok2, inspect_stdout] = GLib.spawn_sync(
                null,
                ['wpctl', 'inspect', String(node_id)],
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
            name: name,
            description: description,
            media_class: media_class,
        });
    }

    return results;
}

function _fetch_devices_from_wpctl() {
    const results = [];

    let status_text;
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null,
            ['wpctl', 'status'],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
        if (!ok) return results;
        status_text = new TextDecoder().decode(stdout);
    } catch (e) {
        return results;
    }

    let in_devices = false;

    for (const line of status_text.split('\n')) {
        const stripped = line.trim();
        if (['Devices:', '├─ Devices:', '└─ Devices:'].includes(stripped)) {
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

function _new_empty_properties() {
    try {
        return Wp.Properties.new_empty();
    } catch (e) {
        return null;
    }
}

function _fetch_node_props(obj) {
    try {
        return obj.get_properties();
    } catch (e) {
        return obj.props.properties || _new_empty_properties();
    }
}

const _proxy_properties = _fetch_node_props;

function get_audio_nodes_sync(callback) {
    const raw = _fetch_nodes_from_wpctl();
    if (typeof callback !== 'function') {
        return raw;
    }
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        callback(raw);
        return GLib.SOURCE_REMOVE;
    });
    return null;
}

function _collect_node(props) {
    const name = props.get('node.name') || '';
    if (!name) {
        return null;
    }
    const media_class = props.get('media.class') || '';
    if (!_AUDIO_MEDIA_CLASSES.has(media_class)) {
        return null;
    }
    return {
        name: name,
        description: props.get('node.description') || name,
        media_class: media_class,
    };
}
