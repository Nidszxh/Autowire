# Autowire Architecture

Detailed reference for contributors and reviewers. For a quick overview, see `README.md`.

---

## Two Entrypoints

Autowire is two separate processes that communicate only through a shared JSON file.

| Process | Entry point (GJS) | Dependencies |
|---|---|---|
| **UI** | `gjs -I src/ src/main.js` | GTK 4, Adwaita, WirePlumber |
| **Daemon** | `gjs -I src/ src/daemon_main.js` | GLib only (no GTK, no Adw) |

No build step required — the UI builds its widgets programmatically.

---

## Module Map (GJS)

### `config_mgr.js`
Manages `~/.config/autowire/profiles.json`.

- `load_profiles()` → `Array<Object>` — reads JSON, migrates old entries (adds `is_active: false`), returns `[]` on any error
- `save_profile(name, trigger, sink, source, bt_profile='', is_active=false, bt_profile_call='', auto_switch=false)` — upserts by `(trigger, name)`; if `is_active=true`, deactivates all siblings for that trigger first
- `get_profile(trigger, name)` → `Object | null`
- `get_profiles_for_trigger(trigger)` → `Array<Object>`
- `get_active_profile(trigger)` → `Object | null`
- `set_active_profile(trigger, name)` — deactivates all siblings for that trigger, activates the named one
- `delete_profile(trigger, name)` → `boolean`
- `initialize_config()` — creates dir + empty file if absent

Atomic writes: `GLib.dir_make_tmp()` → `GLib.file_set_contents()` → `GLib.rename()`. Crash-safe.

### `daemon.js`
Core routing logic + stream-aware capture switching.

- `set_system_default(node_name)` → `boolean` — resolves node name to numeric PW ID via `wpctl inspect`, then `wpctl set-default <id>`
- `set_bt_profile(device_global_id, profile_name)` → `boolean` — `wpctl set-profile <id> <profile>`
- `check_and_route_device(node_name, monitor)` → `boolean` — loads profiles, **skips any where `is_active != true`**, checks `_active_capture_nodes` for BT profile selection, fires routing actions on the first matching active profile
- `handle_capture_started(node_name, monitor)` — cancels restore timer, switches to `bt_profile_call`
- `handle_capture_stopped(node_name, monitor)` — starts 3s debounce, on expiry restores `bt_profile`
- `build_monitor()` → `WpMonitor` — creates monitor wired with `node-added`, `device-added`, `capture-started`, `capture-stopped` signals
- `_bt_card_name(node_name)` — derives `bluez_card.XX_XX_...` from `bluez_output.XX_XX_...`
- `_resolve_node_id(node_name)` — parses `wpctl status` for numeric IDs, `wpctl inspect`s each to match `node.name`
- `_last_routed` dict + 5s cooldown, `_capture_timers` dict + 3s debounce

### `wp_monitor.js`
Poll-based `Wp.Core` wrapper. GJS Wp bindings cannot read proxy properties, so polling via `wpctl status` + `wpctl inspect` is used instead of `Wp.ObjectManager`.

- `WpMonitor.start()` → `Wp.Core.connect('connected')` → `_on_core_connected()` → `_poll()` every 3s
- `_poll()` runs `_poll_nodes()`, `_poll_devices()`, `_poll_streams()`
- `_poll_nodes()` — parses `wpctl status` Sinks/Sources, `wpctl inspect`s each for `node.name` + `node.description`
- `_poll_devices()` — parses Devices section from `wpctl status`
- `_poll_streams()` — parses Streams section, detects `input_*` sub-entries, maps target descriptions to node names via `_desc_to_name`, maintains `_capture_counts` per node
- Emits GObject signals: `node-added(name, desc, media_class)`, `node-removed(name)`, `device-added(name, desc, global_id)`, `device-removed(name)`, `capture-started(name)`, `capture-stopped(name)`, `ready`
- `get_device_global_id(name)` → `number | null`
- `get_audio_nodes()` → `Array<Object>`

