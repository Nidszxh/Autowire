# Changelog

All notable changes to Autowire are documented here.

## [Unreleased]

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