# Changelog

All notable changes to Autowire are documented here.

## [Unreleased]

### Bug fixes, architecture, quality, and new features
- **DaemonEngine class** — all mutable state (`_last_routed`, `_capture_timers`, `_capture_start_timers`, `_active_capture_nodes`, `_restoring_cards`, `_activated_bt_cards`) encapsulated in instance. Module-level constants remain at module scope.
- **Bug fix: activate_bt_card() ordering** — moved `_activated_bt_cards.add()` to after profile-exists check. Prevents cards from being permanently skipped when no active profile targets them at connection time.
- **Bug fix: handle_capture_stopped re-entrancy** — double-layer guard using `_restoring_cards` Set (early exit + timer callback) prevents nested MainLoop from spawning redundant restore timers.
- **read-only profile loader** — `load_profiles_readonly()` added to `config_mgr.js`. Never writes (no `initialize_config`, no backup, no migration persist). All 5 read-only daemon call sites migrated from `load_profiles()`.
- **Daemon crash detection** — `window.js` attaches `wait_async()` callback on `Gio.Subprocess` for immediate re-spawn on daemon death.
- **Import/Export** — gear menu button in header bar opens `Gtk.FileDialog` for JSON import/export via `config_mgr.import_profiles()`/`export_profiles()`.
- **Desktop notifications** — daemon calls `notify-send` via `Gio.Subprocess` on profile routing, capture-start, and capture-stop.
- **File-based logging** — `log.setLogFile(path)` enables stdout+file output with 1MB rotation. Daemon writes to `~/.config/autowire/daemon.log`.
- **Keyboard shortcuts** — `Ctrl+N` (add profile), `Ctrl+Q` (quit), `F5` (refresh).
- **CSS highlight animation** — `.highlight` class with `transition: background-color 1.5s ease-out` replaces red `error` flash.
- **Code quality** — `_last_routed` `{}`→`Map`, `_capture_timers` `{}`→`Map`. Shared `strip_tree_chars()` extracted to `utils.js`. Renamed `_connected_bt_card_names`→`_connected_bt_pw_names`. Removed empty `_watch_config()` from `window.js`. Heartbeat `.tmp` cleanup simplified.
- **Test coverage** — 27 new daemon `_validate_profile()` tests (daemon 10→37). Test runner prints count summary.
- **Stream migration after A2DP restore** — `_migrate_streams_to_bt()` runs `pactl move-sink-input` to move ALSA-bound streams (music players, browsers) back to the restored BT sink after capture-stopped. Uses pactl directly (bypassing the 3s-polled monitor cache) to handle pipewire-pulse registration lag after HSP↔A2DP profile switches.
- **`_resolve_bt_sink_name()` helper** — queries `pactl list sinks` in real-time to find the BT sink name after profile restore, instead of relying on the stale monitor cache.
- **`_reassert_default_sink()` pactl fallback** — when `get_audio_nodes()` returns stale data (no BT sink found), falls back to `_resolve_bt_sink_name()` via pactl. Added `_schedule_sink_reassert()` for retry on successive poll cycles.
- **`_resolve_node_id()` BT cache bypass** — `bluez_*` nodes skip the poll data cache since PipeWire recreates them with new PW IDs after profile switches (ALSA nodes retain their IDs, so cache is safe for them).
- **Source default removal** — removed `set_system_default()` call for BT input source in `handle_capture_started()` since `wpctl set-default` rejects `Audio/Source/Internal` nodes.
- **178 tests** — 178 GJS unit tests across 6 test files.

### Python removal and source cleanup
- **All `.py` source files removed** — `src/*.py`, `src/exp/*.py`, `tests/*.py` deleted. Only GJS remains.
- **`src/prod/` flattened** — 7 JS files moved to `src/` directly; all `imports.prod.*` changed to `imports.*`.
- **Meson launchers rewritten** — `autowire.in` / `autowire-daemon.in` changed from Python to bash wrappers exec'ing `gjs` with dev-mode path detection.
- **No GJS test suite** — all 60 Python tests were removed; zero JS test coverage exists.

### Stream-aware BT auto-switching fixes
- **`_fetch_capture_streams()` parsing fix** — `wpctl status` Streams sub-entries use space indentation (not `│` pipes). Rewrote regex and section parsing to correctly detect `input_*` / `output_*` stream targets.
- **BT card-aware profile matching** — capture events fire with `bluez_input.XX.handsfree-headset` but profiles are keyed by `bluez_output.XX.a2dp-sink`. Added `_get_active_profile_for()` with exact-match → BT card fallback.
- **Cross-card capture lookup** — `check_and_route_device()` used `_active_capture_nodes.has(output_name)` but captures stored by input name. Added `_any_active_capture_for()` checking all BT card siblings.
- **Auto-route BT input/output** — when profile actions have empty `default_sink`/`default_source` for a BT device, daemon auto-discovers corresponding sink/source nodes via `bluez_card.MAC` and routes them.
- **Bidirectional `_desc_to_name`** — `wp_monitor.js` now maps both `description → name` and `name → name` so stream target descriptions resolve correctly.

