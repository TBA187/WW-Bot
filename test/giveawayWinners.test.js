'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const giveaways = require('../events/giveaways');
const Giveaways = require('../commands/giveaways');

const copy = value => structuredClone(value);
const winnerIds = count => Array.from({ length: count }, (_, index) => String(10000000000000000000n + BigInt(index)));
const controls = payload => (payload.components || []).flatMap(row => row.toJSON().components);
const mentions = payload => [...payload.embeds[0].toJSON().description.matchAll(/<@(\d+)>/g)].map(match => match[1]);

function fixture({ count = 100, entries = count } = {}) {
    const initial = {
        giveaway_id: giveaways.makeGiveawayId(), guild_id: '100000000000000000', channel_id: '200000000000000000',
        message_id: null, status: 'active', winners_total: count, prize: 'P'.repeat(512),
        host_text: 'H'.repeat(256), winner_user_ids: [],
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        ends_at: new Date(Date.now() - 60000).toISOString()
    };
    let current = copy(initial);
    const draws = [];
    const participants = winnerIds(entries).map(user_id => ({ user_id, joined_at: initial.starts_at, left_at: null }));
    const store = {
        async getGiveaway(id) { assert.equal(id, initial.giveaway_id); return copy(current); },
        async listEntries() { return copy(participants); },
        async listDraws() { return copy(draws); },
        async saveDraw(id, draw) { assert.equal(id, draw.draw_id); draws.push(copy(draw)); return copy(draw); },
        async updateGiveaway(id, changes) { assert.equal(id, initial.giveaway_id); current = { ...current, ...changes }; return copy(current); }
    };
    const sent = [];
    const channel = { messages: { fetch: async () => null }, async send(payload) {
        sent.push(payload);
        return { id: `announcement-${sent.length}` };
    } };
    const client = { channels: { cache: { get: () => channel }, fetch: async () => channel } };
    return { initial, store, draws, sent, client, channel, participants,
        end: options => giveaways.endGiveaway(client, { giveawayStore: store }, initial, { drawType: 'end', ...options }) };
}

function click(customId, options = {}) {
    const replies = [], edits = [], updates = [], order = [];
    const interaction = {
        customId, user: { id: 'viewer' }, guildId: '100000000000000000',
        async deferReply(payload) { order.push('defer'); replies.push(payload); },
        async editReply(payload) { order.push('edit'); edits.push(payload); },
        async reply(payload) { replies.push(payload); },
        async update(payload) { updates.push(payload); },
        ...options
    };
    return { interaction, replies, edits, updates, order };
}

function assertPayloadLimits(payload) {
    assert.ok((payload.content || '').length <= 2000);
    for (const embed of payload.embeds || []) {
        const json = embed.toJSON();
        assert.ok((json.title || '').length <= 256);
        assert.ok((json.description || '').length <= 4096);
        assert.ok((json.fields || []).length <= 25);
        for (const field of json.fields || []) {
            assert.ok(field.name.length <= 256);
            assert.ok(field.value.length <= 1024);
        }
        assert.ok(embed.length <= 6000);
    }
    for (const control of controls(payload)) assert.ok(control.custom_id.length <= 100);
}

