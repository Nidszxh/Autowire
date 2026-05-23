imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, GObject, Gtk } = imports.gi;

print('[Window] module loaded');

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

var AutowireWindow = GObject.registerClass(class AutowireWindow extends Adw.ApplicationWindow {
    constructor(kwargs) {
        super(kwargs);
        this._profiles_group = null;
        this._build_ui();
        this._connect_signals();
        this.refresh_profiles();
    }

    _build_ui() {
        this.set_default_size(480, 660);
        this.set_title('Autowire');

        const toolbar_view = new Adw.ToolbarView();

        const header_bar = new Adw.HeaderBar();

        this._add_button = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add Profile',
        });
        this._add_button.add_css_class('suggested-action');
        header_bar.pack_end(this._add_button);

        this._about_button = new Gtk.Button({
            icon_name: 'help-about-symbolic',
            tooltip_text: 'About',
        });
        this._about_button.add_css_class('flat');
        header_bar.pack_start(this._about_button);

        toolbar_view.add_top_bar(header_bar);

        this._main_stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 200,
        });

        const status_page = new Adw.StatusPage({
            icon_name: 'audio-speakers-symbolic',
            title: 'No Audio Profiles',
            description: 'Add a profile to automatically route\naudio when a device connects.',
        });

        this._empty_add_button = new Gtk.Button({
            label: 'Add Profile',
            halign: Gtk.Align.CENTER,
        });
        this._empty_add_button.add_css_class('suggested-action');
        this._empty_add_button.add_css_class('pill');
        status_page.set_child(this._empty_add_button);

        this._main_stack.add_named(status_page, 'empty');

        this._profiles_page = new Adw.PreferencesPage();
        this._profiles_page.set_vexpand(true);

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        scrolled.set_child(this._profiles_page);

        this._main_stack.add_named(scrolled, 'profiles');

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

        const group = new Adw.PreferencesGroup();
        const groups = _group_by_trigger(profiles);

        for (const [trigger, triggerProfiles] of Object.entries(groups)) {
            const triggerGroup = new Adw.PreferencesGroup();
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
        const row = new Adw.ActionRow({ title: profileName, subtitle: subtitle });

        const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: profile['is_active'] || false });
        sw.connect('notify::active', () => this._on_switch_toggled(sw, profile));
        row.add_suffix(sw);

        if (!hasSiblings) {
            const editBtn = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                tooltip_text: 'Edit Profile',
                valign: Gtk.Align.CENTER,
            });
            editBtn.add_css_class('flat');
            editBtn.connect('clicked', () => this._on_edit_clicked(profile));
            row.add_suffix(editBtn);
            row.set_activatable_widget(editBtn);
        }

        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete Profile',
            valign: Gtk.Align.CENTER,
        });
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

    _on_switch_toggled(sw, profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) {
            return;
        }
        if (sw.get_active()) {
            imports.config_mgr.set_active_profile(trigger, profileName);
        } else {
            imports.config_mgr.set_active_profile(trigger, '');
        }
        this.refresh_profiles();
    }

    _on_delete_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) {
            return;
        }

        const alert = new Adw.AlertDialog({
            heading: 'Delete Profile?',
            body: `"${profileName}" will be permanently removed.`,
        });
        alert.add_response('cancel', 'Cancel');
        alert.add_response('delete', 'Delete');
        alert.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.set_default_response('cancel');
        alert.set_close_response('cancel');

        alert.connect('response', (dialog, response) => {
            if (response === 'delete') {
                imports.config_mgr.delete_profile(trigger, profileName);
                this.refresh_profiles();
            }
        });
        alert.present(this);
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
        about.set_license_type(Gtk.License.GPL_3_0);
        about.present(this);
    }
});
