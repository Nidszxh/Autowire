# Autowire — Agent Instructions

## Project Overview
Libadwaita-native GTK4 application for automated PipeWire/WirePlumber audio profile switching. Python + Blueprint + Meson build.

## Key Commands

```bash
# Run tests
python3 -m pytest tests/ -v

# Local Meson build (required for GResource/Blueprint templates)
meson setup _build --prefix=/usr/local -Dprofile=development
ninja -C _build

# Flatpak build
flatpak-builder --force-clean --user --install _flatpak_build io.github.nidszxh.Autowire.json
```

## Important Notes

- **Blueprint templates** (`.blp` files in `data/ui/`) are compiled into `autowire.gresource` by Meson. The UI won't load without running `ninja -C _build` first.

- **Dev run**: The quick Python run in README works but Blueprint templates won't load. For full UI dev, use Meson build.

- **App ID**: `io.github.nidszxh.Autowire` (development builds append `.Devel`)

- **Config location**: `~/.config/autowire/profiles.json`

- **Daemon**: Runs as systemd `--user` service (`io.github.nidszxh.Autowire.Daemon.service`) separate from UI

## Dependencies (Fedora)
```
python3-gobject gtk4 libadwaita wireplumber blueprint-compiler
```

## Entry Points
- UI: `src/main.py` → `main()` function
- Daemon: `src/daemon_main.py`
- Config: `src/config_mgr.py`