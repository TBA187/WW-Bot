// Check owner alerts, startup buffering, secret removal and recovery from log delivery failures.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscordDiagnosticLogger, redactDiagnostic } = require('../utils/discordDiagnostics.js');

function fixture(options = {}) {
    const printed = [], sent = [];
    const consoleObject = { warn: (...args) => printed.push(['warn', ...args]), error: (...args) => printed.push(['error', ...args]) };
    const logger = new DiscordDiagnosticLogger({ send: event => sent.push(event), consoleObject, ...options });
    logger.install();
    return { logger, consoleObject, printed, sent };
}

test('actionable warnings before Discord login stay in memory, then post once with their original timestamp', () => {
    const f = fixture({ now: () => Date.parse('2026-10-03T09:30:00Z') });
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 5m (ECONNREFUSED).');
    assert.equal(f.printed.length, 1); assert.equal(f.sent.length, 0);
    f.logger.start(); f.logger.start();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].code, 'ECONNREFUSED');
    assert.equal(f.sent[0].component, 'MySQL');
    assert.equal(f.sent[0].timestamp, '2026-10-03T09:30:00.000Z');
    f.logger.stop();
});

test('expected startup deadlines and transient fallback notices stay in the console', () => {
    const f = fixture();
    const notices = [
        '[WW LOG] Scout autocomplete will refresh in the background (AUTOCOMPLETE_PRELOAD_TIMEOUT).',
        '[WW LOG] Player server preferences will refresh when used (SERVER_PREFERENCE_PRELOAD_TIMEOUT).',
        '[DB LOG] MySQL connectivity issue detected (ECONNRESET: read ECONNRESET). Query retries and feature fallbacks are active.',
        '[WW LOG] MySQL PvP King storage unavailable (ETIMEDOUT). Using the synchronized JSON snapshot; writes will queue for recovery.',
        '[PRO NOTIFICATIONS] MySQL storage unavailable (ECONNREFUSED). Using JSON; pending settings and subscriptions will retry automatically.'
    ];
    for (const notice of notices) f.consoleObject.warn(notice);
    f.consoleObject.warn('[WW LOG] Could not preload scout autocomplete; background refresh will retry:',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    f.consoleObject.warn('[WW LOG] Could not preload player server preferences; lookups will retry:',
        Object.assign(new Error('MySQL is temporarily unavailable.'), { code: 'DATABASE_UNAVAILABLE', causeCode: 'ETIMEDOUT' }));
    f.logger.start();
    assert.equal(f.printed.length, notices.length + 2);
    assert.deepEqual(f.sent, []);
    assert.equal(f.logger.waiting.size, 0);
    // A real preload failure and a non-transient database failure still need attention.
    f.consoleObject.warn('[WW LOG] Could not preload player server preferences:', Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }));
    f.consoleObject.error('[WW LOG] Unexpected MySQL PvP King storage error:', Object.assign(new Error('Lost write'), { code: 'ETIMEDOUT' }));
    assert.equal(f.sent.length, 2);
    f.logger.stop();
});

test('the known loader deprecation stays in stderr and other Node warnings have one warning alert', () => {
    const f = fixture(); f.logger.start();
    f.consoleObject.error('(node:34) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.');
    f.logger.capture('warn', ['Node runtime warning:', Object.assign(new Error('fs.Stats constructor is deprecated.'),
        { name: 'DeprecationWarning', code: 'DEP0180' })]);
    assert.equal(f.sent.length, 0);
    f.consoleObject.error('(node:34) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.');
    f.logger.run({ component: 'Scout parsing', reportId: '123' }, () => {
        f.logger.capture('warn', ['Node runtime warning:', Object.assign(new Error('Possible EventEmitter memory leak detected.'),
            { name: 'MaxListenersExceededWarning' })]);
    });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].level, 'warn');
    assert.equal(f.sent[0].component, 'Bot runtime');
    assert.equal(f.sent[0].reportId, undefined);
    // A deprecation thrown as an exception is a real failure, not a warning notice.
    f.consoleObject.error('Unhandled rejection:', Object.assign(new Error('fs.Stats constructor is deprecated.'),
        { name: 'DeprecationWarning', code: 'DEP0180' }));
    assert.equal(f.sent.length, 2);
    f.logger.stop();
});

