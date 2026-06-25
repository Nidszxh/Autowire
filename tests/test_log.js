#!/usr/bin/env gjs
const log = imports.log;

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

// Level enum
assert_eq(log.Level.DEBUG, 0, 'Level.DEBUG is 0');
assert_eq(log.Level.INFO, 1, 'Level.INFO is 1');
assert_eq(log.Level.WARN, 2, 'Level.WARN is 2');
assert_eq(log.Level.ERROR, 3, 'Level.ERROR is 3');

// Default level is INFO; setLevel(DEBUG) enables all levels
log.setLevel(log.Level.DEBUG);
// After setLevel(DEBUG), all levels should print
// We can't easily capture stdout, but we can verify no crash

log.setLevel(log.Level.INFO);

// Logging functions don't crash
log.debug('test', 'debug message');
log.info('test', 'info message');
log.warn('test', 'warn message');
log.error('test', 'error message');

// Invalid path doesn't crash
log.setLogFile('/nonexistent_dir_xyz_autowire_test/log.txt');

// Restore default level
log.setLevel(log.Level.INFO);

print(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    imports.system.exit(1);
}
