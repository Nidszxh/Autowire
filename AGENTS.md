# Autowire — Agent Instructions

## Project Overview
Libadwaita-native GTK4 application for automated PipeWire/WirePlumber audio profile switching. Two processes: a GTK UI and a headless systemd daemon, both Python. Meson + Blueprint build.

## Architecture

```
data/ui/*.blp ──blueprint-compiler──► data/ui/*.ui ──► autowire.gresource
src/
  autowire.in          # UI launcher script (Meson template)
  autowire-daemon.in   # daemon launcher script
  main.py              # Adw.Application entry point
  window.py            # Profile list UI
  profile_dialog.py    # Create/edit profile dialog (async device loading)
  daemon.py            # Routing engine: wpctl set-default / set-profile
  daemon_main.py       # Pure-GLib daemon entry point (no GTK imports)
  wp_monitor.py        # WpCore + WpObjectManager wrapper (WpNode + WpDevice)
  config_mgr.py        # Atomic JSON persistence at ~/.config/autowire/profiles.json
```

**Two entry points**, each with its own launcher:
- **UI** (`autowire`): `src/main.py` → `main()` — requires GTK/Adwaita imports
- **Daemon** (`autowire-daemon`): `src/daemon_main.py` → `main()` — GLib only (no GTK)

Both launcher scripts auto-detect dev mode by checking for `_build/` artifacts and adjust `sys.path` accordingly (`src` package in dev, `autowire` package when installed).

## Build System

```bash
# First-time setup (required before running anything)
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Wipe and rebuild
rm -rf _build && meson setup _build --prefix=/usr/local -Dprofile=development && ninja -C _build

# Install (postinstall.py: icon cache + desktop db update + systemd service enable)
sudo ninja -C _build install

# Dev profile appends .Devel to app ID: io.github.nidszxh.Autowire.Devel
```

**Blueprint→UI→GResource is mandatory.** Without `ninja -C _build`, `@Gtk.Template` decorators fail to load and the app crashes on startup.

`src/main.py:_load_resources()` searches three paths (in order):
1. `pkgdatadir/autowire.gresource` (installed/Flatpak)
2. `_build/data/autowire.gresource` (Meson dev build)
3. `src/autowire.gresource` (alongside source)

### GResource manifest (`data/io.github.nidszxh.Autowire.gresource.xml`)
Registers `window.ui` and `profile_dialog.ui` under `/io/github/nidszxh/Autowire/`.

### Flatpak build
```bash
flatpak-builder --force-clean --user --install _flatpak_build io.github.nidszxh.Autowire.json
```
The manifest declares two commands (`autowire`, `autowire-daemon`) and installs a D-Bus session service for daemon autostart. Runtime: `org.gnome.Platform//48`.

## Key Commands

```bash
# Run all tests
python3 -m pytest tests/ -v

# Run a single test class
python3 -m pytest tests/test_daemon_routing.py -v

# Run a single test
python3 -m pytest tests/test_daemon_routing.py::SetBtProfileTestCase -v
```

Test count: **55** (14 config_mgr + 23 daemon + 18 wp_monitor).

## Profile Data Model (persisted to `~/.config/autowire/profiles.json`)

```json
{
  "profiles": [
    {
      "profile_name": "Desk Setup",
      "trigger_device_name": "bluez_output.XX_XX_XX_XX_XX_XX.a2dp-sink",
      "actions": {
        "default_sink": "bluez_output.XX_XX_XX_XX_XX_XX.a2dp-sink",
        "default_source": "alsa_input.usb-analog-mic",
        "bt_profile": "a2dp-sink-aac"
      }
    }
  ]
}
```