test('persistent MySQL alerts are grouped for 30 minutes even across error codes and report contexts', () => {
    let now = 1000;
    const f = fixture({ now: () => now }); f.logger.start();
    f.logger.run({ component: 'Scout ingestion', reportId: '123', messageId: '124' }, () => {
        f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 5m (ECONNRESET; 5 failed attempt(s)).');
    });
    assert.equal(f.sent[0].component, 'MySQL');
    assert.equal(f.sent[0].reportId, undefined);
    assert.equal(f.sent[0].messageId, undefined);
    now += 5 * 60_000;
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 10m (ETIMEDOUT; 10 failed attempt(s)).');
    now += 5 * 60_000;
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 15m (ECONNREFUSED; 15 failed attempt(s)).');
    assert.equal(f.sent.length, 1);
    now = 1000 + 30 * 60_000;
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 35m (ETIMEDOUT; 35 failed attempt(s)).');
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].repeats, 2);
    f.consoleObject.error('The database write failed.', Object.assign(new Error('Lost connection'), { code: 'ECONNRESET' }));
    assert.equal(f.sent.length, 3);
    f.logger.stop();
});

test('persistent autocomplete alerts have a 15-minute Discord cooldown', () => {
    let now = 1000;
    const f = fixture({ now: () => now }); f.logger.start();
    const notice = '[WW LOG] /scout autocomplete missed its Discord response deadline 5 times within 5 minutes.';
    f.consoleObject.warn(notice);
    now += 5 * 60_000;
    f.consoleObject.warn(notice);
    assert.equal(f.sent.length, 1);
    now += 10 * 60_000;
    f.consoleObject.warn(notice);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].repeats, 1);
    f.logger.stop();
});

test('asynchronous scout work includes its known report and message IDs in the alert', async () => {
    const f = fixture(); f.logger.start();
    await f.logger.run({ component: 'Scout feedback', reportId: '1350059044102078494', messageId: '1350059160351412264' }, async () => {
        await Promise.resolve();
        f.consoleObject.error('Could not save feedback', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    });
    assert.equal(f.sent[0].reportId, '1350059044102078494');
    assert.equal(f.sent[0].messageId, '1350059160351412264');
    assert.equal(f.sent[0].code, 'ETIMEDOUT');
    f.logger.stop();
});

test('repeated errors do not flood the log channel, and a later alert includes the suppressed count', () => {
    let now = 1000;
    const f = fixture({ now: () => now }); f.logger.start();
    f.consoleObject.warn('Database still unavailable after 15s');
    f.consoleObject.warn('Database still unavailable after 30s');
    f.consoleObject.warn('Database still unavailable after 45s');
    assert.equal(f.sent.length, 1); assert.equal(f.printed.length, 3);
    now += 5 * 60_000;
    f.consoleObject.warn('Database still unavailable after 300s');
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1].repeats, 2);
    f.consoleObject.error('A different failure');
    assert.equal(f.sent.length, 3);
    f.logger.stop();
});

test('Discord copies remove configured secrets, REST tokens, SQL and request bodies', () => {
    const f = fixture({ secrets: ['private-token-123', 'private-db-password'] }); f.logger.start();
    f.consoleObject.error('private-token-123 https://discord.com/api/interactions/123/interaction-secret/callback',
        { message: 'password=private-db-password', code: 'EFAIL', sql: "SELECT 'private-sql'", requestBody: { token: 'private-body' } });
    const text = f.sent[0].message;
    assert.doesNotMatch(text, /private-token|private-db|private-sql|private-body|interaction-secret/u);
    assert.match(text, /redacted/u);
    assert.doesNotMatch(redactDiagnostic('mysql://user:password@host Bot abc123 https://discord.com/api/webhooks/123/secret'),
        /user:password|abc123|123\/secret/u);
    f.logger.stop();
});

test('failed log sends cannot recursively log themselves or interfere with the original console call', () => {
    const f = fixture({ send: () => { throw new Error('Discord unavailable'); } }); f.logger.start();
    assert.doesNotThrow(() => f.consoleObject.error('Original failure'));
    f.consoleObject.warn('[WW LOG] Could not send bot diagnostic log: Missing permission');
    assert.equal(f.printed.length, 2);
    assert.equal(f.logger.recent.size, 1);
    f.logger.stop();
});

test('stopping restores console methods and does not modify unrelated logging hooks', () => {
    const printed = [], consoleObject = { warn: value => printed.push(value), error: value => printed.push(value) };
    const original = consoleObject.error;
    const logger = new DiscordDiagnosticLogger({ consoleObject, send: () => {} });
    logger.install(); logger.install();
    const otherWrapper = () => {};
    consoleObject.warn = otherWrapper;
    logger.stop();
    assert.equal(consoleObject.error, original);
    assert.equal(consoleObject.warn, otherWrapper);
    consoleObject.error('Still logged'); assert.deepEqual(printed, ['Still logged']);
});
