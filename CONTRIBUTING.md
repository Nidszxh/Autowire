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
  config_mgr.js                   # profiles.json persistence (shared)
  constants.js                    # Timing/interval constants (shared)
  utils.js                        # Flatpak detection, path helpers (shared)
  daemon.js                       # Routing engine + stream-aware switching
  daemon_main.js                  # Daemon process (GLib only, no GTK)
  wp_monitor.js                   # Poll-based WpCore + capture detection
  bt_profiles.js                  # Codec-quality ladder (shared)
  pactl_parser.js                 # pactl card parser with 1s cache (shared)
tests/
  test.sh                         # Test runner
  test_bt_profiles.js             # Codec ladder pickBest (25)
  test_config_mgr.js              # Config CRUD + migration (25)
  test_daemon.js                  # Daemon routing + capture (40)
  test_log.js                     # Log levels + file output (4)
  test_pactl_parser.js            # pactl card parsing (37)
  test_utils.js                   # Subprocess + string helpers (19)
  test_wp_monitor.js              # Stream parsing + detection (16)
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
┌─────────────────────────────┐     ┌─────────────────────────────────┐
│       UI PROCESS            │     │     DAEMON PROCESS              │
│  main.js  (GTK+Adwaita)     │     │  daemon_main.js (GLib)          │
│                             │     │                                 │
│  window.js                  │     │  daemon.js  (routing)           │
│  profile_dialog.js          │     │  wp_monitor.js  (poll/events)   │
│  config_mgr.js (write)      │     │  config_mgr.js (read)           │
│  constants.js               │     │  constants.js                   │
│  utils.js                   │     │  utils.js                       │
│  bt_profiles.js             │     │  bt_profiles.js                 │
│                             │     │  pactl_parser.js                │
└─────────────────────────────┘     └─────────────────────────────────┘
```

- **UI** (`src/main.js`) requires GTK and Adwaita. WirePlumber typelib is optional — falls back to poll-only mode when unavailable (e.g. in Flatpak with `org.gnome.Platform//50`).
- **Daemon** (`src/daemon_main.js`) imports only `GLib`, `Gio`, `GLibUnix`, `config_mgr`, and `daemon`. No GTK. This is intentional — the daemon must run in headless environments. WirePlumber typelib is also optional here.

When adding features:
- Routing logic goes in `daemon.js`
- GTK UI logic goes in `window.js` or `profile_dialog.js`
- Shared data logic goes in `config_mgr.js`
- Constants go in `constants.js`
- PipeWire/node inspection parsing goes in `wp_monitor.js`
- pactl card parsing goes in `pactl_parser.js`
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
                                                            pactl move-sink-input —
                                                              migrate ALSA streams
                                                              to BT sink
```

On detecting an `input_*` stream targeting the device:

1. **`capture-started`** signal fires — daemon cancels any pending restore timer, routes BT mic as default source, sets `bt_profile_call` (e.g. `handsfree-headset`)
2. **`capture-stopped`** signal fires — daemon starts a 3s debounce timer; on expiry restores `bt_profile` (e.g. `a2dp-sink-aac`), re-routes BT sink as default, and runs `pactl move-sink-input` to migrate any ALSA-bound streams (music players, browsers) to the restored BT sink. Uses pactl directly (bypassing the 3s-polled monitor cache) to handle pipewire-pulse registration lag after the A2DP profile switch.

If a new capture starts during debounce, the timer is cancelled. This handles push-to-talk gaps.

**BT card bridging:** Capture events fire on `bluez_input.XX.*` but profiles are keyed by `bluez_output.XX.*`. The daemon's `_find_active_profile_for()` tries exact match first, then falls back to matching any active profile on the same `bluez_card.MAC`. Capture state is tracked via `_active_capture_nodes` Set in `daemon.js`.

`check_and_route_device()` always uses `bt_profile` for initial routing. Capture-aware switching between `bt_profile` and `bt_profile_call` is handled separately by `handle_capture_started()` / `handle_capture_stopped()`, driven by actual capture stream transitions.

## Testing

Run all 178 tests:

```bash
./tests/test.sh
```

Or individually:

```bash
gjs -I src/ tests/test_config_mgr.js
gjs -I src/ tests/test_daemon.js
gjs -I src/ tests/test_wp_monitor.js
```

Tests are self-contained (no GI imports beyond GLib — no hardware needed).

## Build

### Meson (system install)

```bash
meson setup _build -Dprofile=development
ninja -C _build
sudo ninja -C _build install
```

### Flatpak

```bash
flatpak-builder --force-clean --user --install _flatpak_build \
    io.github.nidszxh.Autowire.json
flatpak run io.github.nidszxh.Autowire           # UI
flatpak run --command=autowire-daemon io.github.nidszxh.Autowire   # daemon
```

## Code Style

- No comments unless required by AGENTS.md
- Follow existing import ordering

## Debugging

### Daemon logs (systemd)

```bash
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f
```

### Quick restart after config change

```bash
systemctl --user restart io.github.nidszxh.Autowire.Daemon.service
```

### PipeWire inspection

```bash
wpctl inspect <node_id>       # inspect a specific node
wpctl status                  # list all nodes
```

### Profile config location

```bash
cat ~/.config/autowire/profiles.json
```

### Flatpak daemon logs

```bash
flatpak run --command=autowire-daemon io.github.nidszxh.Autowire 2>&1
```
