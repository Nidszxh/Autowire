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

print('\n=== ConfigMgr Tests ===\n');

// Note: these test core logic inline to avoid GI dependency issues.
// Full integration tests require overwriting config_mgr's globals.

// Per-trigger migration test
function test_migration() {
    const profiles = [
        { profile_name: 'Music', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: false },
        { profile_name: 'Call', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: false },
        { profile_name: 'Default', trigger_device_name: 'bluez_output.11_22_33_44_55_66.1', is_active: false },
    ];

    const triggers = [...new Set(profiles.map(p => p['trigger_device_name']))];
    let migrated = false;
    for (const trigger of triggers) {
        const group = profiles.filter(p => p['trigger_device_name'] === trigger);
        if (group.length > 0 && !group.some(p => p['is_active'])) {
            group[0]['is_active'] = true;
            migrated = true;
        }
    }

    assert_true(migrated, 'migration: triggered when no active profiles');
    assert_true(profiles[0]['is_active'],
        `migration: first profile of trigger AA_BB_CC_DD_EE_FF activated (got ${profiles[0]['profile_name']})`);
    assert_true(!profiles[1]['is_active'],
        'migration: second profile of same trigger NOT activated');
    assert_true(profiles[2]['is_active'],
        'migration: first profile of trigger 11_22_33_44_55_66 activated');
}

function test_migration_already_active() {
    const profiles = [
        { profile_name: 'Music', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: true },
        { profile_name: 'Call', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: false },
    ];

    const triggers = [...new Set(profiles.map(p => p['trigger_device_name']))];
    let migrated = false;
    for (const trigger of triggers) {
        const group = profiles.filter(p => p['trigger_device_name'] === trigger);
        if (group.length > 0 && !group.some(p => p['is_active'])) {
            group[0]['is_active'] = true;
            migrated = true;
        }
    }

    assert_false(migrated, 'migration: not triggered when active profile exists');
    assert_true(profiles[0]['is_active'],
        'migration: existing active profile preserved');
}

function test_set_active_profile_logic() {
    const profiles = [
        { profile_name: 'Music', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: false },
        { profile_name: 'Call', trigger_device_name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', is_active: true },
    ];

    // Simulate set_active_profile(trigger, 'Music')
    for (const p of profiles) {
        if (p['trigger_device_name'] === 'bluez_output.AA_BB_CC_DD_EE_FF.1') {
            p['is_active'] = p['profile_name'] === 'Music';
        }
    }

    assert_true(profiles[0]['is_active'], 'set_active: Music becomes active');
    assert_false(profiles[1]['is_active'], 'set_active: Call becomes inactive');

    // Simulate set_active_profile(trigger, '')
    for (const p of profiles) {
        if (p['trigger_device_name'] === 'bluez_output.AA_BB_CC_DD_EE_FF.1') {
            p['is_active'] = p['profile_name'] === '';
        }
    }

    assert_false(profiles[0]['is_active'], 'set_active: deactivate Music');
    assert_false(profiles[1]['is_active'], 'set_active: deactivate Call');
}

function test_reorder_up() {
    const profiles = [
        { profile_name: 'A', trigger_device_name: 'dev1' },
        { profile_name: 'B', trigger_device_name: 'dev1' },
        { profile_name: 'C', trigger_device_name: 'dev1' },
    ];

    // Move B up (swap with A)
    const idx = profiles.findIndex(p => p['profile_name'] === 'B' && p['trigger_device_name'] === 'dev1');
    let prevIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
        if (profiles[i]['trigger_device_name'] === 'dev1') { prevIdx = i; break; }
    }
    [profiles[idx], profiles[prevIdx]] = [profiles[prevIdx], profiles[idx]];

    assert_eq('B', profiles[0]['profile_name'], 'reorder up: B moved to position 0');
    assert_eq('A', profiles[1]['profile_name'], 'reorder up: A moved to position 1');
    assert_eq('C', profiles[2]['profile_name'], 'reorder up: C unchanged');
}

