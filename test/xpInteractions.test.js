// XP commands acknowledge slow lookups and keep invalid-track responses private.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const Rank = require('../commands/levels/rank.js');
const Leaderboard = require('../commands/levels/leaderboard.js');

function interactionFixture() {
    const calls = [];
    const user = { id: 'target', username: 'target', displayAvatarURL: () => 'https://example.com/avatar.png' };
    return { calls, user: { id: 'caller' }, member: { displayName: 'Caller nickname' }, guild: { id: 'guild', name: 'Guild' },
        options: { getString: () => '42', getUser: () => user, getMember: () => null },
        async deferReply() { calls.push('defer'); this.deferred = true; },
        async deleteReply() { calls.push('delete'); },
        async followUp(payload) { calls.push(['followUp', payload]); },
        async editReply(payload) { calls.push(['editReply', payload]); } };
}

for (const Command of [Rank, Leaderboard]) {
    test(`${Command.name} acknowledges before querying special XP tracks`, async () => {
        const interaction = interactionFixture();
        const db = { async query() { assert.equal(interaction.calls[0], 'defer'); return [[]]; } };
        await new Command({ db }).execute(interaction);
        assert.deepEqual(interaction.calls.slice(0, 2), ['defer', 'delete']);
        assert.equal(interaction.calls[2][1].flags, MessageFlags.Ephemeral);
    });

    test(`${Command.name} does not query after acknowledgement fails`, async () => {
        const interaction = interactionFixture();
        interaction.deferReply = async () => { throw new Error('expired'); };
        const db = { query() { assert.fail('No lookup should start'); } };
        await assert.rejects(new Command({ db }).execute(interaction), /expired/);
    });
}

test('rank uses the target username when that target has no cached guild member', async () => {
    const interaction = interactionFixture();
    interaction.options.getString = () => null;
    const command = new Rank({ db: { async query() { return [[]]; } } });
    await command.execute(interaction);
    const response = interaction.calls.find(call => call[0] === 'editReply')[1];
    assert.equal(response.embeds[0].data.title, "Target's Rank Overview");
});

function xpDisplayFixture({ global = false, roles = [], channels = [], date = new Date(2026, 4, 11, 12), noData = false } = {}) {
    const interaction = interactionFixture();
    interaction.options.getString = () => global ? null : '42';
    const db = { async query(sql) {
        if (sql.includes('FROM xp_channel_tracks')) return [[{
            id: 42, name: 'Special XP', role_ids: roles, channel_ids: channels, created_at: date
        }]];
        assert.match(sql, /FROM xp_user_levels/);
        return [noData ? [] : [{
            user_id: 'target', xp_date: date, xp_amount: 0, level: 0,
            message_xp: 0, reaction_xp: 0, command_xp: 0, voice_xp: 0,
            total_messages_sent: 0, total_reactions_added: 0, total_commands_used: 0, total_voice_minutes: 0
        }]];
    } };
    return { interaction, config: {
        db, guildSettingsCache: new Map([['guild', { xpDateEnabled: date }]])
    } };
}

for (const Command of [Rank, Leaderboard]) {
    test(`${Command.name} keeps tracking dates and special-track requirements in its actual embeds`, async () => {
        for (const scenario of [
            { global: true, description: undefined, fields: [] },
            { roles: ['role-one'], description: '**XP-Role:** <@&role-one>', fields: [] },
            { channels: ['channel-one'], description: '**XP-Channel:** <#channel-one>', fields: [] },
            { roles: ['role-one', 'role-two'], channels: ['channel-one', 'channel-two'], description: undefined,
                fields: [
                    { name: 'XP-Roles', value: '-# <@&role-one>\n-# <@&role-two>', inline: true },
                    { name: 'XP-Channels', value: '-# <#channel-one>\n-# <#channel-two>', inline: true },
                    { name: '\u2002', value: '\u2002', inline: false }
                ] },
            { description: undefined, fields: [] }
        ]) {
            const { interaction, config } = xpDisplayFixture(scenario);
            await new Command(config).execute(interaction);
            const payload = interaction.calls.find(call => call[0] === 'editReply')?.[1];
            assert.ok(payload?.embeds?.length, 'The command should render its XP embed');
            const embed = payload.embeds[0].toJSON();
            assert.equal(embed.footer.text, Command === Rank
                ? 'XP tracked since 2026-05-11'
                : 'XP tracked since 2026-05-11  •  Page 1');
            assert.equal(embed.description, scenario.description);
            if (scenario.fields.length) {
                assert.deepEqual(embed.fields.slice(0, scenario.fields.length), scenario.fields);
            } else {
                assert.ok(!embed.fields.some(field => /^XP-(?:Role|Channel)/.test(field.name)));
            }
        }
    });

    test(`${Command.name} keeps the tracking-date fallback for missing or invalid dates`, async () => {
        for (const global of [true, false]) {
            for (const date of [null, 'invalid-date']) {
                const { interaction, config } = xpDisplayFixture({ global, date });
                await new Command(config).execute(interaction);
                const payload = interaction.calls.find(call => call[0] === 'editReply')[1];
                assert.equal(payload.embeds[0].data.footer.text, 'XP tracking start date is not recorded yet.'
                    + (Command === Leaderboard ? '  •  Page 1' : ''));
            }
        }
    });
}

test('rank still shows role and channel requirements before a member has special-track XP', async () => {
    const { interaction, config } = xpDisplayFixture({ roles: ['role-one'], channels: ['channel-one'], noData: true });
    await new Rank(config).execute(interaction);
    const payload = interaction.calls.find(call => call[0] === 'followUp')[1];
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'No XP Data Found!');
    assert.deepEqual(embed.fields.slice(0, 2), [
        { name: 'XP-Role', value: '-# <@&role-one>', inline: true },
        { name: 'XP-Channel', value: '-# <#channel-one>', inline: true }
    ]);
});
