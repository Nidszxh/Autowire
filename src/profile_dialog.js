imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, GObject, GLib, Gio, Gtk } = imports.gi;
const config_mgr = imports.config_mgr;
const C = imports.constants;
const wp_monitor = imports.wp_monitor;
const bt_profiles = imports.bt_profiles;
const pactl_parser = imports.pactl_parser;

print('[ProfileDialog] module loaded');

const _INVALID = Gtk.INVALID_LIST_POSITION;

const BT_PROFILES = [
    ['', "Don't change"],
    ['a2dp-sink-ldac', 'LDAC (high quality)'],
    ['a2dp-sink-aptx_hd', 'aptX HD (high quality)'],
    ['a2dp-sink-aptx', 'aptX (high quality)'],
    ['a2dp-sink-aac', 'AAC (high quality)'],
    ['a2dp-sink', 'A2DP (codec auto)'],
    ['a2dp-sink-sbc_xq', 'SBC-XQ (high quality)'],
    ['a2dp-sink-sbc', 'SBC (standard)'],
    ['handsfree-headset', 'HSP/HFP handsfree (call / mSBC)'],
    ['headset-head-unit', 'HSP/HFP headset (call / CVSD)'],
];

/**
 * Get available BT profiles per card from pactl.
 * @returns {Object<string, string[]>}
 */
function _list_card_profiles() {
    return pactl_parser.listAllCardProfiles();
}

/**
 * Auto-pick the best BT profile for the trigger device.
 * Returns '' if no preference can be inferred.
 */
function _auto_pick_bt_profile(trigger_node_name) {
    if (!trigger_node_name || !trigger_node_name.startsWith('bluez_')) return '';
    const mac_match = trigger_node_name.match(/^bluez_(?:output|input)\.([0-9A-Fa-f_]{17})/);
    if (!mac_match) return '';
    const mac_dotted = mac_match[1].replace(/_/g, ':');
    const card_name = `bluez_card.${mac_match[1]}`;

    const cards = _list_card_profiles();
    const available = cards[card_name] || cards[`bluez_card.${mac_dotted}`] || [];
    if (available.length === 0) {
        const names = Object.keys(cards);
        for (const n of names) {
            if (n.startsWith('bluez_card.') && n.toLowerCase().includes(mac_match[1].toLowerCase())) {
                return bt_profiles.pickBest(available.concat(cards[n] || []));
            }
        }
        return '';
    }
    return bt_profiles.pickBest(available);
}

function _list_card_profiles_for_trigger(trigger_node_name) {
    if (!trigger_node_name || !trigger_node_name.startsWith('bluez_')) return null;
    const mac_match = trigger_node_name.match(/^bluez_(?:output|input)\.([0-9A-Fa-f_]{17})/);
    if (!mac_match) return null;
    const card_name = `bluez_card.${mac_match[1]}`;
    const cards = _list_card_profiles();
    const available = new Set(cards[card_name] || []);
    if (available.size === 0) {
        // Card may not be in pactl yet; return empty so only "Don't change" shows.
        return available;
    }
    return available;
}

