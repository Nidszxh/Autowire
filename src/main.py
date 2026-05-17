"""GTK4/Libadwaita application entry point for Autowire."""

from __future__ import annotations

import os
import sys

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')

from gi.repository import Adw, Gio, GLib

APPLICATION_ID = 'io.github.nidszxh.Autowire'


class AutowireApplication(Adw.Application):
    def __init__(self, version: str) -> None:
        super().__init__(
            application_id=APPLICATION_ID,
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS,
        )
        self._version = version

    def do_activate(self) -> None:
        # Reuse existing window if already open
        win = self.props.active_window
        if not win:
            from .window import AutowireWindow
            win = AutowireWindow(application=self)
        win.present()


def main(version: str, pkgdatadir: str = '') -> int:
    """Application entry point called from the launcher script."""

    # Register the GResource bundle so Blueprint-compiled UI files are found
    _load_resources(pkgdatadir)

    app = AutowireApplication(version)
    return app.run(sys.argv)


def _load_resources(pkgdatadir: str) -> None:
    """Locate and register the compiled GResource bundle."""
    candidates = [
        # Installed Flatpak / system location (passed from launcher)
        os.path.join(pkgdatadir, 'autowire.gresource'),
        # Local Meson build directory (for `ninja -C _build`)
        os.path.join(os.path.dirname(__file__), '..', '..', '_build', 'data', 'autowire.gresource'),
        # Alongside this source file (some dev setups)
        os.path.join(os.path.dirname(__file__), 'autowire.gresource'),
    ]

    for path in candidates:
        path = os.path.abspath(path)
        if os.path.exists(path):
            try:
                resource = Gio.Resource.load(path)
                resource._register()
                print(f'[App] GResource loaded from: {path}')
                return
            except GLib.Error as exc:
                print(f'[App] Failed to load GResource at {path}: {exc}')

    # If no bundle is found, UI templates won't load — warn clearly
    print('[App] WARNING: autowire.gresource not found. Run `ninja -C _build` first.',
          file=sys.stderr)
