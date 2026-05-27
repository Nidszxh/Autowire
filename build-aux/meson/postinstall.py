#!/usr/bin/env python3
"""Post-install script: updates icon cache, desktop database, and enables user services."""

import os
import shutil
import subprocess
import sys

def _call(cmd: list[str]) -> None:
    try:
        subprocess.call(cmd)
    except FileNotFoundError:
        print(f'[postinstall] WARNING: {cmd[0]!r} not found — skipping')

def _systemd_enable() -> None:
    xdg_config = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
    service_src = os.path.join(
        os.environ.get('MESON_INSTALL_PREFIX', '/usr/local'),
        'share', 'systemd', 'user', 'io.github.nidszxh.Autowire.Daemon.service',
    )
    systemd_dir = os.path.join(xdg_config, 'systemd', 'user')
    service_dst = os.path.join(systemd_dir, 'io.github.nidszxh.Autowire.Daemon.service')

    if not os.path.exists(service_src):
        return

    os.makedirs(systemd_dir, exist_ok=True)
    shutil.copy2(service_src, service_dst)
    print(f'[postinstall] Installed user service to {service_dst}')
    _call(['systemctl', '--user', 'enable', '--now', 'io.github.nidszxh.Autowire.Daemon.service'])


def _running_in_flatpak() -> bool:
    return os.environ.get('FLATPAK_ID') is not None or os.path.isdir('/app')


def main() -> None:
    if os.environ.get('DESTDIR') or _running_in_flatpak():
        return

    prefix = os.environ.get('MESON_INSTALL_PREFIX', '/usr/local')
    datadir = os.path.join(prefix, 'share')

    schemas_dir = os.path.join(datadir, 'glib-2.0', 'schemas')
    if os.path.isdir(schemas_dir) and os.listdir(schemas_dir):
        print('Compiling GSettings schemas…')
        _call(['glib-compile-schemas', schemas_dir])

    print('Updating icon cache…')
    _call(['gtk-update-icon-cache', '-qtf', os.path.join(datadir, 'icons', 'hicolor')])

    print('Updating desktop database…')
    _call(['update-desktop-database', '-q', os.path.join(datadir, 'applications')])

    _systemd_enable()


if __name__ == '__main__':
    main()