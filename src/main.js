imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
imports.gi.versions.Wp = '0.5';
const { Adw, Gio, GLib, GObject, Gtk, Wp } = imports.gi;

Wp.init(Wp.InitFlags.ALL);

print('[Main] module loaded');

const APP_VERSION = '0.1.0';
const _scriptDir = (() => {
    try {
        for (const line of Error().stack.split('\n')) {
            const m = line.match(/(?:@|\()(.+?\.js):\d+:\d+/);
            if (m && !m[1].includes('_bootstrap') && !m[1].includes('resource://') && !m[1].includes('<command>')) {
                return GLib.path_get_dirname(m[1]);
            }
        }
    } catch (e) {}
    return GLib.get_current_dir();
})();

const AutowireApplication = GObject.registerClass(class AutowireApplication extends Adw.Application {
    constructor(version) {
        super({
            application_id: 'io.github.nidszxh.Autowire',
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        this._version = version;
    }

    vfunc_activate() {
        let win = this.get_active_window();
        if (!win) {
            const AutowireWindow = imports.window.AutowireWindow;
            win = new AutowireWindow({ application: this });
        }
        win.present();
    }
});

function _load_resources(pkgdatadir) {
    const candidates = [
        pkgdatadir ? GLib.build_filenamev([pkgdatadir, 'autowire.gresource']) : null,
        GLib.build_filenamev([_scriptDir, '..', '_build', 'data', 'autowire.gresource']),
        GLib.build_filenamev([_scriptDir, 'autowire.gresource']),
    ].filter(Boolean);

    for (const path of candidates) {
        try {
            const resource = Gio.Resource.load(path);
            Gio.resources_register(resource);
            print(`[App] GResource loaded from: ${path}`);
            return;
        } catch (e) {
            print(`[App] Failed to load GResource at ${path}: ${e}`);
        }
    }
    print('[App] WARNING: autowire.gresource not found. Run `ninja -C _build` first.');
}

function main(version, pkgdatadir) {
    _load_resources(pkgdatadir || '');
    const app = new AutowireApplication(version || APP_VERSION);
    return app.run(['']);
}

main(APP_VERSION);
