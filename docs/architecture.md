# Autowire Architecture

Detailed reference for contributors and reviewers. For a quick overview, see `README.md`.

---

## Two Entrypoints

Autowire is two separate processes that communicate only through a shared JSON file.

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────────────────────┐      ┌─────────────────────────┐  │
│  │       UI             │      │       DAEMON             │  │
│  │  main.js + window.js │      │  daemon_main.js          │  │
│  │  profile_dialog.js   │      │  daemon.js + wp_monitor.js│ │
│  │                      │      │                         │  │
│  │  GTK4 + Adwaita      │      │  GLib-only (no GTK)     │  │
│  │  gjs -I src/         │      │  gjs -I src/            │  │
│  │  src/main.js         │      │  src/daemon_main.js     │  │
│  └──────────┬───────────┘      └──────────┬──────────────┘  │
│             │                              │                 │
│             └──────────┬───────────────────┘                 │
│                        ▼                                    │
│              ~/.config/autowire/                             │
│                  profiles.json                               │
│             (UI writes, Daemon watches)                      │
└──────────────────────────────────────────────────────────────┘
```

| Process | Entry point (GJS) | Dependencies |
|---|---|---|
| **UI** | `gjs -I src/ src/main.js` | GTK 4, Adwaita (Wp optional — falls back to poll-only) |
| **Daemon** | `gjs -I src/ src/daemon_main.js` | GLib only (no GTK, no Adw, Wp optional) |

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

- `set_system_default(node_name)` → `boolean` — resolves node name to numeric PW ID via `wpctl inspect`, then `wpctl set-default <id>`. If `node_name` is empty and device is a BT headset, auto-discovers the sink/source from the `bluez_card.MAC`.
- `set_bt_profile(device_global_id, profile_name)` → `boolean` — `wpctl set-profile <id> <profile>`
- `check_and_route_device(node_name, monitor)` → `boolean` — loads profiles, **skips any where `is_active != true`**, fires routing actions on the first matching active profile. Initial routing always uses `bt_profile`; capture-aware switching is handled by `handle_capture_started`/`handle_capture_stopped`
- `handle_capture_started(node_name, monitor)` — cancels restore timer, routes BT mic as default source, switches to `bt_profile_call`
- `handle_capture_stopped(node_name, monitor)` — starts 3s debounce, on expiry restores `bt_profile` and re-routes BT sink as default
- `build_monitor()` → `WpMonitor` — creates monitor wired with `node-added`, `device-added`, `capture-started`, `capture-stopped` signals
- `_get_active_profile_for(node_name)` → `Object | null` — tries exact `trigger_device_name == node_name` match, then falls back to BT card match: finds any active profile whose trigger shares the same `bluez_card.MAC`
- `_bt_card_equal(a, b)` → `boolean` — compares two `bluez_card.XX` names for equality
- `_bt_card_name(node_name)` → `string | null` — derives `bluez_card.XX_XX_...` from `bluez_output.XX_XX_...` or `bluez_input.XX_XX_...`
- `_resolve_node_id(node_name)` → `number | null` — parses `wpctl status` for numeric IDs, `wpctl inspect`s each to match `node.name`
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

Also exports `get_audio_nodes_sync()`:
- Synchronous version using `wpctl status` + `wpctl inspect` for each node
- Returns `Array<Object>` directly (blocks ~0.2s)

Also exports `get_audio_nodes_async(callback)`:
- Same data via `Gio.Subprocess.communicate_utf8_async()` (non-blocking)
- Calls `callback(nodes)` on completion, or `callback([])` on error

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
- Device lists loaded via `get_audio_nodes_async()` with a 3s timeout; falls back to synchronous `get_audio_nodes_sync()` on timeout
- All `Adw.PreferencesRow` subclasses (EntryRow, ComboRow, SwitchRow) are children of a single `Adw.PreferencesGroup` — required for ComboRow click handling
- `_on_devices_loaded(nodes)` sets `Gtk.StringList` models on ComboRows, validates, and prefills if editing
- `_prefill(profile)` — pre-selects trigger/sink/source/BT-profile/Call-BT-profile/auto-switch based on saved values
- `_validate()` enables Save only when name is non-empty AND trigger is selected
- `_on_save()` reads all selections including `bt_profile_call` and `auto_switch`, calls `config_mgr.save_profile()`, emits `profile-saved`, closes

---

## Data Flow

### Profile Creation (UI side)

```
 User opens ProfileDialog
     │
     ▼
 get_audio_nodes_async() — with 3s timeout
     │
     ├─ succeeds → _on_devices_loaded(nodes)
     │
     └─ times out → get_audio_nodes_sync() → _on_devices_loaded(nodes)
           │
           ▼
 _on_devices_loaded()
     ├─ ComboRow models set (all rows inside PreferencesGroup)
     └─ _validate() + _prefill()
 
 User clicks Save
     │
     ▼
 config_mgr.save_profile(name, trigger, sink, source, bt, ...)
     │
     ├─ If is_active=true: deactivate all siblings for this trigger
     ├─ Atomic write: tmpdir → file_set_contents → rename
     └─ (Daemon's Gio.FileMonitor detects change)
```

### Device Routing (Daemon side)

```
 Device connects (USB / BT / HDMI)
     │
     ▼
 WirePlumber creates WpNode
     │
     ▼
 WpMonitor polls → detects new node
     │
     ▼
 daemon.check_and_route_device(node_name, monitor)
     │
     ├── 5s cooldown check (skip if routed recently)
     │
     ├── _get_active_profile_for(node_name)
     │     ├─ Exact: trigger_device_name == node_name ?
     │     └─ Fallback: same bluez_card.MAC as node_name ?
     │
     ├── if no profile found → skip
     │
      ├── (capture-aware switching is handled separately by handle_capture_started / handle_capture_stopped)
      │
     ├── if default_sink is empty AND bt headset:
     │       auto-discover BT sink from bluez_card.MAC
     │       → wpctl set-default <sink_id>
     │
     ├── if default_source is empty AND bt headset:
     │       auto-discover BT source from bluez_card.MAC
     │       → wpctl set-default <source_id>
     │
     ├── set_system_default(sink) → _resolve_node_id(sink) → wpctl set-default <id>
     ├── set_system_default(source) → _resolve_node_id(source) → wpctl set-default <id>
     │
     └── if bt_profile:
           _bt_card_name(node) → bluez_card.MAC
           monitor.get_device_global_id(card) → global_id
           wpctl set-profile <global_id> <profile>
```

### Capture-Aware Switching

```
                          ┌──────────────────────┐
                          │  wpctl status polls  │
                          │  every 3 seconds     │
                          └──────────┬───────────┘
                                     │
                          parse Streams section
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                    input_* appears       input_* disappears
                          │                     │
                          ▼                     ▼
              ┌────────────────────┐   ┌────────────────────┐
              │ capture-started    │   │ capture-stopped    │
              │ 0→1 transition    │   │ 1→0 transition     │
              └────────┬───────────┘   └────────┬───────────┘
                       │                        │
                       ▼                        ▼
              ┌────────────────────┐   ┌────────────────────┐
              │ Cancel any pending │   │ Start 3s debounce  │
              │ restore timer      │   │ timer              │
              │                    │   │                    │
              │ Add node to        │   │ ┌────────────────┐ │
              │ _active_capture_   │   │ │ No new capture │ │
              │ nodes              │   │ │ in 3s?         │ │
              │                    │   │ └───────┬────────┘ │
              │ wpctl set-profile  │   │         │ yes      │
              │ <id> bt_profile_   │   │         ▼          │
              │ call (HSP/HFP)     │   │ Remove from        │
              │                    │   │ _active_capture_   │
              │ Route BT mic as    │   │ nodes              │
              │ default source     │   │                    │
              └────────────────────┘   │ wpctl set-profile  │
                                       │ <id> bt_profile   │
                                       │ (A2DP)            │
                                       │                    │
                                       │ Route BT sink as   │
                                       │ default            │
                                       └────────────────────┘
```

Note: Capture fires on `bluez_input.XX.*` but profiles are keyed by `bluez_output.XX.*`.
The daemon bridges this via `_get_active_profile_for()` which falls back to BT card MAC matching.


### Config File Change

```
 profiles.json modified (by UI or manually)
     │
     ▼
 Gio.FileMonitor fires 'changed'
     │
     ▼
 Re-route all currently tracked nodes
 (calls check_and_route_device for each)
```

### Daemon Startup

```
 daemon_main.js starts
     │
     ├─ try: Wp.init(Wp.InitFlags.ALL) — fallback silently if typelib missing
     ├─ build_monitor() → WpMonitor
     ├─ monitor.start() → polls begin
     ├─ FileMonitor installed on profiles.json
     │
     └─ on 'ready' event:
           for each node in monitor.get_audio_nodes():
               check_and_route_device(node_name, monitor)
           for each node in monitor.get_capture_nodes():
               handle_capture_started(node_name, monitor)
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

**System install:** `build-aux/meson/postinstall.py` copies `io.github.nidszxh.Autowire.Daemon.service` to `~/.config/systemd/user/` and runs `systemctl --user enable --now`.

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
- **BT card-aware profile matching** — capture events fire on `bluez_input.XX.MAC` but profiles are keyed by `bluez_output.XX.MAC`. The daemon's `_get_active_profile_for()` tries the exact trigger match first; if that fails, it extracts the `bluez_card.MAC` from both the connecting node and all profile triggers, and returns the first matching active profile on the same BT card. This ensures that mic activation via `bluez_input.XX.handsfree-headset` correctly finds a profile configured for `bluez_output.XX.a2dp-sink`.
- **`_active_capture_nodes` Set** tracks which nodes have active captures, indexed by node name. `handle_capture_started` adds to it; `handle_capture_stopped` removes after debounce. This bridges the gap between output-keyed routing and input-keyed capture tracking.
- **Auto-route BT input/output** — when a profile has `bt_profile` set but empty `default_sink`/`default_source`, the daemon auto-discovers the corresponding BT sink and source node names by scanning all nodes, finding ones that share the same `bluez_card.MAC`, and routing both. This removes the need for users to manually select sink/source for BT profiles.