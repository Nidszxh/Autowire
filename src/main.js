imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';

let Wp = null;
try {
    imports.gi.versions.Wp = '0.5';
    Wp = imports.gi.Wp;
    Wp.init(Wp.InitFlags.ALL);
} catch (e) {
    print('[Main] Wp typelib not available, running without Wp');
}

const { Adw, Gio, GLib, GObject, Gtk } = imports.gi;

print('[Main] module loaded');

const APP_VERSION = '0.1.0';

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

function main(version) {
    const app = new AutowireApplication(version || APP_VERSION);
    return app.run(['']);
}

main(APP_VERSION);
