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
    }

    def __init__(self) -> None:
        super().__init__()
        self._core: Wp.Core | None = None
        self._om: Wp.ObjectManager | None = None
        # name → {name, description, media_class}
        self._nodes: dict[str, dict] = {}

    # ── public API ────────────────────────────────────────────────────────

    def start(self) -> None:
        """Connect to PipeWire and begin monitoring. Call once."""
        self._core = Wp.Core.new(None, None)
        self._core.connect()

        self._om = Wp.ObjectManager.new()
        # Track all Node objects; we filter to audio classes in the callback
        node_type = GObject.type_from_name('WpNode')
        interest = Wp.ObjectInterest.new_type(node_type)
        self._om.add_interest_full(interest)

        self._om.connect('object-added', self._on_object_added)
        self._om.connect('object-removed', self._on_object_removed)

        self._core.install_object_manager(self._om)

    def stop(self) -> None:
        """Disconnect from PipeWire and release resources."""
        if self._core is not None:
            self._core.disconnect()
            self._core = None
        self._om = None
        self._nodes.clear()

    def get_audio_nodes(self) -> list[dict]:
        """Returns a snapshot of currently tracked audio nodes."""
        return list(self._nodes.values())

    # ── internal callbacks ────────────────────────────────────────────────

    def _on_object_added(self, _om: Wp.ObjectManager, node: Wp.Node) -> None:
        name = node.get_property('name') or ''
        description = node.get_property('description') or name
        media_class = node.get_property('media.class') or ''

        if not name or media_class not in _AUDIO_MEDIA_CLASSES:
            return

        self._nodes[name] = {
            'name': name,
            'description': description,
            'media_class': media_class,
        }
        print(f'[WpMonitor] Node added: {name!r} ({media_class})')
        self.emit('node-added', name, description, media_class)

    def _on_object_removed(self, _om: Wp.ObjectManager, node: Wp.Node) -> None:
        name = node.get_property('name') or ''
        if name in self._nodes:
            del self._nodes[name]
            print(f'[WpMonitor] Node removed: {name!r}')
            self.emit('node-removed', name)


def get_audio_nodes_sync() -> list[dict]:
    """One-shot synchronous query of current PipeWire audio nodes.

    Spins a temporary GLib.MainLoop for one iteration to let WirePlumber
    populate the ObjectManager, then returns the collected nodes. Suitable
    for use from the UI thread before the main loop is running.
    """
    results: list[dict] = []
    context = GLib.MainContext.new()
    loop = GLib.MainLoop.new(context, False)

    core = Wp.Core.new(context, None)
    core.connect()

    om = Wp.ObjectManager.new()
    node_type = GObject.type_from_name('WpNode')
    interest = Wp.ObjectInterest.new_type(node_type)
    om.add_interest_full(interest)

    def _on_installed(_om: Wp.ObjectManager) -> None:
        iterator = _om.new_iterator()
        while True:
            result = iterator.next()
            if not result:
                break
            success, obj = result
            if not success or obj is None:
                continue
            name = obj.get_property('name') or ''
            description = obj.get_property('description') or name
            media_class = obj.get_property('media.class') or ''
            if name and media_class in _AUDIO_MEDIA_CLASSES:
                results.append({
                    'name': name,
                    'description': description,
                    'media_class': media_class,
                })
        loop.quit()

    om.connect('installed', _on_installed)
    core.install_object_manager(om)

    # Give WirePlumber up to 2 s to respond, then bail out gracefully
    GLib.timeout_add(2000, loop.quit)
    context.push_thread_default()
    try:
        loop.run()
    finally:
        context.pop_thread_default()
        core.disconnect()

    return results
