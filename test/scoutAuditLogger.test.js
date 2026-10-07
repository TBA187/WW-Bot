// Cover staff log entries for report changes and review decisions.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutAuditLogger, auditPayload, diagnosticPayload, publishedPayload } = require('../features/pvp-scouting/ScoutAuditLogger.js');

function event(action = 'edited') {
    return { action, actorId: '291142291073269761', messageId: '1350059044102078494', reportId: '1350059044102078494',
        timestamp: '2026-10-01T11:12:13.000Z', sources: [{ messageId: '1350059044102078494',
            before: { ign: 'ale', rating: null, notes: 'old', sourceUrl: 'https://discord.com/channels/1/2/1350059044102078494', reviewStatus: 'pending' },
            after: { ign: 'Godredeye', rating: 309, notes: 'new', reviewStatus: 'corrected' } }] };
}

for (const [action, title] of [['edited','Scout Report Edited'], ['deleted','Scout Report Deleted'],
    ['confirmed','Scout Review Approved'], ['corrected','Scout Review Corrected'], ['not_scout','Scout Review Declined']]) {
    test(`${action} audit includes officer, report/source IDs, timestamp, logo footer and before/after values`, () => {
        const payload = auditPayload(event(action)); const embed = payload.embeds[0].toJSON();
        assert.equal(embed.title, title); assert.match(embed.description, /<@291142291073269761>/u);
        assert.match(embed.description, /Scout Report ID.*1350059044102078494/u);
        assert.match(embed.description, /Scout Message ID.*1350059044102078494/u);
        assert.equal(embed.timestamp, '2026-10-01T11:12:13.000Z');
        assert.equal(embed.footer.text, 'White Walkers • Message ID: 1350059044102078494');
        assert.equal(embed.footer.icon_url, 'attachment://ww_logo.png');
        assert.ok(payload.files.some(file => file.name === 'ww_logo.png'));
        assert.match(embed.fields.find(field => field.name === 'Opponent IGN').value, /Before:.*ale.*\n.*After:.*Godredeye/u);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        const history = payload.files.find(file => file.name.endsWith('.json'));
        assert.equal(JSON.parse(history.attachment.toString()).sources[0].before.ign, 'ale');
    });
}

test('long values and many sources fit embed limits while the attachment keeps complete history', () => {
    const value = event(); value.sources[0].after = { ...value.sources[0].after, teamText: 'A'.repeat(10000),
        authorUsername: 'B'.repeat(100), attachments: [{ url: 'https://example.com/' + 'x'.repeat(2000) }], createdAt: '2026-10-01' };
    value.sources.push(...Array.from({ length: 100 }, (_, i) => ({ messageId: String(1350000000000000000n + BigInt(i)) })));
    const payload = auditPayload(value); const embed = payload.embeds[0].toJSON();
    assert.ok(embed.fields.every(field => field.value.length <= 1024));
    const total = embed.title.length + embed.description.length + embed.footer.text.length
        + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    assert.ok(total <= 6000);
    assert.equal(JSON.parse(payload.files[1].attachment.toString()).sources[0].after.teamText.length, 10000);
});

test('logger stays quiet on startup and serializes only new actions to the configured log channel', async () => {
    const sent = [], channel = { guildId: 'guild', async send(payload) { sent.push(payload); } };
    const logger = new ScoutAuditLogger({ guildId: 'guild', channelId: '1423716368326590575',
        client: { channels: { cache: new Map([['1423716368326590575', channel]]) } } });
    await logger.flush(); assert.equal(sent.length, 0);
    logger.enqueue(event('corrected')); logger.enqueue(event('deleted'));
    await logger.flush();
    assert.deepEqual(sent.map(payload => payload.embeds[0].toJSON().title), ['Scout Review Corrected', 'Scout Report Deleted']);
});

test('log delivery failure is reported without retrying duplicate messages or blocking later actions', async t => {
    const logs = []; t.mock.method(console, 'warn', text => logs.push(text));
    let sends = 0;
    const logger = new ScoutAuditLogger({ guildId: 'guild', channelId: 'log', client: { channels: { cache: new Map([['log',
        { guildId: 'guild', async send() { sends++; if (sends === 1) throw new Error('Controlled Discord failure'); } }]]) } } });
    logger.enqueue(event()); logger.enqueue(event('confirmed')); await logger.flush();
    assert.equal(sends, 2); assert.equal(logs.length, 1); assert.match(logs[0], /saved change history is intact/u);
});

test('automatic publication logs use the report ID, logo, timestamp and correct source link without pinging contributors', () => {
    const payload = publishedPayload({ ign: '90skid', reportId: '1500728816346075216', messageId: '1500728954083086407',
        sourceUrl: 'https://discord.com/channels/1/2/1500728816346075216', rating: 318,
        timestamp: '2026-10-03T09:30:00Z', sources: [{ author_id: 'member', message_id: '1500728816346075216' }] });
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, '✅ Scout Report Published');
    assert.match(embed.description, /\*\*90skid\*\*.*validated and added/u);
    assert.match(embed.description, /<@member>/u);
    assert.equal(embed.footer.text, 'WW • Scout Report ID: 1500728816346075216');
    assert.equal(embed.footer.icon_url, 'attachment://ww_logo.png');
    assert.equal(embed.timestamp, '2026-10-03T09:30:00.000Z');
    assert.equal(embed.fields.find(field => field.name === 'PvP Rating').value, '318');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.nonce, 'sp:1500728954083086407');
    assert.equal(payload.enforceNonce, true);
});

test('error and warning messages ping only the owner above the branded embed', () => {
    for (const level of ['warn', 'error']) {
        const payload = diagnosticPayload({ level, message: 'MySQL connection failed: ECONNREFUSED', code: 'ECONNREFUSED',
            component: 'Scout feedback', reportId: '1500728816346075216', messageId: '1500728954083086407' }, '291142291073269761');
        const embed = payload.embeds[0].toJSON();
        assert.equal(payload.content, '<@291142291073269761>');
        assert.deepEqual(payload.allowedMentions, { parse: [], users: ['291142291073269761'] });
        assert.equal(embed.footer.text, 'WW • Scout Report ID: 1500728816346075216');
        assert.equal(embed.footer.icon_url, 'attachment://ww_logo.png');
        assert.ok(embed.timestamp);
        assert.equal(payload.files[0].name, 'ww_logo.png');
    }
    const embed = diagnosticPayload({ level: 'error', message: 'General database error' }, 'owner').embeds[0].toJSON();
    assert.equal(embed.footer.text, 'WW • Bot runtime');
    for (const component of ['MySQL', 'PvP scouting', 'Bot runtime']) {
        const general = diagnosticPayload({ level: 'warn', message: 'Service issue', component, reportId: 'N/A' }, 'owner')
            .embeds[0].toJSON();
        assert.equal(general.footer.text, `WW • ${component}`);
        assert.doesNotMatch(general.footer.text, /Scout Report ID|N\/A/u);
    }
});

test('publication and diagnostic logs share the action queue and configured channel', async () => {
    const sent = [], channel = { guildId: 'guild', async send(payload) { sent.push(payload); } };
    const logger = new ScoutAuditLogger({ guildId: 'guild', channelId: 'log', ownerId: 'owner',
        client: { channels: { cache: new Map([['log', channel]]) } } });
    logger.published({ ign: 'Blacku', reportId: '123', messageId: '124', sources: [] });
    logger.diagnostic({ level: 'error', message: 'Controlled error' });
    await logger.flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].embeds[0].toJSON().title, '✅ Scout Report Published');
    assert.equal(sent[1].content, '<@owner>');
});
