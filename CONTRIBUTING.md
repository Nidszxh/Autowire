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
  test_daemon.js                  # Daemon routing + capture (52)
  test_log.js                     # Log levels + file output (4)
  test_pactl_parser.js            # pactl card parsing (37)
  test_utils.js                   # Subprocess + string helpers (19)
  test_wp_monitor.js              # Stream parsing + detection (16)
```

All code is pure GJS (no Python).

## Architecture

Autowire is two independent processes — the UI and the daemon — that communicate only through `~/.config/autowire/profiles.json`.

- **UI** (`src/main.js`) requires GTK and Adwaita. WirePlumber typelib is optional.
- **Daemon** (`src/daemon_main.js`) is GLib-only. No GTK, runs headless.

When adding features:
- Routing logic goes in `daemon.js`
- GTK UI logic goes in `window.js` or `profile_dialog.js`
- Shared data logic goes in `config_mgr.js`
- Constants go in `constants.js`
- PipeWire/node inspection parsing goes in `wp_monitor.js`
- pactl card parsing goes in `pactl_parser.js`
- Never import GTK from `daemon.js` or `daemon_main.js`

See [`docs/architecture.md`](docs/architecture.md) for the full technical reference:
module descriptions, data flows, JSON schema, Flatpak permissions, and known quirks.
See [`AGENTS.md`](AGENTS.md) for deep implementation patterns and gotchas.

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
