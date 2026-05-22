const { Adw, Gio, GLib, Gtk, GObject } = imports.gi;

print('[Window] module loaded');

const RESOURCE_PATH = '/io/github/nidszxh/Autowire/window.ui';
const APP_VERSION = '0.1.0';

function _group_by_trigger(profiles) {
    const groups = {};
    for (const p of profiles) {
        const trigger = p['trigger_device_name'] || '';
        if (!groups[trigger]) {
            groups[trigger] = [];
        }
        groups[trigger].push(p);
    }
    return groups;
}

var AutowireWindow = GObject.registerClass({
    Template: RESOURCE_PATH,
    InternalChildren: ['add_button', 'about_button', 'main_stack', 'profiles_page', 'empty_add_button'],
}, class AutowireWindow extends Adw.ApplicationWindow {
    constructor(kwargs) {
        super(kwargs);
        this._profiles_group = null;
        this._connect_signals();
        this.refresh_profiles();
    }

    _connect_signals() {
        this._add_button.connect('clicked', () => this._on_add_clicked());
        this._empty_add_button.connect('clicked', () => this._on_add_clicked());
        this._about_button.connect('clicked', () => this._on_about_clicked());
    }

    refresh_profiles() {
        const config_mgr = imports.config_mgr;
        const profiles = config_mgr.load_profiles();

        if (this._profiles_group) {
            this._profiles_page.remove(this._profiles_group);
            this._profiles_group = null;
        }

        if (profiles.length === 0) {
            this._main_stack.set_visible_child_name('empty');
            return;
        }

        this._main_stack.set_visible_child_name('profiles');

        const group = Adw.PreferencesGroup.new();
        const groups = _group_by_trigger(profiles);

        for (const [trigger, triggerProfiles] of Object.entries(groups)) {
            const triggerGroup = Adw.PreferencesGroup.new();
            triggerGroup.set_title(`${trigger} (${triggerProfiles.length})`);
            for (const profile of triggerProfiles) {
                triggerGroup.add(this._build_profile_row(profile, triggerProfiles.length > 1));
            }
            group.add(triggerGroup);
        }

        this._profiles_page.add(group);
        this._profiles_group = group;
    }

    _build_profile_row(profile, hasSiblings) {
        const profileName = profile['profile_name'] || 'Untitled';
        const trigger = profile['trigger_device_name'] || '';
        const actions = profile['actions'] || {};
        const subtitleParts = [];

        if (actions['default_sink']) {
            subtitleParts.push(`Out: ${actions['default_sink'].split('.').pop()}`);
        }
        if (actions['default_source']) {
            subtitleParts.push(`In: ${actions['default_source'].split('.').pop()}`);
        }
        if (actions['bt_profile']) {
            subtitleParts.push(`BT: ${actions['bt_profile']}`);
        }

        const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : trigger;
        const row = Adw.ActionRow.new();
        row.set_title(profileName);
        row.set_subtitle(subtitle);

        if (profile['is_active']) {
            const check = Gtk.Image.new_from_icon_name('emblem-ok-symbolic');
            check.add_css_class('accent-color');
            row.add_suffix(check);
        }

        if (hasSiblings) {
            const activeIcon = profile['is_active'] ? 'emblem-ok-symbolic' : 'pan-down-symbolic';
            const toggleBtn = Gtk.Button.new_from_icon_name(activeIcon);
            toggleBtn.set_tooltip_text('Set as Active');
            toggleBtn.set_valign(Gtk.Align.CENTER);
            toggleBtn.add_css_class('flat');
            const self = this;
            toggleBtn.connect('clicked', () => self._on_toggle_active_clicked(profile));
            row.add_suffix(toggleBtn);
        } else {
            const editBtn = Gtk.Button.new_from_icon_name('document-edit-symbolic');
            editBtn.set_tooltip_text('Edit Profile');
            editBtn.set_valign(Gtk.Align.CENTER);
            editBtn.add_css_class('flat');
            const self = this;
            editBtn.connect('clicked', () => self._on_edit_clicked(profile));
            row.add_suffix(editBtn);
            row.set_activatable_widget(editBtn);
        }

        const delBtn = Gtk.Button.new_from_icon_name('user-trash-symbolic');
        delBtn.set_tooltip_text('Delete Profile');
        delBtn.set_valign(Gtk.Align.CENTER);
        delBtn.add_css_class('flat');
        delBtn.add_css_class('destructive-action');
        const self = this;
        delBtn.connect('clicked', () => self._on_delete_clicked(profile));
        row.add_suffix(delBtn);

        return row;
    }

    _on_add_clicked() {
        const ProfileDialog = imports.profile_dialog.ProfileDialog;
        const dialog = new ProfileDialog();
        dialog.connect('profile-saved', () => this.refresh_profiles());
        dialog.present(this);
    }

    _on_edit_clicked(profile) {
        const ProfileDialog = imports.profile_dialog.ProfileDialog;
        const dialog = new ProfileDialog({ profile });
        dialog.connect('profile-saved', () => this.refresh_profiles());
        dialog.present(this);
    }

    _on_delete_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) {
            return;
        }

        const alert = Adw.AlertDialog.new(
            `Delete Profile "${profileName}"?`,
            `"${profileName}" will be permanently removed.`
        );
        alert.add_response('cancel', 'Cancel');
        alert.add_response('delete', 'Delete');
        alert.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.set_default_response('cancel');
        alert.set_close_response('cancel');

        const self = this;
        alert.connect('response', (dialog, response) => {
            if (response === 'delete') {
                const config_mgr = imports.config_mgr;
                config_mgr.delete_profile(trigger, profileName);
                self.refresh_profiles();
            }
        });
        alert.present(this);
    }

    _on_toggle_active_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) {
            return;
        }
        const config_mgr = imports.config_mgr;
        config_mgr.set_active_profile(trigger, profileName);
        this.refresh_profiles();
    }

    _on_about_clicked() {
        const about = Adw.AboutDialog.new();
        about.set_application_name('Autowire');
        about.set_application_icon('io.github.nidszxh.Autowire');
        about.set_developer_name('nidszxh');
        about.set_version(APP_VERSION);
        about.set_comments('Automated audio profile manager for GNOME.\nAutomatically switches audio routing when devices connect.');
        about.set_website('https://github.com/nidszxh/autowire');
        about.set_support_url('https://github.com/nidszxh/autowire/issues');
        about.set_license_type(Adw.License.GPL_3_0);
        about.present(this);
    }
});

var AutowireApplication = GObject.registerClass(class AutowireApplication extends Adw.Application {
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
            win = new AutowireWindow({ application: this });
        }
        win.present();
    }
});

function main(version, pkgdatadir) {
    _load_resources(pkgdatadir || '');
    const app = new AutowireApplication(version);
    return app.run(['']);
}

function _load_resources(pkgdatadir) {
    const candidates = [
        pkgdatadir ? GLib.build_filenamev([pkgdatadir, 'autowire.gresource']) : null,
        GLib.build_filenamev([GLib.get_user_data_dir(), '..', 'autowire.gresource']),
    ].filter(Boolean);

    for (const path of candidates) {
        try {
            const resource = Gio.Resource.load(path);
            resource._register();
            print(`[App] GResource loaded from: ${path}`);
            return;
        } catch (e) {
            print(`[App] Failed to load GResource at ${path}: ${e}`);
        }
    }
    print('[App] WARNING: autowire.gresource not found. Run `ninja -C _build` first.');
}