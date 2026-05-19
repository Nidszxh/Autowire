"""WirePlumber integration layer for Autowire.

Provides:
  - WpMonitor  — a GObject that wraps WpCore + WpObjectManager and emits
                 'node-added' / 'node-removed' GObject signals.
  - get_audio_nodes_sync() — one-shot synchronous query that returns the
                             list of currently connected audio nodes. Used
                             by the UI to populate device dropdowns.

All interaction with libwireplumber happens on the GLib main loop, so this
module must be used from a thread that owns a running GLib.MainLoop (or
inside the GTK application main loop).
"""

from __future__ import annotations

import re
import subprocess

import gi
gi.require_version('Wp', '0.5')
gi.require_version('GLib', '2.0')
gi.require_version('GObject', '2.0')

from gi.repository import GLib, GObject, Wp

# Media classes we care about
_AUDIO_MEDIA_CLASSES = frozenset({
    'Audio/Sink',
    'Audio/Source',
    'Audio/Duplex',
})


class WpMonitor(GObject.Object):
    """Thin wrapper around WpCore + WpObjectManager.

    Signals
    -------
    node-added(name: str, description: str, media_class: str)
        Emitted when a new audio node appears in the PipeWire graph.
    node-removed(name: str)
        Emitted when an audio node disappears from the PipeWire graph.
    device-added(name: str, description: str, global_id: int)
        Emitted when a new device (e.g. Bluetooth card) appears.
    device-removed(name: str)
        Emitted when a device disappears.
    """

    __gtype_name__ = 'AutowireWpMonitor'

    __gsignals__ = {
        'node-added': (
            GObject.SignalFlags.RUN_FIRST, None,
            (str, str, str),   # name, description, media_class
        ),
        'node-removed': (
            GObject.SignalFlags.RUN_FIRST, None,
            (str,),             # name
        ),
        'device-added': (
            GObject.SignalFlags.RUN_FIRST, None,
            (str, str, int),    # name, description, global_id
        ),
        'device-removed': (
            GObject.SignalFlags.RUN_FIRST, None,
            (str,),             # name
        ),
    }

    def __init__(self) -> None:
        super().__init__()
        self._core: Wp.Core | None = None
        self._om: Wp.ObjectManager | None = None
        # name → {name, description, media_class}
        self._nodes: dict[str, dict] = {}
        # name → {name, description, global_id}
        self._devices: dict[str, dict] = {}

    # ── public API ────────────────────────────────────────────────────────

    def start(self) -> None:
        """Connect to PipeWire and begin monitoring. Call once."""
        self._core = Wp.Core.new(None, None, None)
        GObject.Object.connect(self._core, 'connected', self._on_core_connected)
        GObject.Object.connect(self._core, 'disconnected', self._on_core_disconnected)
        self._core.connect()

    def _on_core_disconnected(self, _core: Wp.Core) -> None:
        """Called when the Wp.Core loses its PipeWire connection."""
        print('[WpMonitor] Core disconnected from PipeWire')

    def _on_core_connected(self, _core: Wp.Core) -> None:
        """Called when the Wp.Core has finished its initial PW handshake."""
        print('[WpMonitor] Core connected, installing Object Manager…')

        self._om = Wp.ObjectManager.new()
        node_type = GObject.type_from_name('WpNode')
        interest = Wp.ObjectInterest.new_type(node_type)
        self._om.add_interest_full(interest)

        device_type = GObject.type_from_name('WpDevice')
        dev_interest = Wp.ObjectInterest.new_type(device_type)
        self._om.add_interest_full(dev_interest)

        self._om.connect('object-added', self._on_object_added)
        self._om.connect('object-removed', self._on_object_removed)
        self._om.connect('installed', self._on_om_installed)

        self._core.install_object_manager(self._om)

    def _on_om_installed(self, _om: Wp.ObjectManager) -> None:
        """Called when the ObjectManager has been fully installed."""
        print('[WpMonitor] Object Manager installed, monitoring active.')

    def stop(self) -> None:
        """Disconnect from PipeWire and release resources."""
        if self._core is not None:
            self._core.disconnect()
            self._core = None
        self._om = None
        self._nodes.clear()
        self._devices.clear()

    def get_audio_nodes(self) -> list[dict]:
        """Returns a snapshot of currently tracked audio nodes."""
        return list(self._nodes.values())

    def get_devices(self) -> list[dict]:
        """Returns a snapshot of currently tracked devices."""
        return list(self._devices.values())

    def get_device_global_id(self, device_name: str) -> int | None:
        """Returns the PipeWire global ID for *device_name*, or None."""
        dev = self._devices.get(device_name)
        return dev['global_id'] if dev else None

    # ── internal callbacks ────────────────────────────────────────────────

    def _on_object_added(self, _om: Wp.ObjectManager, proxy: Wp.Proxy) -> None:
        if isinstance(proxy, Wp.Node):
            self._on_node_added(proxy)
        elif isinstance(proxy, Wp.Device):
            self._on_device_added(proxy)

    @staticmethod
    def _proxy_properties(proxy: Wp.Proxy) -> Wp.Properties:
        return _fetch_node_props(proxy)

    def _on_node_added(self, node: Wp.Node) -> None:
        props = _fetch_node_props(node)
        name = props.get('node.name') or ''
        description = props.get('node.description') or name
        media_class = props.get('media.class') or ''

        if not name or media_class not in _AUDIO_MEDIA_CLASSES:
            return

        self._nodes[name] = {
            'name': name,
            'description': description,
            'media_class': media_class,
        }
        print(f'[WpMonitor] Node added: {name!r} ({media_class})')
        self.emit('node-added', name, description, media_class)

    def _on_device_added(self, device: Wp.Device) -> None:
        props = self._proxy_properties(device)
        name = props.get('device.name') or ''
        description = props.get('device.description') or name

        if not name:
            return

        try:
            global_id = device.get_bound_id()
        except Exception:
            global_id = 0

        self._devices[name] = {
            'name': name,
            'description': description,
            'global_id': global_id,
        }
        print(f'[WpMonitor] Device added: {name!r} global_id={global_id}')
        self.emit('device-added', name, description, global_id)

    def _on_object_removed(self, _om: Wp.ObjectManager, proxy: Wp.Proxy) -> None:
        if isinstance(proxy, Wp.Node):
            self._on_node_removed(proxy)
        elif isinstance(proxy, Wp.Device):
            self._on_device_removed(proxy)

    def _on_node_removed(self, node: Wp.Node) -> None:
        props = _fetch_node_props(node)
        name = props.get('node.name') or ''
        if name in self._nodes:
            del self._nodes[name]
            print(f'[WpMonitor] Node removed: {name!r}')
            self.emit('node-removed', name)

    def _on_device_removed(self, device: Wp.Device) -> None:
        props = _fetch_node_props(device)
        name = props.get('device.name') or ''
        if name in self._devices:
            del self._devices[name]
            print(f'[WpMonitor] Device removed: {name!r}')
            self.emit('device-removed', name)


