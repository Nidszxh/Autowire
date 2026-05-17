blueprint_compiler = find_program('blueprint-compiler', required: true)

# ── Blueprint → UI compilation ──────────────────────────────────────────────
blp_files = files(
  'ui/window.blp',
  'ui/profile_dialog.blp',
)

ui_files = []
foreach blp : blp_files
  custom_name = blp.full_path().split('/').get(-1).split('.').get(0)
  ui_files += custom_target(
    custom_name + '_ui',
    input: blp,
    output: '@BASENAME@.ui',
    command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
  )
endforeach

# ── GResource bundle ─────────────────────────────────────────────────────────
gnome.compile_resources(
  'autowire',
  'io.github.nidszxh.Autowire.gresource.xml',
  gresource_bundle: true,
  install: true,
  install_dir: pkgdatadir,
  dependencies: ui_files,
)

# ── Desktop entry ─────────────────────────────────────────────────────────────
desktop_file = configure_file(
  input: 'io.github.nidszxh.Autowire.desktop.in',
  output: 'io.github.nidszxh.Autowire.desktop',
  configuration: conf,
)
install_data(
  desktop_file,
  install_dir: datadir / 'applications',
)

# ── AppStream metainfo ────────────────────────────────────────────────────────
install_data(
  'io.github.nidszxh.Autowire.metainfo.xml',
  install_dir: datadir / 'metainfo',
)

# ── App icons ────────────────────────────────────────────────────────────────
install_data(
  'icons/hicolor/scalable/apps/io.github.nidszxh.Autowire.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'scalable' / 'apps',
)
install_data(
  'icons/hicolor/symbolic/apps/io.github.nidszxh.Autowire-symbolic.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'symbolic' / 'apps',
)

# ── Systemd user service ──────────────────────────────────────────────────────
install_data(
  'io.github.nidszxh.Autowire.Daemon.service',
  install_dir: datadir / 'systemd' / 'user',
)
