imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, Gio, GLib, GObject, Gtk } = imports.gi;
const { is_flatpak } = imports.utils;
const config_mgr = imports.config_mgr;
const C = imports.constants;

print('[Window] module loaded');

const APP_VERSION = C.APP_VERSION;

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
        this._flashing_profiles = new Set();
        this._flash_timers = new Map();
        this._switch_map = new Map();
        this._toggling_guard = false;
        this._daemon_proc = null;
        this._start_grace_timer = 0;
        try {
            const provider = new Gtk.CssProvider();
            provider.load_from_string(
                '.highlight { background-color: alpha(@accent_bg_color, 0.15); transition: background-color 1.5s ease-out; }'
            );
            Gtk.StyleContext.add_provider_for_display(
                this.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        } catch (e) { /* CSS provider may fail in test environments */ }

        this._build_ui();
        this._connect_signals();
        this.refresh_profiles();
        this._ensure_daemon_running();
        this._daemon_poll_id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, C.DAEMON_POLL_INTERVAL_S, () => {
            this._refresh_daemon_status();
            return GLib.SOURCE_CONTINUE;
        });
    }

    vfunc_dispose() {
        if (this._daemon_poll_id > 0) GLib.source_remove(this._daemon_poll_id);
        if (this._start_grace_timer > 0) GLib.source_remove(this._start_grace_timer);
        for (const id of this._flash_timers.values()) {
            GLib.source_remove(id);
        }
        this._flash_timers.clear();
        super.vfunc_dispose();
    }

    _ensure_daemon_running() {
        if (!this._has_active_profiles()) return;
        if (this._daemon_is_alive()) {
            this._refresh_daemon_status();
            return;
        }
        this._spawn_daemon();
        if (this._start_grace_timer > 0) GLib.source_remove(this._start_grace_timer);
        this._start_grace_timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.DAEMON_START_GRACE_MS, () => {
            this._start_grace_timer = 0;
            this._refresh_daemon_status();
            return GLib.SOURCE_REMOVE;
        });
    }

    _has_active_profiles() {
        const profiles = config_mgr.load_profiles();
        return profiles.some(p => p['is_active']);
    }

    _maybe_stop_daemon() {
        if (this._has_active_profiles()) return;
        if (!this._daemon_proc) return;
        try {
            this._daemon_proc.force_exit();
        } catch (_) {}
        this._daemon_proc = null;
        this._daemon_banner.set_revealed(false);
    }

    _build_ui() {
        this.set_default_size(720, 640);
        this.set_title('Autowire');

        this._toast_overlay = new Adw.ToastOverlay();
        this._toolbar_view = new Adw.ToolbarView();
        const toolbar_view = this._toolbar_view;

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

        const menu_button = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Import / Export',
        });
        menu_button.add_css_class('flat');
        const menu_model = new Gio.Menu();
        menu_model.append('Import Profiles…', 'win.import-profiles');
        menu_model.append('Export Profiles…', 'win.export-profiles');
        menu_button.set_menu_model(menu_model);
        header_bar.pack_start(menu_button);

        toolbar_view.add_top_bar(header_bar);

        this._daemon_banner = new Adw.Banner({
            title: 'Routing daemon is not running',
            button_label: 'Start',
        });
        this._daemon_banner.set_button_label('Start Daemon');
        toolbar_view.add_bottom_bar(this._daemon_banner);

        this._main_stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 200,
        });

        const status_page = new Adw.StatusPage({
            icon_name: 'audio-speakers-symbolic',
            title: 'No Audio Profiles',
            description: 'Connect your headset, speaker, or dock first —\nthen add a profile to route audio to it automatically.',
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
        this._toast_overlay.set_child(toolbar_view);
        this.set_content(this._toast_overlay);

        const add_profile_action = new Gio.SimpleAction({ name: 'add-profile' });
        add_profile_action.connect('activate', () => { this._show_add_dialog(); });
        this.add_action(add_profile_action);

        const refresh_action = new Gio.SimpleAction({ name: 'refresh' });
        refresh_action.connect('activate', () => { this.refresh_profiles(); });
        this.add_action(refresh_action);

        const import_action = new Gio.SimpleAction({ name: 'import-profiles' });
        import_action.connect('activate', () => { this._on_import_clicked(); });
        this.add_action(import_action);

        const export_action = new Gio.SimpleAction({ name: 'export-profiles' });
        export_action.connect('activate', () => { this._on_export_clicked(); });
        this.add_action(export_action);

        if (this.get_application()) {
            this.get_application().set_accels_for_action('win.add-profile', ['<Ctrl>N']);
            this.get_application().set_accels_for_action('win.refresh', ['F5']);
            this.get_application().set_accels_for_action('app.quit', ['<Ctrl>Q']);
        }
    }

    _connect_signals() {
        this._add_button.connect('clicked', () => this._on_add_clicked());
        this._empty_add_button.connect('clicked', () => this._on_add_clicked());
        this._about_button.connect('clicked', () => this._on_about_clicked());
        this._daemon_banner.connect('button-clicked', () => this._on_start_daemon_clicked());
    }

    refresh_profiles() {
        this._switch_map.clear();

        const profiles = config_mgr.load_profiles();
        const error = config_mgr.read_error();
        if (error && error['message']) {
            this._show_toast(`Error: ${error['message']}`);
            config_mgr.clear_error();
        }

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
            const displayName = triggerProfiles[0]['trigger_device_display'] || trigger;
            triggerGroup.set_title(`${displayName} (${triggerProfiles.length})`);
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

        const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : (profile['trigger_device_display'] || trigger);
        const row = new Adw.ActionRow({ title: profileName, subtitle: subtitle });

        const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER, active: profile['is_active'] || false });
        this._switch_map.set(trigger + '|' + profileName, sw);
        sw.connect('notify::active', () => this._on_switch_toggled(sw, profile));
        row.add_suffix(sw);

        if (hasSiblings) {
            const upBtn = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: 'Move Up',
                valign: Gtk.Align.CENTER,
            });
            upBtn.add_css_class('flat');
            upBtn.connect('clicked', () => this._on_move_up_clicked(profile));
            row.add_suffix(upBtn);

            const downBtn = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: 'Move Down',
                valign: Gtk.Align.CENTER,
            });
            downBtn.add_css_class('flat');
            downBtn.connect('clicked', () => this._on_move_down_clicked(profile));
            row.add_suffix(downBtn);
        } else {
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

        
        const profileKey = trigger + '|' + profileName;
        if (this._flashing_profiles && this._flashing_profiles.has(profileKey)) {
            row.add_css_class('highlight');
            const timer_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.FLASH_DURATION_MS, () => {
                this._flash_timers.delete(profileKey);
                row.remove_css_class('highlight');
                return GLib.SOURCE_REMOVE;
            });
            this._flash_timers.set(profileKey, timer_id);
            this._flashing_profiles.delete(profileKey);
        }
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
        if (this._toggling_guard) return;
        this._toggling_guard = true;

        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) {
            this._toggling_guard = false;
            return;
        }

        if (sw.get_active()) {
            config_mgr.set_active_profile(trigger, profileName);
            this._show_toast(`Activated: ${profileName}`);
            this._flashing_profiles.add(trigger + '|' + profileName);
            for (const [key, siblingSw] of this._switch_map) {
                if (key.startsWith(trigger + '|') && key !== trigger + '|' + profileName) {
                    siblingSw.set_active(false);
                }
            }
            this._ensure_daemon_running();
        } else {
            config_mgr.set_active_profile(trigger, '');
            this._show_toast(`Deactivated: ${profileName}`);
            this._maybe_stop_daemon();
        }

        this._toggling_guard = false;
    }

    _on_move_up_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) return;
        config_mgr.move_profile_up(trigger, profileName);
        this.refresh_profiles();
    }

    _on_move_down_clicked(profile) {
        const trigger = profile['trigger_device_name'] || '';
        const profileName = profile['profile_name'] || '';
        if (!trigger || !profileName) return;
        config_mgr.move_profile_down(trigger, profileName);
        this.refresh_profiles();
    }

    _show_toast(message) {
        if (this._toast_overlay) {
            const toast = new Adw.Toast({ title: message, timeout: 2 });
            this._toast_overlay.add_toast(toast);
        }
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
                config_mgr.delete_profile(trigger, profileName);
                this._show_toast(`Deleted: ${profileName}`);
                this.refresh_profiles();
                this._maybe_stop_daemon();
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

    _on_import_clicked() {
        const dialog = new Gtk.FileDialog();
        dialog.set_title('Import Profiles');
        dialog.open(this, null, (dlg, result) => {
            try {
                const file = dlg.open_finish(result);
                const path = file.get_path();
                if (!config_mgr.import_profiles(path)) {
                    this._show_toast('Import failed: invalid file');
                    return;
                }
                this.refresh_profiles();
                this._show_toast('Profiles imported');
            } catch (e) {
                if (e.code !== Gtk.DialogError.DISMISSED) {
                    this._show_toast('Import failed');
                }
            }
        });
    }

    _on_export_clicked() {
        const dialog = new Gtk.FileDialog();
        dialog.set_title('Export Profiles');
        dialog.set_initial_name('autowire-profiles.json');
        dialog.save(this, null, (dlg, result) => {
            try {
                const file = dlg.save_finish(result);
                const path = file.get_path();
                if (config_mgr.export_profiles(path)) {
                    this._show_toast('Profiles exported');
                } else {
                    this._show_toast('Export failed');
                }
            } catch (e) {
                if (e.code !== Gtk.DialogError.DISMISSED) {
                    this._show_toast('Export failed');
                }
            }
        });
    }

    _daemon_heartbeat_path() {
        return GLib.build_filenamev([config_mgr.CONFIG_DIR, 'daemon.heartbeat']);
    }

    _daemon_is_alive() {
        const path = this._daemon_heartbeat_path();
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return false;
            const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            const mtime = info.get_modification_date_time().to_unix();
            return (Math.floor(Date.now() / 1000) - mtime) <= C.HEARTBEAT_ALIVE_THRESHOLD_S;
        } catch (e) {
            return false;
        }
    }

    _refresh_daemon_status() {
        if (!this._has_active_profiles()) {
            this._daemon_banner.set_revealed(false);
            return;
        }
        const alive = this._daemon_is_alive();
        this._daemon_banner.set_revealed(!alive);
        if (!alive) {
            this._ensure_daemon_running();
        }
    }

    _spawn_daemon() {
        // Kill stale subprocess handle before spawning a new daemon.
        if (this._daemon_proc) {
            if (this._daemon_is_alive()) return this._daemon_proc;
            try {
                this._daemon_proc.force_exit();
            } catch (_) { /* ignore */ }
            this._daemon_proc = null;
        }

        let argv;
        if (is_flatpak) {
            argv = ['flatpak-spawn', '--host', 'flatpak', 'run', '--command=autowire-daemon', '--branch=stable', 'io.github.nidszxh.Autowire'];
        } else {
            const exe = 'gjs';
            const exe_path = GLib.find_program_in_path(exe);
            if (!exe_path) {
                this._show_toast('gjs not found in PATH');
                return null;
            }
            let main_js = '';
            try {
                main_js = imports.system.programInvocationName || '';
            } catch (e) {
                main_js = '';
            }
            let daemon_main = 'daemon_main.js';
            if (main_js) {
                const dir = GLib.path_get_dirname(main_js);
                daemon_main = GLib.build_filenamev([dir, 'daemon_main.js']);
            }
            argv = [exe_path, '-I', GLib.path_get_dirname(daemon_main), daemon_main];
        }

        try {
            // Inherit stdio to avoid pipe buffer blocking the daemon's print().
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            this._daemon_proc = proc;

            // Immediate death detection via wait_async (vs. heartbeat's 15s delay).
            proc.wait_async(null, () => {
                if (!this._daemon_proc) return;
                try {
                    const exited = proc.get_exit_status();
                    print(`[Window] Daemon exited with status ${exited}`);
                } catch (_) { /* already reaped */ }
                if (this._daemon_is_alive()) return;
                this._daemon_proc = null;
                this._ensure_daemon_running();
            });

            return proc;
        } catch (e) {
            this._show_toast(`Failed to start daemon: ${e.message || e}`);
            return null;
        }
    }

    _on_start_daemon_clicked() {
        if (this._daemon_is_alive()) {
            this._show_toast('Daemon is already running');
            this._refresh_daemon_status();
            return;
        }
        const proc = this._spawn_daemon();
        if (proc) {
            this._show_toast('Daemon starting…');
            if (this._start_grace_timer > 0) GLib.source_remove(this._start_grace_timer);
            this._start_grace_timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.DAEMON_START_GRACE_MS, () => {
                this._start_grace_timer = 0;
                this._refresh_daemon_status();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
});
