imports.gi.versions.Wp = '0.5';
const { GLib, Gio, Wp } = imports.gi;
const GLibUnix = imports.gi.GLibUnix;

const SIGTERM = 15;
const SIGINT = 2;

Wp.init(Wp.InitFlags.ALL);

print('[Daemon] module loaded');

let _loop = null;

function _watch_config_file(monitor) {
    const config_mgr = imports.config_mgr;
    let mon;
    try {
        mon = Gio.File.new_for_path(config_mgr.CONFIG_FILE).monitor(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        print(`[Daemon] WARNING: could not create config file monitor: ${e}`);
        return;
    }

    mon.connect('changed', (_mon, _file, _other, event) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED) {
            print('[Daemon] profiles.json changed, re-applying routing…');
            const daemon = imports.daemon;
            for (const node of monitor.get_audio_nodes()) {
                daemon.check_and_route_device(node['name'] || '', monitor);
            }
        }
    });
    mon.set_rate_limit(2000);
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

    const daemon = imports.daemon;
    const monitor = daemon.build_monitor();

    monitor.connect('ready', () => {
        print('[Daemon] Routing already-connected devices…');
        for (const node of monitor.get_audio_nodes()) {
            daemon.check_and_route_device(node['name'] || '', monitor);
        }
    });

    try {
        monitor.start();
    } catch (e) {
        print(`[Daemon] Failed to connect to WirePlumber: ${e}`);
        return 1;
    }

    _watch_config_file(monitor);

    print('[Daemon] Listening for device events…');

    try {
        _loop.run();
    } finally {
        monitor.stop();
        print('[Daemon] Stopped.');
    }

    return 0;
}

imports.system.exit(main());