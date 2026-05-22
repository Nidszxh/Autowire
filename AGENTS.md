# Autowire — Agent Instructions

## Project Overview

Libadwaita-native GTK4 application for automated PipeWire/WirePlumber audio profile switching. Two independent processes (UI + daemon) share only `~/.config/autowire/profiles.json`. Python with Meson + Blueprint build.

## Build & Run

```bash
# First-time setup (required before running anything)
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Wipe and rebuild
rm -rf _build && meson setup _build --prefix=/usr/local -Dprofile=development && ninja -C _build

# Run the UI
./_build/src/autowire

# Install system-wide (postinstall: icon cache + desktop db + systemd enable)
sudo ninja -C _build install

# Dev profile appends .Devel to app ID: io.github.nidszxh.Autowire.Devel
```

**Blueprint→UI→GResource is mandatory.** Without `ninja -C _build`, `@Gtk.Template` decorators crash. `_load_resources()` searches `pkgdatadir` → `_build/data/` → `src/` for `autowire.gresource`.

## Architecture

```
src/
  autowire.in / autowire-daemon.in  # Meson launcher templates (auto-detect _build/ for dev)
  main.py                           # Adw.Application entry (GTK/Adwaita)
  window.py                         # Profile list UI, grouped by trigger
  profile_dialog.py                 # Create/edit dialog (async device loading via threading)
  daemon.py                         # Routing engine: wpctl set-default / set-profile
  daemon_main.py                    # Pure-GLib daemon entry (no GTK imports)
  wp_monitor.py                     # WpCore + WpObjectManager wrapper (WpNode + WpDevice)
  config_mgr.py                     # Atomic JSON persistence at ~/.config/autowire/profiles.json
  main.js / daemon_main.js / ...    # Side-by-side GJS port (incomplete, installed but not primary)
```

**Two entry points:**
- **UI** (`autowire`): `src/main.py` → `main()` — requires GTK/Adwaita/Wp imports
- **Daemon** (`autowire-daemon`): `src/daemon_main.py` → `main()` — GLib only (no GTK, no Adw)

Both launchers call `gi.require_version('Wp', '0.5')` then `Wp.init(Wp.InitFlags.ALL)` *before* any other Wp usage.

## Key Commands

```bash
# All tests (60 total: 19 config_mgr + 23 daemon + 18 wp_monitor)
python3 -m pytest tests/ -v

# Single file or class
python3 -m pytest tests/test_daemon_routing.py::CheckAndRouteDeviceTestCase -v

# Run the app (must rebuild first)
ninja -C _build && ./_build/src/autowire

# Daemon logs
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f

# Restart daemon after config change
systemctl --user restart io.github.nidszxh.Autowire.Daemon.service
```

## GResource

Registers `window.ui` and `profile_dialog.ui` under `/io/github/nidszxh/Autowire/` in `data/io.github.nidszxh.Autowire.gresource.xml`. Build output lands at `_build/data/autowire.gresource`. The `.ui` files in `data/` are generated from `data/ui/*.blp` and `.gitignore`d.

## Profile Data Model (`~/.config/autowire/profiles.json`)

```json
{"profiles": [{"profile_name": "AAC High Quality", "trigger_device_name": "bluez_output.XX_...", "is_active": true, "actions": {"default_sink": "...", "default_source": "...", "bt_profile": "a2dp-sink-aac"}}]}
```

- Uniqueness: `(trigger_device_name, profile_name)`. Multiple profiles per trigger allowed.
- `is_active`: only one per trigger can be `true`. `save_profile(is_active=True)` auto-deactivates siblings.
- `bt_profile` valid values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`, or `''` (don't change).
- Atomic writes: `tempfile.mkstemp()` → `os.replace()` — crash-safe.
- `load_profiles()` migrates old entries (adds `is_active: false`), returns `[]` on error.

**`config_mgr.py` API:**
- `initialize_config()` — creates dir + empty file if absent
- `load_profiles()` → `list[dict]`
- `get_profile(trigger, name)` → `dict | None`
- `get_profiles_for_trigger(trigger)` → `list[dict]`
- `get_active_profile(trigger)` → `dict | None`
- `set_active_profile(trigger, name)` — deactivates all others for that trigger
- `save_profile(name, trigger, sink, source, bt_profile='', is_active=False)` — upserts by `(trigger, name)`
- `delete_profile(trigger, name)` → `bool`

## Daemon Flow

```
daemon_main.py:main()
  └─► build_monitor() → WpMonitor.start() → _core.connect()
        └─► _on_core_connected() ── install WpObjectManager (WpNode + WpDevice)
              └─► _on_om_installed() → emit 'ready'
  └─► _watch_config_file() → GLib.FileMonitor on profiles.json
        └─► on change → re-route all active nodes via check_and_route_device()
  └─► On 'ready' signal → check_and_route_device() for already-connected nodes

