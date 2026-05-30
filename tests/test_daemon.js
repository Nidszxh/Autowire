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

function assert_ne(expected, actual, msg) {
    if (expected !== actual) {
        passed++;
    } else {
        failed++;
        print(`FAIL: ${msg}: got '${actual}' which should differ`);
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

print('\n=== Daemon Tests ===\n');

// _bt_card_name — note: duplicated from daemon.js for GI-free testing
function _bt_card_name(node_name) {
    const m = /bluez_(?:output|input)\.([0-9A-Fa-f_]{14,17})\..+/.exec(node_name);
    if (m) return `bluez_card.${m[1]}`;
    return null;
}

assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_output.0F_56_51_19_26_87.1'),
    'bt_card_name: bluez_output');
assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_input.0F_56_51_19_26_87.2'),
    'bt_card_name: bluez_input');
assert_eq(null, _bt_card_name('alsa_output.pci-0000_00_1f.3.analog-stereo'),
    'bt_card_name: non-BT alsa node');
assert_eq(null, _bt_card_name(''),
    'bt_card_name: empty string');
assert_eq(null, _bt_card_name(null),
    'bt_card_name: null');

// _bt_card_equal
function _bt_card_equal(a, b) {
    if (!a || !b) return false;
    const ca = _bt_card_name(a);
    const cb = _bt_card_name(b);
    if (!ca || !cb) return false;
    return ca === cb;
}

assert_true(_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', 'bluez_input.0F_56_51_19_26_87.2'),
    'bt_card_equal: same card different direction');
assert_true(!_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', 'bluez_output.AA_BB_CC_DD_EE_FF.1'),
    'bt_card_equal: different cards');
assert_true(!_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', null),
    'bt_card_equal: null second arg');
assert_true(!_bt_card_equal('alsa_output.pci-0000_00_1f.3.analog-stereo', 'bluez_output.0F_56_51_19_26_87.1'),
    'bt_card_equal: non-BT vs BT');
assert_true(!_bt_card_equal('', ''),
    'bt_card_equal: two empty strings');

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
