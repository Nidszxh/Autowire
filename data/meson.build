ui_files = [
  custom_target(
    'window_ui',
    output: 'window.ui',
    command: ['cp', '@INPUT@', '@OUTPUT@'],
    input: files('window.ui'),
    install: false,
    build_by_default: false,
  ),
  custom_target(
    'profile_dialog_ui',
    output: 'profile_dialog.ui',
    command: ['cp', '@INPUT@', '@OUTPUT@'],
    input: files('profile_dialog.ui'),
    install: false,
    build_by_default: false,
  ),
]

gnome.compile_resources(
  'autowire',
  'io.github.nidszxh.Autowire.gresource.xml',
  gresource_bundle: true,
  install: true,
  install_dir: pkgdatadir,
)

desktop_file = configure_file(
  input: 'io.github.nidszxh.Autowire.desktop.in',
  output: 'io.github.nidszxh.Autowire.desktop',
  configuration: conf,
)
install_data(
  desktop_file,
  install_dir: datadir / 'applications',
)

install_data(
  'io.github.nidszxh.Autowire.metainfo.xml',
  install_dir: datadir / 'metainfo',
)

install_data(
  'icons/hicolor/scalable/apps/io.github.nidszxh.Autowire.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'scalable' / 'apps',
)
install_data(
  'icons/hicolor/symbolic/apps/io.github.nidszxh.Autowire-symbolic.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'symbolic' / 'apps',
)

install_data(
  'io.github.nidszxh.Autowire.Daemon.service',
  install_dir: datadir / 'systemd' / 'user',
)

install_data(
  'io.github.nidszxh.Autowire.service',
  install_dir: datadir / 'dbus-1' / 'session-services',
)