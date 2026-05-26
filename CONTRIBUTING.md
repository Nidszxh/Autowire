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

```
                       ┌──────────────────────┐
                       │  profiles.json        │
                       │  ~/.config/autowire/  │
                       └──────┬───────┬───────┘
                              │       │
                     writes   │       │  watches
                              │       │
              ┌───────────────┘       └───────────────┐
              ▼                                       ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│       UI PROCESS        │             │     DAEMON PROCESS      │
│  main.js  (GTK+Adwaita) │             │  daemon_main.js (GLib)  │
│                         │             │                         │
│  window.js              │             │  daemon.js (routing)    │
│  profile_dialog.js      │             │  wp_monitor.js (poll)   │
│  config_mgr.js (write)  │             │  config_mgr.js (read)   │
└─────────────────────────┘             └─────────────────────────┘
```

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

When a profile has `auto_switch: true`, the daemon monitors capture streams via `WpMonitor._poll_streams()`:

```
  wpctl status → Streams section
       │
       ├── input_* appears  →  emit 'capture-started'
       │                        └─ switch to bt_profile_call (HSP/HFP)
       │                           route BT mic as default source
       │
       └── input_* disappears →  emit 'capture-stopped'
                                 └─ 3s debounce timer
                                    └─ if no new capture → restore bt_profile (A2DP)
                                                           route BT sink as default
```

On detecting an `input_*` stream targeting the device:

1. **`capture-started`** signal fires — daemon cancels any pending restore timer, routes BT mic as default source, sets `bt_profile_call` (e.g. `handsfree-headset`)
2. **`capture-stopped`** signal fires — daemon starts a 3s debounce timer; on expiry restores `bt_profile` (e.g. `a2dp-sink-aac`) and re-routes BT sink as default

If a new capture starts during debounce, the timer is cancelled. This handles push-to-talk gaps.

**BT card bridging:** Capture events fire on `bluez_input.XX.*` but profiles are keyed by `bluez_output.XX.*`. The daemon's `_get_active_profile_for()` tries exact match first, then falls back to matching any active profile on the same `bluez_card.MAC`. `_any_active_capture_for()` checks whether any node sharing the same BT card has an active capture. Both functions live in `daemon.js`.

`check_and_route_device()` also checks `_any_active_capture_for()` at initial routing time — if a device connects while a call is already active, it uses `bt_profile_call` instead of `bt_profile`.

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
