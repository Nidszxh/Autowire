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
- Multiple profiles per device — switch between "Music" and "Call" modes
- **Auto-switch for calls** — daemon detects active mic streams and drops to HSP/HFP automatically, restoring A2DP when capture ends (3s debounce)
- Only the **active** profile fires when a device connects, eliminating race conditions

---

## Requirements

| Dependency | Version |
|---|---|
| GNOME Platform | 48+ |
| GTK | 4.0 |
| Libadwaita | 1.5+ |
| WirePlumber | 0.5+ |
| GJS | 1.80+ |


---

## Quick Local Run (GJS)

```bash
# Install system dependencies (Fedora)
sudo dnf install gjs gtk4 libadwaita wireplumber

# Run the UI
gjs -I src/ src/main.js

# Run the daemon
gjs -I src/ src/daemon_main.js
```

No build step required — builds its UI programmatically.

---

## Flatpak

```bash
flatpak-builder --force-clean --user --install _flatpak_build \
    io.github.nidszxh.Autowire.json
flatpak run io.github.nidszxh.Autowire
```

---

## How It Works

### The Double-Headed Architecture

```
┌─────────────────────────────────────────────────────┐
│  Autowire UI (GTK4 / Adwaita)                       │
│  • Create/edit/delete audio profiles                │
│  • Toggle which profile is active per device        │
│  • Writes to profiles.json on save                  │
└──────────────┬──────────────────────────────────────┘
               │ profiles.json
               ▼
┌─────────────────────────────────────────────────────┐
│  Autowire Daemon (GLib-only, no GTK)                │
│  • Listens to WirePlumber node/device events        │
│  • Matches new nodes against profiles.json           │
│  • Runs wpctl set-default / wpctl set-profile        │
└─────────────────────────────────────────────────────┘
```

### Profile Matching Flow

1. A device connects (USB dock, Bluetooth headset, HDMI monitor)
2. WirePlumber creates a `WpNode` for the new audio endpoint
3. The Daemon's `WpMonitor` catches the `node-added` signal
4. `check_and_route_device()` looks up `profiles.json` for the `is_active` profile matching that trigger
5. If a profile is active, it fires:
   - `wpctl set-default <sink>` — routes audio to the chosen output
   - `wpctl set-default <source>` — routes microphone to the chosen input
   - `wpctl set-profile <device_id> <bt_codec>` — forces high-quality BT codec (optional)

### Stream-Aware Auto-Switching (for Bluetooth headsets)

When a profile has **Auto-switch for calls** enabled:

1. An app captures the mic (Discord, Zoom, `arecord`, etc.)
2. `WpMonitor` detects the `input_*` stream from `wpctl status` → emits `capture-started`
3. Daemon cancels any pending restore, switches to `bt_profile_call` (e.g. `handsfree-headset — mSBC`)
4. Mic works — HSP/HFP profile is active
5. App stops capturing → daemon starts 3s debounce (tolerates push-to-talk gaps)
6. No new capture within 3s → daemon restores `bt_profile` (e.g. AAC, LDAC)
7. High-quality audio returns

### Active Profile Rule

Only **one** profile per trigger device can be `is_active: true`. When you save a profile with "Activate on Connect" enabled, all other profiles for that trigger are automatically deactivated. The daemon only fires the active one — no race conditions.

---

## Project Structure

```
autowire/
├── build-aux/meson/
│   └── postinstall.py          # Post-install: icon cache, db, systemd enable
├── data/
│   ├── *.service               # systemd + D-Bus service files
│   ├── io.github.nidszxh.Autowire.desktop.in
│   ├── io.github.nidszxh.Autowire.metainfo.xml
│   └── meson.build
├── src/                        # Production GJS code
│   ├── main.js                 # UI entry (GTK/Adwaita)
│   ├── window.js               # Profile list
│   ├── profile_dialog.js       # Create/edit dialog
│   ├── config_mgr.js           # profiles.json persistence
│   ├── daemon.js               # Routing engine
│   ├── daemon_main.js          # Daemon process
│   ├── wp_monitor.js           # Poll-based WpCore wrapper
│   ├── autowire.in             # Meson launcher template
│   ├── autowire-daemon.in      # Meson daemon template
│   └── meson.build
├── docs/
│   └── architecture.md
├── io.github.nidszxh.Autowire.json
├── meson.build
├── meson_options.txt
└── AGENTS.md
```

---

## Flathub Submission

- [ ] Add screenshots to `data/screenshots/` (16:9, at least 3)
- [ ] Run `flatpak-builder-lint manifest io.github.nidszxh.Autowire.json`
- [ ] Fork [flathub/flathub](https://github.com/flathub/flathub) and open a New App PR

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
