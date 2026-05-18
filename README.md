# Autowire

**Automated Audio Profile Manager for GNOME**

Autowire automatically switches your PipeWire/WirePlumber audio routing whenever your hardware environment changes. Define a profile once — link a USB dock, Bluetooth headset, or HDMI monitor to a set of default inputs and outputs — and Autowire silently applies it every time that device connects.

---

## Features

- Create named Audio Profiles triggered by any audio device
- Automatically switch default output (speakers, headphones) and input (microphone)
- Event-driven background daemon — near-zero resource usage at idle
- Clean Libadwaita UI that matches GNOME Settings
- Runs as a `systemd --user` service — works even when the UI is closed
- Force high-quality Bluetooth codecs (AAC, LDAC, aptX) instead of mSBC

---

## Requirements

| Dependency | Version |
|---|---|
| GNOME Platform | 48+ |
| GTK | 4.0 |
| Libadwaita | 1.5+ |
| WirePlumber | 0.5+ |
| Python | 3.11+ |
| blueprint-compiler | 0.14+ |

---

## Quick Local Run

```bash
# Install system dependencies (Fedora)
sudo dnf install python3-gobject gtk4 libadwaita wireplumber blueprint-compiler

# Build (required — Blueprint templates won't load without this)
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Run the UI
./_build/src/autowire
```

> **Important:** Always run `ninja -C _build` before launching. The `@Gtk.Template` decorators load UI from `autowire.gresource`, which must be compiled by Meson.

---

## Development

```bash
# First-time setup
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Wipe and rebuild
rm -rf _build && meson setup _build --prefix=/usr/local -Dprofile=development && ninja -C _build

# Install system-wide (also enables the daemon via postinstall.py)
sudo ninja -C _build install

# Run tests
python3 -m pytest tests/ -v
```

**Dev profile** (`-Dprofile=development`) appends `.Devel` to the app ID (`io.github.nidszxh.Autowire.Devel`) so it can coexist with a release install.

---

## Flatpak

```bash
# Install flatpak-builder
flatpak install flathub org.flatpak.Builder

# Build and install locally
flatpak-builder --force-clean --user --install _flatpak_build \
    io.github.nidszxh.Autowire.json
```

The Flatpak manifest declares two commands:
- `autowire` — the GTK UI
- `autowire-daemon` — the headless background service (auto-started via D-Bus session service on login)

---

## How It Works

### The Double-Headed Architecture

```
┌─────────────────────────────────────────────────────┐
│  Autowire UI (GTK4 / Adwaita)                       │
│  • Create/edit/delete audio profiles                │
│  • Select trigger device + actions                  │
│  • Writes to profiles.json on save                  │
└──────────────┬──────────────────────────────────────┘
               │ profiles.json
               ▼
┌─────────────────────────────────────────────────────┐
│  Autowire Daemon (GLib-only, no GTK)                │
│  • Listens to WirePlumber node/device events       │
│  • Matches new nodes against profiles.json          │
│  • Runs wpctl set-default / wpctl set-profile       │
└─────────────────────────────────────────────────────┘
```

### Profile Matching Flow

1. A device connects (USB dock, Bluetooth headset, HDMI monitor)
2. WirePlumber creates a `WpNode` for the new audio endpoint
3. The Daemon's `WpMonitor` catches the `node-added` signal
4. `check_and_route_device()` looks up `profiles.json`
5. If a profile matches the trigger device, it fires:
   - `wpctl set-default <sink>` — routes audio to the chosen output
   - `wpctl set-default <source>` — routes microphone to the chosen input
   - `wpctl set-profile <device_id> <bt_codec>` — forces high-quality BT codec (optional)

---

## Project Structure

```
autowire/
├── build-aux/meson/
│   └── postinstall.py          # Post-install: icon cache, db, systemd enable
├── data/
│   ├── ui/
│   │   ├── window.blp          # Main window Blueprint template
│   │   └── profile_dialog.blp  # Profile create/edit dialog template
│   ├── icons/hicolor/          # App icons (scalable + symbolic + sizes)
│   ├── io.github.nidszxh.Autowire.gresource.xml
│   ├── io.github.nidszxh.Autowire.desktop.in
│   ├── io.github.nidszxh.Autowire.metainfo.xml
│   ├── io.github.nidszxh.Autowire.Daemon.service    # systemd user service
│   └── io.github.nidszxh.Autowire.service            # D-Bus session autostart
├── src/
│   ├── autowire.in             # UI launcher (Meson template)
│   ├── autowire-daemon.in      # Daemon launcher (Meson template)
│   ├── __init__.py
│   ├── main.py                 # Adw.Application entry point
│   ├── window.py               # Main window (profile list)
│   ├── profile_dialog.py        # Create/edit dialog (async device loading)
│   ├── config_mgr.py           # Atomic JSON profile storage
│   ├── daemon.py              # Routing engine (wpctl calls, cooldown)
│   ├── daemon_main.py         # Daemon process (GLib.MainLoop, no GTK)
│   └── wp_monitor.py          # Wp.Core + Wp.ObjectManager wrapper
├── tests/
│   ├── conftest.py
│   ├── test_config_mgr.py     # 14 tests
│   ├── test_daemon_routing.py # 23 tests
│   └── test_wp_monitor.py     # 18 tests
├── docs/
│   └── architecture.md        # Detailed architecture reference
├── io.github.nidszxh.Autowire.json  # Flatpak manifest
├── meson.build
├── meson_options.txt
├── pitch.md                   # Product pitch / vision
├── flow.md                    # First-time user experience flow
├── changes_made.md           # Change log
└── AGENTS.md                 # Agent instructions (for AI coding assistants)
```

---

## Flathub Submission

- [ ] Add screenshots to `data/screenshots/` (16:9, at least 3)
- [ ] Run `flatpak-builder-lint manifest io.github.nidszxh.Autowire.json`
- [ ] Fork [flathub/flathub](https://github.com/flathub/flathub) and open a New App PR

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.