Also exports `get_audio_nodes_sync(callback?)`:
- Uses `wpctl status` + `wpctl inspect` for each node
- Returns `Array<Object>` synchronously, or fires callback via `GLib.idle_add` if provided

### `daemon_main.js`
Daemon entry point (GLib only, zero GTK imports).

1. Builds `WpMonitor` via `daemon.build_monitor()` and starts it
2. Installs `Gio.File.monitor()` on `profiles.json` → re-routes all active nodes on any change
3. Connects to `monitor`'s `ready` signal and routes already-connected devices once ObjectManager is installed
4. Runs `GLib.MainLoop` indefinitely
5. Handles SIGTERM/SIGINT via `GLibUnix.signal_add()` for clean shutdown

### `main.js`
GTK UI entry point.

- `AutowireApplication` — `Adw.Application` subclass; `vfunc_activate()` shows or creates `AutowireWindow`

### `window.js`
`AutowireWindow` — shows the profile list from `profiles.json`, grouped by trigger device.

- `refresh_profiles()` — clears and rebuilds `Adw.PreferencesGroup` hierarchy from disk. Shows empty page if no profiles exist.
- `_group_by_trigger(profiles)` — groups profiles by `trigger_device_name` into nested `Adw.PreferencesGroup` per trigger
- `_build_profile_row(profile, has_siblings)` — `Adw.ActionRow` with: `Gtk.Switch` for active state, Edit button (if single profile), Delete button (always)
- `_on_switch_toggled(switch, profile)` — toggles `config_mgr.set_active_profile()` on/off and refreshes
- Delete → `Adw.AlertDialog({heading, body})` confirmation → `config_mgr.delete_profile()`

### `profile_dialog.js`
`ProfileDialog` — `Adw.Dialog` for create/edit.

- Shows loading spinner immediately (async device fetch)
- Device lists loaded via `GLib.idle_add` → `get_audio_nodes_sync()` → `_on_devices_loaded()`
- `_on_devices_loaded()` sets `Gtk.StringList` models on ComboRows, then schedules an idle callback for `_validate()` + `_prefill()` (deferred until model change propagates)
- `_prefill(profile)` — pre-selects trigger/sink/source/BT-profile/Call-BT-profile/auto-switch based on saved values
- `_validate()` enables Save only when name is non-empty AND trigger is selected
- `_on_save()` reads all selections including `bt_profile_call` and `auto_switch`, calls `config_mgr.save_profile()`, emits `profile-saved`, closes

---

## Data Flow

```
User opens ProfileDialog
    └─► GLib.idle_add → get_audio_nodes_sync() via wpctl
            └─► results → _on_devices_loaded()
                            └─► ComboRow models set
                                    └─► GLib.idle_add → _on_devices_loaded_idle()
                                            └─► _validate() + _prefill()

User clicks Save
    └─► config_mgr.save_profile(..., is_active) writes profiles.json (atomic)
            └─► Daemon's GLib.FileMonitor detects change
                    └─► re-routes all active nodes (config file change path)

Device connects (USB/BT/HDMI)
    └─► WirePlumber creates WpNode
            └─► WpMonitor polls → detects new node
                    └─► daemon.check_and_route_device()
                            ├► 5s cooldown check
                            ├► load_profiles() → filter is_active=True for this trigger
                            ├► (if auto_switch + active capture → use bt_profile_call)
                            ├► wpctl set-default <sink>
                            ├► wpctl set-default <source>
                            └► if bt_profile: wpctl set-profile <id> <codec>

App starts/stops mic capture
    └─► WpMonitor._poll_streams() detects input_* stream
            ├► 0→1 transition → emit 'capture-started'
            │       └─► daemon.handle_capture_started()
            │               ├► cancel pending restore timer
            │               └► wpctl set-profile <id> <bt_profile_call>
            └► 1→0 transition → emit 'capture-stopped'
                    └─► daemon.handle_capture_stopped()
                            └► 3s debounce timer
                                    └► if no new capture → wpctl set-profile <id> <bt_profile>

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
      "profile_name": "BT Headset",
      "trigger_device_name": "bluez_output.0F_56_51_19_26_87.1",
      "is_active": true,
      "actions": {
        "default_sink": "bluez_output.0F_56_51_19_26_87.1",
        "default_source": "",
        "bt_profile": "a2dp-sink-aac",
        "bt_profile_call": "handsfree-headset",
        "auto_switch": true
      }
    }
  ]
}
```

