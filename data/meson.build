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

service_conf = configuration_data()
service_conf.merge_from(conf)
dbus_service = configure_file(
  input: 'io.github.nidszxh.Autowire.service.in',
  output: 'io.github.nidszxh.Autowire.service',
  configuration: service_conf,
)
install_data(
  dbus_service,
  install_dir: datadir / 'dbus-1' / 'session-services',
)

install_subdir(
  'icons',
  install_dir: datadir,
)