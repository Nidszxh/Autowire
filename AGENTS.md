# Autowire — Agent Instructions

## One-Sentence

Libadwaita/GTK4 app + headless daemon for automated PipeWire/WirePlumber audio profile switching when devices connect.

## Architecture (Two Processes, One JSON)

```
┌──────────────────────────────────────────────────────────────┐
│                        UI  PROCESS                           │
│  src/main.js  —  GTK4 + Adwaita (Wp optional)                        │
│                                                            │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────┐    │
│  │  Window     │   │  Profile   │   │   ConfigMgr      │    │
│  │  (profile   │──▶│  Dialog    │──▶│  writes profiles │    │
│  │   list)     │   │  (create/  │   │  .json atomically│    │
│  └────────────┘   │   edit)    │   └────────┬─────────┘    │
│                   └────────────┘            │               │
│  gjs -I src/ src/main.js                    │               │
└─────────────────────────────────────────────┼───────────────┘
                                              │
                           ~/.config/autowire/
                           profiles.json
                                              │
                                              v
┌─────────────────────────────────────────────┼───────────────┐
│                      DAEMON PROCESS         │               │
│  src/daemon_main.js  —  GLib-only, no GTK   │               │
│                                             │               │
│  ┌──────────────┐   ┌──────────────┐   ┌────┴────────┐    │
│  │  WpMonitor   │──▶│   Daemon     │──▶│  ConfigMgr  │    │
│  │  polls wpctl │   │  routing     │   │  reads      │    │
│  │  every 3s    │   │  engine      │   │  profiles   │    │
│  └──────┬───────┘   └──────┬───────┘   │  .json      │    │
│         │                  │           └─────────────┘    │
│         │                  │                               │
│         ▼                  ▼                               │
│  ┌──────────────┐   ┌──────────────┐                      │
│  │  wpctl       │   │  Gio.File    │                      │
│  │  status      │   │  Monitor     │                      │
│  │  + inspect   │   │  (config     │                      │
│  │              │   │   changes)   │                      │
│  └──────────────┘   └──────────────┘                      │
│                                                            │
│  gjs -I src/ src/daemon_main.js                            │
└──────────────────────────────────────────────────────────────┘
```

## File Map

```
src/                    # Production GJS
  main.js               # Adw.Application entry (GTK/Adw/Wp)
  window.js             # Profile list UI, grouped by trigger
  profile_dialog.js     # Create/edit Adw.Dialog
  daemon.js             # Routing engine + capture-aware BT switching
  daemon_main.js        # Daemon main loop (GLib + Gio + Wp, zero GTK)
  wp_monitor.js         # Poll-based WpCore wrapper + capture detection
  config_mgr.js         # Atomic JSON CRUD for profiles.json
data/                   # System integration files
  *.service, *.desktop.in, *.metainfo.xml
```

## Daemon Flowgraph

```
daemon_main.js:main()
  Wp.init(Wp.InitFlags.ALL)
  │
  ├─► daemon.build_monitor() → new WpMonitor()
  │     ├─ node-added → check_and_route_device(name, mon)
  │     ├─ device-added → log if bluez_card.*
  │     ├─ capture-started → handle_capture_started(name, mon)
  │     └─ capture-stopped → handle_capture_stopped(name, mon)
  │
  ├─► monitor.start()
  │     └─ _core.connect() → _on_core_connected()
  │           └─ _poll() every 3s
  │                 ├─ _poll_nodes()   — wpctl status + inspect
  │                 ├─ _poll_devices() — Devices section
  │                 └─ _poll_streams() — Streams → capture detection
  │                       └─ 0→1: emit 'capture-started'
  │                       └─ 1→0: emit 'capture-stopped'
  │
  ├─► on 'ready' → route already-connected nodes, then re-apply call profiles for active captures
  │
  ├─► Gio.File.new_for_path(CONFIG_FILE).monitor()
  │     └─ on change → re-route all tracked nodes
  │
  └─► GLib.MainLoop.run()

check_and_route_device(node_name, monitor?)
  5s cooldown (_last_routed per node_name)

  ┌─ load_profiles() → _get_active_profile_for(name)
  │   tries exact match first (trigger == name)
  │   falls back to BT card match: any active profile
  │   whose trigger_device_name shares the same
  │   bluez_card.MAC as the connecting node
  │
  ├─ set_system_default(sink) / set_system_default(source)
  │   if sink/source is empty AND bt_profile is set:
  │     auto-discover BT sink/source via card name
  │   └─ _resolve_node_id(name):
  │        wpctl status → candidates → wpctl inspect
  │        to find node.name → numeric ID
  │   └─ wpctl set-default <numeric_id>
  │
  └─ if bt_profile:
       _bt_card_name(node) → bluez_card.XX (MAC preserved)
       monitor.get_device_global_id(card) → numeric PW global ID
       wpctl set-profile <global_id> <profile>
```

## Capture-Aware BT Switching Flow

