# Autowire

**Automated Audio Profile Manager for GNOME**

Autowire automatically switches your PipeWire/WirePlumber audio routing whenever your hardware environment changes. Define a profile once — link a USB dock, Bluetooth headset, or HDMI monitor to a set of default inputs and outputs — and Autowire silently applies it every time that device connects.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

---

## Features

- Create named Audio Profiles triggered by any audio device
- Automatically switch default output (speakers, headphones) and input (microphone)
- Event-driven background daemon — near-zero resource usage at idle
- Clean Libadwaita UI that matches GNOME Settings
- Runs as a `systemd --user` service — works even when the UI is closed

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

## Quick Local Run (without Flatpak)

```bash
# Install system dependencies (Fedora)
sudo dnf install python3-gobject gtk4 libadwaita wireplumber blueprint-compiler

# Run the UI directly
python3 -c "
import sys, gi
sys.path.insert(0, 'src')
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
gi.require_version('Wp', '0.5')
from gi.repository import Wp
Wp.init(Wp.InitFlags.ALL)
from src.main import main
sys.exit(main('dev'))
"
```

> **Note:** The UI requires the GResource bundle (`autowire.gresource`) to be compiled first by Meson. Without it, Blueprint templates won't load. For full local development, use the Meson build below.

---

## Meson Build (Local)

```bash
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build
sudo ninja -C _build install
```

---

## Flatpak Build

```bash
# Install flatpak-builder
flatpak install flathub org.flatpak.Builder

# Build and install locally
flatpak-builder --force-clean --user --install _flatpak_build \
    io.github.nidszxh.Autowire.json
```

---

## Run Tests

```bash
python3 -m pytest tests/ -v
```

---

## Project Structure

```
autowire/
├── build-aux/meson/postinstall.py   # Post-install icon/desktop cache update
├── data/
│   ├── ui/
│   │   ├── window.blp               # Main window Blueprint template
│   │   └── profile_dialog.blp       # Profile create/edit dialog template
│   ├── icons/                       # Scalable + symbolic app icons (SVG)
│   ├── *.desktop.in                 # XDG desktop entry (Meson template)
│   ├── *.metainfo.xml               # AppStream metadata (Flathub)
│   ├── *.Daemon.service             # systemd user service unit
│   └── *.gresource.xml             # GResource manifest
├── src/
│   ├── main.py                      # Adw.Application entry point
│   ├── window.py                    # Main window controller
│   ├── profile_dialog.py            # Profile create/edit dialog
│   ├── config_mgr.py                # JSON profile storage (atomic writes)
│   ├── daemon.py                    # Routing engine + WpMonitor wiring
│   ├── daemon_main.py               # Headless daemon process entry point
│   └── wp_monitor.py                # libwireplumber GObject wrapper
├── tests/
│   ├── test_config_mgr.py           # 12 unit tests for config manager
│   └── test_daemon_routing.py       # 9 unit tests for routing engine
├── io.github.nidszxh.Autowire.json  # Flatpak manifest
├── meson.build
└── meson_options.txt
```

---

## Daemon Setup (systemd)

After installation, enable the background daemon:

```bash
systemctl --user enable --now io.github.nidszxh.Autowire.Daemon.service
journalctl --user -u io.github.nidszxh.Autowire.Daemon -f
```

---

## Flathub Submission Checklist

- [ ] Create GitHub repo `nidszxh/autowire` and push code
- [ ] Add screenshots to `data/screenshots/` (16:9, at least 3)
- [ ] Run `flatpak-builder-lint manifest io.github.nidszxh.Autowire.json`
- [ ] Fork [flathub/flathub](https://github.com/flathub/flathub) and open a New App PR

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
