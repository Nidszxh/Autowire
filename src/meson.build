pkgdatadir_conf = conf.get('PKGDATADIR')
application_id_conf = conf.get('APPLICATION_ID')

launcher = configure_file(
  input: 'autowire.in',
  output: 'autowire',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

custom_target('chmod-autowire',
  input: launcher,
  output: 'chmod-autowire.stamp',
  build_by_default: true,
  command: ['sh', '-c', 'chmod +x "$1" && touch "$2"', 'sh', '@INPUT@', '@OUTPUT@'],
)

daemon_launcher = configure_file(
  input: 'autowire-daemon.in',
  output: 'autowire-daemon',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

custom_target('chmod-autowire-daemon',
  input: daemon_launcher,
  output: 'chmod-autowire-daemon.stamp',
  build_by_default: true,
  command: ['sh', '-c', 'chmod +x "$1" && touch "$2"', 'sh', '@INPUT@', '@OUTPUT@'],
)

install_data(
  'main.js',
  'window.js',
  'profile_dialog.js',
  'config_mgr.js',
  'daemon.js',
  'daemon_main.js',
  'wp_monitor.js',
  'utils.js',
  'bt_profiles.js',
  'pactl_parser.js',
  'constants.js',
  'log.js',
  install_dir: pkgdatadir_conf,
  install_mode: 'r--r--r--',
)