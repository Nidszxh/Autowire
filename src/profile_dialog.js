imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, GObject, GLib, Gio, Gtk } = imports.gi;
const config_mgr = imports.config_mgr;

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

function _parse_nodes_from_wpctl(stdout) {
    const results = [];
    const seen_ids = new Set();
    const lines = stdout.split('\n');

    let in_sinks = false;
    let in_sources = false;

    for (const line of lines) {
        const stripped = line.trim();
        if (['Sinks:', '├─ Sinks:', '└─ Sinks:'].includes(stripped)) {
            in_sinks = true;
            in_sources = false;
            continue;
        }
        if (['Sources:', '├─ Sources:', '└─ Sources:'].includes(stripped)) {
            in_sources = true;
            in_sinks = false;
            continue;
        }

        if (!line.startsWith(' │')) {
            in_sinks = false;
            in_sources = false;
            continue;
        }

        const m = line.match(/\s+│\s+(?:\*\s*)?(\d+)\.\s+(.+?)(?:\s+\[.*\])?$/);
        if (!m) continue;

        const node_id = parseInt(m[1], 10);
        if (seen_ids.has(node_id)) continue;
        seen_ids.add(node_id);

        const description = m[2].trim();
        const media_class = in_sinks ? 'Audio/Sink' : 'Audio/Source';

        results.push({
            id: node_id,
            name: description,
            description: description,
            media_class: media_class,
        });
    }
    return results;
}

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

        this._apply_button = new Gtk.Button({ label: 'Apply Now', tooltip_text: 'Save and apply immediately' });
        this._apply_button.set_sensitive(false);
        header_bar.pack_end(this._apply_button);

        this._save_button = new Gtk.Button({ label: 'Save' });
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

        const form_box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });

        this._name_entry = new Adw.EntryRow({ title: 'Profile Name', visible: true });
        this._name_entry.set_size_request(-1, 48);
        form_box.append(this._name_entry);

        this._trigger_row = new Adw.ComboRow({
            title: 'Trigger Device',
            subtitle: 'Device that activates this profile',
            visible: true,
            model: Gtk.StringList.new(['Scanning...']),
        });
        this._trigger_row.set_size_request(-1, 56);
        form_box.append(this._trigger_row);

        this._sink_row = new Adw.ComboRow({
            title: 'Default Sink (Output)',
            subtitle: 'Audio output device',
            visible: true,
            model: Gtk.StringList.new(['Scanning...']),
        });
        this._sink_row.set_size_request(-1, 56);
        form_box.append(this._sink_row);

        this._source_row = new Adw.ComboRow({
            title: 'Default Source (Input)',
            subtitle: 'Audio input device',
            visible: true,
            model: Gtk.StringList.new(['Scanning...']),
        });
        this._source_row.set_size_request(-1, 56);
        form_box.append(this._source_row);

        const bt_labels = BT_PROFILES.map(([, label]) => label);
        this._bt_profile_row = new Adw.ComboRow({ title: 'Bluetooth Profile', subtitle: 'For wireless headsets only', visible: true });
        this._bt_profile_row.set_model(Gtk.StringList.new(bt_labels));
        this._bt_profile_row.set_size_request(-1, 56);
        form_box.append(this._bt_profile_row);

        this._bt_profile_call_row = new Adw.ComboRow({ title: 'Call BT Profile', subtitle: 'Bluetooth profile during calls (HSP/HFP for mic)', visible: true });
        this._bt_profile_call_row.set_model(Gtk.StringList.new(bt_labels));
        this._bt_profile_call_row.set_size_request(-1, 56);
        form_box.append(this._bt_profile_call_row);

        this._auto_switch_row = new Adw.SwitchRow({ title: 'Auto-switch for calls', subtitle: 'Switch to call profile when mic is active', visible: true });
        form_box.append(this._auto_switch_row);

        this._active_row = new Adw.SwitchRow({ title: 'Active', subtitle: 'Enable this profile immediately when triggered', visible: true });
        form_box.append(this._active_row);

        this._content_stack.add_named(form_box, 'ready');
        main_box.append(this._content_stack);
        this._content_stack.set_visible_child_name('loading');

        scroll.set_child(main_box);
        content.set_content(scroll);
        this.set_child(content);
    }

    _load_devices_async() {
        const proc = Gio.Subprocess.new(
            ['wpctl', 'status'],
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                const nodes = _parse_nodes_from_wpctl(stdout || '');
                this._on_devices_loaded(nodes);
            } catch (e) {
                print(`[ProfileDialog] Error scanning devices: ${e}`);
                this._content_stack.set_visible_child_name('ready');
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