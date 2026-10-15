'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { AuditLogEvent, Collection, Events } = require('discord.js');

function fixture() {
    const filename = path.resolve(__dirname, '../events/memberExit.js');
    let now = Date.now(), entry = null, unavailable = false, fetches = 0;
    const timers = new Map(), sent = [], controller = new AbortController();
    class Clock extends Date { static now() { return now; } }
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module: loaded, require: createRequire(filename), Date: Clock,
        console: { warn() {}, error: error => { throw error; } },
        setTimeout(callback, delay) {
            const timer = { unref() {} };
            if (callback.name === 'checkExpiry' || delay >= 10000) timers.set(timer, { callback, at: now + delay });
            else queueMicrotask(callback);
            return timer;
        }, clearTimeout: timer => timers.delete(timer)
    }, { filename });
    const channel = { isTextBased: () => true, send: async payload => { sent.push(payload.embeds[0].toJSON()); } };
    const guild = { id: 'guild', channels: { cache: new Collection([['log', channel]]) },
        fetchAuditLogs: async ({ type }) => {
            assert.equal(type, AuditLogEvent.MemberUpdate);
            if (unavailable) throw new Error('Missing ViewAuditLog');
            return { entries: new Collection(entry ? [[entry.id, entry]] : []) };
        } };
    const member = { id: '296447098298171393', guild, nickname: 'Kaasfondue',
        user: { username: 'kaasfondue', globalName: 'Kaasfondue' }, communicationDisabledUntilTimestamp: null };
    guild.members = { list: async () => new Collection([[member.id, member]]), fetch: async () => { fetches++; return member; } };
    const client = new EventEmitter(); client.guilds = { cache: new Collection([[guild.id, guild]]) };
    loaded.exports.initializeTimeoutTracking(client, { logChannelID: 'log', shutdownSignal: controller.signal });
    return { handlers: loaded.exports, member, sent, client, controller, timers, now: () => now, fetches: () => fetches,
        setUnavailable: () => { unavailable = true; },
        async change(oldExpiry, newExpiry, { audited = true, reason = 'Moderation reason' } = {}) {
            entry = audited ? { id: String(now), targetId: member.id, createdTimestamp: now, reason,
                executor: { id: '632207715229368349', username: 'vangogsan' },
                changes: [{ key: 'communication_disabled_until', old: oldExpiry, new: newExpiry }] } : null;
            const before = { ...member, communicationDisabledUntilTimestamp: oldExpiry };
            member.communicationDisabledUntilTimestamp = newExpiry;
            await loaded.exports.handleGuildMemberUpdate(before, member, 'log');
        },
        async advance(ms) {
            now += ms;
            for (const [timer, item] of [...timers]) if (item.at <= now && timers.delete(timer)) await item.callback();
        }
    };
}

test('timeout application, extensions, shortening and removal use matching audits and correct timing', async t => {
    const f = fixture(); t.after(() => f.controller.abort());
    const first = f.now() + 60000, extended = first + 60000, shortened = first - 10000;
    await f.change(null, first); await f.advance(1000);
    await f.change(first, extended); await f.advance(1000);
    await f.change(extended, shortened); await f.advance(1000);
    await f.change(shortened, null, { reason: null });
    assert.deepEqual(f.sent.map(value => value.author.name), [
        'Member Timeout ⏱️', 'Member Timeout Updated ⏱️', 'Member Timeout Updated ⏱️', 'Member Timeout Removed ⏱️❌'
    ]);
    assert.match(f.sent[1].description, /Previous Timeout Expiry:/);
    assert.match(f.sent[3].description, /No reason provided!\*\n- \*\*Timeout Ended:/);
    for (const embed of f.sent) {
        assert.ok(embed.description.includes('<@632207715229368349>'));
        assert.equal(embed.footer.text, 'User ID: 296447098298171393');
        assert.doesNotMatch(embed.description, /Discord Member Count|User Details/);
    }
    await f.advance(200000);
    assert.equal(f.sent.length, 4, 'cancelled countdowns must not announce expiry');
});

test('countdown expiry and a matching gateway timestamp clear produce one automatic expiry', async t => {
    const f = fixture(); t.after(() => f.controller.abort());
    const expiry = f.now() + 10000;
    await f.change(null, expiry); await f.advance(11500);
    await f.change(expiry, null, { audited: false });
    assert.equal(f.sent.filter(value => value.author.name === 'Member Timeout Expired ⌛').length, 1);
    assert.doesNotMatch(f.sent.at(-1).description, /Unknown Moderator|Reason:/);
});

test('a cleared timeout with unavailable audits does not invent automatic expiry', async t => {
    const f = fixture(); t.after(() => f.controller.abort());
    const expiry = f.now() - 1000;
    f.setUnavailable(); await f.change(expiry, null, { audited: false });
    assert.equal(f.sent.length, 0);
});

test('startup restores countdowns and shutdown prevents their callbacks from fetching or sending', async () => {
    const f = fixture(); f.member.communicationDisabledUntilTimestamp = f.now() + 10000;
    await f.client.listeners(Events.ClientReady)[0]();
    assert.equal([...f.timers.values()].filter(timer => timer.callback.name === 'checkExpiry').length, 1);
    f.controller.abort(); await f.advance(20000);
    assert.equal(f.fetches(), 0); assert.equal(f.sent.length, 0);
});