WpMonitor._on_node_added()
  └─► daemon._on_node_added() → check_and_route_device(name, monitor)
        ├► 5s cooldown (_last_routed per node)
        ├► load_profiles() → first where trigger == name AND is_active == True
        ├► set_system_default(sink) / set_system_default(source)
        └► if bt_profile: _bt_card_name(node) → monitor.get_device_global_id(card) → set_bt_profile(id, profile)
```

- `_bt_card_name(node_name)`: `bluez_output.XX_XX_...` → `bluez_card.XX_XX_...`
- `wpctl set-default <node_name>` — accepts node name string
- `wpctl set-profile <device_global_id> <profile_name>` — **requires numeric PW global ID** (not a name)

## WpMonitor Signals

- `node-added(name, description, media_class)` — filtered by `media.class` in `{'Audio/Sink', 'Audio/Source', 'Audio/Duplex'}`
- `node-removed(name)`
- `device-added(name, description, global_id)` — all devices (no filter)
- `device-removed(name)`
- `ready()` — monitor fully connected and populated

## Window UI

- `main_stack` with `empty` (StatusPage + "Add Profile") and `profiles` pages
- Profiles grouped by `trigger_device_name` via `_group_by_trigger()`; each trigger gets `Adw.PreferencesGroup` with title set by `set_title()`
- `_build_profile_row()` creates `Adw.ActionRow` per profile:
  - Active profile: `emblem-ok-symbolic` in accent color
  - Has siblings: toggle button (`emblem-ok-symbolic` / `pan-down-symbolic`)
  - No siblings: edit button
  - Delete button (all rows) → `Adw.AlertDialog` with destructive response

## ProfileDialog

- `Adw.Dialog` with `content_stack` (loading spinner → form)
- Device lists loaded via `threading.Thread(daemon=True)` → `get_audio_nodes_sync()` (uses `wpctl status` + `wpctl inspect`)
- Three `Adw.ComboRow` widgets for trigger/sink/source, populated with `Gtk.StringList` from descriptions
- `_on_devices_loaded()` schedules `_on_devices_loaded_idle()` via `GLib.idle_add` so combo model propagation completes before `notify::selected` fires
- Save enabled when name non-empty AND trigger selected (`!= Gtk.INVALID_LIST_POSITION`)

## Wp 0.5 API Quirks

- `Proxy.get_properties()` may raise `TypeError`. Use `_proxy_properties(proxy)` which falls back to `proxy.props.properties`. `_get_properties` is a module-level alias.
- `get_audio_nodes_sync()` uses `wpctl` subprocess (not GLib MainLoop). Returns in ~0.2s. If callback passed, fires via `GLib.idle_add`.
- `Wp.Properties()` constructor raises boxed-type error. Use `new_empty()`, `new_string(str)`, or `new_copy()`.

## Testing

- `tests/conftest.py` adds project root to `sys.path` so `from src import config_mgr, daemon` works
- Config tests: `setUp()` overrides `config_mgr.CONFIG_DIR`/`CONFIG_FILE` to `tempfile.mkdtemp()`
- Daemon tests: `@patch('src.daemon.subprocess.run')` to mock `wpctl`
- `CheckAndRouteDeviceTestCase.setUp()` clears `daemon._last_routed` to prevent cross-test leakage
- No CI, no pre-commit, no typechecking, no pyproject.toml — pytest is the only quality gate

## Important Constraints

- **Daemon has zero GTK imports** — `daemon_main.py` imports only `GLib`, `Gio`, `signal`, `config_mgr`, `daemon`
- **`Adw.PreferencesGroup` title via constructor is broken in GTK4** — always use `set_title()` after construction
- `Wp.init(Wp.InitFlags.ALL)` + `gi.require_version('Wp', '0.5')` must precede all Wp usage — done in launcher scripts
- Flatpak runtime version: `org.gnome.Platform//50` (per `io.github.nidszxh.Autowire.json`)

## Debugging

```bash
# Quick routing debug: check profiles on disk
cat ~/.config/autowire/profiles.json

# Inspect PipeWire nodes
wpctl status
wpctl inspect <node_id>

# Trigger re-route by saving any profile in the UI (config file watcher re-applies)
```
