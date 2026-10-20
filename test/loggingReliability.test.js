const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogEvent, Collection } = require('discord.js');

const { buildLogEmbed } = require('../utils/logHelpers.js');
const {
    normalizeForumLayout,
    normalizeForumSortOrder
} = require('../events/channelLogs.js');
const { findModerationAuditEntry } = require('../events/memberExit.js');
const memberExit = require('../events/memberExit.js');
const channelLogs = require('../events/channelLogs.js');

function channelUpdateFixture(t, { sendError, fetchAuditLogs } = {}) {
    const callbacks = [], sent = [], errors = [];
    const controller = new AbortController();
    t.mock.method(global, 'setTimeout', callback => {
        callbacks.push(callback);
        return { unref() {} };
    });
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const logChannel = { send: async payload => {
        if (sendError) throw sendError;
        sent.push(payload);
    } };
    const guild = {
        id: 'guild-channel-update',
        channels: { cache: new Collection([['log-channel', logChannel]]) },
        fetchAuditLogs: fetchAuditLogs || (async () => ({ entries: new Collection([['entry', {
            targetId: 'changed-channel', action: AuditLogEvent.ChannelUpdate,
            createdTimestamp: Date.now(), executor: null
        }]]) }))
    };
    const oldChannel = {
        id: 'changed-channel', name: 'before', type: 0, guild,
        permissionOverwrites: { cache: new Collection() }
    };
    const newChannel = { ...oldChannel, name: 'after' };
    guild.channels.cache.set(newChannel.id, newChannel);
    const config = { logChannelID: 'log-channel', shutdownSignal: controller.signal };
    return { callbacks, sent, errors, controller, oldChannel, newChannel, config };
}

test('channel updates still log when the audit executor is unavailable', async t => {
    const f = channelUpdateFixture(t);
    await channelLogs.handleChannelUpdate(f.oldChannel, f.newChannel, f.config);
    const batch = f.callbacks.shift()();
    f.callbacks.shift()();
    await batch;
    assert.equal(f.errors.length, 0);
    assert.equal(f.sent.length, 1);
    const fields = f.sent[0].embeds[0].toJSON().fields;
    assert.match(fields.find(field => field.name === 'Updated By').value, /Unknown User/);
});

test('delayed channel log delivery failures are handled by the timer callback', async t => {
    const sendError = new Error('Missing channel permissions');
    const f = channelUpdateFixture(t, { sendError });
    await channelLogs.handleChannelUpdate(f.oldChannel, f.newChannel, f.config);
    const batch = f.callbacks.shift()();
    f.callbacks.shift()();
    await batch;
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0][1], sendError);
});

test('queued channel updates do not start audit lookups after shutdown', async t => {
    let lookups = 0;
    const f = channelUpdateFixture(t, { fetchAuditLogs: async () => {
        lookups += 1;
        return { entries: new Collection() };
    } });
    await channelLogs.handleChannelUpdate(f.oldChannel, f.newChannel, f.config);
    f.controller.abort();
    await f.callbacks.shift()();
    assert.equal(lookups, 0);
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.sent.length, 0);
});

test('a channel audit lookup finishing during shutdown does not send a log', async t => {
    let resolveLookup;
    const lookup = new Promise(resolve => { resolveLookup = resolve; });
    const f = channelUpdateFixture(t, { fetchAuditLogs: () => lookup });
    await channelLogs.handleChannelUpdate(f.oldChannel, f.newChannel, f.config);
    const batch = f.callbacks.shift()();
    f.callbacks.shift()();
    await Promise.resolve();
    f.controller.abort();
    resolveLookup({ entries: new Collection() });
    await batch;
    assert.equal(f.sent.length, 0);
    assert.equal(f.errors.length, 0);
});

test('buildLogEmbed ignores malformed fields instead of passing strings to Discord', () => {
    const payload = buildLogEmbed('Thread Updated', null, 'thread-1', 0xFFA500, 'Thread', [
        'Thread',
        null,
        { name: 'Name', value: 'A forum post', inline: true }
    ]);

    assert.doesNotThrow(() => payload.embeds[0].toJSON());
    assert.deepEqual(payload.embeds[0].data.fields, [
        { name: 'Name', value: 'A forum post', inline: true }
    ]);
});

