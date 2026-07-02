const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldNotifyExpiredCooldown } = require('../tasks/cooldownNotifier.js');

const HOUR_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 48 * HOUR_MS;
const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);

function rowExpiredAgo(hours) {
    const lastChallenge = new Date(NOW - COOLDOWN_MS - (hours * HOUR_MS));

    return {
        last_challenge: lastChallenge.toISOString().slice(0, 19).replace('T', ' ')
    };
}

test('cooldown notifier pings recently missed expirations', () => {
    assert.equal(shouldNotifyExpiredCooldown(rowExpiredAgo(0.5), NOW), true);
    assert.equal(shouldNotifyExpiredCooldown(rowExpiredAgo(1), NOW), true);
});

test('cooldown notifier skips expirations missed by more than 1 hour', () => {
    assert.equal(shouldNotifyExpiredCooldown(rowExpiredAgo(1.01), NOW), false);
});
