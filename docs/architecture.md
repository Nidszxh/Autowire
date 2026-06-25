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

- `load_profiles()` → `Array<Object>` — reads JSON, migrates old entries (adds `is_active: false`), writes back on migration, returns `[]` on any error
- `load_profiles_readonly()` → `Array<Object>` — same as `load_profiles()` but NEVER writes (no `initialize_config()`, no backup, no migration persist). Safe for daemon use where file-write races with the UI are a concern.
- `save_profile(opts)` — kwargs object: `{name, trigger, sink, source, btProfile, isActive, btProfileCall, autoSwitch, display, originalName, originalTrigger}`. Upserts by `(trigger, name)`; if `isActive=true`, deactivates all siblings for that trigger first. `originalName`/`originalTrigger` support rename without data loss.
- `get_profile(trigger, name)` → `Object | null`
- `get_active_profile(trigger)` → `Object | null`
- `set_active_profile(trigger, name)` — deactivates all siblings for that trigger, activates the named one
- `delete_profile(trigger, name)` → `boolean`
- `import_profiles(file_path)` → `boolean` — replaces all profiles with contents of an external JSON file
- `export_profiles(file_path)` → `boolean` — writes current profiles to an external JSON file
- `initialize_config()` — creates dir + empty file if absent. On JSON parse failure, backs up corrupted file to `profiles.json.corrupted.<timestamp>` and creates fresh empty config

Atomic writes using `GLib.file_set_contents()` directly (native atomicity on Linux). Crash-safe.

### `constants.js`
Central location for all timing and interval constants. Consumed by `daemon.js`, `wp_monitor.js`, `daemon_main.js`, `profile_dialog.js`, and `window.js`.

- `POLL_INTERVAL_MS` (3000) — interval between wpctl status polls
- `ROUTING_COOLDOWN_S` (5) — per-node-name cooldown before re-routing the same device
- `CAPTURE_DEBOUNCE_MS` (3000) — debounce before restoring bt_profile after capture-stopped
- `HEARTBEAT_INTERVAL_S` (30) — daemon heartbeat tick interval (seconds)
- `HEARTBEAT_ALIVE_THRESHOLD_S` (45) — heartbeat freshness threshold in window.js
- `SYNC_FALLBACK_TIMEOUT_MS` (3000) — periodic logging interval for async device loading in profile dialog
- `BT_RETRY_DELAY_MS` (5000) — delay before falling back to `a2dp-sink` if card stays in `off`
- `CAPTURE_START_DEBOUNCE_MS` (1500) — debounce per-card before acting on capture-started
- `CONFIG_CHANGE_DEBOUNCE_MS` (500) — rate limit for config file monitor events
- `STATUS_TIMEOUT_MS` (4000) — async wpctl status subprocess timeout  
- `DAEMON_POLL_INTERVAL_S` (15) — UI poll interval for daemon heartbeat
- `DAEMON_START_GRACE_MS` (2500) — UI grace period after spawning daemon
- `RECONNECT_DELAY_S` (5) — WpMonitor reconnect delay on Wp.Core failure  
- `FLASH_DURATION_MS` (1500) — UI highlight duration for active indicator (uses CSS `.highlight` class with opacity transition)
- `FALLBACK_BT_PROFILE` (`'a2dp-sink'`) — BT profile to fall back to if card stays in `off`
- `APP_VERSION` (`'0.3.12'`) — current application version

### `log.js`
Structured logging module with severity levels and timestamps.

- `Level` — enum: `DEBUG (0)`, `INFO (1)`, `WARN (2)`, `ERROR (3)`
- `setLevel(level)` — minimum severity to emit; defaults to `INFO`
- `debug(module, msg)` / `info(module, msg)` / `warn(module, msg)` / `error(module, msg)` — emit `[HH:MM:SS] [LEVEL] [module] msg` to stdout (→ systemd journal or terminal)
- `setLogFile(path)` — enables dual-output: all log lines also append to a file (with 1MB rotation, old file → `.old` suffix). The daemon writes to `~/.config/autowire/daemon.log`

