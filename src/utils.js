const { GLib } = imports.gi;

var is_flatpak = GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);

// Resolve absolute paths at startup to prevent PATH injection.
// In Flatpak mode, binaries are accessed via flatpak-spawn, so skip resolution.
var WPCTL_PATH = is_flatpak ? null : (GLib.find_program_in_path('wpctl') || null);
var PACTL_PATH = is_flatpak ? null : (GLib.find_program_in_path('pactl') || null);

var get_wpctl_cmd = function () {
    if (is_flatpak) return ['flatpak-spawn', '--host', 'wpctl'];
    if (!WPCTL_PATH) return ['wpctl'];
    return [WPCTL_PATH];
};

var get_pactl_cmd = function () {
    if (is_flatpak) return ['flatpak-spawn', '--host', 'pactl'];
    if (!PACTL_PATH) return ['pactl'];
    return [PACTL_PATH];
};

var strip_tree_chars = function(s) {
    return s.replace(/^[│├└─\s]+/, '');
};


var spawn_sync_with_timeout = function(argv, timeout_ms = 5000) {
    const { Gio } = imports.gi;
    let proc;
    try {
        proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
    } catch (e) {
        return [false, null, null, 1];
    }

    const loop = new GLib.MainLoop(null, false);
    let result = null;
    let timed_out = false;

    const timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout_ms, () => {
        timed_out = true;
        try { proc.force_exit(); } catch (_) { /* already exited */ }
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    proc.communicate_utf8_async(null, null, (p, res) => {
        if (timed_out) return;
        GLib.source_remove(timeout_id);
        try {
            const [, stdout_utf8, stderr_utf8] = p.communicate_utf8_finish(res);
            result = [true, stdout_utf8 || '', stderr_utf8 || '', p.get_exit_status()];
        } catch (e) {
            result = [false, null, null, 1];
        }
        loop.quit();
    });

    loop.run();

    if (timed_out) return [false, null, null, 1];
    return result || [false, null, null, 1];
};

print('[Utils] module loaded');