test('100 winners use one compact announcement, bounded ended embed and five complete private pages', async () => {
    const f = fixture();
    const [ended, selected] = await f.end();
    assert.equal(f.sent.length, 1);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.draws.length, 1);
    const publicPayload = f.sent[0];
    assertPayloadLimits(publicPayload);
    assert.match(publicPayload.content, /100 winners/);
    assert.doesNotMatch(publicPayload.content, /<@\d+>/);
    assert.deepEqual(publicPayload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    assert.equal(controls(publicPayload)[0].label, 'View winners');
    assert.equal(controls(publicPayload)[0].disabled, undefined);

    assertPayloadLimits({ embeds: [giveaways.buildGiveawayEmbed(ended)] });
    for (const action of ['Ended', 'Rerolled']) {
        const summary = giveaways.drawSummary(action, ended, selected);
        assert.ok(summary.length <= 2000);
        assert.match(summary, /100 selected/);
        assert.doesNotMatch(summary, /<@\d+>/);
    }

    const viewer = click(controls(publicPayload)[0].custom_id);
    const orderedStore = { ...f.store,
        async getGiveaway(id) { assert.deepEqual(viewer.order, ['defer']); return f.store.getGiveaway(id); }
    };
    assert.equal(await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: orderedStore }), true);
    assert.deepEqual(viewer.replies, [{ flags: MessageFlags.Ephemeral }]);
    let page = viewer.edits[0];
    const shown = [];
    for (let index = 0; index < 5; index++) {
        assertPayloadLimits(page);
        assert.deepEqual(page.allowedMentions, { parse: [] });
        assert.equal(mentions(page).length, 20);
        assert.equal(page.embeds[0].toJSON().footer.text, `Page ${index + 1}/5 • 100 winners`);
        assert.equal(controls(page)[0].disabled, index === 0);
        assert.equal(controls(page)[1].disabled, index === 4);
        shown.push(...mentions(page));
        if (index < 4) {
            const next = click(controls(page)[1].custom_id);
            await giveaways.handleGiveawayButton(next.interaction, {});
            page = next.updates[0];
        }
    }
    assert.deepEqual(shown, selected);
    assert.equal(new Set(shown).size, 100);
    const previous = click(controls(page)[0].custom_id);
    await giveaways.handleGiveawayButton(previous.interaction, {});
    assert.deepEqual(mentions(previous.updates[0]), selected.slice(60, 80));
});

test('20 winners keep their existing public congratulations and pings; 21 use the winner list', async () => {
    for (const count of [20, 21]) {
        const f = fixture({ count });
        const [ended, selected] = await f.end();
        const payload = f.sent[0];
        assertPayloadLimits(payload);
        assertPayloadLimits({ embeds: [giveaways.buildGiveawayEmbed(ended)] });
        if (count === 20) {
            assert.equal(payload.content, `### 🎉  Giveaway ended!\n- Congratulations ${selected.map(id => `<@${id}>`).join(', ')}! You won **${f.initial.prize}  <:man_of_culture:1186287184106496112>**`);
            assert.deepEqual(payload.allowedMentions, { users: selected });
            assert.deepEqual(controls(payload), []);
            assert.match(giveaways.drawSummary('Ended', ended, selected), new RegExp(`<@${selected[0]}>`));
        } else {
            const viewer = click(controls(payload)[0].custom_id);
            await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
            const next = click(controls(viewer.edits[0])[1].custom_id);
            await giveaways.handleGiveawayButton(next.interaction, {});
            assert.deepEqual(mentions(next.updates[0]), selected.slice(20));
            assert.equal(controls(next.updates[0])[1].disabled, true);
        }
    }
});

test('the actual winner count determines pagination and empty draws keep their existing message', async () => {
    for (const count of [0, 1, 20]) {
        const f = fixture({ count: 100, entries: count });
        const [, selected] = await f.end();
        assert.equal(selected.length, count);
        assert.deepEqual(controls(f.sent[0]), []);
        assert.deepEqual(f.sent[0].allowedMentions, { users: selected });
        if (!count) assert.match(f.sent[0].content, /Nobody joined this giveaway/);
    }
});

