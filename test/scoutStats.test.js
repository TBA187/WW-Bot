// Keeps scout statistics accurate and valid within Discord embed limits.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ScoutStats = require('../commands/scout-stats.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');

function baseArchive(server, rows = [], contributors = []) {
    return { server, rows, contributors };
}

test('/scout-stats aggregates ratings, opponent overlap, and each archive\'s latest report', () => {
    const command = new ScoutStats({ botTimezone: 'UTC' });
    const now = Date.now();
    const stats = command.aggregate([
        baseArchive('gold', [
            { message_id: '1000000000000000001', ign_normalized: 'Opponent', opponent_ign: 'Opponent',
                rating: 321, created_at: new Date(now - 1000), screenshot_count: 2, has_team: true }
        ]),
        baseArchive('silver', [
            { message_id: '1000000000000000002', ign_normalized: 'opponent', opponent_ign: 'Opponent',
                rating: 300, created_at: new Date(now), screenshot_count: 1, has_team: true }
        ])
    ]);

    assert.equal(stats.totalReports, 2);
    assert.equal(stats.totalOpponents, 1);
    assert.equal(stats.opponentsInBoth, 1);
    assert.deepEqual(stats.ratings, { count: 2, sum: 621, min: 300, max: 321 });
    assert.equal(stats.byServer.gold.ratings.count, 1);
    assert.equal(stats.byServer.silver.ratings.count, 1);
    assert.equal(stats.latestReportsByServer.gold.message_id, '1000000000000000001');
    assert.equal(stats.latestReportsByServer.silver.message_id, '1000000000000000002');
    assert.equal(stats.byServer.gold.reportsWithTeamText, 1);
    assert.equal(Object.hasOwn(stats, 'latestReport'), false);
    assert.equal(Object.hasOwn(stats, 'reports'), false);
    assert.equal(Object.hasOwn(stats, 'allRatings'), false);
});

function contributorFixture(count) {
    return Array.from({ length: count }, (_, index) => ({
        author_id: String(482354850110373898n + BigInt(index)),
        author_username: `Contributor${index + 1}`,
        scout_count: 191 - index
    }));
}

function rankedNumbers(text) {
    return [...text.matchAll(/^\*\*(\d+)\.\*\*/gmu)].map(match => Number(match[1]));
}