```
App opens mic → input_* stream appears in wpctl status Streams
  │
  ▼
WpMonitor._poll_streams() parses stream
  └─ _capture_counts[name] goes 0→1 → emit 'capture-started'
       │
       ▼
handle_capture_started(name, mon)
  cancel pending restore timer (_capture_timers)
  _active_capture_nodes.add(name)
  get_active_profile(name) → if auto_switch:
    wpctl set-profile <id> <bt_profile_call> (e.g. handsfree-headset)
    ╔══════════════════════════════════════════════════╗
    ║  NOTE: capture fires with bluez_input.XX.*       ║
    ║  but profile trigger is bluez_output.XX.*        ║
    ║  _get_active_profile_for() tries exact match     ║
    ║  first, then falls back to BT card MAC match     ║
    ╚══════════════════════════════════════════════════╝
       │
App stops mic → stream disappears
  │
  ▼
_capture_counts[name] goes 1→0 → emit 'capture-stopped'
  │
  ▼
handle_capture_stopped(name, mon)
  GLib.timeout_add(3000ms) — debounce for push-to-talk gaps
    └─ if no new capture-started in 3s:
         _active_capture_nodes.delete(name)
         wpctl set-profile <id> <bt_profile> (e.g. a2dp-sink-aac)
```

## Key Commands

```bash
# Run UI (no build needed)
gjs -I src/ src/main.js

# Run daemon
gjs -I src/ src/daemon_main.js

# System install via Meson (launches GJS)
ninja -C _build && ./_build/src/autowire

# Flatpak build & run
flatpak-builder --force-clean --user --install _flatpak_build io.github.nidszxh.Autowire.json && flatpak run io.github.nidszxh.Autowire

# Flatpak daemon
flatpak run io.github.nidszxh.Autowire.Daemon

# Daemon logs
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f
systemctl --user restart io.github.nidszxh.Autowire.Daemon.service
```

## Profile Data Model (`~/.config/autowire/profiles.json`)

```json
{"profiles": [{"profile_name": "AAC High Quality", "trigger_device_name": "bluez_output.XX_...", "is_active": true, "actions": {"default_sink": "...", "default_source": "...", "bt_profile": "a2dp-sink-aac", "bt_profile_call": "handsfree-headset", "auto_switch": true}}]}
```

- Uniqueness: `(trigger_device_name, profile_name)`.
- `is_active`: only one per trigger can be true.
- Valid `bt_profile` values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`, or `''`.

## GJS Quirks

- **Poll-based WpMonitor** — GJS Wp bindings can't read proxy properties. Uses `wpctl status` + `wpctl inspect` every 3s instead of `Wp.ObjectManager`.
- **`Adw.PreferencesGroup` title via constructor broken** — always use `set_title()` after construction.
- **`Adw.AlertDialog` needs object constructor** — `new Adw.AlertDialog({heading, body})`.
- **`GLibUnix.signal_add()`** (not deprecated `GLib.unix_signal_add`) for SIGTERM/SIGINT.
- **`Wp.Properties()` constructor raises boxed-type error** — use `Wp.Properties.new_empty()`.
- **Numeric ID resolution** — `wpctl set-default` needs numeric PW node ID. `_resolve_node_id()` parses `wpctl status` for candidate IDs, `wpctl inspect`s each to match `node.name`.
- **Device global ID** — `wpctl set-profile` needs PW global ID. Use `monitor.get_device_global_id('bluez_card.XX_XX_...')`.
- **BT node→card mapping** — `bluez_output.XX_XX_...` → `bluez_card.XX_XX_...` (MAC preserved).
- **Atomic writes** — `GLib.dir_make_tmp()` → `GLib.file_set_contents()` → `GLib.rename()`.
- **Config watcher** — `Gio.File.new_for_path(path).monitor()` with 2000ms rate limit.
- **Polling:** 3s interval, 5s routing cooldown (per node name), 3s capture debounce.
- **BT card-aware matching** — `_get_active_profile_for()` falls back to same-`bluez_card.MAC` match when exact trigger match fails. Capture state tracked via `_active_capture_nodes` Set.
- **`Adw.ComboRow` needs `Adw.PreferencesGroup`** — `Adw.PreferencesRow` subclasses (EntryRow, ComboRow, SwitchRow) are non-interactive unless added to an `Adw.PreferencesGroup` parent.
- **`Wp` import optional everywhere** — `main.js`, `daemon_main.js`, and `wp_monitor.js` all wrap the Wp typelib import in try-catch. Flatpak (org.gnome.Platform//50) lacks `Wp-0.5` typelib, so all modules fall back to poll-only / sync mode.
- **Profile dialog sync fallback** — `profile_dialog.js` tries `get_audio_nodes_async()` first with a 3s timeout; on timeout it falls back to synchronous `get_audio_nodes_sync()` to ensure device lists always populate.

## Known Issues

- **No GJS test suite** — all 60 Python tests were removed with the stale Python code.
- **`get_audio_nodes_sync()` blocks UI ~0.2s** — sync subprocess call. Profile dialog falls back to this after 3s async timeout.
- **No subprocess timeout** — GJS `GLib.spawn_sync` doesn't support timeout unlike Python's `subprocess.run(timeout=5)`.
