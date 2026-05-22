const { GLib, Gio } = imports.gi;

print('[Daemon] module loaded');

let _loop = null;

function _watch_config_file() {
    const config_mgr = imports.config_mgr;
    let mon;
    try {
        mon = Gio.FileMonitor.new_for_path(config_mgr.CONFIG_FILE);
    } catch (e) {
        print(`[Daemon] WARNING: could not create config file monitor: ${e}`);
        return;
    }

    mon.connect('changed', (mon, file, other, event) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED) {
            print('[Daemon] profiles.json changed, re-applying routing…');
            const wp_monitor = imports.wp_monitor;
            const daemon = imports.daemon;
            const mon2 = daemon.build_monitor();
            try {
                mon2.start();
            } catch (e) {
                print(`[Daemon] Failed to start temp monitor: ${e}`);
                return;
            }
            const nodes = mon2.get_audio_nodes();
            for (const node of nodes) {
                daemon.check_and_route_device(node['name'] || '', mon2);
            }
            mon2.stop();
        }
    });
    mon.set_rate_limit(2000);
    print('[Daemon] Config file watcher installed.');
}

function main() {
    print('[Daemon] Autowire audio routing daemon starting…');

    _loop = GLib.MainLoop.new(null, false);

    GLib.unix_signal_add(GLib.PRIORITY_HIGH, GLib.UnixSignalInfo.SIGTERM, () => {
        print('[Daemon] Received SIGTERM, shutting down…');
        _loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    GLib.unix_signal_add(GLib.PRIORITY_HIGH, GLib.UnixSignalInfo.SIGINT, () => {
        print('[Daemon] Received SIGINT, shutting down…');
        _loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    const daemon = imports.daemon;
    const monitor = daemon.build_monitor();
    try {
        monitor.start();
    } catch (e) {
        print(`[Daemon] Failed to connect to WirePlumber: ${e}`);
        return 1;
    }

    _watch_config_file();

    print('[Daemon] Connected to PipeWire. Routing already-connected devices…');
    const nodes = monitor.get_audio_nodes();
    for (const node of nodes) {
        daemon.check_and_route_device(node['name'] || '', monitor);
    }

    print('[Daemon] Listening for device events…');

    try {
        _loop.run();
    } finally {
        monitor.stop();
        print('[Daemon] Stopped.');
    }

    return 0;
}