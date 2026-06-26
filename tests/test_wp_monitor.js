#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later

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

// Exact copy of production _fetch_capture_streams from wp_monitor.js
function _fetch_capture_streams(status_text) {
    if (!status_text) return {};
    const lines = status_text.split('\n');
    const capture_by_target = {};

    let in_streams = false;

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

        const dir_m = clean.match(/^\d+\.\s+([\w-]+)\s+([<>])\s+(.+?)\s+\[.*\]$/);
        if (!dir_m) continue;

        const port_name = dir_m[1];
        const arrow = dir_m[2];
        const right_side = dir_m[3].trim();

        // PW <1.6 uses >, PW >=1.6 uses < for input ports; handle both.
        if (port_name.startsWith('input_') && (arrow === '<' || arrow === '>')) {
            const last_colon = right_side.lastIndexOf(':');
            const target = last_colon > 0 ? right_side.substring(0, last_colon).trim() : right_side;
            if (target) {
                capture_by_target[target] = (capture_by_target[target] || 0) + 1;
            }
        }
    }

    return capture_by_target;
}

// Capture stream detection from fixture
const captures = _fetch_capture_streams(STATUS_TEXT);
print('  Capture targets:', JSON.stringify(Object.keys(captures)));
assert_true('alsa_input.pci-0000_00_1f.3.analog-stereo' in captures,
    'capture stream: found analog input');
assert_eq(1, captures['alsa_input.pci-0000_00_1f.3.analog-stereo'],
    'capture stream: analog input count = 1');
assert_false('bluez_output.0F_56_51_19_26_87.1' in captures,
    'capture stream: no output in capture results');

// Empty input
assert_eq(0, Object.keys(_fetch_capture_streams('')).length,
    'capture stream: empty text returns empty object');

// Blank line doesn't exit streams section
const with_blank = `Streams:
  20. input_FL < some_source:capture_0 [active]

`;
assert_eq(1, Object.keys(_fetch_capture_streams(with_blank)).length,
    'capture stream: blank line does not exit section');

// New section header exits streams section
const with_header = `Streams:
  20. input_FL < some_source:capture_0 [active]
Other Section:
  21. input_FL < another_source:capture_0 [active]
`;
assert_eq(1, Object.keys(_fetch_capture_streams(with_header)).length,
    'capture stream: new section header exits streams');

// Non-input streams ignored
const output_only = `Streams:
  20. output_FL > some_sink:playback_0 [active]
`;
const out_result = _fetch_capture_streams(output_only);
print('  Output-only result:', JSON.stringify(out_result));
assert_eq(0, Object.keys(out_result).length,
    'capture stream: output-only streams ignored');

// Multiple captures to same target
const multi_capture = `Streams:
  20. input_FL < alsa_input.some_card:capture_0 [active]
  21. input_FR < alsa_input.some_card:capture_0 [active]
`;
const multi = _fetch_capture_streams(multi_capture);
assert_eq(2, multi['alsa_input.some_card'],
    'capture stream: two captures to same target');

// Tree prefix characters handled
const with_tree = ` └─ Streams:
 │    20. input_FL < alsa_input.test:capture_0 [active]
`;
const tree_result = _fetch_capture_streams(with_tree);
print('  Tree prefix result:', JSON.stringify(tree_result));
assert_eq(1, Object.keys(tree_result).length,
    'capture stream: handles │ tree prefix');

// Init state streams detected
const init_stream = `Streams:
  20. input_FL < alsa_input.test:capture_0 [init]
`;
assert_eq(1, Object.keys(_fetch_capture_streams(init_stream)).length,
    'capture stream: init state streams detected');

// Deep tree nesting
const deep_tree = `Audio
  └─ Streams:
       20. input_FL < alsa_input.test:capture_0 [active]
`;
const deep_result = _fetch_capture_streams(deep_tree);
print('  Deep tree result:', JSON.stringify(deep_result));
assert_eq(1, Object.keys(deep_result).length,
    'capture stream: deep tree nesting');

// Old PW format (> arrow) detected
const old_format = `Streams:
  20. input_PID_1 > alsa_input.old_card:capture_0 [active]
`;
const old_result = _fetch_capture_streams(old_format);
print('  Old format result:', JSON.stringify(old_result));
assert_eq(1, Object.keys(old_result).length,
    'capture stream: old format (> arrow) detected');
assert_true('alsa_input.old_card' in old_result,
    'capture stream: old format target extracted correctly');

// Mixed old/new format arrows
const mixed_format = `Streams:
  20. input_FL < new_card:capture_FL [active]
  21. input_FR > old_card:capture_FR [active]
`;
const mixed_result = _fetch_capture_streams(mixed_format);
print('  Mixed format result:', JSON.stringify(mixed_result));
assert_eq(2, Object.keys(mixed_result).length,
    'capture stream: both arrow directions detected');
assert_eq(1, mixed_result['new_card'],
    'capture stream: new format arrow count');
assert_eq(1, mixed_result['old_card'],
    'capture stream: old format arrow count');

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
