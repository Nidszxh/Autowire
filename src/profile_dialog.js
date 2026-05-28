imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, GObject, GLib, Gio, Gtk } = imports.gi;

const _is_flatpak = imports.gi.GLib.file_test('/.flatpak-info', imports.gi.GLib.FileTest.EXISTS);
function _get_wpctl_cmd() {
    return _is_flatpak ? ['flatpak-spawn', '--host', 'wpctl'] : ['wpctl'];
}

const config_mgr = imports.config_mgr;
const wp_monitor = imports.wp_monitor;

print('[ProfileDialog] module loaded');

const _INVALID = Gtk.INVALID_LIST_POSITION;

const BT_PROFILES = [
    ['', "Don't change"],
    ['a2dp-sink-aac', 'AAC (high quality)'],
    ['a2dp-sink-ldac', 'LDAC (high quality)'],
    ['a2dp-sink-aptx', 'aptX (high quality)'],
    ['a2dp-sink-aptx_hd', 'aptX HD (high quality)'],
    ['a2dp-sink-sbc_xq', 'SBC-XQ (high quality)'],
    ['a2dp-sink-sbc', 'SBC (standard)'],
    ['handsfree-headset', 'HSP/HFP (call / mSBC)'],
];

var ProfileDialog = GObject.registerClass({
    Signals: {
        'profile-saved': {},
    },
}, class AutowireProfileDialog extends Adw.Dialog {
    constructor(kwargs) {
        const profile = kwargs?.profile || null;
        delete kwargs?.profile;
        super(kwargs);

        this.set_title(profile ? 'Edit Profile' : 'Add Profile');
        this._profile = profile;
        this._all_nodes = [];
        this._sink_nodes = [];
        this._source_nodes = [];

        this._setup_ui();
        this._connect_signals();
        this._load_devices_async();
    }

    _get_display_name(node) {
        return node['description'] || node['name'] || '';
    }

    _setup_ui() {
        const content = new Adw.ToolbarView();
        content.set_size_request(460, 540);

        const header_bar = new Adw.HeaderBar({
            title_widget: new Gtk.Label({ label: this._profile ? 'Edit Profile' : 'Add Profile' }),
        });

        this._cancel_button = new Gtk.Button({ label: 'Cancel' });
        this._cancel_button.add_css_class('flat');
        header_bar.pack_start(this._cancel_button);

        this._apply_button = new Gtk.Button({ label: 'Apply Now', tooltip_text: 'Save and apply immediately', valign: Gtk.Align.CENTER });
        this._apply_button.set_sensitive(false);
        this._apply_button.add_css_class('flat');
        header_bar.pack_end(this._apply_button);

        this._save_button = new Gtk.Button({ label: 'Save', valign: Gtk.Align.CENTER });
        this._save_button.add_css_class('suggested-action');
        header_bar.pack_end(this._save_button);

        content.add_top_bar(header_bar);

        const scroll = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });

        const main_box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 20,
            margin_bottom: 20,
            margin_start: 20,
            margin_end: 20,
            spacing: 16,
        });

        this._content_stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 200 });

        const spinner = new Gtk.Spinner({ spinning: true, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER });
        spinner.set_size_request(64, 64);
        const loading_box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, homogeneous: true, spacing: 16 });
        loading_box.append(spinner);
        loading_box.append(new Gtk.Label({ label: 'Scanning audio devices…', halign: Gtk.Align.CENTER }));
        this._content_stack.add_named(loading_box, 'loading');

        const form_box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        const group = new Adw.PreferencesGroup();

        this._name_entry = new Adw.EntryRow({ title: 'Profile Name' });
        group.add(this._name_entry);

        this._trigger_row = new Adw.ComboRow({
            title: 'Trigger Device',
            subtitle: 'Device that activates this profile',
            model: Gtk.StringList.new(['Scanning...']),
        });
        group.add(this._trigger_row);

        this._sink_row = new Adw.ComboRow({
            title: 'Default Sink (Output)',
            subtitle: 'Audio output device',
            model: Gtk.StringList.new(['Scanning...']),
        });
        group.add(this._sink_row);

        this._source_row = new Adw.ComboRow({
            title: 'Default Source (Input)',
            subtitle: 'Audio input device',
            model: Gtk.StringList.new(['Scanning...']),
        });
        group.add(this._source_row);

        const bt_labels = BT_PROFILES.map(([, label]) => label);
        this._bt_profile_row = new Adw.ComboRow({ title: 'Bluetooth Profile', subtitle: 'For wireless headsets only' });
        this._bt_profile_row.set_model(Gtk.StringList.new(bt_labels));
        group.add(this._bt_profile_row);

        this._bt_profile_call_row = new Adw.ComboRow({ title: 'Call BT Profile', subtitle: 'Bluetooth profile during calls (HSP/HFP for mic)' });
        this._bt_profile_call_row.set_model(Gtk.StringList.new(bt_labels));
        group.add(this._bt_profile_call_row);

        this._auto_switch_row = new Adw.SwitchRow({ title: 'Auto-switch for calls', subtitle: 'Switch to call profile when mic is active' });
        group.add(this._auto_switch_row);

        this._active_row = new Adw.SwitchRow({ title: 'Active', subtitle: 'Enable this profile immediately when triggered' });
        group.add(this._active_row);

        form_box.append(group);

        this._content_stack.add_named(form_box, 'ready');
        main_box.append(this._content_stack);
        this._content_stack.set_visible_child_name('loading');

        scroll.set_child(main_box);
        content.set_content(scroll);
        this.set_child(content);
    }

    _load_devices_async() {
        let completed = false;
        const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            if (!completed) {
                print('[ProfileDialog] Async device loading timed out, falling back to sync');
                const nodes = wp_monitor.get_audio_nodes_sync();
                this._on_devices_loaded(nodes);
            }
            return GLib.SOURCE_REMOVE;
        });

        wp_monitor.get_audio_nodes_async(nodes => {
            if (!completed) {
                completed = true;
                if (timeout_id > 0) GLib.source_remove(timeout_id);
                this._on_devices_loaded(nodes);
            }
        });
    }

    _on_devices_loaded(nodes) {
        this._all_nodes = nodes;
        this._sink_nodes = nodes.filter(n => (n['media_class'] || '').includes('Sink'));
        this._source_nodes = nodes.filter(n => (n['media_class'] || '').includes('Source'));

        if (nodes.length === 0) {
            print('[ProfileDialog] No audio devices found.');
            this._content_stack.set_visible_child_name('ready');
            this._trigger_row.set_model(Gtk.StringList.new(['No devices found']));
            this._sink_row.set_model(Gtk.StringList.new(['No devices found']));
            this._source_row.set_model(Gtk.StringList.new(['No devices found']));
            this._validate();
            return;
        }

        const labels = arr => arr.map(n => this._get_display_name(n));

        this._trigger_row.set_model(Gtk.StringList.new(labels(nodes)));
        this._sink_row.set_model(Gtk.StringList.new(labels(this._sink_nodes)));
        this._source_row.set_model(Gtk.StringList.new(labels(this._source_nodes)));

        this._content_stack.set_visible_child_name('ready');
        this._validate();
        if (this._profile) this._prefill(this._profile);
    }

    _connect_signals() {
        this._save_button.connect('clicked', () => this._on_save());
        this._apply_button.connect('clicked', () => this._on_apply_now());
        this._cancel_button.connect('clicked', () => this.close());
        this._name_entry.connect('notify::text', () => this._validate());
        this._trigger_row.connect('notify::selected', () => { this._validate(); this._update_apply_now(); });
        this._active_row.connect('notify::active', () => this._validate());
        this._validate();
    }

    _prefill(profile) {
        this._name_entry.set_text(profile['profile_name'] || '');
        const trigger = profile['trigger_device_name'] || '';
        const actions = profile['actions'] || {};
        this._select_by_name(this._trigger_row, this._all_nodes, trigger);
        this._select_by_name(this._sink_row, this._sink_nodes, actions['default_sink'] || '');
        this._select_by_name(this._source_row, this._source_nodes, actions['default_source'] || '');
        this._select_bt_profile(actions['bt_profile'] || '');
        this._select_bt_profile_call(actions['bt_profile_call'] || '');
        this._auto_switch_row.set_active(actions['auto_switch'] || false);
        this._active_row.set_active(profile['is_active'] || false);
    }

    _select_by_name(combo, nodeList, name) {
        for (let i = 0; i < nodeList.length; i++) {
            if (nodeList[i]['name'] === name) { combo.set_selected(i); return; }
        }
    }

    _select_bt_profile(btKey) {
        for (let i = 0; i < BT_PROFILES.length; i++) {
            if (BT_PROFILES[i][0] === btKey) { this._bt_profile_row.set_selected(i); return; }
        }
    }

    _select_bt_profile_call(btKey) {
        for (let i = 0; i < BT_PROFILES.length; i++) {
            if (BT_PROFILES[i][0] === btKey) { this._bt_profile_call_row.set_selected(i); return; }
        }
    }

    _validate() {
        const ok = this._name_entry.get_text().trim().length > 0 && this._trigger_row.get_selected() !== _INVALID;
        this._save_button.set_sensitive(ok);
    }

    _update_apply_now() {
        const idx = this._trigger_row.get_selected();
        this._apply_button.set_sensitive(idx !== _INVALID && idx < this._all_nodes.length);
    }

    _on_apply_now() {
        this._on_save(false);
    }

    _on_save(closeDialog = true) {
        const name = this._name_entry.get_text().trim();
        const triggerIdx = this._trigger_row.get_selected();
        const sinkIdx = this._sink_row.get_selected();
        const sourceIdx = this._source_row.get_selected();
        const btIdx = this._bt_profile_row.get_selected();

        if (!name || triggerIdx === _INVALID) return;

        const triggerNode = this._all_nodes[triggerIdx];
        const triggerDevice = triggerNode ? triggerNode['name'] : '';
        const triggerDisplay = triggerNode ? this._get_display_name(triggerNode) : '';
        const sinkNode = sinkIdx !== _INVALID && this._sink_nodes[sinkIdx] ? this._sink_nodes[sinkIdx]['name'] : '';
        const sourceNode = sourceIdx !== _INVALID && this._source_nodes[sourceIdx] ? this._source_nodes[sourceIdx]['name'] : '';
        const btProfileKey = btIdx !== _INVALID && BT_PROFILES[btIdx] ? BT_PROFILES[btIdx][0] : '';
        const btCallIdx = this._bt_profile_call_row.get_selected();
        const btProfileCallKey = btCallIdx !== _INVALID && BT_PROFILES[btCallIdx] ? BT_PROFILES[btCallIdx][0] : '';
        const autoSwitch = this._auto_switch_row.get_active();
        const isActive = this._active_row.get_active();

        config_mgr.save_profile(name, triggerDevice, sinkNode, sourceNode, btProfileKey, isActive, btProfileCallKey, autoSwitch, triggerDisplay);
        this.emit('profile-saved');
        if (closeDialog) {
            this.close();
        }
    }
});