### `utils.js`
Shared helpers for subprocess management and string manipulation.

- `is_flatpak` — boolean, checks `/.flatpak-info` file existence
- `get_wpctl_cmd()` / `get_pactl_cmd()` — returns argv array for subprocess calls (includes `flatpak-spawn --host` prefix in Flatpak mode)
- `strip_tree_chars(s)` — strips PipeWire `wpctl status` tree-drawing characters (`│├└─`) from a line
- `spawn_sync_with_timeout(argv, timeout_ms)` — runs a subprocess via `Gio.Subprocess` with `communicate_utf8_async` and a nested `GLib.MainLoop`. Timeouts kill runaway processes via `force_exit()` instead of freezing the daemon. Returns `[ok, stdout, stderr, exitStatus]`.

### `bt_profiles.js`
Codec-quality ladder shared between profile dialog and daemon.

- `A2DP_QUALITY` — ordered quality-codec fallback ladder (LDAC > aptX-HD > aptX > AAC > a2dp-sink-codec-auto > SBC-XQ > SBC)
- `HSP_HFP` — ordered call-profile fallback ladder (handsfree-headset > headset-head-unit)
- `pickBest(available, desired='')` — matches user's desired profile against what the card actually exposes; iterates the appropriate ladder (`HSP_HFP` if desired is a call profile, `A2DP_QUALITY` otherwise) and returns the first entry the card supports, or `''` if nothing matches. Accepts both `Set` and `Array` for `available`.

### `pactl_parser.js`
Synchronous pactl cards parser with 1s TTL cache.

- `parseCardsText(text)` → `Map<pw_name, {active: string, profiles: Set<string>}>` — parses raw `pactl list cards` text (pure, no IO)
- `parsePactlCards()` — calls `fetchCardsText()` then `parseCardsText(text)`; 1s cache avoids re-spawning pactl on rapid calls
- `getActiveProfile(card_pw_name)` → `string` — active profile for a card
- `getCardProfiles(card_pw_name)` → `Set<string>` — available profiles for a card
- `listAllCardProfiles()` → `Object<string, string[]>` — all cards as a plain object (for profile_dialog.js compatibility)
- `clearCardsCache()` — resets the 1s cache

### `daemon.js`
Encapsulated in a `DaemonEngine` class (instantiated by `daemon_main.js`). Core routing logic + stream-aware capture switching. All mutable state (routing cooldowns, capture timers, restoring/activated card sets) is instance state on the engine, allowing multiple independent engines if needed.

