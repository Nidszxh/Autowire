// SPDX-License-Identifier: GPL-3.0-or-later

const { GLib, Gio } = imports.gi;
const GLibUnix = imports.gi.GLibUnix;
const config_mgr = imports.config_mgr;
const { DaemonEngine } = imports.daemon;
const C = imports.constants;
const log = imports.log;

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
    const path = GLib.build_filenamev([config_mgr.CONFIG_DIR, 'daemon.heartbeat']);
    const ts = String(Date.now());
    try {
        GLib.file_set_contents(path, new TextEncoder().encode(ts));
    } catch (e) {
        /* ignore */
    }
}

function _watch_config_file(engine, monitor) {
    try {
        _config_monitor = Gio.File.new_for_path(config_mgr.CONFIG_FILE).monitor(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        log.warn('daemon', `could not create config file monitor: ${e}`);
        return;
    }

    let _config_change_timer = 0;
    _config_monitor.connect('changed', (_mon, _file, _other, event) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED || event === Gio.FileMonitorEvent.ATTRIBUTE_CHANGED) {
            if (_config_change_timer > 0) GLib.source_remove(_config_change_timer);
            _config_change_timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.CONFIG_CHANGE_DEBOUNCE_MS, () => {
                _config_change_timer = 0;
                print('[Daemon] profiles.json changed, re-applying routing…');
                for (const node of monitor.get_audio_nodes()) {
                    engine.check_and_route_device(node['name'] || '', monitor, true);
                }
                for (const node_name of monitor.get_capture_nodes()) {
                    engine.handle_capture_started(node_name, monitor);
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    });
    _config_monitor.set_rate_limit(500);
    print('[Daemon] Config file watcher installed.');
}

function main() {
    print('[Daemon] Autowire audio routing daemon starting…');

    config_mgr.initialize_config();
    log.setLogFile(GLib.build_filenamev([config_mgr.CONFIG_DIR, 'daemon.log']));

    const engine = new DaemonEngine();

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

    const monitor = engine.build_monitor();

    // Wire capture signals outside ready handler to prevent duplicate chains on reconnect.
    monitor.connect('capture-started', (mon, node_name) => {
        engine.handle_capture_started(node_name, mon);
    });
    monitor.connect('capture-stopped', (mon, node_name) => {
        engine.handle_capture_stopped(node_name, mon);
    });

    let _first_ready = true;

    monitor.connect('ready', () => {
        if (_first_ready) {
            _first_ready = false;
            print('[Daemon] Capture signal handlers installed.');
        } else {
            // Clear stale state from previous session on Wp.Core reconnect.
            print('[Daemon] Wp.Core reconnected. Clearing engine routing state…');
            engine.clear_state();
        }

        print('[Daemon] Routing already-connected devices…');
        for (const node of monitor.get_audio_nodes()) {
            engine.check_and_route_device(node['name'] || '', monitor, true);
        }
        print('[Daemon] Activating already-paired Bluetooth cards…');
        for (const dev of monitor.get_devices()) {
            if ((dev['pw_name'] || '').startsWith('bluez_card.')) {
                engine.activate_bt_card(dev['global_id'], dev['pw_name'], monitor);
            }
        }
        print('[Daemon] Checking for active captures…');
        for (const node_name of monitor.get_capture_nodes()) {
            engine.handle_capture_started(node_name, monitor);
        }
    });

    try {
        monitor.start();
    } catch (e) {
        log.error('daemon', `Failed to connect to WirePlumber: ${e}`);
        return 1;
    }

    _watch_config_file(engine, monitor);

    _write_heartbeat();
    _heartbeat_id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, C.HEARTBEAT_INTERVAL_S, () => {
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