var ProfileDialog = GObject.registerClass({
    Signals: {
        'profile-saved': {},
    },
}, class AutowireProfileDialog extends Adw.Dialog {
    constructor(kwargs) {
        const profile = kwargs?.profile || null;
        if (kwargs) delete kwargs.profile;
        super(kwargs);

        this.set_title(profile ? 'Edit Profile' : 'Add Profile');
        this._profile = profile;
        this._originalName = profile ? profile['profile_name'] : null;
        this._originalTrigger = profile ? profile['trigger_device_name'] : null;
        this._all_nodes = [];
        this._sink_nodes = [];
        this._source_nodes = [];
        this._bt_profile_keys = BT_PROFILES.map(([k]) => k);

        this._setup_ui();
        this._connect_signals();
        this._load_devices_async();
    }

    _get_display_name(node) {
        return node['description'] || node['name'] || '';
    }

    _setup_ui() {
        const content = new Adw.ToolbarView();
        content.set_size_request(480, 560);

        const title_label = new Gtk.Label({
            label: `<b>${this._profile ? 'Edit Profile' : 'Add Profile'}</b>`,
            use_markup: true,
        });
        const header_bar = new Adw.HeaderBar({
            title_widget: title_label,
        });

        this._cancel_button = new Gtk.Button({ label: 'Cancel' });
        this._cancel_button.add_css_class('flat');
        header_bar.pack_start(this._cancel_button);

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
        const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.SYNC_FALLBACK_TIMEOUT_MS, () => {
            if (!completed) {
                print('[ProfileDialog] Async device loading timed out, continuing wait...');
            }
            return GLib.SOURCE_CONTINUE;
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
        this._cancel_button.connect('clicked', () => this.close());
        this._name_entry.connect('notify::text', () => this._validate());
        this._trigger_row.connect('notify::selected', () => {
            this._validate();
            this._refresh_bt_profile_options();
            this._maybe_autofill_bt_profile();
        });
        this._active_row.connect('notify::active', () => this._validate());
        this._validate();
        this._refresh_bt_profile_options();
    }

    /**
     * Filter BT profile options to what the selected trigger device supports.
     */
    _refresh_bt_profile_options() {
        const idx = this._trigger_row.get_selected();
        const node = (idx !== _INVALID && idx < this._all_nodes.length) ? this._all_nodes[idx] : null;
        const triggerName = node ? (node['name'] || '') : '';
        const deviceProfiles = _list_card_profiles_for_trigger(triggerName);
        const isBt = deviceProfiles !== null;
        // Map common profile name variations
        const mapped = deviceProfiles ? new Set(deviceProfiles) : null;
        if (mapped && mapped.has('headset-head-unit')) mapped.add('handsfree-headset');
        if (mapped && mapped.has('handsfree-headset')) mapped.add('headset-head-unit');
        const filtered = mapped
            ? BT_PROFILES.filter(([key]) => !key || mapped.has(key))
            : BT_PROFILES;
        const labels = filtered.map(([, label]) => label);
        const previousKey = this._current_bt_profile_key();
        const previousCallKey = this._current_bt_profile_call_key();
        this._bt_profile_row.set_model(Gtk.StringList.new(labels));
        this._bt_profile_call_row.set_model(Gtk.StringList.new(labels));
        this._bt_profile_keys = filtered.map(([key]) => key);
        this._bt_profile_row.set_sensitive(isBt);
        this._bt_profile_call_row.set_sensitive(isBt);
        this._auto_switch_row.set_sensitive(isBt);
        // Re-select previously chosen values if they're still available.
        if (previousKey) this._select_bt_profile(previousKey);
        if (previousCallKey) this._select_bt_profile_call(previousCallKey);
    }

    _current_bt_profile_key() {
        if (!this._bt_profile_keys) return '';
        const idx = this._bt_profile_row.get_selected();
        return (idx >= 0 && idx < this._bt_profile_keys.length) ? this._bt_profile_keys[idx] : '';
    }

    _current_bt_profile_call_key() {
        if (!this._bt_profile_keys) return '';
        const idx = this._bt_profile_call_row.get_selected();
        return (idx >= 0 && idx < this._bt_profile_keys.length) ? this._bt_profile_keys[idx] : '';
    }

    _maybe_autofill_bt_profile() {
        if (this._profile) return;
        if (this._bt_profile_row.get_selected() !== 0) return;
        const idx = this._trigger_row.get_selected();
        if (idx === _INVALID || idx >= this._all_nodes.length) return;
        const node = this._all_nodes[idx];
        const picked = _auto_pick_bt_profile(node['name'] || '');
        if (picked) {
            this._select_bt_profile(picked);
            if (this._bt_profile_call_row.get_selected() === 0) {
                this._select_bt_profile_call('handsfree-headset');
            }
        }
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
        const keys = this._bt_profile_keys || BT_PROFILES.map(([k]) => k);
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] === btKey) { this._bt_profile_row.set_selected(i); return; }
        }
    }

    _select_bt_profile_call(btKey) {
        const keys = this._bt_profile_keys || BT_PROFILES.map(([k]) => k);
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] === btKey) { this._bt_profile_call_row.set_selected(i); return; }
        }
    }

    _validate() {
        const ok = this._name_entry.get_text().trim().length > 0 && this._trigger_row.get_selected() !== _INVALID;
        this._save_button.set_sensitive(ok);
    }

    _on_save() {
        const name = this._name_entry.get_text().trim();
        const triggerIdx = this._trigger_row.get_selected();
        const sinkIdx = this._sink_row.get_selected();
        const sourceIdx = this._source_row.get_selected();
        if (!name || triggerIdx === _INVALID) return;

        const triggerNode = this._all_nodes[triggerIdx];
        const triggerDevice = triggerNode ? triggerNode['name'] : '';
        const triggerDisplay = triggerNode ? this._get_display_name(triggerNode) : '';
        const sinkNode = sinkIdx !== _INVALID && this._sink_nodes[sinkIdx] ? this._sink_nodes[sinkIdx]['name'] : '';
        const sourceNode = sourceIdx !== _INVALID && this._source_nodes[sourceIdx] ? this._source_nodes[sourceIdx]['name'] : '';
        const btProfileKey = this._current_bt_profile_key();
        const btProfileCallKey = this._current_bt_profile_call_key();
        const autoSwitch = this._auto_switch_row.get_active();
        const isActive = this._active_row.get_active();

        // Check for duplicate name+trigger before saving.
        const isEditingExisting = this._originalName !== null
            && this._originalTrigger !== null
            && name === this._originalName
            && triggerDevice === this._originalTrigger;
        if (!isEditingExisting) {
            const existing = config_mgr.get_profile(triggerDevice, name);
            if (existing) {
                const alert = new Adw.AlertDialog({
                    heading: 'Overwrite Profile?',
                    body: `A profile named "${name}" already exists for this device. Overwrite it?`,
                });
                alert.add_response('cancel', 'Cancel');
                alert.add_response('overwrite', 'Overwrite');
                alert.set_response_appearance('overwrite', Adw.ResponseAppearance.DESTRUCTIVE);
                alert.set_default_response('cancel');
                alert.set_close_response('cancel');
                alert.connect('response', (_dialog, response) => {
                    if (response === 'overwrite') {
                        this._do_save(triggerDevice, triggerDisplay, sinkNode, sourceNode,
                            btProfileKey, btProfileCallKey, autoSwitch, isActive);
                    }
                });
                alert.present(this);
                return;
            }
        }

        this._do_save(triggerDevice, triggerDisplay, sinkNode, sourceNode,
            btProfileKey, btProfileCallKey, autoSwitch, isActive);
    }

    _do_save(triggerDevice, triggerDisplay, sinkNode, sourceNode,
        btProfileKey, btProfileCallKey, autoSwitch, isActive) {
        const name = this._name_entry.get_text().trim();

        config_mgr.save_profile({
            name,
            trigger: triggerDevice,
            sink: sinkNode,
            source: sourceNode,
            btProfile: btProfileKey,
            isActive,
            btProfileCall: btProfileCallKey,
            autoSwitch,
            display: triggerDisplay,
            originalName: this._originalName,
            originalTrigger: this._originalTrigger,
        });
        this.emit('profile-saved');
        this.close();
    }
});