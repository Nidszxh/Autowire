# Autowire Architecture

Detailed reference for contributors and reviewers. For a quick overview, see `README.md`.

---

## Two Entrypoints

Autowire is two separate processes that communicate only through a shared JSON file.

| Process | Entry point | Import path (dev) | Import path (installed) | Dependencies |
|---|---|---|---|---|
| **UI** | `_build/src/autowire` | `from src.main import main` | `from autowire.main import main` | GTK 4, Adwaita, WirePlumber |
| **Daemon** | `_build/src/autowire-daemon` | `from src.daemon_main import main` | `from autowire.daemon_main import main` | GLib only (no GTK) |

Both launchers are Meson templates (`src/autowire.in`, `src/autowire-daemon.in`). They detect dev mode by checking for `_build/` artifacts and adjust `sys.path` accordingly.

---

## Module Map

### `config_mgr.py`
Manages `~/.config/autowire/profiles.json`.

- `load_profiles()` → `list[dict]` — reads JSON, migrates old entries (adds `is_active: false`), returns `[]` on any error
- `save_profile(name, trigger, sink, source, bt_profile='', is_active=False)` — upserts by `(trigger, name)`; if `is_active=True`, deactivates all siblings for that trigger first
- `get_profile(trigger, name)` → `dict | None`
- `get_profiles_for_trigger(trigger)` → `list[dict]`
- `get_active_profile(trigger)` → `dict | None`
- `set_active_profile(trigger, name)` — deactivates all siblings for that trigger, activates the named one
- `delete_profile(trigger, name)` → `bool`
- `initialize_config()` — creates dir + empty file if absent

Atomic writes: `tempfile.mkstemp()` → `json.dump()` → `os.replace()`. Crash-safe.

### `daemon.py`
Core routing logic. No GLib imports.

- `set_system_default(node_name)` — `wpctl set-default <name>`, 5s timeout
- `set_bt_profile(device_global_id, profile_name)` — `wpctl set-profile <id> <profile>`, 5s timeout
- `check_and_route_device(node_name, monitor=None)` — loads profiles, **skips any where `is_active != True`**, fires routing actions on the first matching active profile, returns `bool`
- `_bt_card_name(node_name)` — derives `bluez_card.XX_XX_...` from `bluez_output.XX_XX_...`
- `_last_routed` dict + 5s cooldown prevents rapid re-triggering

### `wp_monitor.py`
Wraps `Wp.Core` + `Wp.ObjectManager` for the daemon's live event stream.

- `WpMonitor.start()` → `Wp.Core.connect('connected')` → `_on_core_connected()`
- Installs `Wp.ObjectManager` filtering `WpNode` (audio sinks/sources/duplex) and `WpDevice` (all)
- Emits GObject signals: `node-added`, `node-removed`, `device-added`, `device-removed`
- `get_device_global_id(name)` — looks up `device.name` → `get_bound_id()` for `wpctl set-profile`
- `_proxy_properties(proxy)` — safe wrapper for `proxy.get_properties()` with `TypeError` fallback

Also exports `get_audio_nodes_sync(callback=None)`:
- Uses `wpctl status` + `wpctl inspect <id>` for each node (no WirePlumber GObject needed)
- Returns `list[dict]` with `name` (PipeWire technical name, e.g. `bluez_output.XX_XX_...`), `description` (user-facing label, e.g. `JLab GO Air Pop`), `media_class` (`Audio/Sink`, `Audio/Source`, `Audio/Duplex`)
- If `callback` is passed, fires it via `GLib.idle_add` and returns `None`
- Takes ~0.2s; falls back to `wpctl` parsing if WirePlumber connection fails

### `daemon_main.py`
Daemon entry point (GLib only, zero GTK imports).

1. Builds `WpMonitor` and starts it
2. Installs `GLib.FileMonitor` on `profiles.json` → re-routes all active nodes on any change
3. Connects to `monitor`'s `ready` signal and routes already-connected devices once the ObjectManager is installed
4. Runs `GLib.MainLoop` indefinitely
5. Handles SIGTERM/SIGINT for clean shutdown

### `main.py`
GTK UI entry point.

- `_load_resources()` — registers the compiled GResource bundle from one of three paths (installed, `_build/`, or alongside source)
- `AutowireApplication` — `Adw.Application` subclass; `do_activate()` shows or creates `AutowireWindow`

### `window.py`
`AutowireWindow` — shows the profile list from `profiles.json`, grouped by trigger device.

- `refresh_profiles()` — clears and rebuilds `Adw.PreferencesGroup` hierarchy from disk. Shows empty page if no profiles exist.
- `_group_by_trigger(profiles)` — groups profiles by `trigger_device_name` into nested `Adw.PreferencesGroup` per trigger
- `_build_profile_row(profile, has_siblings)` — `Adw.ActionRow` with: `Gtk.Switch` for active state, Edit button (if single profile), Delete button (always)
- `_on_switch_toggled(switch, _pspec, profile)` — toggles `config_mgr.set_active_profile()` on/off and refreshes
- Delete → `Adw.AlertDialog` confirmation → `config_mgr.delete_profile()`

