"""Routing engine for Autowire.

Listens to WpMonitor node-added / device-added signals and applies matching
profile rules by calling:
  - wpctl set-default for the configured sink/source nodes
  - wpctl set-profile for the configured Bluetooth card profile

set_system_default() and set_bt_profile() use wpctl as their backend because:
  - wpctl is shipped with every WirePlumber installation
  - The DefaultNodes metadata API requires elevated WP permissions
  - subprocess is explicit and easy to test/mock
"""

from __future__ import annotations

import re
import subprocess
import time

from . import config_mgr
from .wp_monitor import WpMonitor

# Regex to extract the Bluetooth MAC address from a node name like:
#   bluez_output.XX_XX_XX_XX_XX_XX.a2dp-sink
_BT_NODE_RE = re.compile(
    r'^bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})\..+'
)

_last_routed: dict[str, float] = {}
_ROUTING_COOLDOWN = 5.0


def _bt_card_name(node_name: str) -> str | None:
    """Derive the Bluetooth card name from a node name, or None."""
    m = _BT_NODE_RE.match(node_name)
    if m:
        return f'bluez_card.{m.group(1)}'
    return None


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


def set_bt_profile(device_global_id: int, profile_name: str) -> bool:
    """Forces *profile_name* on the Bluetooth card identified by *device_global_id*.

    Uses `wpctl set-profile <id> <profile>` to override WirePlumber's automatic
    profile selection (e.g. forcing A2DP AAC instead of HSP/HFP mSBC).

    Returns True on success.
    """
    if not profile_name or device_global_id <= 0:
        return False
    try:
        subprocess.run(
            ['wpctl', 'set-profile', str(device_global_id), profile_name],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        print(f'[Daemon] BT profile set: device={device_global_id} profile={profile_name!r}')
        return True
    except subprocess.CalledProcessError as exc:
        print(f'[Daemon] wpctl set-profile error: {exc.stderr.strip()}')
        return False
    except FileNotFoundError:
        print('[Daemon] ERROR: wpctl not found. Is WirePlumber installed?')
        return False
    except subprocess.TimeoutExpired:
        print(f'[Daemon] wpctl set-profile timed out for device={device_global_id}')
        return False


def check_and_route_device(
    connected_node_name: str,
    monitor: WpMonitor | None = None,
) -> bool:
    """Matches *connected_node_name* against saved profiles and applies actions.

    Debounces rapid repeated events for the same node (5 s cooldown).
    When a profile has *bt_profile* set, the daemon also looks up the
    associated Bluetooth card via the monitor and switches its codec profile.

    Returns True if a matching profile was found and actions were fired.
    """
    now = time.monotonic()
    last = _last_routed.get(connected_node_name, 0)
    if now - last < _ROUTING_COOLDOWN:
        print(f'[Daemon] Cooldown active for {connected_node_name!r}, skipping.')
        return False

    profiles = config_mgr.load_profiles()
    matched = False

    for profile in profiles:
        if profile.get('trigger_device_name') != connected_node_name:
            continue
        if not profile.get('is_active'):
            continue

        matched = True
        print(f'[Daemon] Matched profile: {profile["profile_name"]!r}')
        actions = profile.get('actions', {})

        sink = actions.get('default_sink', '')
        source = actions.get('default_source', '')

        if sink:
            set_system_default(sink)
        if source:
            set_system_default(source)

        bt_profile = actions.get('bt_profile', '')
        if bt_profile and monitor:
            card_name = _bt_card_name(connected_node_name)
            if card_name:
                global_id = monitor.get_device_global_id(card_name)
                if global_id and global_id > 0:
                    set_bt_profile(global_id, bt_profile)

    if matched:
        _last_routed[connected_node_name] = now
    return matched


def build_monitor() -> WpMonitor:
    """Creates and wires a WpMonitor ready to start."""
    monitor = WpMonitor()
    monitor.connect('node-added', _on_node_added)
    monitor.connect('device-added', _on_device_added)
    return monitor


def _on_node_added(
    monitor: WpMonitor,
    name: str,
    _description: str,
    _media_class: str,
) -> None:
    """Signal handler: called on GLib main loop when a new audio node appears."""
    check_and_route_device(name, monitor)


def _on_device_added(
    _monitor: WpMonitor,
    name: str,
    _description: str,
    _global_id: int,
) -> None:
    """Signal handler: called when a new device (e.g. Bluetooth card) appears."""
    if name.startswith('bluez_card.'):
        print(f'[Daemon] Bluetooth device detected: {name!r}')
