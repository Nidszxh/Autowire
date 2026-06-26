#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later

const utils = imports.utils;

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

// strip_tree_chars
assert_eq('Sinks:', utils.strip_tree_chars('Sinks:'), 'strip_tree_chars: no prefix');
assert_eq('Sinks:', utils.strip_tree_chars('├─ Sinks:'), 'strip_tree_chars: ├─ prefix');
assert_eq('Sinks:', utils.strip_tree_chars('└─ Sinks:'), 'strip_tree_chars: └─ prefix');
assert_eq('Audio', utils.strip_tree_chars(' │ Audio'), 'strip_tree_chars: │ prefix');
assert_eq('Audio', utils.strip_tree_chars('  │  Audio'), 'strip_tree_chars: spaces + │ prefix');
assert_eq('', utils.strip_tree_chars(''), 'strip_tree_chars: empty string');
assert_eq('node.name = "test"', utils.strip_tree_chars('node.name = "test"'), 'strip_tree_chars: no pipe chars');

// is_flatpak
assert_true(typeof utils.is_flatpak === 'boolean', 'is_flatpak: is a boolean');

// get_wpctl_cmd
const wpctl_cmd = utils.get_wpctl_cmd();
assert_true(Array.isArray(wpctl_cmd), 'get_wpctl_cmd: returns an array');
assert_true(wpctl_cmd.length >= 1, 'get_wpctl_cmd: has at least 1 element');
assert_true(typeof wpctl_cmd[0] === 'string', 'get_wpctl_cmd: first element is string');

// get_pactl_cmd
const pactl_cmd = utils.get_pactl_cmd();
assert_true(Array.isArray(pactl_cmd), 'get_pactl_cmd: returns an array');
assert_true(pactl_cmd.length >= 1, 'get_pactl_cmd: has at least 1 element');
assert_true(typeof pactl_cmd[0] === 'string', 'get_pactl_cmd: first element is string');

// spawn_sync_with_timeout — non-existent command returns error safely
const [ok, stdout, stderr, exitStatus] = utils.spawn_sync_with_timeout(['nonexistent_cmd_xyz'], 500);
assert_false(ok, 'spawn_sync_with_timeout: returns false for nonexistent command');

// spawn_sync_with_timeout — true command
const [ok2, stdout2, stderr2, exitStatus2] = utils.spawn_sync_with_timeout(['true'], 1000);
assert_true(ok2, 'spawn_sync_with_timeout: true command succeeds');
assert_true(exitStatus2 === 0, 'spawn_sync_with_timeout: true exit status is 0');

// spawn_sync_with_timeout — echo command
const [ok3, stdout3] = utils.spawn_sync_with_timeout(['echo', 'hello world'], 1000);
assert_true(ok3, 'spawn_sync_with_timeout: echo succeeds');
assert_eq('hello world\n', stdout3, 'spawn_sync_with_timeout: echo produces output');

print(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    imports.system.exit(1);
}
