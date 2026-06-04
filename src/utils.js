const { GLib } = imports.gi;

var is_flatpak = GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);

var get_wpctl_cmd = function () {
    return is_flatpak ? ['flatpak-spawn', '--host', 'wpctl'] : ['wpctl'];
};

var get_pactl_cmd = function () {
    return is_flatpak ? ['flatpak-spawn', '--host', 'pactl'] : ['pactl'];
};

print('[Utils] module loaded');
