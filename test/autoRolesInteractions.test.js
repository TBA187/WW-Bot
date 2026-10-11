// Accept role-panel requests before channel fetches or color image preparation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageFlags } = require('discord.js');
const sharp = require('sharp');
const AutoRoles = require('../commands/auto_roles.js');
const { findAutoRolePanel, handleAutoRoleButton, handleAutoRoleSelect, handleAutoRoleModal } = require('../events/auto_roles.js');

function panelRequest() {
    const calls = [];
    const interaction = {
        commandName: 'auto_roles_send', calls,
        member: { roles: { cache: new Collection([['admin', { id: 'admin' }]]) } },
        options: { getString: () => 'color_roles', getChannel: () => null },
        client: { channels: { cache: new Collection(), async fetch() { calls.push('fetch'); return null; } } },
        async deferReply(payload) { calls.push(['defer', payload]); this.deferred = true; },
        async editReply(payload) { calls.push(['edit', payload]); },
        async reply(payload) { calls.push(['reply', payload]); }
    };
    return interaction;
}

function defaultPanelChannel(t) {
    const panel = findAutoRolePanel('color_roles'), original = panel.defaultChannelId;
    panel.defaultChannelId = '123456789012345678';
    t.after(() => { panel.defaultChannelId = original; });
}

test('role panel acknowledges before fetching an uncached default channel', async t => {
    defaultPanelChannel(t);
    const interaction = panelRequest();
    let accept;
    const gate = new Promise(resolve => { accept = resolve; });
    interaction.deferReply = payload => {
        interaction.calls.push(['defer', payload]);
        return gate.then(() => { interaction.deferred = true; });
    };
    const pending = new AutoRoles({ adminRoleID: 'admin' }).execute(interaction);
    assert.deepEqual(interaction.calls, [['defer', { flags: MessageFlags.Ephemeral }]]);
    accept(); await pending;
    assert.deepEqual(interaction.calls.map(call => typeof call === 'string' ? call : call[0]), ['defer', 'fetch', 'edit']);
    assert.match(interaction.calls[2][1].content, /Please choose a channel/u);
});

test('expired role-panel acknowledgement stops before default channel fetch or send', async t => {
    defaultPanelChannel(t);
    const interaction = panelRequest();
    interaction.deferReply = async () => { throw Object.assign(Error('Unknown interaction'), { code: 10062 }); };
    await assert.rejects(new AutoRoles({ adminRoleID: 'admin' }).execute(interaction), error => error.code === 10062);
    assert.deepEqual(interaction.calls, []);
});

function colorRequest(userId) {
    const calls = [];
    return {
        id: `click-${userId}`, user: { id: userId }, guildId: 'guild', guild: { features: [] }, channelId: 'channel', calls,
        customId: 'ww:auto_roles:color_roles:select:0', values: ['ice'],
        message: { id: 'panel', components: [], async edit() { calls.push('panel'); } },
        async deferReply(payload) { calls.push(['defer', payload]); this.deferred = true; },
        async editReply(payload) { calls.push(['edit', payload]); },
        async deleteReply() { calls.push('delete'); },
        async reply(payload) { calls.push(['reply', payload]); },
        async deferUpdate() { calls.push('deferUpdate'); this.deferred = true; }
    };
}

test('color selection acknowledges before replacing a preview or rendering its PNG', async t => {
    const rendered = [];
    t.mock.method(sharp.prototype, 'toBuffer', async () => { rendered.push('render'); return Buffer.from('preview'); });
    const first = colorRequest('preview-replacement');
    await handleAutoRoleSelect(first);
    first.calls.length = 0; rendered.length = 0;
    const next = colorRequest(first.user.id);
    let accept;
    const gate = new Promise(resolve => { accept = resolve; });
    next.deferReply = payload => {
        next.calls.push(['defer', payload]);
        return gate.then(() => { next.deferred = true; });
    };
    const pending = handleAutoRoleSelect(next);
    assert.deepEqual(next.calls, [['defer', { flags: MessageFlags.Ephemeral }]]);
    assert.deepEqual(first.calls, []);
    assert.deepEqual(rendered, []);
    accept(); await pending;
    assert.deepEqual(first.calls, ['delete']);
    assert.deepEqual(rendered, ['render']);
    assert.deepEqual(next.calls.map(call => typeof call === 'string' ? call : call[0]), ['defer', 'edit', 'panel']);
    assert.equal(next.calls[1][1].files[0].name, 'role-color-preview.png');
    const close = colorRequest(first.user.id);
    close.customId = 'ww:auto_roles:color_roles:dismiss';
    await handleAutoRoleButton(close);
});

test('expired color-preview acknowledgement stops before PNG preparation', async t => {
    const render = t.mock.method(sharp.prototype, 'toBuffer', async () => Buffer.from('preview'));
    const interaction = colorRequest('expired-preview');
    interaction.deferReply = async () => { throw Object.assign(Error('Unknown interaction'), { code: 10062 }); };
    await assert.rejects(handleAutoRoleSelect(interaction), error => error.code === 10062);
    assert.equal(render.mock.calls.length, 0);
    assert.deepEqual(interaction.calls, []);
});

test('custom color modal opener responds with the modal directly', async () => {
    const interaction = colorRequest('modal-opener');
    interaction.customId = 'ww:auto_roles:color_roles:modal:solid';
    interaction.showModal = async payload => { interaction.replied = true; interaction.calls.push(['modal', payload]); };
    await handleAutoRoleButton(interaction);
    assert.deepEqual(interaction.calls.map(call => typeof call === 'string' ? call : call[0]), ['modal', 'panel']);
});

test('custom color modal submission defers privately before image rendering', async t => {
    const interaction = colorRequest('modal-submission');
    interaction.customId = 'ww:auto_roles:color_roles:modal_submit:solid';
    interaction.fields = { getTextInputValue: () => '#5865F2' };
    t.mock.method(sharp.prototype, 'toBuffer', async () => {
        assert.equal(interaction.deferred, true); return Buffer.from('preview');
    });
    await handleAutoRoleModal(interaction);
    assert.deepEqual(interaction.calls.map(call => typeof call === 'string' ? call : call[0]), ['defer', 'edit']);
    const close = colorRequest(interaction.user.id);
    close.customId = 'ww:auto_roles:color_roles:dismiss';
    await handleAutoRoleButton(close);
});
