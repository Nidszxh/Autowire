const { GLib, Gio } = imports.gi;
const GLibUnix = imports.gi.GLibUnix;
const config_mgr = imports.config_mgr;
const daemon = imports.daemon;

const SIGTERM = 15;
const SIGINT = 2;

try {
    imports.gi.versions.Wp = '0.5';
    const Wp = imports.gi.Wp;
    Wp.init(Wp.InitFlags.ALL);
} catch (e) {
    print('[Daemon] Wp typelib not available, running without Wp.Core');
}

print('[Daemon] module loaded');

let _loop = null;
let _config_monitor = null;
let _heartbeat_id = 0;

function _write_heartbeat() {
    try {
        const path = GLib.build_filenamev([config_mgr.CONFIG_DIR, 'daemon.heartbeat']);
        const ts = String(Date.now());
        GLib.file_set_contents(path, new TextEncoder().encode(ts));
    } catch (e) {
    }
}

function _watch_config_file(monitor) {
    try {
        _config_monitor = Gio.File.new_for_path(config_mgr.CONFIG_FILE).monitor(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        print(`[Daemon] WARNING: could not create config file monitor: ${e}`);
        return;
    }

    _config_monitor.connect('changed', (_mon, _file, _other, event) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED || event === Gio.FileMonitorEvent.ATTRIBUTE_CHANGED) {
            print('[Daemon] profiles.json changed, re-applying routing…');
            for (const node of monitor.get_audio_nodes()) {
                daemon.check_and_route_device(node['name'] || '', monitor, true);
            }
            for (const node_name of monitor.get_capture_nodes()) {
                daemon.handle_capture_started(node_name, monitor);
            }
        }
    });
    _config_monitor.set_rate_limit(500);
    print('[Daemon] Config file watcher installed.');
}

function main() {
    print('[Daemon] Autowire audio routing daemon starting…');

    _loop = GLib.MainLoop.new(null, false);

    GLibUnix.signal_add(GLib.PRIORITY_HIGH, SIGTERM, () => {
        print('[Daemon] Received SIGTERM, shutting down…');
        _loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    GLibUnix.signal_add(GLib.PRIORITY_HIGH, SIGINT, () => {
        print('[Daemon] Received SIGINT, shutting down…');
        _loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    const monitor = daemon.build_monitor();

    monitor.connect('ready', () => {
        print('[Daemon] Routing already-connected devices…');
        for (const node of monitor.get_audio_nodes()) {
            daemon.check_and_route_device(node['name'] || '', monitor);
        }
        print('[Daemon] Checking for active captures…');
        for (const node_name of monitor.get_capture_nodes()) {
            daemon.handle_capture_started(node_name, monitor);
        }
    });

    try {
        monitor.start();
    } catch (e) {
        print(`[Daemon] Failed to connect to WirePlumber: ${e}`);
        return 1;
    }

    _watch_config_file(monitor);

    _write_heartbeat();
    _heartbeat_id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
        _write_heartbeat();
        return GLib.SOURCE_CONTINUE;
    });

    print('[Daemon] Listening for device events…');

    try {
        _loop.run();
    } finally {
        if (_heartbeat_id > 0) GLib.source_remove(_heartbeat_id);
        monitor.stop();
        print('[Daemon] Stopped.');
    }

    return 0;
}

imports.system.exit(main());