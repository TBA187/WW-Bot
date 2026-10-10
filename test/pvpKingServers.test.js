// Checks that Gold and Silver PvP King commands keep storage, roles and replies separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Collection, ThreadChannel, MessageFlags } = require('discord.js');
const appConfig = require('../config.json');
const PvpKingStorage = require('../commands/pvp-king/utils/pvpKingStorage.js');
const { getPvpServerConfigs } = require('../commands/pvp-king/utils/pvpServers.js');
const { PVP_KING_EVENT } = require('../commands/pvp-king/pvp_event.js');
const { configuredEvent, findEventWinner, loadEventResults, announceEventWinner, utcEventDate } = require('../commands/pvp-king/utils/pvpEvent.js');
const cooldownTask = require('../tasks/cooldownNotifier.js');

const commandNames = fs.readdirSync(path.join(__dirname, '../commands/pvp-king'))
    .filter(file => file.endsWith('.js')).map(file => file.slice(0, -3));

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pvp-servers-'));
    const stores = Object.fromEntries(['gold', 'silver'].map(server => [server, new PvpKingStorage({
        server, storageMode: 'json', dataFile: path.join(dir, `${server}.json`)
    })]));
    const timers = { gold: new Map(), silver: new Map() };
    const roles = new Collection();
    const members = new Collection();
    const sent = new Map();
    const deletedThreads = [];
    const collector = () => new EventEmitter();
    const message = () => ({ url: 'https://discord.com/channels/guild/channel/message',
        createMessageComponentCollector: collector });
    const channel = id => ({ id, messages: { fetch: async () => new Collection() },
        send: async payload => { sent.get(id).push(payload); return message(); } });
    const channels = new Collection();
    for (const id of [appConfig.pvpKingChannelID, appConfig.pvpKingSilverChannelID, 'log']) {
        sent.set(id, []);
        channels.set(id, channel(id));
    }
    for (const id of [appConfig.historyThreadID, appConfig.historySilverThreadID]) {
        const thread = Object.assign(Object.create(ThreadChannel.prototype), {
            id, isThread: () => true,
            send: async payload => { sent.get(id).push(payload); return message(); },
            messages: { fetch: async () => new Collection([['entry', { delete: async () => deletedThreads.push(id) }]]) }
        });
        sent.set(id, []);
        channels.set(id, thread);
    }
    for (const id of [appConfig.pvpKingRoleID, appConfig.pvpKingSilverRoleID, 'warrior', 'officer']) {
        roles.set(id, { id, members: new Collection() });
    }
    for (const [id, name] of [['gold-king', 'Gold Champion'], ['silver-king', 'Silver Champion'],
        ['target', 'New King'], ['challenger', 'Challenger']]) {
        const member = { id, displayName: name, username: name,
            displayAvatarURL: () => 'https://example.com/avatar.png',
            roles: { cache: new Collection() } };
        member.roles.add = async role => {
            const key = typeof role === 'string' ? role : role.id;
            member.roles.cache.set(key, roles.get(key));
            roles.get(key)?.members.set(id, member);
        };
        member.roles.remove = async role => {
            const key = typeof role === 'string' ? role : role.id;
            member.roles.cache.delete(key);
            roles.get(key)?.members.delete(id);
        };
        members.set(id, member);
    }
    for (const [id, roleId] of [['gold-king', appConfig.pvpKingRoleID], ['silver-king', appConfig.pvpKingSilverRoleID]]) {
        roles.get(roleId).members.set(id, members.get(id));
        members.get(id).roles.cache.set(roleId, roles.get(roleId));
    }
    members.get('challenger').roles.cache.set('officer', roles.get('officer'));
    const guild = { channels: { cache: channels, fetch: async id => channels.get(id) },
        roles: { cache: roles }, members: { fetch: async id => id ? members.get(id) : members },
        iconURL: () => 'https://example.com/guild.png' };
    const client = { channels: guild.channels, guilds: { cache: new Map([['guild', guild]]) }, user: { id: 'bot' } };
    const config = { ...appConfig, guildId: 'guild', logChannelID: 'log', officerRoleID: 'officer',
        pvpWarriorRoleID: 'warrior', pvpKingStores: stores, pvpKingStorage: stores.gold,
        pvpChallengeTimeouts: timers, onCooldown: () => false, client };
    function interaction(server, userId = 'challenger') {
        const channelId = server === 'gold' ? config.pvpKingChannelID
            : server === 'silver' ? config.pvpKingSilverChannelID : server;
        const responses = [];
        const collectors = [];
        const replyMessage = { content: '', createMessageComponentCollector() {
            const c = collector(); collectors.push(c); return c;
        } };
        const i = { channelId, guild, channel: channels.get(channelId),
            user: members.get(userId), member: members.get(userId), responses, collectors,
            options: { getUser: () => members.get('target'), getMember: () => members.get('target'), getInteger: () => 10 },
            message: replyMessage,
            deferReply: async () => { i.deferred = true; },
            deferUpdate: async () => { i.deferred = true; },
            reply: async payload => { i.replied = true; responses.push(payload); return replyMessage; },
            editReply: async payload => {
                responses.push(payload);
                if (typeof payload === 'string') replyMessage.content = payload;
                else if (payload.content) replyMessage.content = payload.content;
                return replyMessage;
            },
            followUp: async payload => { responses.push(payload); return message(); },
            update: async payload => { i.replied = true; responses.push(payload); return replyMessage; }
        };
        return i;
    }
    t.after(() => {
        client.cooldownNotifier?.stop();
        for (const map of Object.values(timers)) for (const timer of map.values()) clearTimeout(timer);
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { stores, config, sent, deletedThreads, roles, members, interaction, client };
}

function load(name, config) {
    const Command = require(`../commands/pvp-king/${name}.js`);
    return new Command(config);
}
function body(i) { return JSON.stringify(i.responses); }
async function seed(f) {
    for (const server of ['gold', 'silver']) {
        await f.stores[server].restore();
        await f.stores[server].recordCrownEvent({ newKingId: `${server}-king`,
            newKingName: `${server === 'gold' ? 'Gold' : 'Silver'} Champion`, createdAt: '2026-06-01 00:00:00' });
    }
}

test('all eleven king commands reject other channels before accessing options, roles, or storage', async t => {
    const f = fixture(t);
    assert.equal(commandNames.length, 11);
    for (const name of commandNames) {
        const i = f.interaction('other-channel');
        i.guild = null;
        i.options = null;
        await load(name, f.config).execute(i);
        assert.equal(i.responses.length, 1, name);
        assert.equal(i.responses[0].flags, MessageFlags.Ephemeral, name);
        assert.ok(i.responses[0].content.includes(`<#${f.config.pvpKingChannelID}>`), name);
        assert.ok(i.responses[0].content.includes(`<#${f.config.pvpKingSilverChannelID}>`), name);
        assert.equal(i.deferred, undefined, name);
    }
});

test('stats, current king, history, leaderboard, help, and rules select their channel server', async t => {
    const f = fixture(t);
    await seed(f);
    await f.stores.gold.recordNewKingStats('target', 'Gold-only Target');
    await f.stores.gold.recordDefenseStats('target', 'Gold-only Target');
    await f.stores.silver.recordNewKingStats('target', 'Silver-only Target');
    for (const name of ['pvp_stats', 'pvp_current_king', 'pvp_history', 'pvp_leaderboard', 'pvp_help', 'pvp_rules']) {
        const command = load(name, f.config);
        const gold = f.interaction('gold'), silver = f.interaction('silver');
        await Promise.all([command.execute(gold), command.execute(silver)]);
        const g = body(gold), s = body(silver);
        assert.doesNotMatch(g + s, /Database error|Failed to/u, name);
        if (name === 'pvp_stats') {
            assert.match(g, /Total Wins:.*2/u);
            assert.match(s, /Total Wins:.*1/u);
        } else if (['pvp_current_king', 'pvp_history', 'pvp_leaderboard'].includes(name)) {
            assert.ok(g.includes('gold-king') || g.includes('Gold Champion'), name);
            assert.ok(s.includes('silver-king') || s.includes('Silver Champion'), name);
            assert.ok(!g.includes('silver-king') && !g.includes('Silver Champion'), name);
            assert.ok(!s.includes('gold-king') && !s.includes('Gold Champion'), name);
        } else {
            assert.ok(g.includes(f.config.pvpKingChannelID), name);
            assert.ok(s.includes(f.config.pvpKingSilverChannelID), name);
            assert.ok(!s.includes(f.config.pvpKingChannelID), name);
            if (name === 'pvp_rules') {
                assert.ok(s.includes(f.config.pvpKingSilverRoleID));
                assert.ok(s.includes(f.config.historySilverThreadID));
            }
        }
    }
});

test('same challenger can open both challenges and buttons write only the originating cooldown', async t => {
    const f = fixture(t);
    await seed(f);
    const cooldownKeys = [];
    f.config.onCooldown = (user, key) => { cooldownKeys.push(key); return false; };
    const command = load('pvp_challenge', f.config);
    const gold = f.interaction('gold'), silver = f.interaction('silver');
    await command.execute(gold);
    await command.execute(silver);
    assert.match(body(gold), /gold-king/u);
    assert.match(body(silver), /silver-king/u);
    assert.ok(f.config.pvpChallengeTimeouts.gold.has('challenger'));
    assert.ok(f.config.pvpChallengeTimeouts.silver.has('challenger'));
    assert.deepEqual(cooldownKeys, ['gold:currentking', 'silver:currentking']);
    const yes = f.interaction('silver');
    yes.customId = 'pvp_confirm_yes_silver-king_challenger';
    await command.handleButton(yes);
    assert.ok(f.config.pvpChallengeTimeouts.gold.has('challenger'));
    assert.ok(!f.config.pvpChallengeTimeouts.silver.has('challenger'));
    assert.ok(JSON.stringify(f.sent.get(f.config.pvpKingSilverChannelID)).includes(f.config.pvpKingSilverRoleID));
    assert.equal(f.sent.get(f.config.pvpKingChannelID).length, 0);
    const accept = f.interaction('silver', 'silver-king');
    accept.customId = 'pvp_accept_silver-king_challenger';
    await command.handleButton(accept);
    assert.equal((await f.stores.silver.getCooldown('challenger')).king_id, 'silver-king');
    assert.equal(await f.stores.gold.getCooldown('challenger'), null);
    const wrongChannel = f.interaction('other-channel', 'silver-king');
    wrongChannel.customId = accept.customId;
    assert.equal(await command.handleButton(wrongChannel), true);
    assert.equal(wrongChannel.responses[0].flags, MessageFlags.Ephemeral);
    // A copied Gold button cannot accept a Silver challenge or write a cooldown.
    const wrongKing = f.interaction('silver', 'gold-king');
    wrongKing.customId = 'pvp_accept_gold-king_target';
    await command.handleButton(wrongKing);
    assert.match(body(wrongKing), /King has changed/u);
    assert.equal(await f.stores.silver.getCooldown('target'), null);
});

test('Silver crown and delayed reverse update only Silver role, stats, and history thread', async t => {
    const f = fixture(t);
    await seed(f);
    const goldBefore = f.stores.gold.serializeState();
    await load('pvp_crown', f.config).execute(f.interaction('silver'));
    assert.deepEqual(f.stores.gold.serializeState(), goldBefore);
    assert.equal(f.roles.get(f.config.pvpKingRoleID).members.first().id, 'gold-king');
    assert.equal(f.roles.get(f.config.pvpKingSilverRoleID).members.first().id, 'target');
    assert.equal(f.sent.get(f.config.historyThreadID).length, 0);
    assert.equal(f.sent.get(f.config.historySilverThreadID).length, 1);
    assert.ok(!JSON.stringify([...f.sent.values()]).includes('Event Winner Announcement'));
    const reverse = load('pvp_reverse', f.config);
    const i = f.interaction('silver');
    await reverse.execute(i);
    assert.equal(i.collectors.length, 1);
    // Executing Gold while Silver awaits confirmation must not change its scope.
    await reverse.execute(f.interaction('gold'));
    const confirm = f.interaction('silver');
    confirm.customId = 'confirm_reverse';
    await i.collectors[0].listeners('collect')[0](confirm);
    assert.deepEqual(f.stores.gold.serializeState(), goldBefore);
    assert.equal(f.roles.get(f.config.pvpKingRoleID).members.first().id, 'gold-king');
    assert.equal(f.roles.get(f.config.pvpKingSilverRoleID).members.first().id, 'silver-king');
    assert.deepEqual(f.deletedThreads, [f.config.historySilverThreadID]);
    assert.equal((await f.stores.silver.latestHistory()).king_id, 'silver-king');
});

test('crown starts acknowledgement synchronously and waits for acceptance before fetching members or saving', async t => {
    const f = fixture(t); await seed(f);
    const i = f.interaction('silver');
    let acknowledged = false, accept;
    const gate = new Promise(resolve => { accept = resolve; });
    i.deferReply = () => { acknowledged = true; return gate.then(() => { i.deferred = true; }); };
    const fetch = t.mock.method(i.guild.members, 'fetch');
    const write = t.mock.method(f.stores.silver, 'recordCrownEvent');
    const pending = load('pvp_crown', f.config).execute(i);
    assert.equal(acknowledged, true, 'initial request starts before execute returns its promise');
    assert.equal(fetch.mock.calls.length, 0);
    assert.equal(write.mock.calls.length, 0);
    accept(); await pending;
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(write.mock.calls.length, 1);
    assert.match(body(i), /conquered/u);
});

test('an expired crown acknowledgement leaves both stores, roles, cooldowns and messages untouched', async t => {
    const f = fixture(t); await seed(f);
    const before = Object.fromEntries(Object.entries(f.stores).map(([server, store]) => [server, store.serializeState()]));
    const i = f.interaction('silver');
    i.deferReply = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
    const fetch = t.mock.method(i.guild.members, 'fetch');
    await assert.rejects(load('pvp_crown', f.config).execute(i), error => error.code === 10062);
    assert.equal(fetch.mock.calls.length, 0);
    for (const [server, store] of Object.entries(f.stores)) assert.deepEqual(store.serializeState(), before[server]);
    assert.equal(f.roles.get(f.config.pvpKingSilverRoleID).members.first().id, 'silver-king');
    assert.equal(f.members.get('target').roles.cache.has(f.config.pvpKingSilverRoleID), false);
    assert.deepEqual(i.responses, []);
    assert.ok([...f.sent.values()].every(messages => messages.length === 0));
});

test('unauthorized and incomplete crowns give private responses without deferring or consuming the crown cooldown', async t => {
    const f = fixture(t); await seed(f);
    const cooldown = t.mock.method(f.config, 'onCooldown', () => false);
    const command = load('pvp_crown', f.config);
    const denied = f.interaction('silver', 'target');
    const deniedDefer = t.mock.method(denied, 'deferReply');
    await command.execute(denied);
    assert.equal(deniedDefer.mock.calls.length, 0);
    assert.match(body(denied), /No permission/u);
    assert.equal(denied.responses[0].flags, MessageFlags.Ephemeral);
    const missing = f.interaction('silver');
    missing.options.getMember = () => null;
    await command.execute(missing);
    assert.match(body(missing), /User not found/u);
    assert.equal(missing.deferred, undefined);
    assert.equal(missing.responses[0].flags, MessageFlags.Ephemeral);
    assert.equal(cooldown.mock.calls.length, 0);
});

test('a crown storage failure reports uncertainty without changing roles or publishing a victory', async t => {
    const f = fixture(t); await seed(f);
    const before = f.stores.silver.serializeState();
    t.mock.method(f.stores.silver, 'recordCrownEvent', async () => {
        throw Object.assign(new Error('private-database-details'), { code: 'PVP_DATABASE_UNAVAILABLE' });
    });
    const errors = t.mock.method(console, 'error', () => {});
    const i = f.interaction('silver'); await load('pvp_crown', f.config).execute(i);
    assert.deepEqual(f.stores.silver.serializeState(), before);
    assert.equal(f.roles.get(f.config.pvpKingSilverRoleID).members.first().id, 'silver-king');
    assert.match(body(i), /Could not confirm.*saved/u);
    assert.match(body(i), /Check.*pvp_history.*before retrying/u);
    assert.doesNotMatch(body(i), /conquered|No PvP King changes were applied/u);
    assert.ok([...f.sent.values()].every(messages => messages.length === 0));
    assert.ok(!JSON.stringify(errors.mock.calls).includes('private-database-details'));
});

test('a failed public crown response still saves the result and publishes event, audit and history entries', async t => {
    const f = fixture(t); await seed(f);
    const e = eventFixture(f, 'gold', { targetStreak: 1 });
    const i = e.interaction(), edit = i.editReply;
    i.editReply = async payload => {
        if (payload.embeds) throw Object.assign(new Error('Discord unavailable'), { code: 50027 });
        return edit(payload);
    };
    const warnings = t.mock.method(console, 'warn', () => {});
    await load('pvp_crown', f.config).execute(i);
    assert.equal((await f.stores.gold.latestHistory()).king_id, 'target');
    assert.equal((await f.stores.gold.latestHistory()).total_wins_after, 1);
    assert.equal(e.messages.length, 1, 'event winner check still runs');
    assert.equal(f.sent.get('log').length, 1);
    assert.equal(f.sent.get(f.config.historyThreadID).length, 1);
    assert.match(body(i), /result is saved/u);
    assert.match(body(i), /Do not run.*pvp_crown.*again/u);
    assert.doesNotMatch(body(i), /No PvP King changes were applied/u);
    assert.equal(warnings.mock.calls.length, 1);
});

test('a failed crown audit log cannot prevent the history entry or invite a duplicate crown', async t => {
    const f = fixture(t); await seed(f);
    f.client.channels.cache.get('log').send = async () => { throw Object.assign(new Error('Missing permissions'), { code: 50013 }); };
    t.mock.method(console, 'warn', () => {});
    const i = f.interaction('silver'); await load('pvp_crown', f.config).execute(i);
    assert.equal((await f.stores.silver.latestHistory()).total_wins_after, 1);
    assert.equal(f.sent.get(f.config.historySilverThreadID).length, 1);
    assert.match(body(i), /crown audit log/u);
    assert.match(body(i), /Do not run.*pvp_crown.*again/u);
});

test('failure to assign a new King preserves the old King role and reports that the result needs Discord repair', async t => {
    const f = fixture(t); await seed(f);
    const target = f.members.get('target'), add = target.roles.add;
    target.roles.add = async roleId => {
        if (roleId === f.config.pvpKingSilverRoleID) throw Object.assign(new Error('Missing permissions'), { code: 50013 });
        return add(roleId);
    };
    t.mock.method(console, 'warn', () => {});
    const i = f.interaction('silver'); await load('pvp_crown', f.config).execute(i);
    assert.equal(f.roles.get(f.config.pvpKingSilverRoleID).members.first().id, 'silver-king');
    assert.equal(target.roles.cache.has(f.config.pvpKingSilverRoleID), false);
    assert.equal((await f.stores.silver.latestHistory()).king_id, 'target');
    assert.equal(f.sent.get(f.config.historySilverThreadID).length, 1);
    assert.match(body(i), /King role updates/u);
    assert.match(body(i), /Officers should check the King roles/u);
    assert.match(body(i), /Do not run.*pvp_crown.*again/u);
});

test('a missing history thread reports a saved result that needs repair instead of silently succeeding', async t => {
    const f = fixture(t); await seed(f);
    f.client.channels.cache.delete(f.config.historySilverThreadID);
    t.mock.method(console, 'warn', () => {});
    const i = f.interaction('silver'); await load('pvp_crown', f.config).execute(i);
    assert.equal((await f.stores.silver.latestHistory()).king_id, 'target');
    assert.match(body(i), /history thread entry/u);
    assert.match(body(i), /result is saved/u);
});

test('cooldown notification toggles and expiry pings stay in their own server', async t => {
    const f = fixture(t);
    await seed(f);
    const command = load('pvp_cooldown', f.config);
    const gold = f.interaction('gold'), silver = f.interaction('silver');
    await command.execute(gold);
    await command.execute(silver);
    await silver.collectors[0].listeners('collect')[0](f.interaction('silver'));
    assert.equal((await f.stores.silver.getCooldown('challenger')).notify_on_expire, 1);
    assert.equal(await f.stores.gold.getCooldown('challenger'), null);
    const old = new Date(Date.now() - 48 * 3600000 - 1000).toISOString().slice(0, 19).replace('T', ' ');
    for (const server of ['gold', 'silver']) {
        await f.stores[server].upsertChallengeCooldown('challenger', 'Challenger', `${server}-king`, 'King');
        await f.stores[server].setCooldownNotification('challenger', true);
        f.stores[server].state.cooldowns.get('challenger').last_challenge = old;
    }
    cooldownTask.execute(f.client, f.config);
    for (let n = 0; n < 25 && !(f.sent.get(f.config.pvpKingChannelID).length && f.sent.get(f.config.pvpKingSilverChannelID).length); n++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    f.client.cooldownNotifier.stop();
    const g = JSON.stringify(f.sent.get(f.config.pvpKingChannelID));
    const s = JSON.stringify(f.sent.get(f.config.pvpKingSilverChannelID));
    assert.match(g, /gold-king/u);
    assert.doesNotMatch(g, /silver-king/u);
    assert.match(s, /silver-king/u);
    assert.doesNotMatch(s, /gold-king/u);
});

test('finished event shows Vangogsan, eight wins, 23 capsules, and excludes later wins in both stores', async t => {
    const f = fixture(t);
    await seed(f);
    for (let win = 0; win < 8; win++) {
        await f.stores.gold.recordCrownEvent({ newKingId: PVP_KING_EVENT.winnerId,
            newKingName: 'Vangogsan', isDefense: win > 0, createdAt: PVP_KING_EVENT.endDate });
    }
    await f.stores.gold.recordCrownEvent({ newKingId: 'after-event', newKingName: 'After Event', createdAt: '2026-07-11 00:00:00' });
    await f.stores.silver.recordCrownEvent({ newKingId: 'silver-after-event', newKingName: 'Silver After Event', createdAt: '2026-07-11 00:00:00' });
    const command = load('pvp_event', f.config);
    const gold = f.interaction('gold'), silver = f.interaction('silver');
    await command.execute(gold);
    await command.execute(silver);
    for (const i of [gold, silver]) {
        const text = body(i);
        assert.match(text, /Finished/u);
        assert.match(text, /8 wins in a row/u);
        assert.match(text, /23 Coin Capsules/u);
        assert.ok(text.includes(PVP_KING_EVENT.winnerId));
        assert.doesNotMatch(text, /After Event|race is on|10 wins|has started/u);
    }
    assert.match(body(gold), /8\/8/u);
    assert.match(body(gold), /Gold Champion/u);
    assert.doesNotMatch(body(silver), /Gold Champion/u);
    assert.match(body(silver), /Silver Champion/u);
});

test('server configuration cannot silently share a store, role, channel, or thread', t => {
    const f = fixture(t);
    assert.throws(() => getPvpServerConfigs({ ...f.config, pvpKingStores: { gold: f.stores.gold } }), /not configured/u);
    assert.throws(() => getPvpServerConfigs({ ...f.config, pvpKingStores: { gold: f.stores.gold, silver: f.stores.gold } }), /stores must be separate/u);
    for (const [silver, gold] of [['pvpKingSilverChannelID', 'pvpKingChannelID'],
        ['pvpKingSilverRoleID', 'pvpKingRoleID'], ['historySilverThreadID', 'historyThreadID']]) {
        assert.throws(() => getPvpServerConfigs({ ...f.config, [silver]: f.config[gold] }), /must be separate/u);
    }
});


test('JSON restarts retain independent records for the same Discord user on both servers', async t => {
    const f = fixture(t);
    await seed(f);
    await f.stores.gold.recordNewKingStats('target', 'Gold Target');
    await f.stores.gold.recordDefenseStats('target', 'Gold Target');
    await f.stores.silver.recordNewKingStats('target', 'Silver Target');
    await f.stores.gold.createNotificationCooldown('target', 'Gold Target', true);
    await f.stores.silver.createNotificationCooldown('target', 'Silver Target', false);
    for (const server of ['gold', 'silver']) {
        const restored = new PvpKingStorage({ server, storageMode: 'json', dataFile: f.stores[server].dataFile });
        await restored.restore();
        assert.deepEqual(restored.serializeState(), f.stores[server].serializeState());
        assert.equal((await restored.getStats('target')).total_wins, server === 'gold' ? 2 : 1);
        assert.equal((await restored.getCooldown('target')).notify_on_expire, server === 'gold' ? 1 : 0);
    }
});


function eventFixture(f, server, overrides = {}) {
    const event = { enabled: true, id: 'winter-2026', name: 'Winter PvP King Challenge',
        startDate: '2026-09-01T00:00:00Z', endDate: null, targetStreak: 3, rewardCoinCapsules: 7,
        announcementChannelID: '1180559473501290688', ...overrides };
    f.config.pvpKingEvents = { ...f.config.pvpKingEvents, [server]: event };
    const messages = [];
    const channel = { id: event.announcementChannelID, messages: {
        fetch: async ({ before }) => new Collection(messages.slice().reverse()
            .filter(message => !before || BigInt(message.id) < BigInt(before)).slice(0,100)
            .map(message => [message.id, message]))
    }, send: async payload => {
        const message = { id: String(1800000000000000000n + BigInt(messages.length)),
            author: { id: 'bot' }, createdTimestamp: Date.now(),
            embeds: payload.embeds.map(embed => embed.toJSON()), payload };
        messages.push(message);
        return message;
    } };
    f.interaction(server).guild.channels.cache.set(channel.id, channel);
    return { event, channel, messages, config: () => getPvpServerConfigs(f.config).find(c => c.pvpServer === server),
        interaction: () => ({ ...f.interaction(server), client: f.client }) };
}

async function eventWins(f, server, userId, times) {
    for (let win = 0; win < times.length; win++) await f.stores[server].recordCrownEvent({
        newKingId: userId, newKingName: f.members.get(userId)?.displayName || userId,
        createdAt: times[win], isDefense: win > 0
    });
}

test('future event configuration is opt-in, server-specific and validates UTC dates and requirements', () => {
    assert.equal(configuredEvent({}), null);
    assert.equal(configuredEvent({ pvpKingEvents: { gold: { enabled: false } } }), null);
    const base = { enabled: true, id: 'test-event', name: 'Test Event', startDate: '2026-11-01T00:00:00Z',
        targetStreak: 4, rewardCoinCapsules: 12, announcementChannelID: '1180559473501290688' };
    const config = { pvpServer: 'silver', pvpKingEvents: { silver: base } };
    assert.equal(configuredEvent({ ...config, pvpServer: 'gold' }), null);
    assert.equal(configuredEvent(config).startDate, '2026-11-01 00:00:00');
    for (const patch of [{ startDate: '2026-11-01T00:00:00+02:00' }, { startDate: '2026-02-30T00:00:00Z' },
        { endDate: '2026-10-01T00:00:00Z' }, { targetStreak: 0 }, { targetStreak: 2.5 },
        { rewardCoinCapsules: -1 }, { id: 'spaces invalid' }, { name: '' }, { announcementChannelID: 'wrong' }]) {
        assert.throws(() => configuredEvent({ ...config, pvpKingEvents: { silver: { ...base, ...patch } } }));
    }
    assert.equal(utcEventDate('2026-11-01 00:00:00').toISOString(), '2026-11-01T00:00:00.000Z');
    assert.throws(() => utcEventDate(new Date('invalid')));
});

test('event streaks reset when another player wins and the first qualifying streak stays the winner', () => {
    const event = { startDate: '2026-09-01 00:00:00', endDate: '2026-09-02 00:00:00', targetStreak: 3 };
    const rows = ['first','first','rival','first','first','first','rival','rival','rival'].map((id, index) => ({
        king_id: id, king_name: id, created_at: '2026-09-01 00:00:0' + index
    }));
    const winner = findEventWinner(rows, event);
    assert.equal(winner.winnerId, 'first');
    assert.equal(winner.endDate, '2026-09-01 00:00:05');
    assert.equal(winner.wins.length, 3);
    assert.equal(findEventWinner(rows.slice(0,5), event), null);
    assert.equal(findEventWinner(rows, { ...event, endDate: '2026-09-01 00:00:04' }), null);
    assert.equal(findEventWinner(rows, { ...event, targetStreak: 1 }).endDate, event.startDate);
});

test('event history includes the UTC start and stops at the winning row, even with equal timestamps', async t => {
    const f=fixture(t); await seed(f);
    const e=eventFixture(f,'gold',{ targetStreak: 2 });
    await eventWins(f,'gold','target',[e.event.startDate,'2026-09-01 00:00:00','2026-09-01 00:00:00']);
    const results=await loadEventResults(f.stores.gold,configuredEvent(e.config()),new Date('2026-09-02T00:00:00Z'));
    assert.equal(results.history.length,2);
    assert.equal(results.winner.winnerId,'target');
    assert.deepEqual(results.history.map(r=>r.id),[2,3]);
    // Keep the completed historical event's original strict-start behavior.
    assert.equal((await f.stores.gold.eventHistorySince('2026-09-01 00:00:00')).length,0);
});

test('each server gets its own configured winner and announcement, with its own requirement and reward', async t => {
    const f=fixture(t); await seed(f);
    const gold=eventFixture(f,'gold',{ targetStreak: 2 });
    const silver=eventFixture(f,'silver',{ targetStreak: 1, rewardCoinCapsules: 11, announcementChannelID: '1180559473501290689' });
    await eventWins(f,'gold','gold-king',['2026-09-02 00:00:00','2026-09-02 00:00:01']);
    await eventWins(f,'silver','silver-king',['2026-09-02 00:00:00']);
    for (const e of [gold,silver]) await announceEventWinner(e.config(),e.interaction(),null);
    assert.equal(gold.messages.length,1); assert.equal(silver.messages.length,1);
    assert.match(JSON.stringify(gold.messages[0].payload),/gold-king|2 wins in a row|7 Coin Capsules/u);
    assert.doesNotMatch(JSON.stringify(gold.messages[0].payload),/silver-king/u);
    assert.match(JSON.stringify(silver.messages[0].payload),/silver-king/u);
    assert.match(silver.messages[0].embeds[0].description,/1 wins in a row|11 Coin Capsules/u);
    assert.equal(gold.messages[0].payload.enforceNonce,true);
    assert.ok(gold.messages[0].payload.nonce.length<=25);
    assert.notEqual(gold.messages[0].payload.nonce,silver.messages[0].payload.nonce);
    assert.deepEqual(gold.messages[0].payload.allowedMentions.parse,[]);
});

test('simultaneous announcements and later crowns cannot repeat a winner announcement', async t => {
    const f=fixture(t); await seed(f); const e=eventFixture(f,'gold');
    await eventWins(f,'gold','target',['2026-09-02 00:00:00','2026-09-02 00:00:01','2026-09-02 00:00:02']);
    await Promise.all(Array.from({length:5},()=>announceEventWinner(e.config(),e.interaction(),null)));
    assert.equal(e.messages.length,1);
    await eventWins(f,'gold','gold-king',['2026-09-03 00:00:00','2026-09-03 00:00:01','2026-09-03 00:00:02']);
    await announceEventWinner(e.config(),e.interaction(),null);
    assert.equal(e.messages.length,1);
    assert.match(e.messages[0].payload.content,/target/u);
});

test('a restart finds the announcement beyond the newest 100 messages and ignores other authors', async t => {
    const f=fixture(t); await seed(f); const e=eventFixture(f,'gold');
    await eventWins(f,'gold','target',['2026-09-02 00:00:00','2026-09-02 00:00:01','2026-09-02 00:00:02']);
    await announceEventWinner(e.config(),e.interaction(),null);
    for(let i=0;i<105;i++) e.messages.push({ id: String(1800000000000000000n + BigInt(e.messages.length)),
        author:{id:'someone'}, createdTimestamp:Date.now(), embeds:[] });
    const restart={ ...e.interaction(), guild:{ ...e.interaction().guild } };
    await announceEventWinner(e.config(),restart,null);
    assert.equal(e.messages.length,106);
    const spoofed=eventFixture(f,'silver',{ targetStreak:1 });
    await eventWins(f,'silver','silver-king',['2026-09-02 00:00:00']);
    spoofed.messages.push({id:'1800000000000000000',author:{id:'someone'},createdTimestamp:Date.now(),
        embeds:[{footer:{text:'WW PvP Event • Silver • Event ID: winter-2026'}}]});
    await announceEventWinner(spoofed.config(),spoofed.interaction(),null);
    assert.equal(spoofed.messages.length,2);
});

test('failed winner sends can be retried with the same nonce and missing permissions prevent a send', async t => {
    const f=fixture(t); await seed(f); const e=eventFixture(f,'gold',{targetStreak:1,mentionEveryone:true});
    await eventWins(f,'gold','target',['2026-09-02 00:00:00']);
    const original=e.channel.send; let failedPayload;
    e.channel.send=async payload=>{failedPayload=payload;throw Error('Discord unavailable');};
    await assert.rejects(announceEventWinner(e.config(),e.interaction(),null),/Discord unavailable/u);
    e.channel.send=original;
    await announceEventWinner(e.config(),e.interaction(),null);
    assert.equal(e.messages.length,1);
    assert.equal(e.messages[0].payload.nonce,failedPayload.nonce);
    assert.deepEqual(e.messages[0].payload.allowedMentions.parse,['everyone']);
    const blocked=eventFixture(f,'silver',{targetStreak:1});
    await eventWins(f,'silver','silver-king',['2026-09-02 00:00:00']);
    blocked.channel.permissionsFor=()=>({has:()=>false});
    await assert.rejects(announceEventWinner(blocked.config(),blocked.interaction(),null),/Read Message History/u);
    assert.equal(blocked.messages.length,0);
});

test('a failed event announcement does not undo a crown or report it as a failed crown', async t => {
    const f=fixture(t); await seed(f); const e=eventFixture(f,'gold',{targetStreak:1});
    e.channel.send=async()=>{throw Error('Discord unavailable');};
    const warnings=t.mock.method(console,'warn',()=>{});
    const i=e.interaction(); await load('pvp_crown',f.config).execute(i);
    assert.equal((await f.stores.gold.latestHistory()).king_id,'target');
    assert.equal(f.roles.get(f.config.pvpKingRoleID).members.first().id,'target');
    assert.match(body(i),/conquered/u);
    assert.doesNotMatch(body(i),/No PvP King changes were applied/u);
    assert.equal(warnings.mock.calls.length,1);
    assert.match(warnings.mock.calls[0].arguments[0],/crown is saved/u);
});

test('future event progress and results replace the historical panel only for the configured server', async t => {
    const f=fixture(t); await seed(f); eventFixture(f,'gold',{targetStreak:2});
    await eventWins(f,'gold','target',['2026-09-02 00:00:00']);
    const command=load('pvp_event',f.config); const progress=f.interaction('gold');
    await command.execute(progress);
    assert.match(body(progress),/Winter PvP King Challenge.*In progress/u);
    assert.doesNotMatch(body(progress),/Vangogsan/u);
    await eventWins(f,'gold','target',['2026-09-02 00:00:01']);
    await eventWins(f,'gold','gold-king',['2026-09-03 00:00:00']);
    const finished=f.interaction('gold'); await command.execute(finished);
    assert.match(body(finished),/Finished/u);
    assert.match(body(finished),/Event Winner: <@target>/u);
    assert.doesNotMatch(body(finished),/Gold Champion/u);
    const silver=f.interaction('silver'); await command.execute(silver);
    assert.match(body(silver),/Vangogsan/u);
    assert.doesNotMatch(body(silver),/Winter PvP King Challenge/u);
});

test('disabled, future, and expired events without a winner do not send announcements', async t => {
    const f=fixture(t); await seed(f);
    for (const overrides of [{enabled:false},{startDate:'2099-01-01T00:00:00Z'},
        {endDate:'2026-09-02T00:00:00Z'}]) {
        const e=eventFixture(f,'gold',overrides);
        await eventWins(f,'gold','target',['2026-09-03 00:00:00']);
        await announceEventWinner(e.config(),e.interaction(),null);
        assert.equal(e.messages.length,0);
    }
});