### GJS Migration (primary runtime)
- **GJS-first** — all source files ported from Python to GJS.
- **Poll-based WpMonitor** — replaces Wp.ObjectManager (GJS bindings can't read proxy properties). Uses `wpctl status` + `wpctl inspect` in 3s poll cycle.
- **Programmatic UI** — no Blueprint/GResource templates needed. All widgets built in code.
- **Daemon reworked** — `GLibUnix.signal_add` for signal handling, `Gio.File.monitor` for config watching, numeric node ID resolution for wpctl.

### Stream-aware auto-switching (initial)
- **Capture stream detection** — `_poll_streams()` parses `wpctl status` Streams section, detects `input_*` sub-entries, maps target descriptions to node names. Emits `capture-started`/`capture-stopped` GObject signals.
- **Auto-switch for calls** — daemon switches to `bt_profile_call` (e.g. HSP/HFP) on mic activity, restores `bt_profile` (e.g. AAC) after 3s debounce. Profile dialog has Call BT Profile + Auto-switch toggle.
- **`_active_capture_nodes` tracking** — `check_and_route_device()` checks active capture state at routing time to select correct BT profile.

### Profile enhancements
- **`bt_profile_call` / `auto_switch` fields** — stored in profile actions for capture-aware BT codec switching.
- **Multi-profile per trigger** — multiple named profiles per device enforced by `(trigger, name)` uniqueness.
- **`is_active` field** — only one active profile per trigger. Daemon fires only active profiles.
- **Active toggle** — `Gtk.Switch` on each row to activate/deactivate profiles without opening dialog.
- **Startup routing** — daemon routes all connected nodes immediately on ready.

### UI fixes
- **Adw.AlertDialog constructor** — switched from positional args to `{heading, body}` object for Adw 1.5+ compatibility.
- **Adw.Dialog child attachment** — added `this.set_child(content)` so dialog content renders.
- **Dialog sizing** — set 460×540 minimum size for the profile dialog.
- **Gtk.Switch active in constructor** — avoids spurious `notify::active` emissions.
- **AboutDialog** — added with version, license, and links.

### Capture-aware switching fixes
- **`check_and_route_device` no longer checks capture state** — initial routing always uses `bt_profile` (AAC). Capture-aware switching (`bt_profile_call` / HSP/HFP) is handled exclusively by `handle_capture_started`/`handle_capture_stopped`, which are triggered by real capture stream transitions. This prevents false/stale capture detections from keeping the device stuck in HSP/HFP.
- **`ready` handler re-applies capture profiles** — after initial routing, `daemon_main.js` now iterates `monitor.get_capture_nodes()` and calls `handle_capture_started` for each, ensuring active captures at startup correctly switch to `bt_profile_call`.
- **New `get_capture_nodes()` method** on `WpMonitor` — returns node names with active capture counts > 0.

### Flatpak & GJS compatibility fixes
- **Wp typelib optional everywhere** — `main.js`, `daemon_main.js`, `wp_monitor.js` wrap Wp import/init in try-catch. Flatpak `org.gnome.Platform//50` lacks `Wp-0.5` typelib; all modules fall back to poll-only / sync mode.
- **Profile dialog combo rows fixed** — all `Adw.PreferencesRow` widgets (EntryRow, ComboRow, SwitchRow) now inside an `Adw.PreferencesGroup` (required for ComboRow click handling). Header bar buttons compacted with `flat` + `valign: CENTER`.
- **Async→sync device loading fallback** — `get_audio_nodes_async()` with 3s timeout; falls back to synchronous `get_audio_nodes_sync()` if async fails. New `get_audio_nodes_sync()` exported from `wp_monitor.js`.
- **Icon cache rebuild in Flatpak build** — `gtk-update-icon-cache -f` added to manifest after icon install so about dialog finds the app icon.

### Documentation
- **All docs updated** — README, CONTRIBUTING, CHANGELOG, docs/architecture.md reflect GJS-primary status, Wp-optional architecture, and stream-aware features.

## [0.3.11] - 2026-06-19

### Source code refactoring
- **`bt_profiles.js` extracted** — codec-quality ladder factored out of `daemon.js` for shared use.
- **`pactl_parser.js` extracted** — pactl card parser with 1s TTL cache factored out; exports `parse_cards(cards_text) → Map`.
- **`constants.js` extracted** — all timing/interval constants (`POLL_INTERVAL_MS`, `COOLDOWN_S`, `DEBOUNCE_MS`, etc.) centralized in one file, consumed by daemon + monitor + UI.
- **`utils.js` created** — shared helpers for Flatpak detection (`is_flatpak`), absolute wpctl/pactl path resolution (prevents path injection).
- **Architecture:** `daemon.js` (routing engine, 736 lines) < `wp_monitor.js` (poll/event wrapper, 537 lines) uses only exported functions from `bt_profiles.js`, `pactl_parser.js`, `constants.js`.

### Critical bug fixes
- **Profile overwrite on rename** — saving a profile with a new name no longer creates a duplicate. `save_profile()` now accepts `originalName`/`originalTrigger` kwargs to detect and clean up old entries. Rename preserves position and active state.
- **Profile position lost on rename** — when renaming a profile, its sort position within the trigger group is now preserved (was being appended to the end).
- **`save_profile()` data loss** — fixed atomic-write logic that could clobber unrelated profiles when `originalName` differs from `profile_name`.
- **Deactivation migration** — deactivating a profile and activating another now correctly sets `is_active: false` on the deactivated one (migration loop was running on the wrong profile map).
- **Heartbeat atomic write corruption** — daemon heartbeat now writes to a temp file and `GLib.rename()`s atomically instead of writing directly to `profiles.json`.
- **`off` state node filtering** — `_poll_nodes()` now skips nodes whose `node.state` is `"off"`, preventing false routing attempts for inactive Bluetooth cards.
- **`_desc_to_name` → `_desc_to_id` + `_id_to_node`** — map structure changed from description→name (ambiguous for same-description nodes) to description→numeric PW node ID, with a separate lookup for node metadata. Fixes routing when multiple sinks share the same description.
- **Stream parser `<>` arrow fix** — PipeWire 1.6.6+ uses `<` for input ports (was `>`). Parser now detects `<input*` / `>output*` consistently via `_parse_streams()`. Backward compatible with older PW.
- **`_get_active_profile_for()` → `_find_active_profile_for()`** — renamed to avoid confusion with property getter naming convention.
- **Window hardcoded 45 → `C.HEARTBEAT_ALIVE_THRESHOLD_S`** — `window.js:375` was using a magic number instead of the constant from `constants.js`.
- **`_VALID_BT_PROFILES` missing `headset-head-unit`** — added alongside `handsfree-headset` for consistency with card-querying code that may expose either name.

### Capture-aware BT switching refinements
- **`_restoring_cards` Set** — prevents routing engine from barging in when capture handler is mid-codec-change. `_bt_card_name()` returns `null` for cards in restoring state.
- **Per-card capture timer map** — replaced single shared debounce timer with `Map<pw_id, source_id>` for independent debounce per Bluetooth card.
- **`activate_bt_card()` skip logic** — skips set-profile when current profile is already the resolved target (prevents codec-upgrade barging on startup).
- **Retry fallback** — `_bt_activate_after_delay()` retries with `a2dp-sink` if card stays in `off` after 1.5s (handles slow cards).
- **Card-aware profile matching** — `_find_active_profile_for()` now extracts `bluez_card.MAC` from trigger device and matches any active profile on the same card when exact match fails.
- **`handle_capture_started()` uses card-aware match** — capture fires on `bluez_input.XX.*` but profile is keyed by `bluez_output.XX.*`; the handler now finds the correct card via MAC-based fallback.

### Test suite
- **51 GJS unit tests** — three test files with zero GI imports (GLib-only, no hardware needed):
  - `test_config_mgr.js` (25) — config migration v0→v1, CRUD, set-active, reorder, empty profiles edge cases.
  - `test_daemon.js` (10) — BT card name parsing (`bluez_output.XX_...` → `bluez_card.XX_...`), capture node matching, active profile lookup without filesystem.
  - `test_wp_monitor.js` (16) — `_parse_streams()` with `<`/`>` arrows, PW 1.6.6 format, multiple sinks, empty state, lines without arrows, `_find_card_for_node()` (MAC extraction).
- **`tests/test.sh` runner** — shebanged runner that executes all three test files and prints pass/fail counts.

### Flatpak & D-Bus
- **Flatpak daemon app-id unified** — daemon no longer has a separate app-id; launched via `flatpak run --command=autowire-daemon io.github.nidszxh.Autowire`.
- **D-Bus service `Exec` fix** — `Exec=/app/bin/autowire` corrected (was `/app/bin/autowire-daemon`, which doesn't exist for the UI service file).
- **SVG icons validation** — scalable and symbolic icons verified as valid XML.
- **Desktop file validation** — `desktop-file-validate` passes clean.
- **`flathub.json`** — added with `publish-delay-hours: 3` for Flathub submission.
- **`appstreamcli compose` passes** — the validator Flathub uses for metainfo validation.

### UI improvements
- **Profile dialog BT row sensitivity** — `bt_profile` and `bt_profile_call` `ComboRow`s are disabled for non-Bluetooth triggers, with a helper label explaining "Not applicable for non-Bluetooth devices".
- **Profile dialog async→sync fallback** — falls back to synchronous `get_audio_nodes_sync()` after 3s async timeout, ensuring device lists always populate even when Wp typelib is unavailable.

### Daemon lifecycle
- **Heartbeat-based daemon re-spawn** — `daemon_main.js` ticks a heartbeat timestamp into memory every 10s; `window.js` polls every 30s and shows a "daemon not running" state if heartbeat is stale (>45s threshold).
- **`node-removed` timer cleanup** — active capture counts and `_capture_timers` entries are cleaned up when a node is removed from the PW graph, preventing stale state.
- **SIGTERM/SIGINT graceful shutdown** — `GLibUnix.signal_add()` stops the main loop and cleans up before exit.