### `profile_dialog.py`
`ProfileDialog` — `Adw.Dialog` for create/edit.

- Shows loading spinner immediately (async device fetch)
- Device lists loaded via `threading.Thread` → `get_audio_nodes_sync()` → `GLib.idle_add` → `_on_devices_loaded()`
- `_on_devices_loaded()` sets `Gtk.StringList` models on ComboRows, then schedules `_on_devices_loaded_idle()` via `GLib.idle_add()` to defer `_validate()` and `_prefill()` until after the model change propagates
- `_prefill(profile)` — pre-selects trigger/sink/source/BT-profile based on saved values; reads `is_active` from the profile
- `_validate()` enables Save only when name is non-empty AND trigger is selected
- `_on_save()` reads all selections including the `is_active` SwitchRow, calls `config_mgr.save_profile()`, emits `profile-saved`, closes

---

## Data Flow

```
User opens ProfileDialog
    └─► _load_devices_async() spawns threading.Thread
            └─► get_audio_nodes_sync() via wpctl
                    └─► results → GLib.idle_add → _on_devices_loaded()
                            └─► ComboRow models set
                                    └─► GLib.idle_add → _on_devices_loaded_idle()
                                            └─► _validate() + _prefill()

User clicks Save
    └─► config_mgr.save_profile(..., is_active) writes profiles.json (atomic)
            └─► Daemon's GLib.FileMonitor detects change
                    └─► re-routes all active nodes (config file change path)

Device connects (USB/BT/HDMI)
    └─► WirePlumber creates WpNode
            └─► WpMonitor._on_node_added() signal
                    └─► daemon.check_and_route_device()
                            ├► 5s cooldown check
                            ├► load_profiles() → filter is_active=True for this trigger
                            ├► wpctl set-default <sink>
                            ├► wpctl set-default <source>
                            └► if bt_profile: wpctl set-profile <id> <codec>

Daemon startup
    └─► for each node in monitor.get_audio_nodes():
            └─► check_and_route_device(node_name, monitor)
```

---

## Profiles JSON Schema

```json
{
  "profiles": [
    {
      "profile_name": "Desk Setup",
      "trigger_device_name": "bluez_output.0F_56_51_19_26_87.a2dp-sink",
      "is_active": true,
      "actions": {
        "default_sink": "bluez_output.0F_56_51_19_26_87.a2dp-sink",
        "default_source": "alsa_input.usb-dock-mic.analog-stereo",
        "bt_profile": "a2dp-sink-aac"
      }
    }
  ]
}
```

- `trigger_device_name`: matched against `node.name` from WirePlumber (the technical PipeWire name, not the display description)
- `is_active`: only one profile per trigger can be `true`. The daemon fires only active profiles. Saving with `is_active=true` auto-deactivates all siblings for the same trigger.
- `default_sink` / `default_source`: node names for `wpctl set-default`
- `bt_profile`: optional. Valid values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`. Empty = don't touch BT profile.

---

## Flatpak Permissions

| Finish arg | Purpose |
|---|---|
| `--socket=pipewire-0` | PipeWire portal — lets the app talk to the audio server |
| `--talk-name=org.freedesktop.WirePlumber` | Direct WirePlumber D-Bus access |
| `--filesystem=/usr/bin/wpctl:ro` | `wpctl` command for device enumeration |
| `--socket=wayland` | GTK display |
| `--socket=fallback-x11` | X11 fallback |
| `--system-talk-name=org.freedesktop.login1` | Power management (suspend/resume) |

---

## Autostart

**System install:** `postinstall.py` copies `io.github.nidszxh.Autowire.Daemon.service` to `~/.config/systemd/user/` and runs `systemctl --user enable --now`.

**Flatpak:** `io.github.nidszxh.Autowire.service` (D-Bus session service) tells the D-Bus session bus to launch `autowire-daemon` on login. No systemd needed inside the sandbox.

---

## Key Quirks

- **`Adw.PreferencesGroup` title via constructor is broken in GTK4** — always use `set_title()` after construction.
- **`wpctl inspect`** returns Device-type objects (no `node.name`) for hardware cards (e.g. ALSA card 59). Only Node-type objects have `node.name`. The UI displays the description string which is human-readable.
- **`get_audio_nodes_sync()`** does not use `GLib.MainLoop` internally — Python 3.14's GLib binding has a bug where timers don't fire in private contexts. The wpctl subprocess approach is reliable and ~0.2s fast.
- **Cooldown** is per-node-name, not global. Rapid plug/unplug cycles on *different* devices all fire immediately.
- **Config file watcher** runs inside the daemon's `GLib.MainLoop` and re-routes ALL active nodes (not just the changed one) to handle profile edits made while devices are already connected.
- **`Proxy.get_properties()` may raise `TypeError`** on some Wp 0.5 builds. Use `_proxy_properties(proxy)` which falls back to `proxy.props.properties` on `TypeError`.