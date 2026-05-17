pkgdatadir_conf = conf.get('PKGDATADIR')
application_id_conf = conf.get('APPLICATION_ID')

# ── Generate the launcher script ──────────────────────────────────────────────
launcher = configure_file(
  input: 'autowire.in',
  output: 'autowire',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

daemon_launcher = configure_file(
  input: 'autowire-daemon.in',
  output: 'autowire-daemon',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

# ── Install Python package ─────────────────────────────────────────────────────
python.install_sources(
  '__init__.py',
  'main.py',
  'window.py',
  'profile_dialog.py',
  'config_mgr.py',
  'daemon.py',
  'daemon_main.py',
  'wp_monitor.py',
  subdir: 'autowire',
)
