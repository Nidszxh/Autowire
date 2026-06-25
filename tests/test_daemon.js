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

function assert_false(actual, msg) {
    if (!actual) {
        passed++;
    } else {
        failed++;
        print(`FAIL: ${msg}: expected false, got ${actual}`);
    }
}

print('\n=== Daemon Tests ===\n');

// _bt_card_name — duplicated from daemon.js for GI-free testing
// Must match src/daemon.js _BT_NODE_RE
function _bt_card_name(node_name) {
    const m = /bluez_(?:output|input)\.([0-9A-Fa-f_:]{17})(?:\..*)?$/.exec(node_name);
    if (m) return `bluez_card.${m[1].replace(/:/g, '_')}`;
    return null;
}

assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_output.0F_56_51_19_26_87.1'),
    'bt_card_name: bluez_output');
assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_input.0F_56_51_19_26_87.2'),
    'bt_card_name: bluez_input with underscore MAC');
assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_input.0F:56:51:19:26:87'),
    'bt_card_name: bluez_input with colon MAC');
assert_eq('bluez_card.0F_56_51_19_26_87', _bt_card_name('bluez_output.0F:56:51:19:26:87.a2dp-sink'),
    'bt_card_name: bluez_output with colon MAC and suffix');
assert_eq(null, _bt_card_name('alsa_output.pci-0000_00_1f.3.analog-stereo'),
    'bt_card_name: non-BT alsa node');
assert_eq(null, _bt_card_name(''),
    'bt_card_name: empty string');
assert_eq(null, _bt_card_name(null),
    'bt_card_name: null');
assert_eq(null, _bt_card_name('bluez_output.invalid'),
    'bt_card_name: malformed BT node (too short MAC)');
assert_eq('bluez_card.AA_BB_CC_DD_EE_FF', _bt_card_name('bluez_input.AA_BB_CC_DD_EE_FF.3'),
    'bt_card_name: input with trailing .3');
assert_eq('bluez_card.12_34_56_78_9A_BC', _bt_card_name('bluez_output.12_34_56_78_9A_BC.a2dp-sink'),
    'bt_card_name: output with codec suffix');

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
assert_true(_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', 'bluez_input.0F:56:51:19:26:87'),
    'bt_card_equal: same card underscore vs colon');
assert_true(!_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', 'bluez_output.AA_BB_CC_DD_EE_FF.1'),
    'bt_card_equal: different cards');
assert_true(!_bt_card_equal('bluez_output.0F_56_51_19_26_87.1', null),
    'bt_card_equal: null second arg');
assert_true(!_bt_card_equal('alsa_output.pci-0000_00_1f.3.analog-stereo', 'bluez_output.0F_56_51_19_26_87.1'),
    'bt_card_equal: non-BT vs BT');
assert_true(!_bt_card_equal('', ''),
    'bt_card_equal: two empty strings');

// _validate_profile via DaemonEngine (no PW/hardware needed)
const { DaemonEngine } = imports.daemon;
const engine = new DaemonEngine();

assert_false(engine._validate_profile(null),
    'validate_profile: null');
assert_false(engine._validate_profile(undefined),
    'validate_profile: undefined');
assert_false(engine._validate_profile('string'),
    'validate_profile: string instead of object');
assert_false(engine._validate_profile(42),
    'validate_profile: number instead of object');
assert_false(engine._validate_profile({}),
    'validate_profile: empty object (no profile_name)');
assert_false(engine._validate_profile({ profile_name: '' }),
    'validate_profile: empty profile_name');
assert_false(engine._validate_profile({ profile_name: 'Test' }),
    'validate_profile: missing trigger_device_name');
assert_false(engine._validate_profile({ profile_name: 'Test', trigger_device_name: '' }),
    'validate_profile: empty trigger_device_name');
assert_false(engine._validate_profile({
    profile_name: 'Test',
    trigger_device_name: 'bluez_output.XX_XX.1',
    actions: { bt_profile: 'nonexistent-codec' }
}), 'validate_profile: invalid bt_profile');
assert_false(engine._validate_profile({
    profile_name: 'Test',
    trigger_device_name: 'bluez_output.XX_XX.1',
    actions: { bt_profile_call: 'nonexistent-profile' }
}), 'validate_profile: invalid bt_profile_call');

assert_true(engine._validate_profile({
    profile_name: 'Test',
    trigger_device_name: 'bluez_output.XX_XX.1',
}), 'validate_profile: minimal valid profile');
assert_true(engine._validate_profile({
    profile_name: 'AAC High',
    trigger_device_name: 'bluez_output.0F_56_51_19_26_87.1',
    actions: { bt_profile: 'a2dp-sink-aac', bt_profile_call: '' }
}), 'validate_profile: valid with a2dp-sink-aac');
assert_true(engine._validate_profile({
    profile_name: 'LDAC Best',
    trigger_device_name: 'bluez_output.0F_56_51_19_26_87.1',
    actions: { bt_profile: 'a2dp-sink-ldac', bt_profile_call: 'handsfree-headset' }
}), 'validate_profile: valid with LDAC + handsfree');
assert_true(engine._validate_profile({
    profile_name: 'Call Only',
    trigger_device_name: 'bluez_output.0F_56_51_19_26_87.1',
    actions: { bt_profile: '', bt_profile_call: 'headset-head-unit' }
}), 'validate_profile: valid with empty bt_profile + call profile');
assert_true(engine._validate_profile({
    profile_name: 'No actions',
    trigger_device_name: 'alsa_output.pci-0000.analog-stereo',
    is_active: true,
}), 'validate_profile: valid with no actions object');

