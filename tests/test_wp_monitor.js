#!/usr/bin/env gjs
const { GLib } = imports.gi;

let passed = 0;
let failed = 0;

function assert_eq(expected, actual, msg) {
    if (expected === actual) {
        passed++;
    } else {
        failed++;
        print(`FAIL: ${msg}: expected '${expected}', got '${actual}'`);
    }
}

function assert_true(actual, msg) {
    if (actual) {
        passed++;
    } else {
        failed++;
        print(`FAIL: ${msg}: expected true, got ${actual}`);
    }
}

function assert_false(actual, msg) {
    if (!actual) {
        passed++;
    } else {
        failed++;
        print(`FAIL: ${msg}: expected false, got ${actual}`);
    }
}

print('\n=== WpMonitor (Parser) Tests ===\n');

// Read fixture
const script_dir = GLib.path_get_dirname(imports.system.programPath);
const fixture_path = GLib.build_filenamev([script_dir, 'fixtures', 'wpctl_status_sample.txt']);
const [, raw] = GLib.file_get_contents(fixture_path);
const STATUS_TEXT = new TextDecoder().decode(raw);

function _strip_tree_chars(s) {
    return s.replace(/^[│├└─\s]+/, '');
}

function _fetch_capture_streams(status_text) {
    if (!status_text) return {};
    const lines = status_text.split('\n');
    const capture_by_target = {};

    let in_streams = false;
    const port_re = /\d+\.\s+(\S+)\s*>\s*(.+?):\S+\s+\[(active|init)\]/;

    for (const line of lines) {
        const stripped = line.trim();
        const clean = _strip_tree_chars(stripped);

        if (clean === 'Streams:' || clean === '├─ Streams:' || clean === '└─ Streams:') {
            in_streams = true;
            continue;
        }

        if (!in_streams) continue;
        if (!stripped) continue;

        if (stripped.endsWith(':') && !stripped.match(/^\d+\.\s/)) {
            in_streams = false;
            continue;
        }

        const port_m = clean.match(port_re);
        if (port_m) {
            const port_name = port_m[1];
            if (port_name.startsWith('input_')) {
                const target = port_m[2].trim();
                capture_by_target[target] = (capture_by_target[target] || 0) + 1;
            }
        }
    }

    return capture_by_target;
}

// Test 1: capture stream detection from fixture
const captures = _fetch_capture_streams(STATUS_TEXT);
print('  Capture targets:', JSON.stringify(Object.keys(captures)));
assert_true('alsa_input.pci-0000_00_1f.3.analog-stereo' in captures,
    'capture stream: found analog input');
assert_eq(1, captures['alsa_input.pci-0000_00_1f.3.analog-stereo'],
    'capture stream: analog input count = 1');
assert_false('bluez_output.0F_56_51_19_26_87.1' in captures,
    'capture stream: no output in capture results');

// Test 2: empty input
assert_eq(0, Object.keys(_fetch_capture_streams('')).length,
    'capture stream: empty text returns empty object');

// Test 3: section termination — blank line doesn't exit streams section
const with_blank = `Streams:
  20. input_PID_1 > some_source:capture_0 [active]

`;
assert_eq(1, Object.keys(_fetch_capture_streams(with_blank)).length,
    'capture stream: blank line does not exit section');

// Test 4: new section header exits streams section
const with_header = `Streams:
  20. input_PID_1 > some_source:capture_0 [active]
Other Section:
  21. input_PID_2 > another_source:capture_0 [active]
`;
assert_eq(1, Object.keys(_fetch_capture_streams(with_header)).length,
    'capture stream: new section header exits streams');

// Test 5: non-input streams are ignored
const output_only = `Streams:
  20. output_PID_1 > some_sink:playback_0 [active]
`;
const out_result = _fetch_capture_streams(output_only);
print('  Output-only result:', JSON.stringify(out_result));
assert_eq(0, Object.keys(out_result).length,
    'capture stream: output-only streams ignored');

// Test 6: multiple captures to same target
const multi_capture = `Streams:
  20. input_PID_1 > alsa_input.some_card:capture_0 [active]
  21. input_PID_2 > alsa_input.some_card:capture_0 [active]
`;
const multi = _fetch_capture_streams(multi_capture);
assert_eq(2, multi['alsa_input.some_card'],
    'capture stream: two captures to same target');

// Test 7: tree prefix characters are handled
const with_tree = ` └─ Streams:
 │    20. input_PID_1 > alsa_input.test:capture_0 [active]
`;
const tree_result = _fetch_capture_streams(with_tree);
print('  Tree prefix result:', JSON.stringify(tree_result));
assert_eq(1, Object.keys(tree_result).length,
    'capture stream: handles │ tree prefix');

// Test 8: init state streams are detected
const init_stream = `Streams:
  20. input_PID_1 > alsa_input.test:capture_0 [init]
`;
assert_eq(1, Object.keys(_fetch_capture_streams(init_stream)).length,
    'capture stream: init state streams detected');

// Test 9: deep tree nesting
const deep_tree = `Audio
  └─ Streams:
       20. input_PID_1 > alsa_input.test:capture_0 [active]
`;
const deep_result = _fetch_capture_streams(deep_tree);
print('  Deep tree result:', JSON.stringify(deep_result));
assert_eq(1, Object.keys(deep_result).length,
    'capture stream: deep tree nesting');

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