- `new DaemonEngine()` — initializes `_last_routed` (Map), `_capture_timers` (Map), `_capture_start_timers` (Map), `_active_capture_nodes` (Set), `_restoring_cards` (Set), `_activated_bt_cards` (Set)
- `set_system_default(node_name, monitor)` → `boolean` — resolves node name to numeric PW ID via `wpctl inspect`, then `wpctl set-default <id>`. Returns `false` immediately if `node_name` is empty (BT auto-discovery of sink/source happens in `_apply_profile_actions`, not here).
- `_reassert_default_sink(card_name, monitor)` → `boolean` — iterates `monitor.get_audio_nodes()` for the BT sink; if not found (stale cache), falls back to `_resolve_bt_sink_name()` which queries pactl in real-time. Calls `set_system_default` + `_migrate_streams_to_bt` on success.
- `_resolve_bt_sink_name(card_name)` → `string|null` — queries `pactl list sinks` (real-time, bypasses monitor cache) and returns the current BT sink name matching the given card. Prefers numeric-suffix names (e.g. `bluez_output.MAC.1` — A2DP sinks) but falls back to any `bluez_output.MAC.*` name when only the non-numeric variant exists.
- `_migrate_streams_to_bt(bt_sink_name)` — queries `pactl list sink-inputs`, finds streams not already on the BT sink, and calls `pactl move-sink-input` to migrate them from ALSA to the restored BT sink. Used after HSP→A2DP restore to fix "no audio after call" when apps (Spotify, etc.) were still bound to the ALSA sink. The delayed 600ms migration also calls `set_system_default()` before migrating to re-assert the BT sink as default after pipewire-pulse registers the new sink.
- `set_bt_profile(device_global_id, profile_name, card_pw_name)` → `boolean` — `wpctl set-profile <id> <profile>`. Uses `card_pw_name` to resolve the profile via `_resolve_bt_profile()` which calls `pickBest()` with the card's available profiles.
- `check_and_route_device(node_name, monitor, force)` → `boolean` — loads profiles via `load_profiles_readonly()`, **skips any where `is_active != true`**, iterates ALL matching profiles and applies actions for each. Initial routing always uses `bt_profile`; capture-aware switching is handled by `handle_capture_started`/`handle_capture_stopped`.
- `handle_capture_started(node_name, monitor)` — cancels restore timer, routes BT mic as default source, switches to `bt_profile_call`
- `handle_capture_stopped(node_name, monitor)` — starts 3s debounce per card (via `_capture_timers` Map keyed by node_name), on expiry restores `bt_profile` and re-routes BT sink as default. Has early `_restoring_cards` guard to prevent re-entrancy when `set_bt_profile → _spawn_sync_with_timeout` runs a nested MainLoop.
- `build_monitor()` → `WpMonitor` — creates monitor wired with `node-added`, `device-added`, `device-removed`, `node-removed` signals (capture-started/stopped are wired by `daemon_main.js` outside the `ready` handler to prevent duplicate handler chains on Wp.Core reconnect)
- `activate_bt_card(global_id, card_name, monitor)` — called on `device-added` and during `ready`; checks if a BT card is in `off` state and an active profile targets it, then sets the best available profile. Has skip logic: if current profile is already the resolved target (`current !== 'off' && resolved === pid`), skips to avoid barging. If card stays in `off` after initial attempt, `_bt_activate_after_delay()` retries with `FALLBACK_BT_PROFILE` (`a2dp-sink`) after `BT_RETRY_DELAY_MS` (5000ms). Tracks already-activated cards via `_activated_bt_cards` Set. After normal profile restore, also schedules `_bt_activate_after_delay()` to handle BT radio glitches or codec mismatches that leave the card in `off` state.
- `clear_state()` — clears all routing cooldowns (`_last_routed`), capture timers (`_capture_timers`, `_capture_start_timers`), active capture set (`_active_capture_nodes`), and restoring guard (`_restoring_cards`). Preserves `_activated_bt_cards` (BT hardware survives PipeWire restarts). Called by `daemon_main.js` when the `ready` signal fires for a Wp.Core reconnection.
- `_notify(summary, body)` — sends a desktop notification via `notify-send` subprocess with `--icon=io.github.nidszxh.Autowire` and `Gio.SubprocessFlags.STDERR_SILENCE` (sanitized input, silently skipped if `notify-send` is not installed)
- Private methods: `_find_active_profile_for()` (exact + BT card fallback), `_bt_card_name()` (regex extractor), `_resolve_node_id()` (may run nested MainLoop), `_has_active_capture_on_card()`, `_apply_profile_actions()`, `_find_capture_profile()`, `_validate_profile()` (uses module-level `_VALID_BT_PROFILES` Set), `_spawn_sync_with_timeout()` (delegates to `utils.spawn_sync_with_timeout`), `clear_state()` (called on Wp.Core reconnect)

### `wp_monitor.js`
Poll-based `Wp.Core` wrapper. GJS Wp bindings cannot read proxy properties, so polling via `wpctl status` + `wpctl inspect` is used instead of `Wp.ObjectManager`.

