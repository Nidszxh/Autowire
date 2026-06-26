#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later

const bt_profiles = imports.bt_profiles;

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

print('\n=== BT Profiles Tests ===\n');

(function test_a2dp_quality_order() {
    const ladder = bt_profiles.A2DP_QUALITY;
    assert_eq('a2dp-sink-ldac', ladder[0], 'A2DP_QUALITY: LDAC is best');
    assert_eq('a2dp-sink-aptx_hd', ladder[1], 'A2DP_QUALITY: aptX-HD second');
    assert_eq('a2dp-sink-aptx', ladder[2], 'A2DP_QUALITY: aptX third');
    assert_eq('a2dp-sink-aac', ladder[3], 'A2DP_QUALITY: AAC fourth');
    assert_eq('a2dp-sink', ladder[4], 'A2DP_QUALITY: a2dp-sink fifth');
    assert_eq('a2dp-sink-sbc_xq', ladder[5], 'A2DP_QUALITY: SBC-XQ sixth');
    assert_eq('a2dp-sink-sbc', ladder[6], 'A2DP_QUALITY: SBC worst');
})();

(function test_hsp_hfp_order() {
    const ladder = bt_profiles.HSP_HFP;
    assert_eq('handsfree-headset', ladder[0], 'HSP_HFP: handsfree preferred');
    assert_eq('headset-head-unit', ladder[1], 'HSP_HFP: headset second');
})();

(function test_pick_best_basic() {
    assert_eq('a2dp-sink-aac', bt_profiles.pickBest(['a2dp-sink-sbc', 'a2dp-sink-aac', 'a2dp-sink']),
        'pickBest: picks best from array');
    assert_eq('a2dp-sink-ldac', bt_profiles.pickBest(new Set(['a2dp-sink-sbc', 'a2dp-sink-ldac', 'a2dp-sink'])),
        'pickBest: picks best from Set');
})();

(function test_pick_best_single_match() {
    assert_eq('a2dp-sink-sbc', bt_profiles.pickBest(['a2dp-sink-sbc']),
        'pickBest: only match in array');
    assert_eq('a2dp-sink-sbc', bt_profiles.pickBest(new Set(['a2dp-sink-sbc'])),
        'pickBest: only match in Set');
})();

(function test_pick_best_desired_call() {
    const available = ['a2dp-sink-aac', 'handsfree-headset'];
    assert_eq('handsfree-headset', bt_profiles.pickBest(available, 'handsfree-headset'),
        'pickBest(desired=handsfree): returns handsfree');
    assert_eq('headset-head-unit', bt_profiles.pickBest(['headset-head-unit'], 'handsfree-headset'),
        'pickBest(desired=handsfree): falls back to headset');
    assert_eq('handsfree-headset', bt_profiles.pickBest(new Set(['a2dp-sink-aac', 'handsfree-headset']), 'handsfree-headset'),
        'pickBest(desired=handsfree, Set): returns handsfree');
})();

(function test_pick_best_desired_a2dp() {
    const available = ['a2dp-sink-sbc', 'a2dp-sink-aac'];
    assert_eq('a2dp-sink-aac', bt_profiles.pickBest(available, 'a2dp-sink-aac'),
        'pickBest(desired=aac): exact match');
    assert_eq('a2dp-sink-aac', bt_profiles.pickBest(available, 'a2dp-sink-ldac'),
        'pickBest(desired=ldac): falls back to best from A2DP ladder');
    assert_eq('a2dp-sink-aac', bt_profiles.pickBest(new Set(available), 'a2dp-sink-aac'),
        'pickBest(desired=aac, Set): exact match');
})();

(function test_pick_best_no_match() {
    assert_eq('', bt_profiles.pickBest([]),
        'pickBest: empty array returns empty');
    assert_eq('', bt_profiles.pickBest(new Set()),
        'pickBest: empty Set returns empty');
    assert_eq('', bt_profiles.pickBest(['unrelated_profile']),
        'pickBest: no match returns empty');
})();

(function test_pick_best_empty_desired() {
    assert_eq('a2dp-sink-aac', bt_profiles.pickBest(['a2dp-sink-aac', 'a2dp-sink-sbc'], ''),
        'pickBest(desired=""): uses A2DP ladder');
})();

(function test_pick_best_prefers_higher_in_ladder() {
    const available = ['a2dp-sink-sbc', 'a2dp-sink-ldac', 'a2dp-sink', 'a2dp-sink-aac'];
    assert_eq('a2dp-sink-ldac', bt_profiles.pickBest(available),
        'pickBest: prefers LDAC over AAC and SBC');
    assert_eq('a2dp-sink-ldac', bt_profiles.pickBest(new Set(available)),
        'pickBest(Set): prefers LDAC over AAC and SBC');
})();

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
