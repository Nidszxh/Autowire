"""ProfileDialog — create or edit an audio profile."""

from __future__ import annotations

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')

from gi.repository import Adw, GObject, GLib, Gtk

from . import config_mgr
from .wp_monitor import get_audio_nodes_sync

RESOURCE_PATH = '/io/github/nidszxh/Autowire/profile_dialog.ui'

_INVALID = Gtk.INVALID_LIST_POSITION


@Gtk.Template(resource_path=RESOURCE_PATH)
class ProfileDialog(Adw.Dialog):
    __gtype_name__ = 'ProfileDialog'

    __gsignals__ = {
        'profile-saved': (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    # Available Bluetooth A2DP / HFP profiles
    BT_PROFILES: list[tuple[str, str]] = [
        ('', "Don't change"),
        ('a2dp-sink-aac', 'AAC (high quality)'),
        ('a2dp-sink-ldac', 'LDAC (high quality)'),
        ('a2dp-sink-aptx', 'aptX (high quality)'),
        ('a2dp-sink-aptx_hd', 'aptX HD (high quality)'),
        ('a2dp-sink-sbc_xq', 'SBC-XQ (high quality)'),
        ('a2dp-sink-sbc', 'SBC (standard)'),
        ('handsfree-headset', 'HSP/HFP (call / mSBC)'),
    ]

    # Widgets from Blueprint template
    content_stack: Gtk.Stack = Gtk.Template.Child()
    name_entry: Adw.EntryRow = Gtk.Template.Child()
    trigger_row: Adw.ComboRow = Gtk.Template.Child()
    sink_row: Adw.ComboRow = Gtk.Template.Child()
    source_row: Adw.ComboRow = Gtk.Template.Child()
    bt_profile_row: Adw.ComboRow = Gtk.Template.Child()
    active_row: Adw.SwitchRow = Gtk.Template.Child()
    save_button: Gtk.Button = Gtk.Template.Child()
    cancel_button: Gtk.Button = Gtk.Template.Child()

    def __init__(self, profile: dict | None = None) -> None:
        super().__init__()

        self._profile = profile
        self._all_nodes: list[dict] = []
        self._sink_nodes: list[dict] = []
        self._source_nodes: list[dict] = []
        self._nodes_ready = False

        self.content_stack.set_visible_child_name('loading')

        if profile:
            self.set_title('Edit Profile')

        self._populate_bt_profiles()
        self._connect_signals()
        self._load_devices_async()

    # ── setup ─────────────────────────────────────────────────────────────

    def _load_devices_async(self) -> None:
        import threading

        def _worker() -> None:
            nodes = get_audio_nodes_sync()
            GLib.idle_add(lambda: self._on_devices_loaded(nodes))

        threading.Thread(target=_worker, daemon=True).start()

    def _on_devices_loaded(self, nodes: list[dict]) -> None:
        self._all_nodes = nodes
        self._sink_nodes = [n for n in nodes if 'Sink' in n.get('media_class', '')]
        self._source_nodes = [n for n in nodes if 'Source' in n.get('media_class', '')]

        def labels(node_list: list[dict]) -> list[str]:
            return [n.get('description') or n.get('name', '') for n in node_list]

        self.trigger_row.set_model(Gtk.StringList.new(labels(nodes)))
        self.sink_row.set_model(Gtk.StringList.new(labels(self._sink_nodes)))
        self.source_row.set_model(Gtk.StringList.new(labels(self._source_nodes)))

        self.content_stack.set_visible_child_name('ready')
        self._nodes_ready = True
        GLib.idle_add(self._on_devices_loaded_idle)

    def _on_devices_loaded_idle(self) -> None:
        self._validate()
        if self._profile:
            self._prefill(self._profile)

    def _on_combo_changed(self, *_args) -> None:
        self._validate()

    def _on_switch_changed(self, *_args) -> None:
        self._validate()

    def _populate_device_lists(self) -> None:
        nodes = get_audio_nodes_sync()
        self._all_nodes = nodes
        self._sink_nodes = [n for n in nodes if 'Sink' in n.get('media_class', '')]
        self._source_nodes = [n for n in nodes if 'Source' in n.get('media_class', '')]

        def _labels(node_list: list[dict]) -> list[str]:
            return [n.get('description') or n.get('name', '') for n in node_list]

        self.trigger_row.set_model(Gtk.StringList.new(_labels(nodes)))
        self.sink_row.set_model(Gtk.StringList.new(_labels(self._sink_nodes)))
        self.source_row.set_model(Gtk.StringList.new(_labels(self._source_nodes)))

    def _populate_bt_profiles(self) -> None:
        """Fill the Bluetooth profile combo with label-only items."""
        labels = [label for _key, label in self.BT_PROFILES]
        self.bt_profile_row.set_model(Gtk.StringList.new(labels))

    def _connect_signals(self) -> None:
        self.save_button.connect('clicked', self._on_save)
        self.cancel_button.connect('clicked', lambda _: self.close())
        self.name_entry.connect('changed', self._validate)
        self.trigger_row.connect('notify::selected', self._on_combo_changed)
        self.sink_row.connect('notify::selected', self._on_combo_changed)
        self.source_row.connect('notify::selected', self._on_combo_changed)
        self._validate()

        self.active_row.connect('notify::active', self._validate)

    def _prefill(self, profile: dict) -> None:
        """Pre-select values when editing an existing profile."""
        self.name_entry.set_text(profile.get('profile_name', ''))

        trigger = profile.get('trigger_device_name', '')
        actions = profile.get('actions', {})

        self._select_by_name(self.trigger_row, self._all_nodes, trigger)
        self._select_by_name(self.sink_row, self._sink_nodes, actions.get('default_sink', ''))
        self._select_by_name(self.source_row, self._source_nodes, actions.get('default_source', ''))

        bt_profile = actions.get('bt_profile', '')
        self._select_bt_profile(bt_profile)

        self.active_row.set_active(profile.get('is_active', False))

    @staticmethod
    def _select_by_name(combo: Adw.ComboRow, node_list: list[dict], name: str) -> None:
        for i, node in enumerate(node_list):
            if node.get('name') == name:
                combo.set_selected(i)
                return

    def _select_bt_profile(self, bt_key: str) -> None:
        """Select the BT profile row entry matching *bt_key*."""
        for i, (key, _label) in enumerate(self.BT_PROFILES):
            if key == bt_key:
                self.bt_profile_row.set_selected(i)
                return

    # ── validation ────────────────────────────────────────────────────────

    def _validate(self, *_args) -> None:
        ok = (
            bool(self.name_entry.get_text().strip())
            and self.trigger_row.get_selected() != _INVALID
        )
        self.save_button.set_sensitive(ok)

    # ── save ──────────────────────────────────────────────────────────────

    def _on_save(self, _btn: Gtk.Button) -> None:
        name = self.name_entry.get_text().strip()
        trigger_idx = self.trigger_row.get_selected()
        sink_idx = self.sink_row.get_selected()
        source_idx = self.source_row.get_selected()
        bt_idx = self.bt_profile_row.get_selected()

        if not name or trigger_idx == _INVALID:
            return

        trigger_node = self._all_nodes[trigger_idx]['name']
        sink_node = self._sink_nodes[sink_idx]['name'] if sink_idx != _INVALID else ''
        source_node = self._source_nodes[source_idx]['name'] if source_idx != _INVALID else ''
        bt_profile_key = self.BT_PROFILES[bt_idx][0] if bt_idx != _INVALID else ''
        is_active = self.active_row.get_active()

        config_mgr.save_profile(name, trigger_node, sink_node, source_node, bt_profile_key, is_active)
        self.emit('profile-saved')
        self.close()
