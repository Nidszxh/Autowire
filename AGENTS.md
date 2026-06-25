# Autowire — Agent Instructions

## One-Sentence

Libadwaita/GTK4 app + headless daemon for automated PipeWire/WirePlumber audio profile switching when devices connect.

## Architecture (Two Processes, One JSON)

```
┌──────────────────────────────────────────────────────────────┐
│                        UI  PROCESS                           │
│  src/main.js  —  GTK4 + Adwaita (Wp optional)                │
│  gjs -I src/ src/main.js                                     │
└──────────────────────────┬───────────────────────────────────┘
                           │
          ~/.config/autowire/profiles.json
           (UI writes atomically, Daemon watches)
                           │
                           v
┌──────────────────────────────────────────────────────────────┐
│                     DAEMON PROCESS                            │
│  src/daemon_main.js  —  GLib-only, no GTK                     │
│  gjs -I src/ src/daemon_main.js                               │
└──────────────────────────────────────────────────────────────┘
```

No IPC — just a shared JSON file. No build step — pure GJS executed directly.

## File Map

```
src/
  main.js               # Adw.Application entry (GTK/Adw/Wp optional)
  window.js             # Profile list UI, grouped by trigger
  profile_dialog.js     # Create/edit Adw.Dialog
  daemon.js             # DaemonEngine class + routing engine (~865 lines)
  daemon_main.js        # Daemon entry: MainLoop + signals + file watcher
  wp_monitor.js         # Poll-based WpCore wrapper (~567 lines)
  config_mgr.js         # Atomic JSON CRUD for profiles.json (~522 lines)
  constants.js          # All timing/interval constants — NO magic numbers elsewhere
  log.js                # Structured logging with levels + timestamps + file output
  utils.js              # is_flatpak, absolute wpctl/pactl paths, strip_tree_chars, spawn_sync_with_timeout
  bt_profiles.js        # Codec-quality ladder (A2DP_QUALITY, HSP_HFP, pickBest())
  pactl_parser.js       # pactl list cards parser with 1s TTL cache
  autowire.in           # Meson launcher template → /usr/bin/autowire
  autowire-daemon.in    # Meson launcher template → /usr/bin/autowire-daemon
flathub.json               # Flathub config: publish-delay-hours: 3
io.github.nidszxh.Autowire.json   # Flatpak manifest (buildsystem: simple)
data/
  *.service, *.desktop.in, *.metainfo.xml, icons/
tests/
  test.sh               # Shell runner — accepts GJS env var, individual file args
  test_bt_profiles.js   # 25 tests — pickBest ladder logic with Set/Array, HSP vs A2DP, fallback
  test_config_mgr.js    # 25 tests — CRUD, migration, set-active, reorder
  test_daemon.js        # 40 tests — BT card parsing, capture matching, profile lookup, validate
  test_log.js           # 4 tests — log levels, file output, no-crash assertions
  test_pactl_parser.js  # 37 tests — card parsing, empty/malformed input, complex profile names
  test_utils.js         # 19 tests — spawn_sync_with_timeout, strip_tree_chars, cmd builders
  test_wp_monitor.js    # 16 tests — stream parsing, card matching, arrow handling
  fixtures/wpctl_status_sample.txt
```

## Shared Modules (loaded by both processes)

- **config_mgr.js** — `CONFIG_DIR`, `CONFIG_FILE` computed from `XDG_CONFIG_HOME`. `initialize_config()` creates dir + empty file if absent. Auto-migrates v0→v1 (adds `is_active: false`) on load. On JSON parse failure, backs up corrupted file to `profiles.json.corrupted.<timestamp>` and creates fresh empty config. `save_profile()` accepts `originalName`/`originalTrigger` kwargs for rename detection (prevents duplicates). Writes via `GLib.file_set_contents` — crash-safe. `load_profiles_readonly()` parses without ever writing (no migration persist). `import_profiles()`/`export_profiles()` for JSON file transfer.
- **constants.js** — all magic numbers centralized: `POLL_INTERVAL_MS=3000`, `ROUTING_COOLDOWN_S=5`, `CAPTURE_DEBOUNCE_MS=3000`, `CAPTURE_START_DEBOUNCE_MS=1500`, `HEARTBEAT_INTERVAL_S=30`, `HEARTBEAT_ALIVE_THRESHOLD_S=45`, `BT_RETRY_DELAY_MS=5000`, `CONFIG_CHANGE_DEBOUNCE_MS=500`, `SYNC_FALLBACK_TIMEOUT_MS=3000`, `FLASH_DURATION_MS=1500`.
- **log.js** — structured logging with levels (`DEBUG`/`INFO`/`WARN`/`ERROR`) and `[HH:MM:SS]` timestamps. `setLogFile(path)` enables dual stdout+file output with 1MB rotation. Used via `log.info('module', 'msg')`, `log.warn(...)`, `log.error(...)`.
- **utils.js** — `is_flatpak` checks `/.flatpak-info` file existence. In Flatpak mode, `get_wpctl_cmd()`/`get_pactl_cmd()` prepend `['flatpak-spawn', '--host']`. Outside Flatpak, resolves absolute binary paths at module load time to prevent PATH injection. `strip_tree_chars(line)` removes PipeWire tree-drawing characters from status output lines. `spawn_sync_with_timeout(argv, timeout_ms)` runs a subprocess via `Gio.Subprocess` with `communicate_utf8_async` + nested `GLib.MainLoop` — timeouts kill runaway processes instead of freezing the daemon.
- **bt_profiles.js** — exports `A2DP_QUALITY` (ordered: LDAC > aptX-HD > aptX > AAC > a2dp-sink > SBC-XQ > SBC) and `HSP_HFP` (handsfree-headset > headset-head-unit). `pickBest(available, desired)` matches user preference against card capability via ladder fallback.
- **pactl_parser.js** — `parseCardsText(text)` returns `Map<pw_name, {active: string, profiles: Set<string>}>`. `parsePactlCards()` wraps+ caches. Internal 1s cache avoids re-spawning pactl on rapid successive calls.

