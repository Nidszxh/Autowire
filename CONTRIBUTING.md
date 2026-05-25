# Contributing to Autowire

## Getting Started

```bash
# Install dependencies (Fedora)
sudo dnf install gjs gtk4 libadwaita wireplumber meson ninja-build

# Run the UI (no build required)
gjs -I src/ src/main.js

# Run the daemon
gjs -I src/ src/daemon_main.js
```

## Project Layout

```
src/
  main.js                         # UI entry (GTK/Adwaita)
  window.js                       # Profile list window (grouped by trigger)
  profile_dialog.js               # Create/edit dialog
  config_mgr.js                   # profiles.json persistence
  daemon.js                       # Routing engine + stream-aware switching
  daemon_main.js                  # Daemon process (GLib only, no GTK)
  wp_monitor.js                   # Poll-based WpCore + capture detection
```

All code is pure GJS (no Python).

## Architecture Notes

**Two independent processes** — the UI and the daemon are completely separate. They only share `~/.config/autowire/profiles.json`.

- **UI** (`src/main.js`) requires GTK, Adwaita, and WirePlumber GObject bindings.
- **Daemon** (`src/daemon_main.js`) imports only `GLib`, `Gio`, `config_mgr`, and `daemon`. No GTK. This is intentional — the daemon must run in headless environments.

When adding features:
- Routing logic goes in `daemon.js`
- GTK UI logic goes in `window.js` or `profile_dialog.js`
- Shared data logic goes in `config_mgr.js`
- Never import GTK from `daemon.js` or `daemon_main.js`

### Profile Activation

Each profile has an `is_active` boolean. Only one profile per trigger device can be active at a time. When `save_profile()` is called with `is_active=True`, it automatically deactivates all sibling profiles for that trigger. `daemon.check_and_route_device()` skips any profile where `is_active` is not True.

### Stream-Aware Auto-Switching

When a profile has `auto_switch: true`, the daemon monitors capture streams via `WpMonitor._poll_streams()` (parses `wpctl status` Streams section). On detecting an `input_*` stream targeting the device:

1. **`capture-started`** signal fires — daemon cancels any pending restore timer, sets `bt_profile_call` (e.g. `handsfree-headset`)
2. **`capture-stopped`** signal fires — daemon starts a 3s debounce timer; on expiry restores `bt_profile` (e.g. `a2dp-sink-aac`)

If a new capture starts during debounce, the timer is cancelled. This handles push-to-talk gaps.

`check_and_route_device()` also checks `_active_capture_nodes` at initial routing time — if a device connects while a call is already active, it uses `bt_profile_call` instead of `bt_profile`.

## Code Style

- No comments unless required by AGENTS.md
- Follow existing import ordering

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
