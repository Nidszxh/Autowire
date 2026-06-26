#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later

const pactl_parser = imports.pactl_parser;

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

print('\n=== Pactl Parser Tests ===\n');

(function test_parse_single_bt_card() {
    const text = [
        'Card #42',
        '	Name: bluez_card.0F_56_51_19_26_87',
        '	Driver: module-bluez5.c',
        '	Owner Module: 33',
        '	Profiles:',
        '		a2dp-sink: High Fidelity Playback (A2DP Sink) (sinks: 1, sources: 0, priority: 20, available: unknown)',
        '		a2dp-sink-aac: High Fidelity Playback (A2DP Sink, codec AAC) (sinks: 1, sources: 0, priority: 20, available: unknown)',
        '		a2dp-sink-ldac: High Fidelity Playback (A2DP Sink, codec LDAC) (sinks: 1, sources: 0, priority: 20, available: unknown)',
        '		handsfree-headset: Handsfree (HFP/HSP, codec CVSD) (sinks: 1, sources: 1, priority: 20, available: unknown)',
        '		off: Off (sinks: 0, sources: 0, priority: 0, available: yes)',
        '	Active Profile: a2dp-sink-aac',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    assert_eq(1, result.size, 'parse: one card found');

    const bt_card = result.get('bluez_card.0F_56_51_19_26_87');
    assert_true(!!bt_card, 'parse: BT card entry exists');
    assert_eq('a2dp-sink-aac', bt_card.active, 'parse: active profile is AAC');
    assert_true(bt_card.profiles instanceof Set, 'parse: profiles is a Set');
    assert_true(bt_card.profiles.has('a2dp-sink'), 'parse: has a2dp-sink');
    assert_true(bt_card.profiles.has('a2dp-sink-aac'), 'parse: has a2dp-sink-aac');
    assert_true(bt_card.profiles.has('a2dp-sink-ldac'), 'parse: has a2dp-sink-ldac');
    assert_true(bt_card.profiles.has('handsfree-headset'), 'parse: has handsfree-headset');
    assert_true(bt_card.profiles.has('off'), 'parse: has off');
    assert_eq(5, bt_card.profiles.size, 'parse: 5 profiles total');
})();

(function test_parse_multiple_cards() {
    const text = [
        'Card #0',
        '	Name: alsa_card.pci-0000_00_1f.3',
        '	Driver: module-alsa-card.c',
        '	Owner Module: 6',
        '	Profiles:',
        '		output:analog-stereo: Analog Stereo Output (sinks: 1, sources: 0, priority: 6500)',
        '		off: Off (sinks: 0, sources: 0, priority: 0, available: yes)',
        '	Active Profile: output:analog-stereo',
        '',
        'Card #42',
        '	Name: bluez_card.AA_BB_CC_DD_EE_FF',
        '	Driver: module-bluez5.c',
        '	Owner Module: 33',
        '	Profiles:',
        '		a2dp-sink: High Fidelity Playback (sinks: 1, sources: 0)',
        '		handsfree-headset: Handsfree (sinks: 1, sources: 1)',
        '		off: Off (sinks: 0, sources: 0, available: yes)',
        '	Active Profile: handsfree-headset',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    assert_eq(2, result.size, 'parse multiple: 2 cards found');

    const alsa = result.get('alsa_card.pci-0000_00_1f.3');
    assert_true(!!alsa, 'parse multiple: ALSA card exists');
    assert_eq('output:analog-stereo', alsa.active, 'parse multiple: ALSA active profile');
    assert_true(alsa.profiles.has('output:analog-stereo'), 'parse multiple: ALSA has analog-stereo');
    assert_true(alsa.profiles.has('off'), 'parse multiple: ALSA has off');

    const bt = result.get('bluez_card.AA_BB_CC_DD_EE_FF');
    assert_true(!!bt, 'parse multiple: BT card exists');
    assert_eq('handsfree-headset', bt.active, 'parse multiple: BT active profile');
    assert_true(bt.profiles.has('a2dp-sink'), 'parse multiple: BT has a2dp-sink');
    assert_true(bt.profiles.has('handsfree-headset'), 'parse multiple: BT has handsfree');
})();

(function test_parse_empty_text() {
    const result = pactl_parser.parseCardsText('');
    assert_eq(0, result.size, 'parse empty: no cards');
})();

(function test_parse_no_profiles_section() {
    const text = [
        'Card #42',
        '	Name: bluez_card.XX_XX_XX_XX_XX_XX',
        '	Driver: module-bluez5.c',
        '	Active Profile: off',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    assert_eq(1, result.size, 'parse no profiles: card created');
    const card = result.get('bluez_card.XX_XX_XX_XX_XX_XX');
    assert_true(!!card, 'parse no profiles: entry exists');
    assert_eq('off', card.active, 'parse no profiles: active is off');
    assert_eq(0, card.profiles.size, 'parse no profiles: empty profiles Set');
})();

(function test_parse_malformed_line_skipped() {
    // Lines within Profiles: that don't match the profile name pattern are skipped
    const text = [
        'Card #42',
        '	Name: bluez_card.XX_XX_XX_XX_XX_XX',
        '	Driver: module-bluez5.c',
        '	Profiles:',
        '		a2dp-sink-aac: AAC (sinks: 1, sources: 0)',
        '		(malformed line without colon-space)',
        '		off: Off (sinks: 0, sources: 0, available: yes)',
        '	Active Profile: a2dp-sink-aac',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    const card = result.get('bluez_card.XX_XX_XX_XX_XX_XX');
    assert_true(!!card, 'parse malformed: card exists');
    assert_true(card.profiles.has('a2dp-sink-aac'), 'parse malformed: has AAC');
    assert_true(card.profiles.has('off'), 'parse malformed: has off');
    assert_eq(2, card.profiles.size, 'parse malformed: skips malformed line');
})();

(function test_parse_profile_with_dots_and_pluses() {
    const text = [
        'Card #0',
        '	Name: alsa_card.usb-Microsoft_Microsoft_LifeCam_HD-3000-01',
        '	Driver: module-alsa-card.c',
        '	Profiles:',
        '		input:mono: Mono Input (sinks: 0, sources: 1, priority: 1, available: unknown)',
        '		output:hdmi-stereo-extra1: Digital Stereo (HDMI) Output (sinks: 1, sources: 0, priority: 700, available: unknown)',
        '		output:analog-stereo+input:analog-stereo: Analog Stereo Duplex (sinks: 1, sources: 1, priority: 6480)',
        '		off: Off (sinks: 0, sources: 0, priority: 0, available: yes)',
        '	Active Profile: input:mono',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    const card = result.get('alsa_card.usb-Microsoft_Microsoft_LifeCam_HD-3000-01');
    assert_true(!!card, 'parse complex: card exists');
    assert_true(card.profiles.has('input:mono'), 'parse complex: has input:mono');
    assert_true(card.profiles.has('output:hdmi-stereo-extra1'), 'parse complex: has hdmi-stereo-extra1');
    assert_true(card.profiles.has('output:analog-stereo+input:analog-stereo'), 'parse complex: has duplex');
    assert_true(card.profiles.has('off'), 'parse complex: has off');
    assert_eq(4, card.profiles.size, 'parse complex: 4 profiles');
    assert_eq('input:mono', card.active, 'parse complex: active is input:mono');
})();

(function test_getActiveProfile_and_getCardProfiles() {
    // Test via parseCardsText directly
    const text = [
        'Card #42',
        '	Name: bluez_card.0F_56_51_19_26_87',
        '	Driver: module-bluez5.c',
        '	Profiles:',
        '		a2dp-sink-aac: AAC (sinks: 1, sources: 0)',
        '		handsfree-headset: Handsfree (sinks: 1, sources: 1)',
        '		off: Off (sinks: 0, sources: 0, available: yes)',
        '	Active Profile: a2dp-sink-aac',
    ].join('\n');

    const result = pactl_parser.parseCardsText(text);
    const card = result.get('bluez_card.0F_56_51_19_26_87');
    assert_eq('a2dp-sink-aac', card.active, 'getActiveProfile via parseCardsText');
    assert_true(card.profiles.has('handsfree-headset'), 'getCardProfiles via parseCardsText');
})();

print(`\n${passed} passed, ${failed} failed\n`);
imports.system.exit(failed > 0 ? 1 : 0);
