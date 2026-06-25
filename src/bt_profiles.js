/**
 * Shared Bluetooth codec priority ladders.
 * Single source of truth for A2DP quality ranking and HSP/HFP ordering.
 */

var A2DP_QUALITY = [
    'a2dp-sink-ldac',
    'a2dp-sink-aptx_hd',
    'a2dp-sink-aptx',
    'a2dp-sink-aac',
    'a2dp-sink',
    'a2dp-sink-sbc_xq',
    'a2dp-sink-sbc',
];

var HSP_HFP = ['handsfree-headset', 'headset-head-unit'];

/**
 * Pick the best profile the device actually supports for the user's intent.
 * @param {Set<string>|string[]} available  profiles the card exposes
 * @param {string} [desired='']             user's preferred profile
 * @returns {string} best match, or '' if nothing matches
 */
var pickBest = function pickBest(available, desired = '') {
    const isSet = available instanceof Set;
    const has = isSet
        ? candidate => available.has(candidate)
        : candidate => available.includes(candidate);
    const is_call = desired && HSP_HFP.includes(desired);
    const ladder = is_call ? HSP_HFP : A2DP_QUALITY;
    for (const cand of ladder) {
        if (has(cand)) return cand;
    }
    return '';
};
