// Voice sessions remain separate across guilds and clients.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    let now = 0;
    const awards = [], activity = [];
    const settings = { sources: { voice: true }, voiceXp: { minTimeForXp: 60, xpPerMinuteMin: 1, xpPerMinuteMax: 1 }, boostStackStrategy: 'additive' };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../events/levels/xpVoiceHandler.js'), 'utf8'), {
        module, Date: { now: () => now }, Map, WeakMap, Math,
        require(name) {
            if (name.endsWith('xpConfig')) return settings;
            if (name.endsWith('xpHelper')) return { getXPTracksForUser: async () => [{ xpType: 'global' }],
                calculateVoiceActivityMultiplier: () => 1, calculateXpBoostMultiplier: () => 1 };
            if (name.endsWith('xpEngine')) return { processXp: async (...args) => awards.push(args) };
            if (name.endsWith('xpDbHelper')) return { recordRawActivity: async (...args) => activity.push(args), getXpTypeFromTrackInfo: track => track.xpType };
            throw new Error(`Unexpected dependency ${name}`);
        }
    });
    const state = (guildId, channelId, member = { id: 'user', user: { bot: false, username: 'user' } }) =>
        ({ id: 'user', guild: { id: guildId }, channelId, member });
    return { execute: module.exports.execute, awards, activity, state, setTime: value => { now = value; } };
}

test('the same user can have independent voice sessions in two guilds', async () => {
    const { execute, state, setTime, awards } = fixture();
    const config = {};
    await execute(state('gold', null), state('gold', 'voice'), config);
    setTime(60_000);
    await execute(state('silver', null), state('silver', 'voice'), config);
    setTime(180_000);
    await execute(state('gold', 'voice'), state('gold', null), config);
    setTime(240_000);
    await execute(state('silver', 'voice'), state('silver', null), config);
    assert.deepEqual(awards.map(args => [args[1].id, args[4], args[8]]), [['gold', 3, 3], ['silver', 3, 3]]);
});

test('voice sessions from a different client cannot be awarded or discarded', async () => {
    const { execute, state, setTime, awards } = fixture();
    const first = { client: {} }, second = { client: {} };
    await execute(state('guild', null), state('guild', 'voice'), first);
    setTime(60_000);
    await execute(state('guild', null), state('guild', 'voice'), second);
    setTime(180_000);
    await execute(state('guild', 'voice'), state('guild', null), first);
    await execute(state('guild', 'voice'), state('guild', null), second);
    assert.deepEqual(awards.map(args => args[4]), [3, 2]);
});

test('missing voice members discard their session without crashing or awarding XP', async () => {
    const { execute, state, setTime, awards } = fixture();
    const config = {};
    await execute(state('guild', null), state('guild', 'voice'), config);
    setTime(60_000);
    await execute(state('guild', 'voice'), state('guild', null, null), config);
    await execute(state('guild', 'voice'), state('guild', null), config);
    assert.equal(awards.length, 0);
});
