# Contributing to Autowire

## Getting Started

```bash
# Install dependencies (Fedora)
sudo dnf install python3-gobject gtk4 libadwaita wireplumber blueprint-compiler meson ninja-build

# Clone and build
git clone https://github.com/nidszxh/autowire
cd autowire
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Run the app
./_build/src/autowire
```

## Development Workflow

**Always rebuild before running** after any `.blp`, `.py`, or `.json` change:

```bash
ninja -C _build
./_build/src/autowire
```

**To wipe and start fresh:**
```bash
rm -rf _build && meson setup _build --prefix=/usr/local -Dprofile=development && ninja -C _build
```

**Blueprint templates are mandatory.** Never try to run the app without `ninja -C _build` first. `@Gtk.Template` decorators load UI from `autowire.gresource`, which only exists after Meson compiles the `.blp` files.

## Testing

```bash
# All tests (60 total)
python3 -m pytest tests/ -v

# Single file
python3 -m pytest tests/test_daemon_routing.py -v

# Single test class
python3 -m pytest tests/test_daemon_routing.py::CheckAndRouteDeviceTestCase -v
```

Tests are hardware-free — all WirePlumber/PipeWire calls are mocked with `@patch`.

## Project Layout

```
src/
  autowire.in / autowire-daemon.in   # Meson launcher templates
  main.py                            # UI entry (GTK/Adwaita)
  window.py                          # Profile list window (grouped by trigger)
  profile_dialog.py                  # Create/edit dialog (async device loading)
  config_mgr.py                      # profiles.json persistence + is_active logic
  daemon.py                          # Routing engine (is_active check, wpctl calls)
  daemon_main.py                     # Daemon process (GLib only)
  wp_monitor.py                      # WirePlumber WpCore wrapper

data/ui/
  *.blp                              # Blueprint templates → *.ui via Meson

tests/
  conftest.py                        # sys.path setup for src/ imports
  test_config_mgr.py                # 20 tests
  test_daemon_routing.py            # 23 tests
  test_wp_monitor.py                # 17 tests
```

## Architecture Notes

**Two independent processes** — the UI and the daemon are completely separate. They only share `~/.config/autowire/profiles.json`.

- **UI** (`src/main.py`) requires GTK, Adwaita, and WirePlumber GObject bindings.
- **Daemon** (`src/daemon_main.py`) imports only `GLib`, `signal`, `config_mgr`, and `daemon`. No GTK. This is intentional — the daemon must run in headless environments.

When adding features:
- Routing logic goes in `daemon.py`
- GTK UI logic goes in `window.py` or `profile_dialog.py`
- Shared data logic goes in `config_mgr.py`
- Never import GTK from `daemon.py` or `daemon_main.py`

### Profile Activation

Each profile has an `is_active` boolean. Only one profile per trigger device can be active at a time. When `save_profile()` is called with `is_active=True`, it automatically deactivates all sibling profiles for that trigger. `daemon.check_and_route_device()` skips any profile where `is_active` is not True.

## Code Style

- No comments unless required by AGENTS.md
- Follow existing import ordering (stdlib → gi → local)
- Type hints on all public functions
- Test new code with `python3 -m pytest` before committing

## Debugging

**Daemon logs:**
```bash
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f
```

**Quick restart after config change:**
```bash
systemctl --user restart io.github.nidszxh.Autowire.Daemon.service
```

**Inspect a node:**
```bash
wpctl inspect <node_id>
```

**List all nodes:**
```bash
wpctl status
```

**Profile config location:**
```bash
cat ~/.config/autowire/profiles.json
```