## Daemon Flow Summary

```
daemon_main.js:main()
  config_mgr.initialize_config()    # ensure CONFIG_DIR exists before log/heartbeat
  try Wp.init(Wp.InitFlags.ALL)     # silently skip if typelib missing
  engine = new DaemonEngine()       # all mutable state encapsulated in instance
  monitor = engine.build_monitor()  # WpMonitor wired with node/device signals, capture signals wired OUTSIDE ready handler
  monitor.start()                    # engine._core.connect() → engine._on_core_connected() → engine._poll() every 3s
  Gio.File.new_for_path(CONFIG_FILE).monitor()   # re-route on changes, 500ms rate limit
  GLib.MainLoop.run()

_poll() cycle (every 3s):
  _poll_nodes()    → wpctl status + inspect (builds _desc_to_id / _id_to_node maps first)
  _poll_devices()  → Devices section (cached — skips inspect for known devices)
  _poll_streams()  → capture detection, emits capture-started/capture-stopped on 0→1/1→0

on 'ready' signal (order matters!):
  1. on first fire: capture-started/capture-stopped already wired (outside handler)
  2. on re-fire (Wp.Core reconnect): engine.clear_state() clears stale routing/capture state
  3. route already-connected nodes (force=true)
  4. activate_bt_card() for every bluez_card.* device
  5. re-apply call profiles for active captures

capture-stopped flow (restore):
  1. set_bt_profile() → switch card from HSP/HFP back to A2DP
  2. _bt_activate_after_delay() → safety retry: if profile switch leaves card in 'off', fall back to a2dp-sink after 5s
  3. _reassert_default_sink() → set BT sink as default (tries monitor cache, falls back to pactl)
  4. _migrate_streams_to_bt() → immediate pactl-based stream migration
  5. delayed re-assert + migration at 600ms → pactl _resolve_bt_sink_name() + set_system_default() + migration (handles pw-pulse lag)
```

## Critical Patterns & Gotchas

### Routing & Capture
- **5s cooldown** per node name (`_last_routed` Map) — rapid plug/unplug on *different* devices all fire independently.
- **Initial routing always uses `bt_profile` (A2DP)** — capture-aware switching (`bt_profile_call`/HSP-HFP) is handled exclusively by `handle_capture_started`/`handle_capture_stopped`, driven by real stream transitions.
- **Capture fires on `bluez_input.XX.*` but profiles are keyed by `bluez_output.XX.*`** — `_find_active_profile_for()` tries exact match first, then falls back to matching any active profile on the same `bluez_card.MAC`.
- **3s capture debounce** per card (`_capture_timers` Map keyed by node_name) — tolerates push-to-talk gaps. New capture-started during debounce cancels timer. (Separate `_capture_start_timers` Map keyed by card_name provides 1.5s capture-start debounce.)
- **`_restoring_cards` Set** — added before `set_bt_profile()`, cleared in `finally` block. Checked in `handle_capture_stopped()` to prevent multiple timers racing to restore the same card. `_bt_card_name()` is a pure regex extractor with no awareness of this Set.
- **`_active_capture_nodes` Set** — tracks which nodes have active captures. Bridges output-keyed routing vs. input-keyed capture tracking. Cleaned on `node-removed` and `capture-stopped`.
- **`off` state filtering** — `_fetch_nodes_from_wpctl()` applies a `/\boff\b/` regex to the raw `wpctl status` line, skipping `(off)` entries to prevent false routing on inactive BT cards.
- **`node-removed` cleanup** — `_capture_timers` and `_active_capture_nodes` entries cleaned up on node removal. Crucially, `_capture_counts` is NOT deleted in `_poll_nodes()` — it persists until `_poll_streams()` replaces the entire counts map at the end of the poll cycle. This allows `_poll_streams()` to detect the >0→0 transition and emit `capture-stopped`; deleting it early would silently lose the transition.
- **`activate_bt_card()` retry** — if card stays in `off` after initial profile set, retries with `a2dp-sink` after 5s (`BT_RETRY_DELAY_MS`). Skip logic: if `current !== 'off' && resolved === current`, skip to avoid barging.
- **Stream `<`/`>` arrows** — PipeWire ≥1.6.6 uses `<` for input ports, `>` for output. Parser handles both backward-compatibly.
- **BT auto-discover** — when profile has `bt_profile` but empty `default_sink`/`default_source`, daemon auto-discovers BT sink/source nodes sharing the same `bluez_card.MAC`.
- **Stream migration after restore** — after HSP→A2DP restore, `_migrate_streams_to_bt()` runs `pactl move-sink-input` to move ALSA-bound streams (Spotify, browser, etc.) to the freshly-created A2DP sink. The monitor cache is stale at this point, so the delayed migration uses `_resolve_bt_sink_name()` (pactl, real-time) instead of `monitor.get_audio_nodes()`. `_reassert_default_sink()` also has a pactl fallback for the same reason.

