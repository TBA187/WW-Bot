const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeScoutTypo } = require('../features/pvp-scouting/ScoutEditPolicy');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore');
const { auditPayload, memberEditPayload, publishedPayload, diagnosticPayload } = require('../features/pvp-scouting/ScoutAuditLogger');
const oldText = 'Vegeta111\n[Hoppowdon Rocky Helmet] Earthquake, Toxic';
const newText = oldText.replace('Hoppowdon', 'Hippowdon');
const base = { content: oldText, ign: 'Vegeta111', rating: 300, authorId: 'member',
    classification: 'scout', reviewStatus: 'not_required', teamText: '[Hippowdon Rocky Helmet] Earthquake, Toxic',
    attachments: [{ id: 'image', name: 'image.jpg', url: 'https://cdn/image?old' }] };

test('the requested one-letter species correction auto-approves, but semantic changes cannot', () => {
    const proposal = { ...base, content: newText };
    assert.equal(isSafeScoutTypo(base, proposal), true);
    for (const patch of [{ ign: 'Vegeta112' }, { rating: 301 }, { attachments: [] },
        { reviewStatus: 'pending' }, { content: newText + '\nspam' },
        { content: newText.replace('Toxic', 'Taunt') }, { content: 'spam' }]) {
        assert.equal(isSafeScoutTypo(base, { ...proposal, ...patch }), false, JSON.stringify(patch));
    }
    assert.equal(isSafeScoutTypo({ ...base, reviewed_by_id: 'officer' }, proposal), false);
    assert.equal(isSafeScoutTypo({ ...base, staffOverrides: { locked: true } }, proposal), false);
    assert.equal(isSafeScoutTypo(base, { ...proposal, attachments: [{ ...base.attachments[0], url: 'https://cdn/image?new' }] }), true);
});

test('audit ignores refreshed screenshots, equal dates, numeric types and supplied false changes', () => {
    const before = { messageContent: oldText, createdAt: new Date('2026-10-01T06:00:00Z'),
        attachments: base.attachments, ign: base.ign, rating: '300' };
    const after = { ...before, messageContent: newText, createdAt: '2026-10-01T06:00:00.000Z',
        rating: 300, attachments: [{ id: 'image', name: 'image.jpg' }] };
    const event = { action: 'edit_accepted', actorId: 'officer', reportId: '123', messageId: '123', sources: [{ before, after }] };
    for (const changes of [undefined, Object.fromEntries(Object.keys(after).map(key => [key, { before: before[key], after: after[key] }]))]) {
        const embed = auditPayload({ ...event, sources: [{ before, after, changes }] }).embeds[0].toJSON();
        assert.deepEqual(embed.fields.map(f => f.name), ['Stored message text']);
        assert.match(embed.fields[0].value, /^```diff\n- \[Hoppowdon.*\n\+ \[Hippowdon.*\n```$/u);
        assert.doesNotMatch(embed.description, /Scout Report ID/u);
    }
});

test('all log kinds deduplicate IDs and member edits omit unchanged metadata', () => {
    const event = { reportId: '123', messageId: '123', ign: base.ign, before: base, after: { ...base, content: newText }, autoApproved: true };
    for (const build of [memberEditPayload, publishedPayload, e => diagnosticPayload({ ...e, message: 'Error' })]) {
        const embed = build(event).embeds[0].toJSON();
        assert.doesNotMatch(JSON.stringify(embed), /Scout Report ID/u);
        assert.match(JSON.stringify(embed), /Scout Message ID/u);
    }
    const embed = memberEditPayload(event).embeds[0].toJSON();
    assert.match(embed.description, /Automatically approved.*updated and published/u);
    assert.ok(!embed.fields.some(f => ['Opponent IGN', 'IGN confidence', 'IGN detection source', 'Attachments', 'PvP rating'].includes(f.name)));
    const changed = memberEditPayload({ ...event, after: { ...event.after, attachments: [] } }).embeds[0].toJSON();
    assert.ok(changed.fields.some(f => f.name === 'Attachments'));
    assert.match(publishedPayload({ ...event, reportId: '456' }).embeds[0].toJSON().description, /Scout Report ID.*456/u);
});

