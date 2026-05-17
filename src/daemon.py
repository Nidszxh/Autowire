"""Routing engine for Autowire.

Listens to WpMonitor node-added signals and applies matching profile rules
by calling wpctl set-default for the configured sink and source nodes.

set_system_default() uses wpctl as its backend because:
  - wpctl is shipped with every WirePlumber installation
  - The DefaultNodes metadata API requires elevated WP permissions
  - subprocess is explicit and easy to test/mock
"""

from __future__ import annotations

import subprocess

from . import config_mgr
from .wp_monitor import WpMonitor


def set_system_default(node_name: str) -> bool:
    """Routes audio to *node_name* via `wpctl set-default`.

    Returns True on success, False if wpctl reported an error.
    """
    if not node_name:
        return False
    try:
        subprocess.run(
            ['wpctl', 'set-default', node_name],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        print(f'[Daemon] Default set to: {node_name!r}')
        return True
    except subprocess.CalledProcessError as exc:
        print(f'[Daemon] wpctl error for {node_name!r}: {exc.stderr.strip()}')
        return False
    except FileNotFoundError:
        print('[Daemon] ERROR: wpctl not found. Is WirePlumber installed?')
        return False
    except subprocess.TimeoutExpired:
        print(f'[Daemon] wpctl timed out for {node_name!r}')
        return False


def check_and_route_device(connected_node_name: str) -> bool:
    """Matches *connected_node_name* against saved profiles and applies actions.

    Returns True if a matching profile was found and actions were fired.
    """
    profiles = config_mgr.load_profiles()

    for profile in profiles:
        if profile.get('trigger_device_name') != connected_node_name:
            continue

        print(f'[Daemon] Matched profile: {profile["profile_name"]!r}')
        actions = profile.get('actions', {})

        sink = actions.get('default_sink', '')
        source = actions.get('default_source', '')

        if sink:
            set_system_default(sink)
        if source:
            set_system_default(source)

        return True

    return False


def build_monitor() -> WpMonitor:
    """Creates and wires a WpMonitor ready to start."""
    monitor = WpMonitor()
    monitor.connect('node-added', _on_node_added)
    return monitor


def _on_node_added(
    _monitor: WpMonitor,
    name: str,
    _description: str,
    _media_class: str,
) -> None:
    """Signal handler: called on GLib main loop when a new audio node appears."""
    check_and_route_device(name)
