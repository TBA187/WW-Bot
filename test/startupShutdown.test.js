// Check that startup and background work stop cleanly during shutdown.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events } = require('discord.js');
const { StartupLifecycle } = require('../utils/abortable.js');
const cooldown = require('../tasks/cooldownNotifier.js');
const roster = require('../events/scoutRoster.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('a late startup step cannot proceed to storage restoration or Discord login after shutdown', async () => {
    const lifecycle = new StartupLifecycle();
    const storageReady = deferred();
    const entered = deferred();
    const calls = [];
    const bootstrap = (async () => {
        await lifecycle.run(() => { entered.resolve(); return storageReady.promise; });
        await lifecycle.run(() => calls.push('restore'));
        await lifecycle.run(() => calls.push('login'));
    })();
    await entered.promise;
    lifecycle.stop();
    await assert.rejects(bootstrap, { code: 'BOT_SHUTTING_DOWN' });
    storageReady.resolve('late success');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, []);
    await assert.rejects(lifecycle.run(() => calls.push('new startup')), { code: 'BOT_SHUTTING_DOWN' });
});

test('late startup rejections remain observed after cancellation', async () => {
    const lifecycle = new StartupLifecycle();
    const pending = deferred();
    const entered = deferred();
    const work = lifecycle.run(() => { entered.resolve(); return pending.promise; });
    await entered.promise;
    lifecycle.stop();
    await assert.rejects(work, { code: 'BOT_SHUTTING_DOWN' });
    pending.reject(new Error('controlled late pool rejection'));
    await new Promise(resolve => setImmediate(resolve));
});

test('optional preloads keep filling the cache after their startup deadline without a warning', async () => {
    const lifecycle = new StartupLifecycle();
    const pending = deferred();
    const notices = [], errors = [];
    let cached = false;
    await lifecycle.preload(async () => { await pending.promise; cached = true; }, {
        timeoutMs: 5, timeoutCode: 'PRELOAD_TIMEOUT',
        onTimeout: error => notices.push(error.code), onError: error => errors.push(error)
    });
    assert.deepEqual(notices, ['PRELOAD_TIMEOUT']);
    assert.equal(cached, false);
    pending.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cached, true);
    assert.deepEqual(errors, []);
});

test('optional preload errors are reported once, including errors after the startup deadline', async () => {
    const lifecycle = new StartupLifecycle();
    const errors = [], notices = [];
    const options = { timeoutMs: 5, timeoutCode: 'PRELOAD_TIMEOUT',
        onTimeout: error => notices.push(error.code), onError: error => errors.push(error.message) };
    await lifecycle.preload(() => Promise.reject(new Error('early failure')), options);
    const pending = deferred();
    await lifecycle.preload(() => pending.promise, options);
    pending.reject(new Error('late failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, ['early failure', 'late failure']);
    assert.deepEqual(notices, ['PRELOAD_TIMEOUT']);
});

test('stopping an optional preload cancels startup and suppresses late shutdown errors', async () => {
    const lifecycle = new StartupLifecycle();
    const pending = deferred(), entered = deferred();
    const errors = [], notices = [];
    const work = lifecycle.preload(() => { entered.resolve(); return pending.promise; }, {
        timeoutMs: 1000, timeoutCode: 'PRELOAD_TIMEOUT',
        onTimeout: error => notices.push(error), onError: error => errors.push(error)
    });
    await entered.promise;
    lifecycle.stop();
    await assert.rejects(work, { code: 'BOT_SHUTTING_DOWN' });
    pending.reject(new Error('Pool closed during shutdown'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.deepEqual(notices, []);
});

test('cooldown shutdown cancels the timer and ignores an in-flight storage response', async () => {
    const lifecycle = new StartupLifecycle();
    const query = deferred();
    let fetches = 0;
    const client = { guilds: { cache: { get: () => assert.fail('no guild work after shutdown') } } };
    const task = cooldown.execute(client, { shutdownSignal: lifecycle.signal,
        pvpKingStorage: { findExpiredNotifiableCooldowns: () => { fetches++; return query.promise; } } });
    lifecycle.stop();
    query.resolve([{ id: 1 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetches, 1);
    task.stop();
});

test('cooldown task does not start for an already-stopped client', () => {
    const lifecycle = new StartupLifecycle();
    lifecycle.stop();
    const client = {};
    cooldown.execute(client, { shutdownSignal: lifecycle.signal,
        pvpKingStorage: { findExpiredNotifiableCooldowns: () => assert.fail('late startup query') } });
    client.cooldownNotifier.stop();
});

test('roster initialization never starts after shutdown and late failure does not retry or log', async t => {
    const lifecycle = new StartupLifecycle();
    const query = deferred();
    const entered = deferred();
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    let seeds = 0;
    const client = new EventEmitter();
    client.guilds = { cache: new Map([['guild', {}]]) };
    roster.register(client, { shutdownSignal: lifecycle.signal, guildId: 'guild', guildMemberRoleID: 'role',
        scoutRosterStore: { seedCurrentGuildMembers: () => { seeds++; entered.resolve(); return query.promise; } } });
    client.emit(Events.ClientReady);
    await entered.promise;
    lifecycle.stop();
    query.reject(new Error('Pool is closed.'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seeds, 1);
    assert.deepEqual(errors, []);
    const stoppedClient = new EventEmitter();
    roster.register(stoppedClient, { shutdownSignal: lifecycle.signal, guildId: 'guild', guildMemberRoleID: 'role',
        scoutRosterStore: { seedCurrentGuildMembers: () => assert.fail('late seed') } });
    stoppedClient.emit(Events.ClientReady);
});
