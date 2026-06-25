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
- **Import/Export** — gear menu with `Gtk.FileDialog` for sharing all profiles as JSON
- **Desktop notifications** — daemon notifies on routing events (profile match, call switch)
- **Keyboard shortcuts** — `Ctrl+N` (add profile), `Ctrl+Q` (quit), `F5` (refresh)
- **File-based logging** — daemon logs to `~/.config/autowire/daemon.log` with auto-rotation
- **Daemon crash detection** — UI immediately re-spawns daemon on unexpected exit

---

## Screenshots

![Main window](data/screenshots/main.png)

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|---|
| GNOME Platform | 50 | |
| GTK | 4.0 | |
| Libadwaita | 1.5+ | |
| WirePlumber | 0.5+ | Optional — typelib missing on Flatpak `//50` runtime, falls back to poll-only |
| GJS | 1.80+ | |
| PipeWire | ≥ 1.0 | Tested on 1.6.6 (handles both `<` and `>` stream arrows) |


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

# Flatpak daemon (uses the same app with a different entry point)
flatpak run --command=autowire-daemon io.github.nidszxh.Autowire
```

---

## How It Works

### The Double-Headed Architecture

```
 UI (GTK) ──write──▶  profiles.json  ◀──watch──  Daemon (GLib)
```

### Two Processes, One JSON

1. **UI** writes profiles.json when user creates/edits/deletes a profile (atomic write)
2. **Daemon** watches profiles.json via `Gio.FileMonitor` + re-routes on changes
3. **Daemon** also polls `wpctl status` every 3s for new/removed audio nodes
4. No IPC needed — just a shared JSON file on disk

### Profile Matching Flow

1. A device connects (USB dock, Bluetooth headset, HDMI monitor)
2. WirePlumber creates a `WpNode` for the new audio endpoint
3. The Daemon's `WpMonitor` polls `wpctl status` every 3s and detects new nodes; for Bluetooth cards, `device-added` triggers `activate_bt_card()` to bring the card out of `off` state into the best available profile (from active profile config, or `a2dp-sink-aac` by default, with a retry fallback to `a2dp-sink` after 5s if the card stays in `off`)
4. `check_and_route_device()` loads `profiles.json`, finds the `is_active` profile matching that trigger via:
   - **Exact match**: `trigger_device_name == node_name`
   - **BT card fallback**: extracts `bluez_card.MAC` from the node and matches any active profile whose trigger shares the same MAC
5. If a profile is active, it fires:
   - `wpctl set-default <sink>` — routes audio to the chosen output (auto-discovers BT sink if empty)
   - `wpctl set-default <source>` — routes microphone to the chosen input (auto-discovers BT source if empty)
    - `wpctl set-profile <global_id> <bt_codec>` — forces high-quality BT codec via resolved PW global ID (initial routing always uses `bt_profile`; capture-aware switching is handled separately by `handle_capture_started`/`handle_capture_stopped`)

### Stream-Aware Auto-Switching (for Bluetooth headsets)

When a profile has **Auto-switch for calls** enabled:

```
 Capture starts → wpctl detects input_* stream
   → switch to bt_profile_call (HSP/HFP)
   → route BT mic as default source

Capture stops → 3s debounce
   → restore bt_profile (A2DP)
   → route BT sink as default
   → pactl migrate streams from ALSA
```

1. An app captures the mic (Discord, Zoom, `arecord`, etc.)
2. `WpMonitor` detects the `input_*` stream from `wpctl status` → emits `capture-started`
3. Daemon cancels any pending restore, switches to `bt_profile_call` (e.g. `handsfree-headset` — falls back to `headset-head-unit` if the card doesn't expose the former)
4. Mic works — HSP/HFP profile is active
5. App stops capturing → daemon starts 3s debounce (tolerates push-to-talk gaps)
6. No new capture within 3s → daemon restores `bt_profile` (e.g. AAC, LDAC)
7. High-quality audio returns

**Important:** Capture events fire on the `bluez_input.XX.*` node name, but profiles are keyed by `bluez_output.XX.*`. The daemon's `_find_active_profile_for()` tries exact match first, then falls back to matching any active profile on the same `bluez_card.MAC` — ensuring the correct profile is found regardless of whether the input or output node triggers routing. A `_restoring_cards` Set prevents the routing engine from barging in on codec changes that the capture handler is already managing. After A2DP restore, `_migrate_streams_to_bt()` runs `pactl move-sink-input` to move ALSA-bound streams (music players, browsers) back to the restored BT sink — using pactl directly (bypassing the stale monitor cache) to handle pipewire-pulse registration lag.

### Active Profile Rule

Only **one** profile per trigger device can be `is_active: true`. When you save a profile with "Activate on Connect" enabled, all other profiles for that trigger are automatically deactivated. The daemon only fires the active one — no race conditions.

---

## Project Structure

```
autowire/
├── build-aux/meson/
│   └── postinstall.py         # Post-install: icon cache, db, systemd enable
│
├── src/                        # All GJS code (no Python)
│   ├── main.js                 # ──┐  UI entry (Adw.Application)
│   ├── window.js               #   │  Profile list, grouped by trigger
│   ├── profile_dialog.js       #   ├─ GTK4 + Adwaita
│   │                           #   │
│   ├── config_mgr.js           # ──┤  Shared: atomic JSON CRUD
│   ├── constants.js            #   │  Timing/interval constants
│   ├── utils.js                #   │  Flatpak detection, absolute path helpers
│   │                           #   │
│   ├── daemon.js               #   │  Routing engine + BT switching
│   ├── daemon_main.js          #   ├─ GLib-only (no GTK)
│   ├── wp_monitor.js           #   │  Poll-based WpCore wrapper
│   ├── bt_profiles.js          #   │  Codec-quality ladder
│   ├── pactl_parser.js         #   │  pactl card parser with 1s cache
│   │                           #   │
│   ├── autowire.in             # ──┤  Meson launchers (bash+gjs)
│   ├── autowire-daemon.in      #   │
│   └── meson.build
│
├── tests/
│   ├── test.sh                 # Shell runner
│   ├── test_bt_profiles.js     # Codec ladder pickBest logic (25)
│   ├── test_config_mgr.js      # Config CRUD + migration (25)
│   ├── test_daemon.js          # Daemon routing + capture logic (40)
│   ├── test_log.js             # Log levels + file output (4)
│   ├── test_pactl_parser.js    # pactl card parsing (37)
│   ├── test_utils.js           # Subprocess + string helpers (19)
│   └── test_wp_monitor.js      # Stream parsing + detection (16)
│
├── docs/
│   └── architecture.md
│
├── data/
│   ├── screenshots/            # 4 screenshots (main, profile, add, edit)
│   ├── icons/hicolor/          # App icons (scalable + symbolic)
│   ├── *.service               # systemd --user + D-Bus session service
│   ├── io.github.nidszxh.Autowire.desktop.in
│   ├── io.github.nidszxh.Autowire.metainfo.xml
│   └── meson.build
│
├── io.github.nidszxh.Autowire.json   # Flatpak manifest
├── flathub.json                      # Flathub repo config (publish-delay-hours: 3)
├── meson.build                       # Root build definition
├── meson_options.txt                 # Meson options (profile=devel/release)
├── CHANGELOG.md                      # Release notes
├── CONTRIBUTING.md                   # Contributor guide
├── AGENTS.md                         # LLM agent instructions
└── LICENSE                           # GPL-3.0
```



## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