- `WpMonitor.start()` → `Wp.Core.connect('connected')` → `_on_core_connected()` → `_poll()` every 3s
- `_poll()` runs `_poll_nodes()`, `_poll_devices()`, `_poll_streams()`
- `_poll_nodes()` — parses `wpctl status` Sinks/Sources, `wpctl inspect`s each for `node.name` + `node.description`
- `_poll_devices()` — parses Devices section from `wpctl status` (cached by global_id — skips `wpctl inspect` for known devices to avoid O(N) blocking)
- `_poll_streams()` — parses Streams section with `<`/`>` arrow detection (handles both PipeWire ≥1.6.6 and older), detects `input_*` sub-entries, maps target descriptions to node IDs via `_desc_to_id` and nodes via `_id_to_node`, maintains `_capture_counts` per node. At the end of each cycle, `_capture_counts` is replaced wholesale (line 270), not deleted in `_poll_nodes()` — this ensures >0→0 transitions are detectable
- Emits GObject signals: `node-added(name, desc, media_class)`, `node-removed(name)`, `device-added(name, desc, global_id, pw_name)`, `device-removed(name, desc, global_id, pw_name)`, `capture-started(name)`, `capture-stopped(name)`, `ready`
- `get_device_global_id(name)` → `number | null`
- `resolveDeviceGlobalId(device_name)` → `number | null` — wraps `get_device_global_id()`, falls back to parsing the Devices section from `wpctl status` on-the-fly if the device isn't in the poll cache yet
- `get_audio_nodes()` → `Array<Object>`
- `get_capture_nodes()` → `Array<string>` — returns node names with active capture counts > 0

Exports `get_audio_nodes_async(callback)`:
- Same data via `Gio.Subprocess.communicate_utf8_async()` (non-blocking)
- Has safety timeout (`STATUS_TIMEOUT_MS + 1000`); if `wpctl status` hangs, callback fires with `[]`
- Calls `callback(nodes)` on completion, or `callback([])` on error/timeout

### `daemon_main.js`
Daemon entry point (GLib only, zero GTK imports).

1. Ensures config directory exists via `config_mgr.initialize_config()` (must be before log/heartbeat to avoid silent write failures)
2. Enables file logging via `log.setLogFile(~/.config/autowire/daemon.log)`
3. Creates `new DaemonEngine()` instance
4. Builds `WpMonitor` via `engine.build_monitor()` and starts it
5. Installs `Gio.File.monitor()` on `profiles.json` → re-routes all active nodes on any change (500ms rate-limited), calls `engine.check_and_route_device()` and `engine.handle_capture_started()`
6. Wires capture-started/stopped signals OUTSIDE the `ready` handler (prevents duplicate handlers on Wp.Core reconnect). Inside the `ready` handler: routes already-connected devices (force=true), activates BT cards, re-applies active capture profiles. On reconnection (Wp.Core restart), calls `engine.clear_state()` to purge stale routing state before re-applying.
7. Ticks a heartbeat timestamp atomically every 30s (`HEARTBEAT_INTERVAL_S`) so the UI can detect daemon liveness
8. Runs `GLib.MainLoop` indefinitely
9. Handles SIGTERM/SIGINT via `GLibUnix.signal_add()` for clean shutdown

### `main.js`
GTK UI entry point.

- `AutowireApplication` — `Adw.Application` subclass; `vfunc_activate()` shows or creates `AutowireWindow`
- Installs SIGINT/SIGTERM handlers via `GLibUnix.signal_add()` for clean shutdown
- Does not import `constants.js` (unused `C` import removed)

### `window.js`
`AutowireWindow` — shows the profile list from `profiles.json`, grouped by trigger device (680×560 default size).

