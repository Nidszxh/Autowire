const { GLib } = imports.gi;
const log = imports.log;
const { get_pactl_cmd, spawn_sync_with_timeout } = imports.utils;

let _cardsCache = { text: '', ts: 0 };
const CACHE_TTL_MS = 1000;

/**
 * Fetch pactl card data with a 1-second cache.
 * @returns {string} raw pactl output, or '' on failure
 */
function fetchCardsText() {
    const now = Date.now();
    if (now - _cardsCache.ts < CACHE_TTL_MS && _cardsCache.text) {
        return _cardsCache.text;
    }
    try {
        const [ok, stdout] = spawn_sync_with_timeout(get_pactl_cmd().concat(['list', 'cards']), 2000);
        if (!ok) {
            if (!_cardsCache.text) log.warn('pactl_parser', 'pactl list cards returned error, no cached data available');
            return _cardsCache.text || '';
        }
        const text = stdout;
        _cardsCache = { text, ts: now };
        return text;
    } catch (e) {
        if (!_cardsCache.text) log.warn('pactl_parser', `pactl spawn failed: ${e.message || e}, no cached data available`);
        return _cardsCache.text || '';
    }
}

/**
 * Parse pactl card text into structured data.
 * @param {string} text - raw pactl output
 * @returns {Map<string, {active: string, profiles: Set<string>}>}
 */
function parseCardsText(text) {
    const result = new Map();
    let current = null;
    let in_profiles = false;

    for (const raw_line of text.split('\n')) {
        const line = raw_line.trim();
        if (line.startsWith('Name: ')) {
            current = line.substring(6).trim();
            result.set(current, { active: '', profiles: new Set() });
            in_profiles = false;
        } else if (current && line.startsWith('Active Profile: ')) {
            const rest = line.substring('Active Profile: '.length).trim();
            const entry = result.get(current);
            if (entry) entry.active = rest;
        } else if (current && line === 'Profiles:') {
            in_profiles = true;
        } else if (current && in_profiles && line && !line.startsWith('Active Profile:')) {
            const m = line.match(/^([\w\-+.:]+):\s/);
            if (m) {
                const entry = result.get(current);
                if (entry) entry.profiles.add(m[1]);
            } else if (line === '') {
                in_profiles = false;
            }
        }
    }

    return result;
}

/**
 * Parse pactl card output, fetching via subprocess.
 * @returns {Map<string, {active: string, profiles: Set<string>}>}
 */
function parsePactlCards() {
    return parseCardsText(fetchCardsText());
}

/**
 * Get the active BT profile for a card.
 * @param {string} card_pw_name
 * @returns {string} active profile name, or '' on failure
 */
function getActiveProfile(card_pw_name) {
    if (!card_pw_name) return '';
    const cards = parsePactlCards();
    const entry = cards.get(card_pw_name);
    return entry ? entry.active : '';
}

/**
 * Get available profiles for a card.
 * @param {string} card_pw_name
 * @returns {Set<string>} profile names, empty set on failure
 */
function getCardProfiles(card_pw_name) {
    if (!card_pw_name) return new Set();
    const cards = parsePactlCards();
    const entry = cards.get(card_pw_name);
    return entry ? entry.profiles : new Set();
}

/**
 * Get all cards as an object map.
 * @returns {Object<string, string[]>}
 */
function listAllCardProfiles() {
    const cards = parsePactlCards();
    const out = {};
    for (const [name, entry] of cards) {
        out[name] = [...entry.profiles];
    }
    return out;
}

function clearCardsCache() {
    _cardsCache = { text: '', ts: 0 };
}

