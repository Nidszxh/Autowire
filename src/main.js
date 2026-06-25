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

const { Adw, Gio, GLib, GLibUnix, GObject, Gtk } = imports.gi;

const SIGTERM = 15;
const SIGINT = 2;

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

    GLibUnix.signal_add(GLib.PRIORITY_HIGH, SIGINT, () => {
        print('[Main] Received SIGINT, quitting…');
        app.quit();
        return GLib.SOURCE_REMOVE;
    });

    GLibUnix.signal_add(GLib.PRIORITY_HIGH, SIGTERM, () => {
        print('[Main] Received SIGTERM, quitting…');
        app.quit();
        return GLib.SOURCE_REMOVE;
    });

    return app.run([GLib.get_prgname() || 'autowire']);
}

main();