- `close-request` signal calls `app.quit()` to trigger proper shutdown. `vfunc_dispose()` kills the daemon subprocess via `force_exit()`.
- `refresh_profiles()` — clears and rebuilds `Adw.PreferencesGroup` hierarchy from disk. Shows a custom empty state (`Gtk.Box` with icon, title, description, and CTA button) when no profiles exist. Header "+" button is hidden on empty state.
- `_group_by_trigger(profiles)` — groups profiles by `trigger_device_name` into nested `Adw.PreferencesGroup` per trigger. Group title shows just the device name (no `(N)` count suffix).
- `_build_profile_row(profile, has_siblings)` — `Adw.ActionRow` with: `Gtk.Switch` for active state, Edit button (always visible, `document-edit-symbolic`), Delete button (always). Row is clickable to edit via `activated` signal. Move up/down buttons shown when `has_siblings`. No tooltips on any button.
- `_on_switch_toggled(switch, profile)` — toggles `config_mgr.set_active_profile()` on/off and refreshes
- Delete → `Adw.AlertDialog({heading, body})` confirmation → `config_mgr.delete_profile()`
- **Keyboard shortcuts:** `Ctrl+N` (add profile, maps to `_on_add_clicked`), `Ctrl+Q` (quit), `F5` (refresh profiles)
- **Import uses `dialog.open()`** — `Gtk.FileDialog` for importing must call `dialog.open()` + `open_finish()`, NOT `dialog.save()` + `save_finish()` (would show "Save As" instead of "Open File"). Export uses `dialog.save()` + `save_finish()` as expected.

### `profile_dialog.js`
`ProfileDialog` — `Adw.Dialog` for create/edit (600×500).

- Shows loading spinner immediately (async device fetch)
- Device lists loaded via `get_audio_nodes_async()` cleanly avoiding UI freezes
- Profile name uses a `Gtk.Entry` inside `Adw.PreferencesRow` (no separate card frame); blue focus box removed via `outline-width: 0` on a per-widget `Gtk.CssProvider` at `USER` priority
- BT Profile and Call Profile dropdowns share the same device-filtered list (no HSP/HFP-only filter on call)
- Auto-switch is implicit — when a call profile (`bt_profile_call`) is set, auto-switch is automatically `true`; no separate toggle
- `_on_devices_loaded(nodes)` sets `Gtk.StringList` models on ComboRows, validates, and prefills if editing
- `_prefill(profile)` — pre-selects trigger/sink/source/BT-profile/Call-BT-profile based on saved values
- `_validate()` enables Save only when name is non-empty AND trigger is selected
- `_on_save()` reads all selections, calls `config_mgr.save_profile({...})` with kwargs, emits `profile-saved`, closes
- BT labels stripped of parenthetical descriptions: `"LDAC"` instead of `"LDAC (high quality)"`

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
     └─ times out → wait continues or fails cleanly
           │
           ▼
 _on_devices_loaded()
     ├─ ComboRow models set (all rows inside PreferencesGroup)
     └─ _validate() + _prefill()
 
 User clicks Save
     │
     ▼
 config_mgr.save_profile({
     name, trigger, sink, source,
     btProfile, btProfileCall,
     isActive, autoSwitch,
     display,
     originalName, originalTrigger
 })
     │
     ├─ If isActive=true: deactivate all siblings for this trigger
     ├─ If originalName/originalTrigger differ from name/trigger:
     │     rename preserves position, removes old entry
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
      ├── _find_active_profile_for(node_name)
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
                                       │                    │
                                       │ pactl move-sink-   │
                                       │ input — migrate    │
                                       │ ALSA-bound streams │
                                       │ to restored BT     │
                                       │ sink (pactl, not   │
                                       │ monitor cache)     │
                                       └────────────────────┘
```

Note: Capture fires on `bluez_input.XX.*` but profiles are keyed by `bluez_output.XX.*`.
The daemon bridges this via `_find_active_profile_for()` which falls back to BT card MAC matching.
A `_restoring_cards` Set prevents the routing engine from barging in when the capture handler is mid-codec-change.


### Config File Change

```
 profiles.json modified (by UI or manually)
     │
     ▼
 Gio.FileMonitor fires 'changed'
     │
     ▼
  Re-route all currently tracked nodes
  (calls check_and_route_device for each, force=true)
  Re-apply active captures
  (calls handle_capture_started for each captured node)
