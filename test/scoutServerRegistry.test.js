// Check server routing, archive boundaries, and shared review evidence.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutServerRegistry } = require('../features/pvp-scouting/ScoutServerRegistry.js');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
const { buildGroupLinks, PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor.js');
const events = require('../events/pvpScouting.js');

function registryFixture() {
    const calls = [];
    class Store {
        constructor(options) { Object.assign(this, options); this.reviewLearningAt = 100; }
        async ensureSchema() { calls.push(`schema:${this.server}`); }
        async autocomplete() { calls.push(`autocomplete:${this.server}`); }
    }
    class Ingestor {
        constructor(options) { Object.assign(this, options); }
        async start() { calls.push(`start:${this.server}`); }
        async stop() { calls.push(`stop:${this.server}`); }
        async handleCreate(message) { calls.push(`create:${this.server}:${message.id}`); }
        async handleUpdate(message) { calls.push(`update:${this.server}:${message.id}`); }
        async handleDelete(message) { calls.push(`delete:${this.server}:${message.id}`); }
    }
    const registry = new ScoutServerRegistry({ Store, Ingestor, config: {
        guildId: 'guild', pvpScoutingGoldChannelID: 'gold-channel', pvpScoutingSilverChannelID: 'silver-channel'
    } });
    return { registry, calls };
}

test('completed screenshot reinspection logs identify their archive', async t => {
    const messages = [];
    t.mock.method(console, 'log', message => messages.push(message));
    for (const server of ['gold', 'silver']) {
        const ingestor = new PvpScoutIngestor({ server,
            store: { savedResultCardsToReinspect: async () => [] }, ocr: {},
            feedback: { stop: async () => {} } });
        await ingestor.reinspectLegacyResultCards();
        await ingestor.stop();
        await ingestor.reinspectLegacyResultCards();
    }
    assert.deepEqual(messages, ['Gold', 'Silver'].map(label =>
        `[WW LOG] ${label} PvP saved-result-card reinspection COMPLETE: no archived screenshots need rereading.`));
});

test('bot-posted member submissions retain their server in edit-review snapshots', async t => {
    for (const server of ['gold', 'silver']) {
        const ingestor = new PvpScoutIngestor({ server, channelId: `${server}-channel`,
            client: { user: { id: '123456789012345678' } }, store: {}, feedback: { stop: async () => {} } });
        t.after(() => ingestor.stop());
        const record = await ingestor.buildRecord({ id: '1554781141230424094',
            channelId: `${server}-channel`, author: { id: '123456789012345678', bot: true },
            embeds: [{ title: 'PvP Scout Report — Opponent', description: 'Charizard: Roost',
                author: { name: 'Reporter', url: 'https://discord.com/users/291142291073269761' } }] });
        assert.equal(record.server, server);
        assert.equal(record.channelId, `${server}-channel`);
        assert.equal(record.ignSource, 'member_submission');
    }
});

test('registry binds separate archives, caches, and queues while sharing roster and learning channels', () => {
    const { registry } = registryFixture();
    const gold = registry.get('gold'), silver = registry.get('silver');
    assert.notEqual(gold.store, silver.store);
    assert.notEqual(gold.ingestor, silver.ingestor);
    assert.equal(registry.forChannel('silver-channel'), silver);
    assert.equal(registry.forChannel('other-channel'), null);
    assert.match(gold.store.autocompleteCachePath, /scout-autocomplete-cache\.json$/u);
    assert.match(silver.store.autocompleteCachePath, /scout-autocomplete-silver-cache\.json$/u);
    assert.deepEqual(silver.store.learningChannelIds, ['gold-channel', 'silver-channel']);
    gold.store.onLearningChanged();
    assert.equal(silver.store.reviewLearningAt, 0);
    assert.equal(Object.isFrozen(gold), true);
});

test('both archives warm before event ingestion and stop their own jobs', async () => {
    const { registry, calls } = registryFixture();
    await registry.warmAutocomplete(); await registry.start(); await registry.stop();
    assert.deepEqual(calls, ['schema:gold', 'schema:silver', 'autocomplete:gold', 'autocomplete:silver',
        'start:gold', 'start:silver', 'stop:gold', 'stop:silver']);
});

test('events route create, edit, and delete only to the source server', async () => {
    const { registry, calls } = registryFixture();
    const handlers = new Map();
    events.register({ user: { id: 'bot' }, on: (type, handler) => handlers.set(type, handler) }, { scoutServers: registry });
    const gold = { id: 'one', channelId: 'gold-channel', author: { id: 'author' } };
    const silver = { ...gold, id: 'two', channelId: 'silver-channel' };
    await handlers.get('messageCreate')(gold);
    await handlers.get('messageUpdate')(null, silver);
    await handlers.get('messageDelete')(silver);
    await handlers.get('messageCreate')({ ...gold, channelId: 'unrelated' });
    await handlers.get('messageCreate')({ ...silver, author: { id: 'bot', bot: true } });
    assert.deepEqual(calls, ['create:gold:one', 'update:silver:two', 'delete:silver:two']);
});

test('one server cannot retrieve or save a source from the other channel', async () => {
    let params;
    const store = new PvpScoutStore({ channelId: 'silver-channel', server: 'silver', db: {
        async query(sql, values) {
            assert.match(sql, /message_id = \? AND channel_id = \?/u); params = values;
            return [[]];
        }
    } });
    store.schemaReady = true;
    assert.equal(await store.getMessage('gold-source'), null);
    assert.deepEqual(params, ['gold-source', 'silver-channel']);
    await assert.rejects(store.saveMessage({ messageId: 'gold-source', channelId: 'gold-channel' }), /another server/u);
    await assert.rejects(store.stageEditReview({ messageId: 'gold-source', channelId: 'gold-channel' },
        { messageId: 'gold-source', channelId: 'gold-channel', content: 'edited' }), /another server/u);
});

test('same-author continuations and explicit replies never join across server archives', () => {
    const root = { message_id: '1', channel_id: 'gold-channel', server: 'gold', author_id: 'reporter',
        created_at: new Date('2026-10-03T12:00:00Z'), classification: 'scout', ign_normalized: 'opponent',
        team_text: '- Landorus: Earthquake' };
    const reply = { ...root, message_id: '2', channel_id: 'silver-channel', server: 'silver', reply_to_id: '1',
        created_at: new Date('2026-10-03T12:00:10Z'), ign_normalized: null };
    assert.deepEqual(buildGroupLinks([root, reply]).links, []);
});

test('fresh schemas include server metadata without rerunning completed upgrades', async () => {
    const calls = [];
    const store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query(sql, params) {
        calls.push({ sql, params }); return [[]];
    } } });
    await store.ensureSchema();
    assert.match(calls[0].sql, /`server` enum\('gold','silver'\) NOT NULL DEFAULT 'gold'/u);
    assert.ok(calls.every(call => /^\s*CREATE TABLE IF NOT EXISTS/u.test(call.sql)));
});

test('an in-flight shared learning read cannot revive a cache invalidated by an officer decision', async () => {
    let complete;
    const store = new PvpScoutStore({ channelId: 'gold-channel', learningChannelIds: ['gold-channel', 'silver-channel'],
        db: { query: () => new Promise(resolve => { complete = resolve; }) } });
    store.schemaReady = true;
    const pending = store.staffReviewLearning();
    await new Promise(resolve => setImmediate(resolve));
    store.reviewLearningRevision++;
    store.reviewLearningAt = 0;
    complete([[]]);
    await pending;
    assert.equal(store.reviewLearning, null);
    assert.equal(store.reviewLearningAt, 0);
});
