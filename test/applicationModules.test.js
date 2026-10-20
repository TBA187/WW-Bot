// Check module discovery, event failures and cooldown cleanup without starting the bot.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { discoverModules, registerEvents } = require('../app/moduleLoader.js');
const { CommandCooldowns } = require('../app/CommandCooldowns.js');

test('module discovery preserves the one-level boundary that keeps nested helpers out of command loading', () => {
    const rootPath = path.resolve('offline');
    const modules = discoverModules(rootPath, 'commands', { readdirSync(directory, options) {
        if (options) return [{ name: 'pvp-king', isDirectory: () => true },
            { name: 'ping.js', isDirectory: () => false }, { name: 'old.js.backup', isDirectory: () => false }];
        assert.equal(directory, path.join(rootPath, 'commands/pvp-king'));
        return ['pvp_crown.js', 'utils', 'old.js.backup'];
    } });
    assert.deepEqual(modules.map(entry => entry.basePath + entry.file), ['./commands/pvp-king/pvp_crown.js', './commands/ping.js']);
});

test('XP event gating retains guild/message/reaction lookup and skips DMs, disabled guilds and shutdown', async () => {
    const client = new EventEmitter(), calls = [], errors = [];
    const lifecycle = { stopping: false };
    const commandConfig = { guildSettingsCache: new Map([['enabled', { xpEnabled: true }]]) };
    registerEvents({ client, lifecycle, commandConfig,
        consoleObject: { log() {}, error: error => errors.push(error) },
        modules: [{ file: 'xpMessageHandler.js', basePath: './events/levels/',
            event: { name: 'activity', execute: (...args) => calls.push(args) } }] });
    const forms = [{ guild: { id: 'enabled' } }, { message: { guild: { id: 'enabled' } } }, { guildId: 'enabled' }];
    for (const input of [...forms, {}, { guildId: 'disabled' }]) client.emit('activity', input);
    lifecycle.stopping = true;
    client.emit('activity', forms[0]);
    assert.equal(calls.length, 3);
    calls.forEach((args, i) => { assert.equal(args[0], forms[i]); assert.equal(args[1], commandConfig); });
    assert.deepEqual(errors, []);
});

test('registered events observe sync throws and async rejections and preserve once listeners', async () => {
    const client = new EventEmitter(), errors = [];
    const syncError = new Error('sync'), asyncError = new Error('async');
    registerEvents({ client, lifecycle: { stopping: false }, commandConfig: {},
        consoleObject: { log() {}, error: (...args) => errors.push(args) },
        modules: [
            { file: 'sync.js', event: { name: 'sync', once: true, execute() { throw syncError; } } },
            { file: 'async.js', event: { name: 'async', async execute() { throw asyncError; } } }
        ] });
    client.emit('sync'); client.emit('sync'); client.emit('async');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors.map(args => args[1]), [syncError, asyncError]);
});

test('cooldowns retain expiry and server keys while sweeping inactive users', () => {
    let now = 1000;
    const cooldowns = new CommandCooldowns({ now: () => now, sweepIntervalMs: 1000 });
    assert.equal(cooldowns.onCooldown('user', 'gold:crown', 2), false);
    assert.equal(cooldowns.onCooldown('user', 'gold:crown', 2), true);
    assert.equal(cooldowns.onCooldown('user', 'silver:crown', 2), false);
    cooldowns.onCooldown('inactive-user', 'xp_msg', 1);
    now = 2000;
    assert.equal(cooldowns.onCooldown('user', 'gold:crown', 2), true);
    assert.equal(cooldowns.entries.has('inactive-user:xp_msg'), false);
    now = 3000;
    assert.equal(cooldowns.onCooldown('user', 'gold:crown', 2), false);
    assert.equal(cooldowns.entries.has('user:silver:crown'), false);
});
