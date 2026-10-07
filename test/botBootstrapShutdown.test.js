// Check that cancelling startup prevents the bot from logging in or starting tasks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const discord = require('discord.js');
const abortHelpers = require('../utils/abortable.js');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

test('actual index startup cannot restore stores, register commands, login or start ready tasks after Ctrl+C', async () => {
    const databaseReady = deferred();
    const calls = [];
    const processHandlers = new Map();
    const exit = deferred();
    let client;
    class FakeClient extends EventEmitter {
        constructor() { super(); client = this; }
        destroy() { calls.push('disconnect'); }
        login() { calls.push('login'); return Promise.resolve(); }
    }
    class FakeStore {
        restore() { calls.push('restore'); return Promise.resolve(); }
        stopSyncLoop() {}
        startSyncLoop() { calls.push('start sync'); }
        autocomplete() { return Promise.resolve([]); }
    }
    const monitor = { start() { calls.push('monitor start'); return Promise.resolve(); }, stop() {} };
    class FakeIngestor { start() { calls.push('ingestor start'); return Promise.resolve(); } stop() {} }
    const db = { initPromise: databaseReady.promise,
        end: async () => calls.push('feature pool closed') };
    const imports = {
        'dotenv': { config() {} },
        './config.json': { guildId: 'test-guild' },
        './db/db-conn.js': db,
        './utils/abortable.js': abortHelpers,
        './utils/discordDiagnostics.js': require('../utils/discordDiagnostics.js'),
        './commands/pvp-king/utils/pvpKingStorage.js': FakeStore,
        './events/giveaways.js': { createGiveawayStore: () => new FakeStore() },
        './features/pro-notifications/NotificationStore.js': FakeStore,
        './features/pro-notifications/notificationCatalog.js': { NOTIFICATION_DEFINITIONS: [] },
        './features/guild-applications/index.js': { createGuildApplicationMonitor: () => monitor },
        './features/tba-forum-shops/index.js': { createTbaForumShopMonitor: () => monitor },
        './features/pvp-scouting/ScoutServerRegistry.js': { ScoutServerRegistry: class {
            get() { return { store: new FakeStore(), ingestor: new FakeIngestor() }; }
            async warmAutocomplete() {}
            async start() { calls.push('ingestor start'); }
            async stop() {}
        } },
        './features/pvp-scouting/ScoutServerSettings.js': { ScoutServerSettings: class { async hydratePreferences() {} } },
        './features/pvp-scouting/ScoutRosterStore.js': { ScoutRosterStore: FakeStore },
        './features/pvp-scouting/ScoutAuditLogger.js': { ScoutAuditLogger: class { async flush() {} } },
        './utils/jsonFile.js': { writeJsonIfChanged() {} },
        './tasks/proNotifications.js': { stop() {} },
        'discord.js': { ...discord, Client: FakeClient },
        'fs': {}, 'path': path
    };
    const root = path.resolve(__dirname, '..');
    vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), {
        __dirname: root, require: name => {
            if (!(name in imports)) throw new Error(`Unexpected startup import: ${name}`);
            return imports[name];
        },
        process: {
            env: { TOKEN: 'fake-token', CLIENT_ID: 'fake-client' },
            on() {}, once: (event, handler) => processHandlers.set(event, handler),
            exit: code => { calls.push(`exit ${code}`); exit.resolve(); }
        },
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, Map, Set
    });
    await new Promise(resolve => setImmediate(resolve));
    await processHandlers.get('SIGINT')();
    await exit.promise;
    databaseReady.resolve(true);
    client.emit(discord.Events.ClientReady);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['disconnect', 'feature pool closed', 'exit 0']);
});