```

### Daemon Startup

```
 daemon_main.js starts
     │
  ├─ try: Wp.init(Wp.InitFlags.ALL) — fallback silently if typelib missing
  ├─ build_monitor() → WpMonitor
  ├─ monitor.connect('capture-started', ...) — wired OUTSIDE the ready handler
  ├─ monitor.connect('capture-stopped', ...)  — prevents duplicate handlers on reconnect
  ├─ monitor.start() → polls begin
  ├─ FileMonitor installed on profiles.json
  │
  └─ on 'ready' event:
        if _first_ready:
            set _first_ready = false
        else:
            # Wp.Core reconnected — clear stale engine state
            engine.clear_state()
            # (capture signals already wired outside, no reconnection needed)
        # route already-connected devices
        for each node in monitor.get_audio_nodes():
            check_and_route_device(node_name, monitor, force=true)
        # activate BT cards
        for each dev in monitor.get_devices():
            if bluez_card.* → activate_bt_card(dev.global_id, dev.pw_name, monitor)
        # re-apply active capture profiles
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
- `bt_profile`: optional. Valid values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`, `headset-head-unit`, or empty (don't touch BT profile).
- `bt_profile_call`: optional. BT profile to switch to when capture is active (call mode). Typically `handsfree-headset`. The daemon also accepts `headset-head-unit` as an alternative HSP/HFP alias — both are treated as call profiles and will be substituted depending on what the card exposes. Only used when `auto_switch: true`.
- `auto_switch`: boolean. When `true`, daemon monitors capture streams and auto-switches between `bt_profile` and `bt_profile_call` based on mic activity.

---

## Flatpak Permissions

| Finish arg | Purpose |
|---|---|
| `--share=ipc` | Shared memory for X11/Wayland |
| `--socket=wayland` | GTK display |
| `--socket=pulseaudio` | Audio access via PulseAudio/PipeWire |
| `--talk-name=org.freedesktop.WirePlumber` | Session D-Bus WirePlumber access (audio routing) |
| `--system-talk-name=org.freedesktop.WirePlumber` | System D-Bus WirePlumber access (needed by some setups) |
| `--talk-name=org.freedesktop.Flatpak` | Flatpak D-Bus API for `flatpak-spawn --host` |
| `--filesystem=xdg-config/autowire:create` | Read/write access to profiles.json |

---

## Autostart

**System install:** `build-aux/meson/postinstall.py` copies `io.github.nidszxh.Autowire.Daemon.service` to `~/.config/systemd/user/` and runs `systemctl --user enable --now`. The daemon launches via systemd; the UI is launched manually or via D-Bus activation.

**Flatpak:** `io.github.nidszxh.Autowire.service` (D-Bus session service) tells the D-Bus session bus to launch `autowire` (the UI) on demand. The daemon is launched separately via `flatpak run --command=autowire-daemon io.github.nidszxh.Autowire`, or manually from the user session. No systemd inside the sandbox.

---

## Key Quirks

- **`Adw.PreferencesGroup` title via constructor is broken in GTK4** — always use `set_title()` after construction.
- **`Adw.AlertDialog` constructor requires plain object** — `new Adw.AlertDialog({heading, body})`, not positional arguments.
- **GJS Wp bindings cannot read proxy properties** — `Proxy.get_properties()` returns null, `props.properties` is undefined. All node/device data is obtained via `wpctl status` + `wpctl inspect` subprocess polling instead.
- **Polling interval** is 3s by default (`POLL_INTERVAL_MS`). The poll runs `_poll_nodes()`, `_poll_devices()`, and `_poll_streams()` every cycle.
- **Capture stream detection** uses a regex on `wpctl status` Streams sub-entries: `input_<port>.*(?:<|>) <description>:<port> [active|init]`. Handles both `<` (PipeWire ≥1.6.6, left arrow indicates input) and `>` (older versions, right arrow indicates output). Target descriptions are mapped to numeric node IDs via `_desc_to_id`, with node metadata in `_id_to_node`.
- **Debounce on capture-stopped** is 3s (`CAPTURE_DEBOUNCE_MS`) to tolerate push-to-talk mic gaps. A new `capture-started` during debounce cancels the timer.
- **`wpctl set-default` requires numeric ID** on PipeWire 1.6.5 — `_resolve_node_id()` parses `wpctl status` for candidate IDs, then `wpctl inspect`s each to match `node.name`.
- **`wpctl set-profile` requires PW global ID** (numeric), not a node or device name. Use `monitor.resolveDeviceGlobalId('bluez_card.XX_XX_...')` which wraps `get_device_global_id()` with an on-the-fly `wpctl status` Devices section fallback.
- **Cooldown** is per-node-name, not global. Rapid plug/unplug cycles on *different* devices all fire immediately.
- **Config file watcher** uses `Gio.File.new_for_path(path).monitor()` (GJS 1.80+ API, not `Gio.FileMonitor.new_for_path`).
- **Signal handling** uses `GLibUnix.signal_add()` with numeric signals (GJS 1.80+ API, not `GLib.unix_signal_add`).
- **capture-started/stopped signals** only fire on 0→1 / 1→0 transitions (never repeated for same state). Daemon can safely react to each event once.
- **WirePlumber restart recovery** — capture-started/stopped signals are wired OUTSIDE the `ready` handler to prevent duplicate handler chains. On Wp.Core reconnect, `ready` fires again and `daemon_main.js` calls `engine.clear_state()` to purge stale routing/capture state, then re-applies routing against the new audio graph.
- **Device/Node ID caching** — `_poll_devices()` and `_fetch_nodes_from_wpctl()` cache known devices/nodes by global_id, skipping expensive `wpctl inspect` calls for already-known hardware. New devices still get inspected once on first appearance. This avoids O(N) blocking subprocess calls every poll cycle.
- **BT card removal guard** — when a BT device disconnects during an active capture, `_activated_bt_cards` is cleared immediately. The 3s capture-stopped debounce timer checks `_activated_bt_cards.has(card_name)` before attempting to restore, preventing `wpctl set-profile` calls on nonexistent devices.
- **BT card-aware profile matching** — capture events fire on `bluez_input.XX.MAC` but profiles are keyed by `bluez_output.XX.MAC`. The daemon's `_find_active_profile_for()` tries the exact trigger match first; if that fails, it extracts the `bluez_card.MAC` from both the connecting node and all profile triggers, and returns the first matching active profile on the same BT card. This ensures that mic activation via `bluez_input.XX.handsfree-headset` correctly finds a profile configured for `bluez_output.XX.a2dp-sink`.
- **`_active_capture_nodes` Set** tracks which nodes have active captures, indexed by node name. `handle_capture_started` adds to it; `handle_capture_stopped` removes after debounce. Bridges the gap between output-keyed routing and input-keyed capture tracking.
- **`_capture_timers` plain object** — per-node-name debounce timers (keyed by node_name string). Replaced a single shared timer so independent BT cards each get their own 3s debounce window. (Note: `_capture_start_timers` is a separate `Map` keyed by `card_name` for the 1.5s capture-start debounce.)
- **`_restoring_cards` Set** — when the capture handler initiates a codec change via `set_bt_profile()`, it adds the card name to this Set (try/finally ensures cleanup). The `handle_capture_stopped` handler checks this Set before restoring (prevents multiple timers from racing to restore the same card). `_bt_card_name()` itself is a pure regex extractor with no awareness of this Set.
- **Auto-route BT input/output** — when a profile has `bt_profile` set but empty `default_sink`/`default_source`, the daemon auto-discovers the corresponding BT sink and source node names by scanning all nodes, finding ones that share the same `bluez_card.MAC`, and routing both. This removes the need for users to manually select sink/source for BT profiles.
- **`node-removed` cleanup** — `_capture_timers` and `_active_capture_nodes` entries cleaned up on node removal. `_capture_counts` is NOT deleted here — it persists until `_poll_streams()` replaces the entire counts map at the end of the poll cycle, allowing >0→0 transition detection.
- **`off` state filtering** — `_fetch_nodes_from_wpctl()` applies a `/\boff\b/` regex to the raw `wpctl status` line, skipping nodes shown as `(off)` to prevent false routing attempts for inactive Bluetooth cards.