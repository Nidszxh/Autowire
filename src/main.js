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
const C = imports.constants;

print('[Main] module loaded');

const AutowireApplication = GObject.registerClass(class AutowireApplication extends Adw.Application {
    constructor() {
        super({
            application_id: 'io.github.nidszxh.Autowire',
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
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

function main() {
    const app = new AutowireApplication();
    return app.run([GLib.get_prgname() || 'autowire']);
}

main();