### Daemon Lifecycle
- **Config dir first**: `daemon_main.js:main()` calls `config_mgr.initialize_config()` before anything else (log file, heartbeat) to ensure `CONFIG_DIR` exists. This prevents silent log/heartbeat write failures on first launch.
- **Heartbeat**: daemon writes timestamp to `~/.config/autowire/daemon.heartbeat` (atomic file_set_contents, initial write then every 30s via `HEARTBEAT_INTERVAL_S`). `window.js` checks file mtime ≤ 45s (`HEARTBEAT_ALIVE_THRESHOLD_S`) to detect liveness.
- **Daemon death detection**: `window.js` spawns daemon via `Gio.Subprocess` and attaches `wait_async()` callback for immediate crash detection (in addition to heartbeat polling every `DAEMON_POLL_INTERVAL_S`). Calls `_ensure_daemon_running()` to re-spawn.
- **SIGTERM/SIGINT**: `GLibUnix.signal_add()` (NOT deprecated `GLib.unix_signal_add`) with numeric signal constants (15, 2).
- **Config file watcher**: `Gio.File.new_for_path(path).monitor()` (GJS 1.80+ API, not `Gio.FileMonitor.new_for_path`). 500ms rate limit. On change: re-route all tracked nodes (force=true), re-apply active captures.
- **WirePlumber restart recovery**: capture-started/stopped signals are wired OUTSIDE the `ready` handler to prevent duplicate handler chains. On Wp.Core reconnect, `ready` fires again with `_first_ready = false`, calling `engine.clear_state()` to purge stale routing/capture state then re-applies routing.