test('only the viewer who opened a private winner list can change its page', async () => {
    const f = fixture({ count: 21 });
    await f.end();
    const viewer = click(controls(f.sent[0])[0].custom_id);
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    const nextId = controls(viewer.edits[0])[1].custom_id;
    const stranger = click(nextId, { user: { id: 'someone-else' } });
    await giveaways.handleGiveawayButton(stranger.interaction, {});
    assert.deepEqual(stranger.updates, []);
    assert.equal(stranger.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(stranger.replies[0].content, /Only the command user/);
    const next = click(nextId);
    await giveaways.handleGiveawayButton(next.interaction, {});
    assert.deepEqual(mentions(next.updates[0]), f.draws[0].winner_user_ids.slice(20));
});

test('expired private winner pages can be reopened from the unchanged public button', async t => {
    const f = fixture({ count: 21 });
    await f.end();
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const publicId = controls(f.sent[0])[0].custom_id;
    const viewer = click(publicId);
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    const privateId = controls(viewer.edits[0])[1].custom_id;
    now += 5 * 60 * 1000 + 1;
    const expired = click(privateId);
    await giveaways.handleGiveawayButton(expired.interaction, {});
    assert.match(expired.replies[0].content, /expired.*original button/);
    assert.deepEqual(expired.updates, []);
    const reopened = click(publicId);
    await giveaways.handleGiveawayButton(reopened.interaction, { giveawayStore: f.store });
    assert.deepEqual(mentions(reopened.edits[0]), f.draws[0].winner_user_ids.slice(0, 20));
    assert.notEqual(controls(reopened.edits[0])[1].custom_id, privateId);
});

test('end and historical reroll buttons resolve their saved draws after a store and process-state restart', async t => {
    const f = fixture({ count: 21, entries: 63 });
    await f.end();
    await f.end({ drawType: 'reroll' });
    await f.end({ drawType: 'reroll' });
    assert.equal(f.sent.length, 3);
    assert.equal(f.draws.length, 3);
    assert.equal(new Set(f.sent.map(payload => controls(payload)[0].custom_id)).size, 3);
    assert.equal(new Set(f.draws.flatMap(draw => draw.winner_user_ids)).size, 63);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-winner-history-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const storeOptions = { storageMode: 'json', dataFile: path.join(directory, 'giveaways.json'),
        db: { async query() { assert.fail('Winner history must not query MySQL'); } } };
    const persisted = giveaways.createGiveawayStore(storeOptions);
    persisted.localSaveGiveaway(f.initial.giveaway_id, await f.store.getGiveaway(f.initial.giveaway_id), false);
    for (const draw of f.draws) persisted.localSaveDraw(draw.draw_id, draw, false);
    const viewer = click(controls(f.sent[0])[0].custom_id);
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: persisted });

    const modulePath = require.resolve('../events/giveaways');
    delete require.cache[modulePath];
    const restarted = require('../events/giveaways');
    const restored = restarted.createGiveawayStore(storeOptions);
    await restored.restore();
    const oldPrivatePage = click(controls(viewer.edits[0])[1].custom_id);
    await restarted.handleGiveawayButton(oldPrivatePage.interaction, {});
    assert.match(oldPrivatePage.replies[0].content, /expired/);
    for (const [index, announcement] of f.sent.entries()) {
        const reopened = click(controls(announcement)[0].custom_id);
        await restarted.handleGiveawayButton(reopened.interaction, { giveawayStore: restored });
        assert.deepEqual(mentions(reopened.edits[0]), f.draws[index].winner_user_ids.slice(0, 20));
        const last = click(controls(reopened.edits[0])[1].custom_id);
        await restarted.handleGiveawayButton(last.interaction, {});
        assert.deepEqual(mentions(last.updates[0]), f.draws[index].winner_user_ids.slice(20));
        assert.equal(reopened.edits[0].embeds[0].toJSON().title, index ? 'Rerolled winners' : 'Giveaway winners');
    }
});

test('missing draws and cross-guild winner buttons never substitute the latest winners', async () => {
    const f = fixture({ count: 21 });
    await f.end();
    const publicId = controls(f.sent[0])[0].custom_id;
    let drawReads = 0;
    const store = { ...f.store, async listDraws() { drawReads++; return []; } };
    const outside = click(publicId, { guildId: 'another-guild' });
    await giveaways.handleGiveawayButton(outside.interaction, { giveawayStore: store });
    assert.equal(drawReads, 0);
    assert.deepEqual(outside.edits, ['That giveaway could not be found.']);
    const missing = click(publicId);
    await giveaways.handleGiveawayButton(missing.interaction, { giveawayStore: store });
    assert.equal(drawReads, 1);
    assert.match(missing.edits[0], /saved winner list could not be found/);
});

test('failed acknowledgement of a winner click stops before accessing storage', async () => {
    const f = fixture({ count: 21 });
    await f.end();
    const viewer = click(controls(f.sent[0])[0].custom_id, {
        async deferReply() { throw new Error('Interaction expired'); }
    });
    await assert.rejects(giveaways.handleGiveawayButton(viewer.interaction, {
        giveawayStore: { async getGiveaway() { assert.fail('No read before acknowledgement'); } }
    }), /Interaction expired/);
});

