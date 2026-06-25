project('autowire',
  version: '0.3.12',
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
conf.set('bindir', bindir)

subdir('data')
subdir('src')

meson.add_install_script('build-aux/meson/postinstall.py')

test_sh = find_program('tests/test.sh')
test('unit-tests', test_sh, workdir: meson.project_source_root())