test('equivalent Discord forum defaults do not look like setting changes', () => {
    assert.equal(normalizeForumLayout(null), normalizeForumLayout(0));
    assert.equal(normalizeForumLayout(undefined), normalizeForumLayout(0));
    assert.notEqual(normalizeForumLayout(1), normalizeForumLayout(2));

    assert.equal(normalizeForumSortOrder(null), normalizeForumSortOrder(0));
    assert.equal(normalizeForumSortOrder(undefined), normalizeForumSortOrder(0));
    assert.notEqual(normalizeForumSortOrder(0), normalizeForumSortOrder(1));
});

test('mass moderation lookups share a 100-entry audit batch and find early entries', async () => {
    let fetchCount = 0;
    const entries = new Collection();
    for (let index = 1; index <= 7; index++) {
        entries.set(`entry-${index}`, {
            targetId: `member-${index}`,
            createdTimestamp: Date.now() - 100
        });
    }
    const guild = {
        id: 'guild-moderation-test',
        fetchAuditLogs: async options => {
            fetchCount += 1;
            assert.deepEqual(options, { limit: 100, type: AuditLogEvent.MemberBanAdd });
            return { entries };
        }
    };

    const [first, seventh] = await Promise.all([
        findModerationAuditEntry(guild, AuditLogEvent.MemberBanAdd, 'member-1', { attempts: 1 }),
        findModerationAuditEntry(guild, AuditLogEvent.MemberBanAdd, 'member-7', { attempts: 1 })
    ]);

    assert.equal(first.targetId, 'member-1');
    assert.equal(seventh.targetId, 'member-7');
    assert.equal(fetchCount, 1);
});

test('a failed older audit fetch cannot evict a newer shared request', async t => {
    let now = Date.now(), rejectOlder, resolveNewer, calls = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'warn', () => {});
    const older = new Promise((_, reject) => { rejectOlder = reject; });
    const newer = new Promise(resolve => { resolveNewer = resolve; });
    const guild = { id: 'audit-cache-replacement', fetchAuditLogs: () => ++calls === 1 ? older : newer };
    const options = { attempts: 1 };
    const first = findModerationAuditEntry(guild, AuditLogEvent.MemberKick, 'member', options);
    now += 1000;
    const second = findModerationAuditEntry(guild, AuditLogEvent.MemberKick, 'member', options);
    rejectOlder(new Error('Old request failed'));
    assert.equal(await first, null);
    const third = findModerationAuditEntry(guild, AuditLogEvent.MemberKick, 'member', options);
    const entry = { id: 'kick', targetId: 'member', createdTimestamp: now };
    resolveNewer({ entries: new Collection([[entry.id, entry]]) });
    assert.deepEqual(await Promise.all([second, third]), [entry, entry]);
    assert.equal(calls, 2);
});

test('a ban event that arrives first produces one ban log and no leave log', async () => {
    const sent = [];
    const user = { id: 'member-ban-order-test', tag: 'Member#1234', globalName: 'Member' };
    const auditEntries = new Collection([[
        'ban-entry',
        {
            targetId: user.id,
            createdTimestamp: Date.now(),
            executor: { id: 'moderator-1' },
            reason: 'Test ban'
        }
    ]]);
    const channel = {
        isTextBased: () => true,
        send: async content => sent.push(content)
    };
    const guild = {
        id: 'guild-ban-order-test',
        memberCount: 99,
        channels: { cache: new Collection([['log-channel', channel]]) },
        fetchAuditLogs: async () => ({ entries: auditEntries })
    };
    const ban = { guild, user };
    const member = {
        id: user.id,
        guild,
        user,
        displayName: 'Server Member'
    };

    const banPromise = memberExit.handleGuildBanAdd(ban, 'log-channel');
    await memberExit.handleMemberRemove(member, 'log-channel');
    await banPromise;

    assert.equal(sent.length, 1);
    const embed = sent[0].embeds[0].toJSON();
    assert.equal(embed.author.name, 'Member Banned 🔨');
    assert.match(embed.description, /was banned by/);
    assert.doesNotMatch(embed.description, /voluntarily left/);
});
