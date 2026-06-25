const { GLib, Gio } = imports.gi;

var Level = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

var _min_level = Level.INFO;
var _log_file = null;
var _log_path = null;
var _MAX_LOG_SIZE = 1024 * 1024;

function setLevel(level) {
    _min_level = level;
}

function setLogFile(path) {
    if (_log_file) {
        try { _log_file.close(null); } catch (e) { /* ignore */ }
        _log_file = null;
    }
    _log_path = path;
    _open_append();
}

function _open_append() {
    if (!_log_path) return;
    try {
        const file = Gio.File.new_for_path(_log_path);
        _log_file = file.append_to(Gio.FileCreateFlags.NONE, null);
    } catch (e) {
        _log_file = null;
    }
}

function _rotate_if_needed() {
    if (!_log_path) return;
    try {
        const file = Gio.File.new_for_path(_log_path);
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_size() > _MAX_LOG_SIZE) {
            if (_log_file) {
                try { _log_file.close(null); } catch (e) { /* ignore */ }
                _log_file = null;
            }
            const old = Gio.File.new_for_path(_log_path + '.old');
            try { old.delete(null); } catch (e) { /* ignore */ }
            file.move(old, Gio.FileCopyFlags.NONE, null, null);
            _open_append();
        }
    } catch (e) { /* ignore */ }
}

function _write_file(module, level, msg) {
    if (!_log_file) return;
    try {
        _rotate_if_needed();
        const line = `[${_ts()}] [${level}] [${module}] ${msg}\n`;
        _log_file.write(new TextEncoder().encode(line), null);
        _log_file.flush(null);
    } catch (e) { /* ignore */ }
}

function _ts() {
    return GLib.DateTime.new_now_local().format('%H:%M:%S');
}

function debug(module, msg) {
    if (_min_level <= Level.DEBUG) {
        print(`[${_ts()}] [DEBUG] [${module}] ${msg}`);
        _write_file(module, 'DEBUG', msg);
    }
}

function info(module, msg) {
    if (_min_level <= Level.INFO) {
        print(`[${_ts()}] [INFO] [${module}] ${msg}`);
        _write_file(module, 'INFO', msg);
    }
}

function warn(module, msg) {
    if (_min_level <= Level.WARN) {
        print(`[${_ts()}] [WARN] [${module}] ${msg}`);
        _write_file(module, 'WARN', msg);
    }
}

function error(module, msg) {
    if (_min_level <= Level.ERROR) {
        print(`[${_ts()}] [ERROR] [${module}] ${msg}`);
        _write_file(module, 'ERROR', msg);
    }
}
