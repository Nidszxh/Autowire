imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { Adw, GObject, GLib, Gio, Gtk } = imports.gi;
const { get_pactl_cmd } = imports.utils;
const config_mgr = imports.config_mgr;
const wp_monitor = imports.wp_monitor;

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
    ['handsfree-headset', 'HSP/HFP (call / mSBC)'],
];

// Highest quality first. Used for auto-detection.
const BT_QUALITY_ORDER = [
    'a2dp-sink-ldac',
    'a2dp-sink-aptx_hd',
    'a2dp-sink-aptx',
    'a2dp-sink-aac',
    'a2dp-sink',
    'a2dp-sink-sbc_xq',
    'a2dp-sink-sbc',
];

/**
 * Parse `pactl list cards` and return a map of card_name -> available profile names.
 * @returns {Object<string, string[]>}
 */
function _list_card_profiles() {
    const out = {};
    try {
        const [ok, stdout] = GLib.spawn_sync(
            null, get_pactl_cmd().concat(['list', 'cards']),
            null, GLib.SpawnFlags.SEARCH_PATH, null
        );
        if (!ok) return out;
        const text = new TextDecoder().decode(stdout);
        let current_card = null;
        let in_profiles = false;
        for (const raw_line of text.split('\n')) {
            const line = raw_line.trim();
            if (line.startsWith('Name: ')) {
                current_card = line.substring(6).trim();
                out[current_card] = [];
                in_profiles = false;
            } else if (current_card && line === 'Profiles:') {
                in_profiles = true;
            } else if (current_card && in_profiles && line && !line.startsWith('Active Profile:')) {
                const m = line.match(/^([\w\-+.]+):\s/);
                if (m) {
                    out[current_card].push(m[1]);
                }
            } else if (current_card && line === '' && in_profiles) {
                in_profiles = false;
            }
        }
    } catch (e) {
    }
    return out;
}

/**
 * Pick the best BT profile for a device that supports input/output switching.
 * `trigger_node_name` is a node name like 'bluez_output.XX_XX_...'.
 * Returns '' if no preference can be inferred.
 */
function _auto_pick_bt_profile(trigger_node_name) {
    if (!trigger_node_name || !trigger_node_name.startsWith('bluez_')) return '';
    const mac_match = trigger_node_name.match(/^bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})/);
    if (!mac_match) return '';
    const mac_dotted = mac_match[1].replace(/_/g, ':');
    const card_name = `bluez_card.${mac_match[1]}`;

    const cards = _list_card_profiles();
    const available = cards[card_name] || cards[`bluez_card.${mac_dotted}`] || [];
    if (available.length === 0) {
        const names = Object.keys(cards);
        for (const n of names) {
            if (n.startsWith('bluez_card.') && n.toLowerCase().includes(mac_match[1].toLowerCase())) {
                return _pick_best(available.concat(cards[n] || []));
            }
        }
        return '';
    }
    return _pick_best(available);
}

function _pick_best(available) {
    for (const cand of BT_QUALITY_ORDER) {
        if (available.includes(cand)) return cand;
    }
    return '';
}

/**
 * Return a Set of profile names the bluez card behind `trigger_node_name`
 * actually exposes, or null when the trigger isn't a bluez device (in which
 * case the ComboRow should keep the full BT_PROFILES list, just disabled).
 */
function _list_card_profiles_for_trigger(trigger_node_name) {
    if (!trigger_node_name || !trigger_node_name.startsWith('bluez_')) return null;
    const mac_match = trigger_node_name.match(/^bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})/);
    if (!mac_match) return null;
    const card_name = `bluez_card.${mac_match[1]}`;
    const cards = _list_card_profiles();
    const available = new Set(cards[card_name] || []);
    if (available.size === 0) {
        // The card may not be in `pactl list cards` yet (e.g. right after
        // pairing). Return an empty set so the ComboRow shows only the
        // "Don't change" option — better than showing a wrong profile.
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
        delete kwargs?.profile;
        super(kwargs);

        this.set_title(profile ? 'Edit Profile' : 'Add Profile');
        this._profile = profile;
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
        content.set_size_request(460, 540);

        const header_bar = new Adw.HeaderBar({
            title_widget: new Gtk.Label({ label: this._profile ? 'Edit Profile' : 'Add Profile' }),
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
     * Replace the BT profile ComboRows' models with the subset of BT_PROFILES
     * that the currently-selected trigger device actually supports. Falls back
     * to the full list for non-BT triggers (where the rows stay disabled).
     */
    _refresh_bt_profile_options() {
        const idx = this._trigger_row.get_selected();
        const node = (idx !== _INVALID && idx < this._all_nodes.length) ? this._all_nodes[idx] : null;
        const triggerName = node ? (node['name'] || '') : '';
        const deviceProfiles = _list_card_profiles_for_trigger(triggerName);
        // Map common names to PipeWire names the device may expose:
        //   handsfree-headset → headset-head-unit
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
        const btIdx = this._bt_profile_row.get_selected();

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

        // If editing and the key (name or trigger) changed, delete the old
        // profile first so we don't leave an orphan behind.
        if (this._originalName !== null && this._originalTrigger !== null) {
            const keyChanged = name !== this._originalName || triggerDevice !== this._originalTrigger;
            if (keyChanged) {
                config_mgr.delete_profile(this._originalTrigger, this._originalName);
            }
        }

        // Duplicate detection: if adding a new profile and one with the same
        // name+trigger already exists, confirm overwrite.
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
        });
        this.emit('profile-saved');
        this.close();
    }
});