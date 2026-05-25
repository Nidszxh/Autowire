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
  'io.github.nidszxh.Autowire.Daemon.service',
  install_dir: datadir / 'systemd' / 'user',
)

install_data(
  'io.github.nidszxh.Autowire.service',
  install_dir: datadir / 'dbus-1' / 'session-services',
)