def _collect_node(props: Wp.Properties) -> dict | None:
    """Extract audio node info from a Wp.Properties, or return None."""
    name = props.get('node.name') or ''
    if not name:
        return None
    media_class = props.get('media.class') or ''
    if media_class not in _AUDIO_MEDIA_CLASSES:
        return None
    return {
        'name': name,
        'description': props.get('node.description') or name,
        'media_class': media_class,
    }


def _fetch_node_props(obj: Wp.Proxy) -> Wp.Properties:
    """Safely retrieve a proxy's Wp.Properties, handling GI binding quirks."""
    try:
        return obj.get_properties()
    except TypeError:
        return obj.props.properties or Wp.Properties.new_empty()


_proxy_properties = _fetch_node_props


def get_audio_nodes_sync(callback: callable | None = None, timeout_ms: int = 2000) -> list[dict] | None:
    """Query current PipeWire audio nodes.

    Uses `wpctl status` + `wpctl inspect` to enumerate all sinks and sources
    with their display descriptions and technical node names. This works
    reliably without requiring a WirePlumber DBus connection.

    If *callback* is given, delivers the node list asynchronously (fire-and-forget).
    """
    raw = _fetch_nodes_from_wpctl()
    if callback is None:
        return raw

    GLib.idle_add(lambda: (callback(raw), False))
    return None


def _fetch_nodes_from_wpctl() -> list[dict]:
    """Enumerate audio nodes via `wpctl status` + `wpctl inspect`.

    Parses the Sinks/Sources sections of `wpctl status` to find node IDs,
    then calls `wpctl inspect <id>` on each to retrieve `node.name` and
    `node.description` — the technical names needed for profile matching.
    Returns a list of node dicts with name, description, media_class.
    """
    results: list[dict] = []
    seen_ids: set[int] = set()

    try:
        status = subprocess.run(
            ['wpctl', 'status'],
            capture_output=True, text=True, check=True, timeout=5,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []

    in_sinks = False
    in_sources = False

    for line in status.stdout.splitlines():
        stripped = line.strip()
        if stripped in ('Sinks:', '├─ Sinks:', '└─ Sinks:'):
            in_sinks = True
            in_sources = False
            continue
        if stripped in ('Sources:', '├─ Sources:', '└─ Sources:'):
            in_sources = True
            in_sinks = False
            continue

        if not line.startswith(' │'):
            in_sinks = False
            in_sources = False
            continue

        # Lines like: " │  *   48. JLab GO Air Pop                     [vol: 0.49]"
        m = re.match(r'\s+│\s+(?:\*\s*)?(\d+)\.\s+(.+?)(?:\s+\[.*\])?$', line)
        if not m:
            continue

        node_id = int(m.group(1))
        if node_id in seen_ids:
            continue
        seen_ids.add(node_id)

        description = m.group(2).strip()
        media_class = 'Audio/Sink' if in_sinks else 'Audio/Source'

        name = description  # provisional; upgrade below
        try:
            inspect = subprocess.run(
                ['wpctl', 'inspect', str(node_id)],
                capture_output=True, text=True, check=True, timeout=3,
            )
            for iline in inspect.stdout.splitlines():
                if 'node.name' in iline:
                    _, _, val = iline.partition('=')
                    name = val.strip().strip('"')
                    break
                if 'node.description' in iline and not description:
                    _, _, desc_val = iline.partition('=')
                    description = desc_val.strip().strip('"')
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass

        results.append({
            'name': name,
            'description': description,
            'media_class': media_class,
        })

    return results
