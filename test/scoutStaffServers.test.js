// Cover archive selection and persistent server binding in officer menus.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ScoutReview = require('../commands/scout-review.js');
const ScoutSettings = require('../commands/scout-settings.js');
const { ScoutReportManagerRegistry } = require('../features/pvp-scouting/ScoutReportManager.js');
const { sourceManagerFor } = require('../features/pvp-scouting/ScoutSourceManager.js');
const { staffServer, bindServer } = require('../features/pvp-scouting/ScoutStaffServers.js');
const { normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const OWNER = '291142291073269761';
const ID = '1554691886654955681';
function config() {
    const contexts = ['gold', 'silver'].map(server => ({ server, label: server, channelId: `${server}-channel`,
        store: { channelId: `${server}-channel`, server }, ingestor: null }));
    return { ownerID: OWNER, officerRoleID: 'officer', guildId: 'guild', client: {},
        pvpScoutStore: contexts[0].store, scoutRosterStore: {},
        scoutServers: { contexts: () => contexts },
        scoutServerSettings: { getSelectedServer: async () => 'silver' } };
}
function interaction(customId = '', options = {}) {
    const calls = [];
    return { customId, calls, user: { id: OWNER }, guildId: 'guild', guild: { id: 'guild' },
        member: { roles: ['officer'] }, inGuild: () => true,
        options: { getString: name => options[name] || null },
        async deferReply() { calls.push('defer'); this.deferred = true; },
        async reply(payload) { calls.push(payload); }, async update(payload) { calls.push(payload); } };
}

function reportSource(id = ID, root = ID) {
    return normalizeMessageRow({ message_id: id, root_message_id: root, server: 'silver', channel_id: 'silver-channel',
        author_id: OWNER, author_username: 'officer', created_at: new Date('2026-10-01T12:00:00Z'),
        classification: 'scout', opponent_ign: 'Opponent', ign_normalized: 'opponent', review_status: 'pending',
        review_reason: 'Confirm the opponent.', ign_confidence: 0.79, ign_source: 'battle_banner',
        source_url: `https://discord.com/channels/1/2/${id}`, team_text: '- Charizard: Roost',
        message_content: 'Opponent\nCharizard: Roost', attachments_json: '[]', ocr_json: '[]' });
}

function validateControls(payload) {
    assert.ok(payload.components.length <= 5);
    const controls = payload.components.flatMap(row => row.toJSON().components);
    const ids = controls.map(control => control.custom_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => id.length <= 100));
    assert.ok(controls.every(control => !control.options || control.options.length <= 25));
    for (const id of ids) {
        if (/^(?:pvp-scout-review|scout-settings:reports-|scout-sources:)/u.test(id)
            && !id.includes(':server:') && !id.includes(':reports-server:')) assert.match(id, /:silver$/u);
    }
}

test('staff defaults use saved server, explicit selection wins, and absent preferences use Gold', async () => {
    const cfg = config();
    assert.equal(await staffServer(cfg, interaction()), 'silver');
    assert.equal(await staffServer(cfg, interaction('', { server: 'gold' })), 'gold');
    cfg.scoutServerSettings.getSelectedServer = async () => null;
    assert.equal(await staffServer(cfg, interaction()), 'gold');
});

test('review commands acknowledge and default to both queues independently of preferences', async () => {
    const cfg = config(), command = new ScoutReview(cfg), click = interaction();
    cfg.scoutServerSettings.getSelectedServer = async () => {
        assert.equal(click.calls[0], 'defer'); return 'silver';
    };
    command.scoped.get('silver').execute = async () => 'silver-review';
    command.scoped.get('gold').execute = async () => 'gold-review';
    command.scoped.get('cross').execute = async () => 'combined-review';
    assert.equal(await command.execute(click), 'combined-review');
    assert.equal(click.calls[0], 'defer');
    assert.equal(await command.execute(interaction('', { server: 'silver' })), 'silver-review');
    assert.equal(await command.execute(interaction('', { server: 'gold' })), 'gold-review');
    assert.equal(command.scoped.get('gold').channelId, 'gold-channel');
    assert.equal(command.scoped.get('silver').channelId, 'silver-channel');
});

test('empty review queues identify the selected server with its custom emoji', async () => {
    const command = new ScoutReview(config());
    for (const [server, label, emoji] of [
        ['gold', 'Gold', '<:gold:1555743525759356948>'],
        ['silver', 'Silver', '<:silver:1555743603567886478>']
    ]) {
        const child = command.scoped.get(server);
        child.store.pendingReviews = async () => [];
        child.store.pendingReviewCount = async () => 0;
        const payload = await child.queuePayload(0, OWNER);
        assert.equal(payload.content, `### The ${emoji} **${label}** scout review queue is empty.`);
        assert.equal(payload.components[0].toJSON().components.find(button => button.style === ButtonStyle.Primary).label, label);
    }
});

test('review buttons and correction forms retain their server independently of preferences', async () => {
    const command = new ScoutReview(config());
    command.scoped.get('silver').handleButton = async () => 'silver-button';
    command.scoped.get('gold').handleButton = async () => 'gold-button';
    command.scoped.get('silver').handleModal = async () => 'silver-modal';
    assert.equal(await command.handleButton(interaction(`pvp-scout-review:confirm:${OWNER}:${ID}:0:silver`)), 'silver-button');
    assert.equal(await command.handleButton(interaction(`pvp-scout-review:confirm:${OWNER}:${ID}:0`)), 'gold-button');
    assert.equal(await command.handleModal(interaction(`pvp-scout-review:modal:${OWNER}:${ID}:0:silver`)), 'silver-modal');
    const child = command.scoped.get('silver');
    const payload = child.serverPanel({ content: 'Empty', embeds: [], components: [] }, OWNER);
    assert.deepEqual(payload.components[0].toJSON().components.map(button => button.label), ['Gold', 'Silver', 'Cross Server']);
    assert.equal(payload.components[0].toJSON().components[1].custom_id, `pvp-scout-review:server:${OWNER}:silver`);
});

