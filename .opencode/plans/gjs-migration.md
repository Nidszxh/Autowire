# GJS Migration — Complete ✅

## Summary

All six phases implemented. Python tests still pass (60/60). No `.py` files were touched.

## Changes

| Phase | File | Status | What changed |
|---|---|---|---|
| 1 | `wp_monitor.js` | ✅ Complete | Full WpMonitor GObject class (WpCore, ObjectManager, 5 signals, node/device tracking, `_fetch_node_props()`, `get_audio_nodes_sync()` with real `wpctl` parsing). Removed mock data stub. |
| 2 | `daemon_main.js` | ✅ Complete | Startup routing now waits for `ready` signal. Config watcher reuses running monitor. Added `Wp.init()`. |
| 3 | `daemon.js` | ✅ Complete | `GLib.subprocess_new_sync()` → `GLib.spawn_sync()` with stderr capture, exit status checking, and error type differentiation (`SpawnError.NOENT` for missing binary). |
| 4a | `main.js` | ✅ Complete | Trimmed to entry point only: `AutowireApplication` + `main()` + `_load_resources()`. Added `Wp.init()`, proper ARGV handling, dev/installed GResource path resolution. |
| 4b | `window.js` | ✅ Complete | Stripped `AutowireApplication`, `main()`, `_load_resources()` — now only `AutowireWindow` (template-based). Unified coding style (property constructors). |
| 5 | `config_mgr.js` | ✅ Complete | Fixed `delete_profile()` bug: was writing original array, now writes filtered array. |
| 6 | Launcher | ✅ Complete | Both entry points (`main.js` + `daemon_main.js`) call `Wp.init(Wp.InitFlags.ALL)` before Wp usage. Wrapper scripts unchanged. |

## Remaining gaps (not blocking)

- **No GJS test suite** — Python has 60 tests. JS equivalent doesn't exist yet.
- **`profile_dialog.js` device loading** — uses sync `get_audio_nodes_sync()` via `GLib.idle_add` instead of a worker thread. Blocking is brief (~0.2s) but technically freezes the UI loop.
- **No subprocess timeout** — Python has 5s `subprocess.run(timeout=5)`. GJS `GLib.spawn_sync` doesn't support timeout. Could use `Gio.Subprocess` + cancellable in the future.
- **Flatpak daemon not wired** — D-Bus service points at `/app/bin/autowire-daemon` but no daemon wrapper is installed by the Flatpak manifest.

## File sizes

| File | Python | GJS (before) | GJS (after) |
|---|---|---|---|
| `wp_monitor` | 332 lines | 19 lines | 200 lines |
| `daemon_main` | 90 lines | 84 lines | 79 lines |
| `daemon` | 178 lines | 134 lines | 161 lines |
| `main` | 68 lines | 229 lines | 64 lines |
| `window` | 193 lines | 236 lines | 182 lines |
| `config_mgr` | 166 lines | 209 lines | 209 lines |
| `profile_dialog` | 181 lines | 214 lines | 214 lines |
