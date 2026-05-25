project('autowire',
  version: '0.1.0',
  meson_version: '>= 0.62.0',
  default_options: ['warning_level=2'],
)

gjs = find_program('gjs')

prefix = get_option('prefix')
bindir = prefix / get_option('bindir')
datadir = prefix / get_option('datadir')
pkgdatadir = datadir / meson.project_name()

profile = get_option('profile')

application_id = 'io.github.nidszxh.Autowire'
if profile == 'development'
  application_id = application_id + '.Devel'
endif

conf = configuration_data()
conf.set('APPLICATION_ID', application_id)
conf.set('PKGDATADIR', pkgdatadir)
conf.set('VERSION', meson.project_version())
conf.set('GJS', gjs.full_path())

subdir('data')
subdir('src')

meson.add_install_script('build-aux/meson/postinstall.py')
