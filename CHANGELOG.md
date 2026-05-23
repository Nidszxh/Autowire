# Changelog

All notable changes to Autowire are documented here.

## [Unreleased]

### GJS Migration (primary runtime)
- **GJS-first** — all source files ported from Python to GJS. Python files kept as reference only.
- **Poll-based WpMonitor** — replaces Wp.ObjectManager (GJS bindings can't read proxy properties). Uses `wpctl status` + `wpctl inspect` in 3s poll cycle.
- **Programmatic UI** — no Blueprint/GResource templates needed. All widgets built in code.
- **Daemon reworked** — `GLibUnix.signal_add` for signal handling, `Gio.File.monitor` for config watching, numeric node ID resolution for wpctl.

### Stream-aware auto-switching
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

### Documentation
- **All docs updated** — README, CONTRIBUTING, CHANGELOG, docs/architecture.md reflect GJS-primary status and stream-aware features.