### UI Patterns
- **Import/Export** — gear menu button opens `Gtk.FileDialog`. Import must call `dialog.open()` + `open_finish()`, NOT `dialog.save()` + `save_finish()` (would show "Save As" instead of "Open File"). Export uses `dialog.save()` + `save_finish()` as expected.
- **`Adw.PreferencesGroup` title via constructor broken** — always use `set_title()` after construction.
- **`Adw.AlertDialog` needs object constructor** — `new Adw.AlertDialog({heading, body})`.
- **`Adw.ComboRow` needs `Adw.PreferencesGroup` parent** — all `Adw.PreferencesRow` subclasses (EntryRow, ComboRow, SwitchRow) non-interactive outside one.
- **`Gtk.Switch` active in constructor** — set `active` in constructor props, avoid setting post-construction to prevent spurious `notify::active` emissions.
- **Profile dialog**: loads devices via `get_audio_nodes_async()` asynchronously. Profile name uses `Gtk.Entry` in `Adw.PreferencesRow` (no separate card frame); blue focus box killed via `outline-width: 0` on per-widget `Gtk.CssProvider` at `USER` priority. BT and Call Profile dropdowns share the same device-filtered list. Auto-switch is implicit — setting a call profile enables it automatically; no separate toggle. BT labels stripped of parenthetical descriptions (`"LDAC"` not `"LDAC (high quality)"`). Dialog size 600×500.
- **Profile rows**: clickable to edit via `activated` signal on `Adw.ActionRow`. Pencil icon (`document-edit-symbolic`) always visible on every row alongside move/delete buttons. No tooltips on any button.
- **Main window**: 680×560 default size. `close-request` signal calls `app.quit()`. `vfunc_dispose()` kills daemon subprocess. Header "+" button hidden on empty state, made flat (removed `suggested-action`). Trigger group titles show device name only (no `(N)` count suffix). Empty state uses custom `Gtk.Box` layout instead of `Adw.StatusPage`.
- **`Ctrl+N`** maps to `_on_add_clicked()` (not `_show_add_dialog()` which doesn't exist).
- **`Wp` import optional everywhere** — `main.js`, `daemon_main.js`, `wp_monitor.js` all wrap Wp typelib import/init in try-catch. Flatpak `org.gnome.Platform//50` lacks `Wp-0.5` typelib, falls back to poll-only mode.
- **No GResource/Blueprint** — all widgets built programmatically in GJS. No `.blp` or `.gresource` files.
- **Keyboard shortcuts** — `Ctrl+N` (add profile), `Ctrl+Q` (quit), `F5` (refresh) via `Gio.SimpleAction` accelerators.

### GJS PipeWire Workarounds
- **Poll-based WpMonitor** — GJS Wp bindings can't read proxy properties (`Proxy.get_properties()` returns null). Uses `wpctl status` + `wpctl inspect` every 3s instead of `Wp.ObjectManager`.
- **`get_audio_nodes_async()` timeout** — the async subprocess now has a safety timeout (`STATUS_TIMEOUT_MS + 1000`). If `wpctl status` hangs, the callback fires with an empty array instead of leaving the dialog loading forever.
- **Numeric ID resolution** — `wpctl set-default` needs numeric PW node ID. `_resolve_node_id()` parses `wpctl status` for candidate IDs, `wpctl inspect`s each to match `node.name`. **Caveat**: runs a nested `GLib.MainLoop` via `_spawn_sync_with_timeout` — new call paths must be reviewed for re-entrancy.
- **Device global ID** — `wpctl set-profile` needs PW global ID (numeric). Use `monitor.resolveDeviceGlobalId('bluez_card.XX_XX_...')` which caches via `_devices` and falls back to parsing `wpctl status` Devices section on-the-fly.

### Flatpak
- **Manifest uses `buildsystem: simple`** (not Meson) — manually installs files via `install` commands.
- **Daemon**: `flatpak run --command=autowire-daemon io.github.nidszxh.Autowire` (no separate app-id). Wrapper scripts in `scripts/` (`autowire-wrapper.sh`, `autowire-daemon-wrapper.sh`).
- **D-Bus activation**: `io.github.nidszxh.Autowire.service.in` launches UI on demand. systemd user service (`io.github.nidszxh.Autowire.Daemon.service`) starts daemon independently.
- **`flathub.json`**: `publish-delay-hours: 3`.

## Key Commands

```bash
# Run UI / daemon (no build)
gjs -I src/ src/main.js
gjs -I src/ src/daemon_main.js

# Run single test file
gjs -I src/ tests/test_config_mgr.js
# Run all tests (supports GJS env var, individual file args)
./tests/test.sh
GJS=/usr/bin/gjs ./tests/test.sh tests/test_daemon.js

# Meson build (profile=development adds .Devel app ID suffix)
meson setup _build -Dprofile=development
ninja -C _build && ./_build/src/autowire

# Flatpak
flatpak-builder --force-clean --user --install _flatpak_build io.github.nidszxh.Autowire.json && flatpak run io.github.nidszxh.Autowire
flatpak run --command=autowire-daemon io.github.nidszxh.Autowire

# Daemon logs
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f
systemctl --user restart io.github.nidszxh.Autowire.Daemon.service
```

## Profile Data Model (`~/.config/autowire/profiles.json`)

```json
{"profiles": [{"profile_name": "AAC High Quality", "trigger_device_name": "bluez_output.XX_...", "is_active": true, "actions": {"default_sink": "...", "default_source": "", "bt_profile": "a2dp-sink-aac", "bt_profile_call": "handsfree-headset", "auto_switch": true}}]}
```

- Uniqueness: `(trigger_device_name, profile_name)`.
- `is_active`: only one per trigger can be true. Saving with `is_active=true` auto-deactivates siblings.
- Valid `bt_profile`: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink`, `a2dp-sink-sbc`, `handsfree-headset`, `headset-head-unit`, or `''`.
- `bt_profile_call`: accepts `handsfree-headset` or `headset-head-unit`; daemon substitutes between them based on card's `HSP_HFP` ladder.

## What Goes Where (Adding Features)

- Routing → `daemon.js`
- GTK UI → `window.js` or `profile_dialog.js`
- Data persistence → `config_mgr.js`
- Constants → `constants.js`
- PipeWire/WirePlumber node parsing → `wp_monitor.js`
- pactl card parsing → `pactl_parser.js`
- BT codec logic → `bt_profiles.js`
- Never import GTK from `daemon.js` or `daemon_main.js`
- Tests in `tests/test_*.js` with zero GI imports (GLib-only, no hardware)