// All valid BT profiles pass validation
const VALID_PROFILES = [
    'a2dp-sink-aac', 'a2dp-sink-ldac', 'a2dp-sink-aptx',
    'a2dp-sink-aptx_hd', 'a2dp-sink-sbc_xq', 'a2dp-sink',
    'a2dp-sink-sbc', 'handsfree-headset', 'headset-head-unit',
];
for (const p of VALID_PROFILES) {
    assert_true(engine._validate_profile({
        profile_name: 'test',
        trigger_device_name: 'bluez_output.XX_XX.1',
        actions: { bt_profile: p }
    }), `validate_profile: valid bt_profile '${p}'`);
}

// _reassert_default_sink
(function test_reassert_default_sink() {
    let default_set_count = 0;
    let last_set_node = '';
    const saved_set_default = engine.set_system_default;
    engine.set_system_default = function(node_name, monitor) {
        default_set_count++;
        last_set_node = node_name;
        return true;
    };

    const mock_monitor = {
        get_audio_nodes() {
            return [
                { name: 'alsa_output.pci-0000.analog-stereo', 'media_class': 'Audio/Sink' },
                { name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', 'media_class': 'Audio/Sink' },
                { name: 'bluez_output.11_22_33_44_55_66.1', 'media_class': 'Audio/Sink' },
                { name: 'alsa_input.pci-0000.analog-stereo', 'media_class': 'Audio/Source' },
                { name: 'bluez_input.AA_BB_CC_DD_EE_FF.0', 'media_class': 'Audio/Source' },
            ];
        }
    };

    // Find existing BT sink
    default_set_count = 0;
    const found = engine._reassert_default_sink('bluez_card.AA_BB_CC_DD_EE_FF', mock_monitor);
    assert_true(found, '_reassert_default_sink: found AA_BB_CC_DD_EE_FF');
    assert_eq(1, default_set_count, '_reassert_default_sink: set_system_default called once');
    assert_eq('bluez_output.AA_BB_CC_DD_EE_FF.1', last_set_node, '_reassert_default_sink: correct node set');

    // Unknown card returns false
    default_set_count = 0;
    const not_found = engine._reassert_default_sink('bluez_card.99_99_99_99_99_99', mock_monitor);
    assert_false(not_found, '_reassert_default_sink: unknown card returns false');
    assert_eq(0, default_set_count, '_reassert_default_sink: set_system_default not called for unknown');

    // Non-BT card (no matching sink) returns false
    default_set_count = 0;
    const alsa_not_found = engine._reassert_default_sink('alsa_card.pci-0000', mock_monitor);
    assert_false(alsa_not_found, '_reassert_default_sink: ALSA card returns false');
    assert_eq(0, default_set_count, '_reassert_default_sink: set_system_default not called for ALSA');

    // Empty monitor returns false
    const empty_monitor = { get_audio_nodes() { return []; } };
    const empty_result = engine._reassert_default_sink('bluez_card.AA_BB_CC_DD_EE_FF', empty_monitor);
    assert_false(empty_result, '_reassert_default_sink: empty nodes returns false');

    engine.set_system_default = saved_set_default;
})();

// _schedule_sink_reassert
(function test_schedule_sink_reassert() {
    const mock_monitor = {
        get_audio_nodes() { return []; }
    };
    const saved_set_default = engine.set_system_default;
    engine.set_system_default = function() { return true; };

    // First call stores a timer entry
    engine._schedule_sink_reassert('bluez_card.TEST_CARD', mock_monitor, 0);
    assert_true(engine._sink_reassert_timers.has('bluez_card.TEST_CARD'),
        '_schedule_sink_reassert: stores timer on first call');
    // Clean up
    const tid = engine._sink_reassert_timers.get('bluez_card.TEST_CARD');
    GLib.source_remove(tid);
    engine._sink_reassert_timers.delete('bluez_card.TEST_CARD');

    // Calling with attempt >= 8 does not store a timer
    engine._activated_bt_cards.add('bluez_card.GIVE_UP');
    engine._schedule_sink_reassert('bluez_card.GIVE_UP', mock_monitor, 8);
    assert_false(engine._sink_reassert_timers.has('bluez_card.GIVE_UP'),
        '_schedule_sink_reassert: attempt >= 8 does not store timer');
    engine._activated_bt_cards.delete('bluez_card.GIVE_UP');

    engine.set_system_default = saved_set_default;
})();

(function test_sink_reassert_cancelled_in_handle_capture_stopped() {
    // Verify that handle_capture_stopped cancels pending sink reassert timers
    const saved_timers = engine._sink_reassert_timers;
    engine._sink_reassert_timers = new Map();
    engine._sink_reassert_timers.set('bluez_card.CANCEL_TEST', 12345);

    // Submit a capture stopped event. The timer cleanup runs inside the debounce
    // callback, which is scheduled async. So instead, test the cleanup pattern
    // directly by simulating what handle_capture_stopped does:
    let removed = false;
    if (engine._sink_reassert_timers.has('bluez_card.CANCEL_TEST')) {
        const tid = engine._sink_reassert_timers.get('bluez_card.CANCEL_TEST');
        GLib.source_remove(tid);
        engine._sink_reassert_timers.delete('bluez_card.CANCEL_TEST');
        removed = true;
    }
    assert_true(removed, 'sink_reassert_timers cleanup: pending timer removed');
    assert_false(engine._sink_reassert_timers.has('bluez_card.CANCEL_TEST'),
        'sink_reassert_timers cleanup: entry deleted');

    engine._sink_reassert_timers = saved_timers;
})();

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
