"""Standalone entry point for the Autowire background daemon.

This module contains no GTK imports. It is invoked by the systemd user
service unit (autowire-daemon) and runs a GLib.MainLoop indefinitely,
listening for WirePlumber node events and applying audio routing rules.

Signals handled:
  SIGTERM / SIGINT — clean shutdown via loop.quit()
"""

from __future__ import annotations

import signal
import sys

import gi
gi.require_version('GLib', '2.0')

from gi.repository import GLib

from . import config_mgr
from .daemon import build_monitor, check_and_route_device


def _watch_config_file(loop: GLib.MainLoop) -> None:
    """Watch profiles.json for changes and re-apply routing for all active nodes."""
    try:
        mon = GLib.FileMonitor.new_for_path(config_mgr.CONFIG_FILE)
    except Exception as exc:
        print(f'[Daemon] WARNING: could not create config file monitor: {exc}')
        return

    def _on_changed(
        _mon: GLib.FileMonitor,
        _file: GLib.File,
        _other: GLib.File | None,
        _event: GLib.FileMonitorEvent,
    ) -> None:
        print('[Daemon] profiles.json changed, re-applying routing…')
        from .wp_monitor import WpMonitor
        mon2 = build_monitor()
        try:
            mon2.start()
        except Exception:
            return
        for node in mon2.get_audio_nodes():
            check_and_route_device(node.get('name', ''), mon2)
        mon2.stop()

    mon.connect('changed', _on_changed)
    mon.set_rate_limit(2000)
    print('[Daemon] Config file watcher installed.')


def main() -> int:
    print('[Daemon] Autowire audio routing daemon starting…')

    loop = GLib.MainLoop()

    def _shutdown(sig: int, _frame: object) -> None:  # type: ignore[type-arg]
        print(f'[Daemon] Received signal {sig}, shutting down…')
        loop.quit()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    monitor = build_monitor()
    try:
        monitor.start()
    except Exception as exc:
        print(f'[Daemon] Failed to connect to WirePlumber: {exc}', file=sys.stderr)
        return 1

    _watch_config_file(loop)

    print('[Daemon] Connected to PipeWire. Routing already-connected devices…')
    for node in monitor.get_audio_nodes():
        check_and_route_device(node.get('name', ''), monitor)

    print('[Daemon] Listening for device events…')

    try:
        loop.run()
    finally:
        monitor.stop()
        print('[Daemon] Stopped.')

    return 0


if __name__ == '__main__':
    sys.exit(main())