test('/scout-stats keeps the top 5 on the frontpage and lists 20 contributors per page in groups of 10', () => {
    const contributors = contributorFixture(30);
    contributors[29].author_id = null;
    contributors[29].author_username = 'A'.repeat(128);
    const command = new ScoutStats({ botTimezone: 'UTC' });
    const stats = command.aggregate([baseArchive('gold', [], contributors), baseArchive('silver')]);

    const frontpage = command.render(stats, 0, 'owner', 'test-token');
    const frontEmbed = frontpage.embeds[0].toJSON();
    const topContributors = frontEmbed.fields.find(field => field.name.includes('Top 5 Contributors'));
    assert.deepEqual(rankedNumbers(topContributors.value), [1, 2, 3, 4, 5]);
    assert.ok(topContributors.value.includes(`**<@${contributors[0].author_id}>:**`));
    assert.ok(topContributors.value.includes(`${SERVERS.gold.markup} \x60191\x60`));
    assert.ok(topContributors.value.includes(`${SERVERS.silver.markup} \x600\x60`));
    assert.doesNotMatch(frontEmbed.description, /continued/iu);
    assert.equal(frontpage.components[0].toJSON().components[0].label, 'Contributors');
    assert.equal(frontpage.components[0].toJSON().components[0].emoji.id, '1186287184106496112');

    const contributorPage1 = command.render(stats, 1, 'owner', 'test-token');
    const page1Embed = contributorPage1.embeds[0].toJSON();
    assert.deepEqual(rankedNumbers(page1Embed.description), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.deepEqual(rankedNumbers(contributorPage1.embeds[1].toJSON().description), Array.from({ length: 10 }, (_, i) => i + 11));
    assert.equal(page1Embed.footer, undefined);
    assert.equal(page1Embed.timestamp, undefined);
    assert.equal(contributorPage1.embeds[1].toJSON().title, undefined);
    assert.ok(contributorPage1.embeds[1].toJSON().footer);
    assert.ok(page1Embed.description.length <= 4096);
    const back = contributorPage1.components[0].toJSON().components[0];
    assert.equal(back.label, 'Back to frontpage');
    assert.equal(back.emoji.name, '↩️');
    const page1Buttons = contributorPage1.components[1].toJSON().components;
    assert.deepEqual(page1Buttons.map(button => button.label), ['Previous Page', 'Next Page']);
    assert.deepEqual(page1Buttons.map(button => button.emoji.name), ['⬅️', '➡️']);
    assert.equal(page1Buttons[0].disabled, true);
    assert.equal(page1Buttons[1].disabled, false);
    assert.match(back.custom_id, /:0$/u);

    const contributorPage2 = command.render(stats, 2, 'owner', 'test-token');
    const page2Embed = contributorPage2.embeds[0].toJSON();
    assert.deepEqual(rankedNumbers(page2Embed.description), Array.from({ length: 10 }, (_, i) => i + 21));
    assert.equal(contributorPage2.embeds.length, 1);
    assert.equal(page2Embed.footer, undefined);
    const page2Buttons = contributorPage2.components[1].toJSON().components;
    assert.equal(page2Buttons[0].disabled, false);
    assert.equal(page2Buttons[1].disabled, true);
});

test('/scout-stats contributor navigation returns directly to its frontpage', async () => {
    const command = new ScoutStats({ guildId: 'guild', guildMemberRoleID: 'member', botTimezone: 'UTC' });
    const stats = command.aggregate([baseArchive('gold', [], contributorFixture(30)), baseArchive('silver')]);
    command.sessions.set('test-token', { ownerId: 'owner', stats, expiresAt: Date.now() + 60_000 });
    const contributorButton = command.render(stats, 0, 'owner', 'test-token').components[0].toJSON().components[0];
    const interaction = { customId: contributorButton.custom_id, user: { id: 'owner' }, guildId: 'guild',
        inGuild: () => true, member: { roles: ['member'] }, calls: [],
        async deferUpdate() {}, async editReply(payload) { this.calls.push(payload); },
        async reply(payload) { this.calls.push(payload); } };

    assert.equal(await command.handleButton(interaction), true);
    assert.match(interaction.calls[0].embeds[0].toJSON().description, /Contributors 1–10 of 30/u);
    const backButton = interaction.calls[0].components[0].toJSON().components[0];
    interaction.customId = backButton.custom_id;
    await command.handleButton(interaction);
    const home = interaction.calls[1].embeds[0].toJSON();
    assert.deepEqual(rankedNumbers(home.fields.find(field => field.name.includes('Top 5 Contributors')).value), [1, 2, 3, 4, 5]);
    assert.ok(home.fields.length > 0);
});

test('/scout-stats shares a concurrent refresh and reuses the short-lived stats cache', async () => {
    const command = new ScoutStats({ scoutArchiveRegistry: { contexts: () => [{ server: 'gold' }] } });
    let reads = 0;
    command.readArchive = async () => {
        reads++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return baseArchive('gold');
    };

    const [first, concurrent] = await Promise.all([command.loadStats(), command.loadStats()]);
    assert.equal(first, concurrent);
    assert.equal(reads, 1);
    assert.equal(await command.loadStats(), first);
    assert.equal(reads, 1);
});

test('/scout-stats uses one metadata query per archive and shares public report visibility', async () => {
    const queries = [];
    const store = {
        async ensureSchema() {},
        db: { async query(sql, params) {
            queries.push({ sql, params });
            return [[], []];
        } }
    };
    const command = new ScoutStats({});
    await command.readArchive({ server: 'gold', channelId: 'archive-channel', store });

    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, ['archive-channel']);
    assert.match(queries[0].sql, /WHERE root\.channel_id = \?/u);
    assert.match(queries[0].sql, /root\.opponent_ign IS NOT NULL AND root\.ign_normalized IS NOT NULL/u);
    assert.match(queries[0].sql, /source\.review_status <> 'not_scout'/u);
    assert.doesNotMatch(queries[0].sql, /ocr_json|ORDER BY|SUM\(JSON_LENGTH/u);
});

test('/scout-stats counts grouped follow-up teams and staff-selected screenshots once', async () => {
    const image = { id: 'image', name: 'team.png', url: 'https://example.com/team.png', contentType: 'image/png' };
    const root = { message_id: '1', root_message_id: '1', channel_id: 'gold-channel', opponent_ign: 'Opponent',
        ign_normalized: 'opponent', created_at: new Date(), author_id: 'author', author_username: 'Author',
        review_status: 'approved', message_content: 'Opponent', team_text: null,
        attachments_json: JSON.stringify([image]), staff_overrides_json: JSON.stringify({ attachments: [] }) };
    const followUp = { ...root, message_id: '2', opponent_ign: null, message_content: 'Kommo-o z',
        team_text: 'Kommo-o (Other: Z-Move)', staff_overrides_json: null,
        attachments_json: JSON.stringify([image, image, { id: 'file', name: 'notes.txt', url: 'https://example.com/notes.txt' }]) };
    const reply = { ...followUp, message_id: '3', author_id: 'other-author', reply_to_id: '1',
        message_content: 'Kommo-o: Close Combat', team_text: 'Kommo-o: Close Combat', attachments_json: '[]' };
    const filler = { ...reply, message_id: '4', author_id: 'filler', message_content: 'nice', team_text: null };
    const command = new ScoutStats({});
    const archive = await command.readArchive({ server: 'gold', channelId: 'gold-channel', store: {
        async ensureSchema() {}, db: { async query() { return [[root, followUp, reply, filler]]; } }
    } });
    assert.equal(archive.rows.length, 1);
    assert.equal(archive.rows[0].screenshot_count, 1);
    assert.equal(archive.rows[0].has_team, true);
    assert.deepEqual(archive.contributors.map(row => [row.author_id, row.scout_count]), [['author', 1], ['other-author', 1]]);
    const stats = command.aggregate([archive]);
    assert.equal(stats.byServer.gold.reportsWithTeamText, 1);
    assert.equal(stats.byServer.gold.screenshots, 1);
});

test('/scout-stats invalidates its cache when either archive changes and does not cache an older in-flight read', async () => {
    const contexts = ['gold', 'silver'].map(server => ({ server, store: { dataRevision: 0 } }));
    const command = new ScoutStats({ scoutArchiveRegistry: { contexts: () => contexts } });
    let reads = 0;
    let finish;
    command.readArchive = async context => { reads++; return baseArchive(context.server); };
    await command.loadStats();
    contexts[1].store.dataRevision++;
    await command.loadStats();
    assert.equal(reads, 4);
    contexts[0].store.dataRevision++;
    command.readArchive = context => new Promise(resolve => { if (context.server === 'gold') finish = () => resolve(baseArchive('gold'));
        else resolve(baseArchive('silver')); });
    const pending = command.loadStats();
    contexts[0].store.dataRevision++;
    finish(); await pending;
    assert.notEqual(command.statsSnapshot.revision, command.archiveRevision());
    command.readArchive = async context => { reads++; return baseArchive(context.server); };
    await command.loadStats();
    assert.equal(reads, 6);
});