- `trigger_device_name`: matched against `node.name` from WirePlumber (the technical PipeWire name, not the display description)
- `is_active`: only one profile per trigger can be `true`. The daemon fires only active profiles. Saving with `is_active=true` auto-deactivates all siblings for the same trigger.
- `default_sink` / `default_source`: node names for `wpctl set-default`
- `bt_profile`: optional. Valid values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`. Empty = don't touch BT profile.
- `bt_profile_call`: optional. BT profile to switch to when capture is active (call mode). Typically `handsfree-headset`. Only used when `auto_switch: true`.
- `auto_switch`: boolean. When `true`, daemon monitors capture streams and auto-switches between `bt_profile` and `bt_profile_call` based on mic activity.

---

## Flatpak Permissions

| Finish arg | Purpose |
|---|---|
| `--share=ipc` | Shared memory for X11/Wayland |
| `--socket=wayland` | GTK display |
| `--socket=fallback-x11` | X11 fallback |
| `--socket=pulseaudio` | Audio access via PulseAudio/PipeWire |
| `--talk-name=org.freedesktop.WirePlumber` | Direct WirePlumber D-Bus access |
| `--share=network` | D-Bus session bus access |

---

## Autostart

**System install:** `postinstall.py` copies `io.github.nidszxh.Autowire.Daemon.service` to `~/.config/systemd/user/` and runs `systemctl --user enable --now`.

**Flatpak:** `io.github.nidszxh.Autowire.service` (D-Bus session service) tells the D-Bus session bus to launch `autowire-daemon` on login. No systemd needed inside the sandbox.

---

## Key Quirks

- **`Adw.PreferencesGroup` title via constructor is broken in GTK4** — always use `set_title()` after construction.
- **`Adw.AlertDialog` constructor requires plain object** — `new Adw.AlertDialog({heading, body})`, not positional arguments.
- **GJS Wp bindings cannot read proxy properties** — `Proxy.get_properties()` returns null, `props.properties` is undefined. All node/device data is obtained via `wpctl status` + `wpctl inspect` subprocess polling instead.
- **Polling interval** is 3s by default (`_POLL_INTERVAL_MS`). The poll runs `_poll_nodes()`, `_poll_devices()`, and `_poll_streams()` every cycle.
- **Capture stream detection** uses a regex on `wpctl status` Streams sub-entries: `input_<port>.*> <description>:<port> [active|init]`. Target descriptions are mapped to node names via `_desc_to_name`, built during node polling from each node's `description` → `name`.
- **Debounce on capture-stopped** is 3s (`_CAPTURE_DEBOUNCE_MS`) to tolerate push-to-talk mic gaps. A new `capture-started` during debounce cancels the timer.
- **`wpctl set-default` requires numeric ID** on PipeWire 1.6.5 — `_resolve_node_id()` parses `wpctl status` for candidate IDs, then `wpctl inspect`s each to match `node.name`.
- **`wpctl set-profile` requires PW global ID** (numeric), not a node or device name. Use `WpMonitor.get_device_global_id('bluez_card.XX_XX_...')` to resolve.
- **Cooldown** is per-node-name, not global. Rapid plug/unplug cycles on *different* devices all fire immediately.
- **Config file watcher** uses `Gio.File.new_for_path(path).monitor()` (GJS 1.80+ API, not `Gio.FileMonitor.new_for_path`).
- **Signal handling** uses `GLibUnix.signal_add()` with numeric signals (GJS 1.80+ API, not `GLib.unix_signal_add`).
- **capture-started/stopped signals** only fire on 0→1 / 1→0 transitions (never repeated for same state). Daemon can safely react to each event once.