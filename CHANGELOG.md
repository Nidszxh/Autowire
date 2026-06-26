# Changelog

All notable changes to Autowire are documented here.

## [Unreleased]

### Flathub pre-submission polish
- **Flatpak daemon `--branch=stable` removed** — `window.js` no longer hardcodes `--branch=stable` when spawning the daemon via flatpak-spawn, fixing local builds on non-stable branches.
- **Daemon wrapper exit code 141/143 handling** — `scripts/autowire-daemon-wrapper.sh` treats exit codes >= 128 (signal-terminated) as intentional shutdown, preventing restart loops.
- **`SYNC_FALLBACK_TIMEOUT_MS` renamed to `DEVICE_LOAD_LOG_INTERVAL_MS`** — constant name now accurately reflects its actual use as a periodic logging interval during async device loading.
- **Desktop file** — removed `X-GNOME-UsesNotifications=false`; reordered categories to `Audio;AudioVideo;Settings;`.
- **About dialog** — changed "Bluetooth devices" to "hardware devices" to reflect the app works with USB docks and HDMI monitors.
- **Architecture docs** — fixed `a2dp-sink-codec-auto` → `a2dp-sink` in the codec ladder; renamed `SYNC_FALLBACK_TIMEOUT_MS` to `DEVICE_LOAD_LOG_INTERVAL_MS`.
- **GPL-3.0-or-later SPDX headers** — added to all 12 source modules, 7 test files, wrapper scripts, and postinstall script.

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
- **178 tests** — 178 GJS unit tests across 7 test files.
- **Flatpak daemon wrapper exit fix** — wrapper now checks gjs exit code: exits cleanly on code 0 (Ctrl+C/SIGTERM), restarts on non-zero (crash). Prevents infinite restart loop on intentional shutdown.

### v0.3.12 — UI polish, daemon fixes, Flathub prep
- **HSP→A2DP restore fixes** — `_bt_activate_after_delay()` retry after profile restore handles BT radio glitches; `_resolve_bt_sink_name()` permissive regex falls back to non-numeric-suffix names; 600ms delayed migration now re-asserts `set_system_default()` before stream migration.
- **notify-send warnings fixed** — added `--icon=io.github.nidszxh.Autowire` and `Gio.SubprocessFlags.STDERR_SILENCE` to suppress stderr noise.
- **Window close cleanup** — `close-request` signal calls `app.quit()`; `vfunc_dispose()` kills daemon subprocess via `force_exit()`.
- **UI text refined** — about dialog and empty state descriptions tightened; removed tooltips from all header/row buttons.
- **Empty state** — custom `Gtk.Box` layout replaces `Adw.StatusPage` for controlled spacing.
- **Header "+" button** — hidden when no profiles exist; made flat (removed `suggested-action`).
- **Profile dialog refactored** — profile name merged into main card (no separate frame); blue focus box killed via `outline-width: 0` per-widget CSS at `USER` priority; call profile restored as separate row sharing same device-filtered list as BT profile; BT labels stripped of parentheticals (`"LDAC"` not `"LDAC (high quality)"`); dialog sized 600×500.
- **Main window** — 680×560 default size; trigger group titles show device name without `(N)` count.
- **Profile rows** — clickable to edit via `activated` signal; pencil icon (`document-edit-symbolic`) always visible alongside move/delete buttons.
- **Ctrl+N fix** — keyboard shortcut now calls `_on_add_clicked()` (was undefined `_show_add_dialog()`).
- **Screenshots** — 4 PNGs added to `data/screenshots/` (main, profile, add, edit).
- **metainfo update** — screenshots block added; test count 166→178; `APP_VERSION`→0.3.12.
- **constants.js** — `APP_VERSION` updated to `'0.3.12'`.
- **main.js** — unused `C = imports.constants` removed; SIGINT/SIGTERM handlers installed via `GLibUnix.signal_add()`.
- **All 178 tests pass**.

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