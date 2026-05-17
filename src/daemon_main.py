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

from .daemon import build_monitor


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

    print('[Daemon] Connected to PipeWire. Listening for device events…')

    try:
        loop.run()
    finally:
        monitor.stop()
        print('[Daemon] Stopped.')

    return 0


if __name__ == '__main__':
    sys.exit(main())