test('report managers bind token routes, selectors and old Gold menus without changing global member lists', async () => {
    const cfg = config(), registry = new ScoutReportManagerRegistry(cfg);
    registry.forServer('silver').handleButton = async () => 'silver-report';
    registry.forServer('gold').handleButton = async () => 'gold-report';
    assert.equal(await registry.handleButton(interaction(`scout-settings:reports-edit-details:${OWNER}:token:silver`), OWNER, 'reports-edit-details', ['token', 'silver']), 'silver-report');
    assert.equal(await registry.handleButton(interaction(`scout-settings:reports-edit-details:${OWNER}:token`), OWNER, 'reports-edit-details', ['token']), 'gold-report');
    const settings = new ScoutSettings(cfg);
    assert.equal(settings.store, cfg.scoutRosterStore);
    assert.equal(settings.home(OWNER, 'silver').components[0].toJSON().components[2].custom_id,
        `scout-settings:reports-open:${OWNER}:silver`);
    const silver = registry.forServer('silver');
    silver.admin.list = async () => ({ rows: [], total: 0 });
    const panel = await silver.listPanel(OWNER);
    assert.match(panel.embeds[0].data.title, /Silver/u);
    const ids = panel.components.flatMap(row => row.toJSON().components).map(component => component.custom_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => id.length <= 100));
    assert.ok(ids.some(id => id === `scout-settings:reports-server:${OWNER}:gold`));
});

test('source manager facade routes the server and rejects cross-server attachments', async () => {
    const manager = sourceManagerFor(config());
    manager.forServer('silver').handleInteraction = async () => 'silver-source';
    assert.equal(await manager.handleInteraction(interaction(`scout-sources:open:${OWNER}:${ID}:silver`)), 'silver-source');
    const silver = manager.forServer('silver');
    assert.throws(() => silver.confirmation(OWNER, { root: { channel_id: 'silver-channel' } },
        { root: { channel_id: 'gold-channel' } }), /same server/u);
});

test('server binding is idempotent and does not change global settings controls', () => {
    const panel = { components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`scout-sources:open:${OWNER}:${ID}`).setLabel('Sources').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`scout-settings:home:${OWNER}`).setLabel('Settings').setStyle(ButtonStyle.Secondary))] };
    bindServer(panel, 'silver'); bindServer(panel, 'silver');
    assert.deepEqual(panel.components[0].toJSON().components.map(button => button.custom_id),
        [`scout-sources:open:${OWNER}:${ID}:silver`, `scout-settings:home:${OWNER}`]);
});

test('Silver review queue panels and correction modals serialize within Discord component limits', async () => {
    const command = new ScoutReview(config()), child = command.scoped.get('silver'), root = reportSource();
    child.store.pendingReviews = async () => [root];
    child.store.pendingReviewCount = async () => 1;
    child.store.sourcesForRoots = async () => [root];
    validateControls(await child.queuePayload(0, OWNER));
    for (const edited of [false, true]) {
        root.pending_edit = edited;
        root.edit_before = { content: 'Old team', ign: 'Opponent' };
        root.edit_after = { content: 'Updated team', ign: 'Opponent' };
        validateControls(await child.queuePayload(0, OWNER));
    }
    const click = interaction(`pvp-scout-review:edit:${OWNER}:${ID}:0:silver`);
    let modal;
    click.showModal = async value => { modal = value.toJSON(); };
    await command.handleButton(click);
    assert.equal(modal.custom_id, `pvp-scout-review:modal:${OWNER}:${ID}:0:silver`);
    assert.ok(modal.custom_id.length <= 100);
});

test('Silver report and source panels keep all controls and modal submissions scoped', async () => {
    const cfg = config(), reports = new ScoutReportManagerRegistry(cfg), manager = reports.forServer('silver');
    const root = reportSource(), sources = [root, ...Array.from({ length: 27 }, (_, index) =>
        reportSource(`manual_${String(index).padStart(20, '0')}`))];
    manager.admin.get = async () => ({ root, sources });
    manager.admin.list = async () => ({ rows: sources.slice(0, 25), total: 28 });
    validateControls(await manager.listPanel(OWNER));
    const detail = await manager.detailPanel(OWNER, ID, '', 0, sources.at(-1).message_id);
    validateControls(detail);
    const detailSession = [...manager.sessions.values()].find(value => value.kind === 'detail');
    for (const section of ['details', 'source', 'images']) {
        assert.match(manager.editModal(OWNER, detailSession, section).toJSON().custom_id, /:silver$/u);
    }
    assert.match(manager.searchModal(OWNER).toJSON().custom_id, /:silver$/u);
    const sourcesManager = sourceManagerFor(cfg).forServer('silver');
    sourcesManager.admin.get = async () => ({ root, source: sources.at(-1), sources, versions: {} });
    validateControls(await sourcesManager.panel(OWNER, sources.at(-1).message_id));
    const session = [...sourcesManager.sessions.values()][0];
    for (const kind of ['move', 'edit', 'detach', 'add-id', 'add-text']) {
        assert.match(sourcesManager.modal(OWNER, session, kind).toJSON().custom_id, /:silver$/u);
    }
    validateControls(sourcesManager.confirmation(OWNER, session, { root: { ...root, message_id: 'another' }, versions: {} }));
});
