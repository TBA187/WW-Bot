const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DatabaseHealthTracker,
    DatabaseUnavailableError
} = require('../db/DatabaseHealthTracker.js');

function testLogger() {
    const messages = { logs: [], warnings: [] };
    return {
        messages,
        logger: {
            log: message => messages.logs.push(message),
            warn: message => messages.warnings.push(message)
        }
    };
}

test('database health tracker consolidates an outage and applies exponential backoff', () => {
    let now = 1000;
    const { logger, messages } = testLogger();
    const tracker = new DatabaseHealthTracker({
        logger,
        now: () => now,
        baseCooldownMs: 100,
        maxCooldownMs: 400,
        statusLogIntervalMs: 1000
    });

    tracker.recordFailure(Object.assign(new Error('lost'), { code: 'ECONNRESET' }));
    assert.equal(messages.warnings.length, 1);
    assert.equal(tracker.retryAfterMs(), 100);
    assert.equal(tracker.canAttempt(), false);

    now += 100;
    tracker.recordFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    assert.equal(messages.warnings.length, 1);
    assert.equal(tracker.retryAfterMs(), 200);

    const unavailable = tracker.unavailableError();
    assert.ok(unavailable instanceof DatabaseUnavailableError);
    assert.equal(unavailable.code, 'DATABASE_UNAVAILABLE');
    assert.equal(unavailable.causeCode, 'ECONNREFUSED');
});

test('database health tracker logs periodic status and one recovery message', () => {
    let now = 1000;
    const { logger, messages } = testLogger();
    const tracker = new DatabaseHealthTracker({
        logger,
        now: () => now,
        baseCooldownMs: 100,
        maxCooldownMs: 100,
        statusLogIntervalMs: 1000
    });

    tracker.recordFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    now += 1100;
    tracker.recordBlockedOperation();
    assert.equal(messages.warnings.length, 2);
    assert.match(messages.warnings[1], /still unavailable/);

    tracker.recordSuccess();
    tracker.recordSuccess();
    assert.equal(messages.logs.length, 1);
    assert.match(messages.logs[0], /connection restored/);
    assert.equal(tracker.isUnavailable(), false);
});

test('a failure from an older in-flight query cannot reopen a recovered outage', () => {
    let now = 1000;
    const { logger, messages } = testLogger();
    const tracker = new DatabaseHealthTracker({ logger, now: () => now });

    tracker.recordFailure(Object.assign(new Error('lost'), { code: 'ECONNRESET' }), { attemptStartedAt: 1000 });
    now = 2000;
    tracker.recordSuccess();
    tracker.recordFailure(Object.assign(new Error('stale'), { code: 'ECONNRESET' }), { attemptStartedAt: 1500 });

    assert.equal(tracker.isUnavailable(), false);
    assert.equal(messages.warnings.length, 1);
    assert.equal(messages.logs.length, 1);
});
