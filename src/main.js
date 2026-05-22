const { Adw, Gio, GLib, GObject, Gtk } = imports.gi;

print('[Main] module loaded');

const APP_VERSION = '0.1.0';

const AutowireApplicationClass = GObject.registerClass(class AutowireApplication extends Adw.Application {
    constructor() {
        super({
            application_id: 'io.github.nidszxh.Autowire',
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
    }

    vfunc_activate() {
        let win = this.get_active_window();
        if (!win) {
            win = new AutowireWindowClass({ application: this });
        }
        win.present();
    }
});

function _group_by_trigger(profiles) {
    const groups = {};
    for (const p of profiles) {
        const trigger = p['trigger_device_name'] || '';
        if (!groups[trigger]) groups[trigger] = [];
        groups[trigger].push(p);
    }
    return groups;
}

const AutowireWindowClass = GObject.registerClass(class AutowireWindow extends Adw.ApplicationWindow {
    constructor(kwargs) {
        super(kwargs);
        this.set_title('Autowire');
        this.set_default_size(500, 700);
        this._setup_ui();
        this._profiles_group = null;
        this._connect_signals();
        this.refresh_profiles();
    }

    _setup_ui() {
        const toolbar_view = new Adw.ToolbarView();
        toolbar_view.set_size_request(500, 700);

        const header_bar = new Adw.HeaderBar();
        header_bar.set_title_widget(new Gtk.Label({ label: 'Autowire' }));

        this._add_button = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add Profile',
        });
        this._add_button.add_css_class('suggested-action');
        header_bar.pack_end(this._add_button);

        this._about_button = new Gtk.Button({ icon_name: 'help-about-symbolic' });
        this._about_button.set_tooltip_text('About');
        this._about_button.add_css_class('flat');
        header_bar.pack_end(this._about_button);

        toolbar_view.add_top_bar(header_bar);

        this._main_stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 200 });

        const empty_page = new Adw.StatusPage({
            icon_name: 'audio-speakers-symbolic',
            title: 'No Audio Profiles',
            description: 'Add a profile to automatically route\naudio when a device connects.',
        });

        this._empty_add_button = new Gtk.Button({ label: 'Add Profile' });
        this._empty_add_button.add_css_class('suggested-action');
        this._empty_add_button.add_css_class('pill');
        this._empty_add_button.set_halign(Gtk.Align.CENTER);
        empty_page.set_child(this._empty_add_button);

        this._main_stack.add_named(empty_page, 'empty');

        toolbar_view.set_content(this._main_stack);

        this.set_content(toolbar_view);
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
        this._profiles_group = new Adw.PreferencesGroup();
        this._profiles_page.add(this._profiles_group);

        const groups = _group_by_trigger(profiles);
        for (const [trigger, triggerProfiles] of Object.entries(groups)) {
            const triggerGroup = new Adw.PreferencesGroup();
            triggerGroup.set_title(`${trigger} (${triggerProfiles.length})`);
            for (const profile of triggerProfiles) {
                triggerGroup.add(this._build_profile_row(profile, triggerProfiles.length > 1));
            }
            this._profiles_group.add(triggerGroup);
        }
    }

    _build_profile_row(profile, hasSiblings) {
        const profileName = profile['profile_name'] || 'Untitled';
        const trigger = profile['trigger_device_name'] || '';
        const actions = profile['actions'] || {};
        const subtitleParts = [];
        if (actions['default_sink']) subtitleParts.push(`Out: ${actions['default_sink'].split('.').pop()}`);
        if (actions['default_source']) subtitleParts.push(`In: ${actions['default_source'].split('.').pop()}`);
        if (actions['bt_profile']) subtitleParts.push(`BT: ${actions['bt_profile']}`);
        const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : trigger;

        const row = new Adw.ActionRow({ title: profileName, subtitle });

        if (profile['is_active']) {
            const check = new Gtk.Image({ icon_name: 'emblem-ok-symbolic' });
            check.add_css_class('accent-color');
            row.add_suffix(check);
        }

        if (hasSiblings) {
            const activeIcon = profile['is_active'] ? 'emblem-ok-symbolic' : 'pan-down-symbolic';
            const toggleBtn = new Gtk.Button({ icon_name: activeIcon, valign: Gtk.Align.CENTER });
            toggleBtn.set_tooltip_text('Set as Active');
            toggleBtn.add_css_class('flat');
            toggleBtn.connect('clicked', () => this._on_toggle_active_clicked(profile));
            row.add_suffix(toggleBtn);
        } else {
            const editBtn = new Gtk.Button({ icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER });
            editBtn.set_tooltip_text('Edit Profile');
            editBtn.add_css_class('flat');
            editBtn.connect('clicked', () => this._on_edit_clicked(profile));
            row.add_suffix(editBtn);
            row.set_activatable_widget(editBtn);
        }

        const delBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        delBtn.set_tooltip_text('Delete Profile');
        delBtn.add_css_class('flat');
        delBtn.add_css_class('destructive-action');
        delBtn.connect('clicked', () => this._on_delete_clicked(profile));
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
        if (!trigger || !profileName) return;

        const alert = new Adw.AlertDialog(`Delete Profile "${profileName}"?`, `"${profileName}" will be permanently removed.`);
        alert.add_response('cancel', 'Cancel');
        alert.add_response('delete', 'Delete');
        alert.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.set_default_response('cancel');
        alert.set_close_response('cancel');
        alert.connect('response', (d, response) => {
            if (response === 'delete') {
                imports.config_mgr.delete_profile(trigger, profileName);
                this.refresh_profiles();
            }
        });
        alert.present(this);
    }

    _on_toggle_active_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) return;
        imports.config_mgr.set_active_profile(trigger, profileName);
        this.refresh_profiles();
    }

    _on_about_clicked() {
        const about = new Adw.AboutDialog();
        about.set_application_name('Autowire');
        about.set_application_icon('io.github.nidszxh.Autowire');
        about.set_developer_name('nidszxh');
        about.set_version(APP_VERSION);
        about.set_comments('Automated audio profile manager for GNOME.\nAutomatically switches audio routing when devices connect.');
        about.set_website('https://github.com/nidszxh/autowire');
        about.set_support_url('https://github.com/nidszxh/autowire/issues');
        about.set_license_type(3);
        about.present(this);
    }
});

function main() {
    const app = new AutowireApplicationClass();
    return app.run(['']);
}

if (typeof ARGV !== 'undefined') {
    main();
}