test('manual end and reroll commands retain the public winner button and send compact private summaries', async () => {
    const f = fixture({ entries: 200 });
    const config = { giveawayStore: f.store, officerRoleID: 'officer' };
    const command = new Giveaways(config);
    for (const action of ['end', 'reroll']) {
        const publicReplies = [], privateReplies = [];
        const interaction = {
            client: f.client, user: { id: 'staff', username: 'Officer' },
            member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
            options: { getString: () => f.initial.giveaway_id, getInteger: () => 100 },
            async deferReply() { this.deferred = true; },
            async editReply(payload) { this.replied = true; publicReplies.push(payload); return { id: `${action}-reply` }; },
            async followUp(payload) { privateReplies.push(payload); }
        };
        await command[action](interaction);
        assert.equal(publicReplies.length, 1);
        assert.equal(controls(publicReplies[0])[0].label, 'View winners');
        assertPayloadLimits(publicReplies[0]);
        assert.deepEqual(publicReplies[0].allowedMentions.users, []);
        assert.equal(privateReplies.length, 1);
        assert.equal(privateReplies[0].flags, MessageFlags.Ephemeral);
        assertPayloadLimits(privateReplies[0]);
        assert.match(privateReplies[0].content, /100 selected/);
        assert.doesNotMatch(privateReplies[0].content, /<@\d+>/);
    }
    assert.equal(f.sent.length, 0, 'Manual draws must not duplicate delivery in the channel');
});

test('the existing reroll summary fallback retains its saved winner button after a transient announcement failure', async () => {
    for (const count of [20, 21]) {
        const f = fixture({ count, entries: count * 2 });
        await f.end();
        const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
        const attempts = [];
        const interaction = {
            client: f.client, user: { id: 'staff', username: 'Officer' },
            member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
            options: { getString: () => f.initial.giveaway_id, getInteger: () => count },
            async deferReply() { this.deferred = true; },
            async editReply(payload) {
                attempts.push(payload);
                if (attempts.length === 1) throw new Error('Temporary response failure');
                this.replied = true;
                return { id: 'recovered-reroll-reply' };
            },
            async followUp() { assert.fail('Failed public response must use its existing summary fallback'); }
        };
        await command.reroll(interaction);
        assert.equal(attempts.length, 2);
        assert.equal(f.draws.length, 2);
        assert.equal(f.sent.length, 1, 'Reroll must not fall back to another channel announcement');
        const summary = attempts[1];
        assertPayloadLimits(summary);
        assert.match(summary.content, /Rerolled Giveaway/);
        if (count > 20) {
            assert.deepEqual(summary.allowedMentions, { parse: [] });
            assert.equal(controls(summary)[0].custom_id, controls(attempts[0])[0].custom_id);
            const viewer = click(controls(summary)[0].custom_id);
            await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
            assert.deepEqual(mentions(viewer.edits[0]), f.draws[1].winner_user_ids.slice(0, 20));
        } else {
            assert.deepEqual(controls(summary), []);
            assert.equal(summary.allowedMentions, undefined);
            assert.match(summary.content, new RegExp(`<@${f.draws[1].winner_user_ids[0]}>`));
        }
    }
});

test('a large recovered legacy end uses its saved draw ID even if pending metadata lacks end_draw_id', async () => {
    const f = fixture({ count: 21 });
    await f.store.updateGiveaway(f.initial.giveaway_id, { status: 'ended', end_announcement_pending: true,
        winner_user_ids: winnerIds(21), ended_at: f.initial.ends_at });
    const saved = { draw_id: `${f.initial.giveaway_id}:end:legacy`, giveaway_id: f.initial.giveaway_id,
        draw_type: 'end', drawn_at: f.initial.ends_at, winner_user_ids: winnerIds(21) };
    await f.store.saveDraw(saved.draw_id, saved);
    const [ended] = await f.end();
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.draws.length, 1);
    const viewer = click(controls(f.sent[0])[0].custom_id);
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    assert.deepEqual(mentions(viewer.edits[0]), saved.winner_user_ids.slice(0, 20));
});