test('historical edit guard counts two other distinct old reports using durable channel-scoped activity', async () => {
    let count = 1, calls = [];
    const store = new PvpScoutStore({ channelId: 'channel', db: { async query(sql, params) { calls.push({ sql, params }); return [[{ total: count }]]; } } });
    store.ensureSchema = async () => {};
    const before = { ...base, messageId: 'source', root_message_id: 'root', createdAt: new Date(Date.now() - 8 * 86400000) };
    assert.equal(await store.isHistoricalEditBurst(before, { ...before, content: newText }), false);
    count = 2;
    assert.equal(await store.isHistoricalEditBurst(before, { ...before, content: newText }), true);
    assert.match(calls[0].sql, /COUNT\(DISTINCT/u);
    assert.match(calls[0].sql, /e.requested_at/u);
    assert.deepEqual(calls[0].params, ['channel', 'member', 'root']);
    calls = [];
    assert.equal(await store.isHistoricalEditBurst({ ...before, createdAt: new Date() }, { ...before, content: newText }), false);
    assert.equal(await store.isHistoricalEditBurst(before, before), false);
    assert.equal(calls.length, 0);
});

test('live typo updates publish and log; old spam, bursts, and pending proposals stay staged', async () => {
    const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor');
    for (const scenario of ['typo', 'old typo', 'old spam', 'burst', 'pending']) {
        const old = scenario !== 'typo';
        let row = { message_id: '123', root_message_id: '123', channel_id: 'channel', author_id: 'member',
            author_username: 'Member', message_content: oldText, attachments: base.attachments,
            classification: 'scout', review_status: 'not_required', opponent_ign: base.ign, rating: base.rating,
            team_text: base.teamText, created_at: new Date(Date.now() - (old ? 8 : 0) * 86400000) };
        const logs = [], calls = [];
        const pending = scenario === 'pending' ? { status: 'pending', after: { ...base, content: oldText } } : null;
        const store = { async getMessage() { return row; }, async getEditReview() { return pending; },
            async isHistoricalEditBurst() { return scenario === 'burst'; },
            async sourcesForRoots() { return [row]; },
            async saveMessage(proposal) { calls.push('save'); row = { ...row, message_content: proposal.content }; return row; },
            async stageEditReview() { calls.push('stage'); return { message_id: '123', revision: 1 }; },
            auditLogger: { memberEdited(event) { logs.push(event); } } };
        const ingestor = new PvpScoutIngestor({ store, channelId: 'channel', client: { user: { id: 'bot' } }, ocr: {},
            feedback: { async observeMessage() { calls.push('feedback'); } } });
        ingestor.buildRecord = async () => ({ ...base, messageId: '123', channelId: 'channel',
            createdAt: row.created_at, content: scenario === 'old spam' ? 'spam' : newText });
        ingestor.rebuildGroups = async () => { calls.push('publish'); };
        ingestor.notifyEditReview = async () => { calls.push('notify'); };
        await ingestor.handleUpdate({ id: '123', channelId: 'channel', author: { id: 'member' } });
        const safe = scenario === 'typo' || scenario === 'old typo';
        assert.deepEqual(calls, safe ? ['save', 'publish', 'feedback'] : ['stage', 'notify', 'feedback'], scenario);
        assert.equal(logs.length, 1, scenario);
        assert.equal(logs[0].awaitingApproval, !safe, scenario);
        assert.equal(logs[0].autoApproved, safe ? true : undefined, scenario);
    }
});

test('historical pending edits notify officers and deduplicate report/message IDs', async () => {
    const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor');
    const sent = [];
    const store = { async getMessage() { return { message_id: '123', root_message_id: '123',
        created_at: new Date('2020-01-01'), author_username: 'Member', source_url: 'https://discord.com/channels/1/2/123' }; },
        async getEditReview() { return { status: 'pending', revision: 1 }; },
        async claimEditReviewAlert() { return true; }, async markEditReviewAlertSent() {} };
    const ingestor = new PvpScoutIngestor({ store, channelId: 'channel', officerChannelId: 'staff', ocr: {}, feedback: {},
        client: { channels: { cache: new Map([['staff', { async send(payload) { sent.push(payload); return { id: 'alert' }; } }]]) } } });
    await ingestor.notifyEditReview({ message_id: '123', revision: 1 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Scout Message ID: 123/u);
    assert.doesNotMatch(sent[0].content, /Scout Report ID/u);
});