function test_reorder_down() {
    const profiles = [
        { profile_name: 'A', trigger_device_name: 'dev1' },
        { profile_name: 'B', trigger_device_name: 'dev1' },
        { profile_name: 'C', trigger_device_name: 'dev1' },
    ];

    // Move A down (swap with B)
    const idx = profiles.findIndex(p => p['profile_name'] === 'A' && p['trigger_device_name'] === 'dev1');
    let nextIdx = -1;
    for (let i = idx + 1; i < profiles.length; i++) {
        if (profiles[i]['trigger_device_name'] === 'dev1') { nextIdx = i; break; }
    }
    [profiles[idx], profiles[nextIdx]] = [profiles[nextIdx], profiles[idx]];

    assert_eq('B', profiles[0]['profile_name'], 'reorder down: B moved to position 0');
    assert_eq('A', profiles[1]['profile_name'], 'reorder down: A moved to position 1');
    assert_eq('C', profiles[2]['profile_name'], 'reorder down: C unchanged');
}

function test_reorder_boundary() {
    const profiles = [
        { profile_name: 'A', trigger_device_name: 'dev1' },
        { profile_name: 'B', trigger_device_name: 'dev1' },
    ];

    // Move A up — should be no-op (already at top)
    const idx = profiles.findIndex(p => p['profile_name'] === 'A');
    let prevIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
        if (profiles[i]['trigger_device_name'] === 'dev1') { prevIdx = i; break; }
    }
    assert_eq(-1, prevIdx, 'reorder boundary: no previous element for top item');

    // Move B down — should be no-op (already at bottom)
    const idx2 = profiles.findIndex(p => p['profile_name'] === 'B');
    let nextIdx = -1;
    for (let i = idx2 + 1; i < profiles.length; i++) {
        if (profiles[i]['trigger_device_name'] === 'dev1') { nextIdx = i; break; }
    }
    assert_eq(-1, nextIdx, 'reorder boundary: no next element for bottom item');
}

function test_validate_profile() {
    const valid_bt = new Set([
        'a2dp-sink-aac', 'a2dp-sink-ldac', 'a2dp-sink-aptx',
        'a2dp-sink-aptx_hd', 'a2dp-sink-sbc_xq', 'a2dp-sink-sbc',
        'handsfree-headset',
    ]);

    function validate(p) {
        if (!p || typeof p !== 'object') return false;
        if (typeof p['profile_name'] !== 'string' || !p['profile_name']) return false;
        if (typeof p['trigger_device_name'] !== 'string' || !p['trigger_device_name']) return false;
        const actions = p['actions'];
        if (actions && typeof actions === 'object') {
            if (actions['bt_profile'] && !valid_bt.has(actions['bt_profile'])) return false;
            if (actions['bt_profile_call'] && !valid_bt.has(actions['bt_profile_call']) && actions['bt_profile_call'] !== '') return false;
        }
        return true;
    }

    assert_true(validate({ profile_name: 'Test', trigger_device_name: 'dev1', actions: {} }),
        'validate: valid profile');
    assert_true(validate({ profile_name: 'Test', trigger_device_name: 'dev1', actions: { bt_profile: 'a2dp-sink-aac' } }),
        'validate: valid bt_profile');
    assert_false(validate(null), 'validate: null');
    assert_false(validate({}), 'validate: empty object');
    assert_false(validate({ profile_name: '', trigger_device_name: 'dev1' }), 'validate: empty name');
    assert_false(validate({ profile_name: 'Test', trigger_device_name: '' }), 'validate: empty trigger');
    assert_false(validate({ profile_name: 'Test', trigger_device_name: 'dev1', actions: { bt_profile: 'invalid' } }),
        'validate: invalid bt_profile');
}

test_migration();
test_migration_already_active();
test_set_active_profile_logic();
test_reorder_up();
test_reorder_down();
test_reorder_boundary();
test_validate_profile();

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