- `trigger_device_name` matches PipeWire `node.name`.
- `bt_profile` is optional (empty = don't change). Valid values: `a2dp-sink-aac`, `a2dp-sink-ldac`, `a2dp-sink-aptx`, `a2dp-sink-aptx_hd`, `a2dp-sink-sbc_xq`, `a2dp-sink-sbc`, `handsfree-headset`.
- Writes are atomic: `tempfile.mkstemp()` → `os.replace()` — crash-safe.
- On load error, `load_profiles()` returns `[]`.

## WpMonitor: WirePlumber Integration

`wp_monitor.py` wraps `Wp.Core` + `Wp.ObjectManager` and monitors:
- **WpNode**: filtered by `media.class` in `{'Audio/Sink', 'Audio/Source', 'Audio/Duplex'}`. Emits `node-added(name, description, media_class)`.
- **WpDevice**: all devices. Emits `device-added(name, description, global_id)`.

Key property keys:
- Node: `node.name`, `node.description`, `media.class`
- Device: `device.name`, `device.description` (no `media.class` filter)

`get_device_global_id(name)` returns the PipeWire numeric global ID (from `Wp.Proxy.get_bound_id()`). Required for `wpctl set-profile`.

### Bluetooth Card Name Resolution
`daemon._bt_card_name(node_name)` derives the BT card name:
- `bluez_output.XX_XX_XX_XX_XX_XX.a2dp-sink` → `bluez_card.XX_XX_XX_XX_XX_XX`
- `bluez_input.XX_XX_XX_XX_XX_XX.handsfree-headset` → `bluez_card.XX_XX_XX_XX_XX_XX`

## wpctl Backend

- `wpctl set-default <node_name>` — accepts node names (strings)
- `wpctl set-profile <device_global_id> <profile_name>` — **requires numeric PW global ID**, not a name

All calls use `subprocess.run()` with 5s timeout, `capture_output=True`, `check=True`. Errors return False and log.

## Daemon Flow

```
daemon_main.py:main()
    └─► build_monitor() → WpMonitor
            ├─► start() → _core.connect() → _on_core_connected()
            │         └─► install WpObjectManager → watch node/device events
            └─► _watch_config_file() → GLib.FileMonitor on profiles.json
                    (re-routes all active nodes when config file changes)

WpMonitor._on_node_added()
    └─► daemon._on_node_added() → check_and_route_device(name, monitor)
            ├► 5s cooldown check (_last_routed per node)
            ├► set_system_default(sink)
            ├► set_system_default(source)
            └► if bt_profile: set_bt_profile(global_id, bt_profile)
```

**Config file change path:** When `profiles.json` is modified, `GLib.FileMonitor` fires `changed` → re-routes all currently active nodes so edits apply immediately without reconnecting hardware.

## Testing

- `tests/conftest.py` adds project root to `sys.path` so `from src import config_mgr, daemon` works
- Config tests: `setUp()` overrides `config_mgr.CONFIG_DIR`/`CONFIG_FILE` to a temp dir
- Daemon tests: `@patch('src.daemon.subprocess.run')` to mock `wpctl`
- `CheckAndRouteDeviceTestCase.setUp()` clears `daemon._last_routed` to prevent cross-test leakage
- Routing tests pass a mock `WpMonitor` via `monitor=mock_monitor` to test BT profile resolution

## ProfileDialog

- `Adw.Dialog` subclass using `@Gtk.Template(resource_path='/io/github/nidszxh/Autowire/profile_dialog.ui')`
- Widgets: `content_stack`, `name_entry`, `trigger_row`, `sink_row`, `source_row`, `bt_profile_row`, `save_button`, `cancel_button`
- `content_stack` is a `Gtk.Stack` with `loading` (spinner + "Scanning audio devices…" label) and `ready` (the form) pages. Dialog shows spinner immediately on open; switches to `ready` when `_on_devices_loaded` fires.
- `BT_PROFILES` class constant: `[(key, label), ...]` — key is `''` for "Don't change"
- Device lists are loaded **asynchronously** via `threading.Thread` (daemon=True) → `get_audio_nodes_sync()` → `GLib.idle_add` → `_on_devices_loaded()`. Dialog appears immediately; combo rows populate when the thread delivers results.
- `_on_devices_loaded()` sets `Gtk.StringList` models on the ComboRows using the `description` field (human-readable labels, e.g. `JLab GO Air Pop`). Trigger selection uses the `name` field (PipeWire technical names, e.g. `bluez_output.0F_56_...`) stored in `profile.trigger_device_name`.
- Save button enabled when name is non-empty AND trigger is selected (`!= Gtk.INVALID_LIST_POSITION`)

## Important Constraints

- **`Wp.init(Wp.InitFlags.ALL)` must be called before any Wp usage** — done in launcher scripts, not library modules
- **`gi.require_version('Wp', '0.5')` must precede `from gi.repository import Wp`**
- **Blueprint templates won't load without `ninja -C _build`** — most common agent mistake
- **Daemon has zero GTK imports** — `daemon_main.py` imports only `GLib`, `signal`, `config_mgr`, `daemon`
- **No CI, no pre-commit, no typechecking, no pyproject.toml** — pytest is the only quality gate
- **Postinstall enables systemd service**: `ninja -C _build install` copies `io.github.nidszxh.Autowire.Daemon.service` to `~/.config/systemd/user/` and runs `systemctl --user enable --now`
- **Flatpak D-Bus autostart**: `data/io.github.nidszxh.Autowire.service` tells the D-Bus session bus to start `autowire-daemon` on login
- **Delete confirmation** uses `Adw.AlertDialog` with destructive response

## Wp 0.5 API Quirks

- **`Proxy.get_properties()` may raise `TypeError`** on some Wp 0.5 builds. Use `_proxy_properties(proxy)` in `wp_monitor.py` which falls back to `proxy.props.properties` on `TypeError`. `_get_properties` is an alias of `_proxy_properties` for backward compatibility.
- **`get_audio_nodes_sync()` uses `wpctl` directly** — no `GLib.MainLoop` blocking or `GLib.Thread`. Calls `wpctl status` to find node IDs, then `wpctl inspect <id>` for each to get `node.name` and `node.description`. Returns in ~0.2s. If a *callback* is passed, fires it via `GLib.idle_add`.
- **`Wp.Properties` constructors** are `new_empty()`, `new_string(str)`, `new_copy()` — `Wp.Properties()` raises a boxed-type error.

## Icon Sizes

Only `scalable/` and `symbolic/` SVG exist. For GTK compatibility, symlinks at 16/24/32/48/64/128/256/512 px are created via:
```bash
python3 -c "import os; sizes=[16,24,32,48,64,128,256,512]; ..."
```
These must be regenerated if icons are changed.