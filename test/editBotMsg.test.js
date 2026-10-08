const test = require('node:test');
const assert = require('node:assert/strict');

const EditBotMsg = require('../commands/edit_bot_msg.js');

test('/edit_bot_msg acknowledges the interaction before fetching the target message', async () => {
    const calls = [];
    const command = new EditBotMsg({
        adminRoleID: 'admin-role',
        blockedEditBotMsgChannels: [],
        onCooldown: () => false
    });
    const interaction = {
        user: { id: 'admin-user' },
        member: {
            roles: {
                cache: {
                    some: callback => callback({ id: 'admin-role' })
                }
            }
        },
        options: {
            getString: name => ({
                channel_id: 'channel-id',
                message_id: 'message-id',
                content: 'Updated message'
            })[name]
        },
        client: {
            user: { id: 'bot-user' },
            channels: {
                fetch: async () => {
                    calls.push('fetch-channel');
                    return {
                        messages: {
                            fetch: async () => {
                                calls.push('fetch-message');
                                return {
                                    author: { id: 'bot-user' },
                                    edit: async () => calls.push('edit-message')
                                };
                            }
                        }
                    };
                }
            }
        },
        deferReply: async () => calls.push('defer-reply'),
        editReply: async content => calls.push(`edit-reply:${content}`)
    };

    await command.handleSlash(interaction);

    assert.deepEqual(calls, [
        'defer-reply',
        'fetch-channel',
        'fetch-message',
        'edit-message',
        'edit-reply:### ✅  Message edited!'
    ]);
});

const { Collection, MessageFlags, MessageFlagsBitField } = require('discord.js');

function fixture(role = 'officer-role', config = {}) {
    const calls = [];
    const message = {
        id: '123', channelId: '456', content: 'Old text  \n', embeds: [],
        attachments: new Collection([['file-id', { id: 'file-id', name: 'guide.txt' }]]),
        author: { id: 'bot-user' }, url: 'https://discord.com/channels/guild/456/123',
        edit: async payload => calls.push(['edit-message', payload])
    };
    const channel = { id: '456', messages: { fetch: async () => message } };
    const command = new EditBotMsg({
        leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role',
        onCooldown: () => false, ...config
    });
    const interaction = {
        user: { id: 'officer-user', username: 'Officer' },
        member: { roles: { cache: new Collection([[role, { id: role }]]) } },
        targetMessage: message,
        options: { getString: name => ({ channel_id: '456', message_id: '123', content: 'New\\ntext' })[name] },
        client: { user: { id: 'bot-user' }, channels: { fetch: async () => channel } },
        reply: async payload => calls.push(['reply', payload]),
        editReply: async payload => calls.push(['edit-reply', payload]),
        deferReply: async payload => calls.push(['defer-reply', payload]),
        deferUpdate: async () => calls.push(['defer-update']),
        update: async payload => calls.push(['update', payload]),
        showModal: async modal => calls.push(['modal', modal])
    };
    return { command, interaction, calls, message, channel };
}

async function previewEdit(state, values) {
    const modal = {
        ...state.interaction,
        customId: 'editMsg_123_456',
        fields: { getTextInputValue: name => ({ append: 'N', content: '', embed: '', ...values })[name] }
    };
    await state.command.handleModal(modal);
    const reply = state.calls.at(-1)[1];
    return reply.components[0].toJSON().components.map(component => component.custom_id);
}

test('the message context menu and slash command allow Leader, Admin and Officer roles', async () => {
    for (const role of ['leader-role', 'admin-role', 'officer-role']) {
        const state = fixture(role);
        await state.command.handleSlash(state.interaction);
        assert.deepEqual(state.calls.find(([type]) => type === 'edit-message')[1], { content: 'New\ntext' });
        await state.command.handleContext(state.interaction);
        assert.equal(state.calls.at(-1)[1].toJSON().title, 'Edit Bot Message (Officer)');
    }
    assert.equal(fixture().command.data[1].toJSON().name, 'Edit Bot Message (Officer)');
});

test('the editor denies other roles and blocked channels before fetching', async () => {
    for (const state of [fixture('member-role'), fixture('officer-role', { blockedEditBotMsgChannels: ['456'] })]) {
        state.interaction.client.channels.fetch = () => assert.fail('Must not fetch');
        await state.command.handleSlash(state.interaction);
        assert.equal(state.calls[0][1].flags, MessageFlags.Ephemeral);
        assert.match(state.calls[0][1].content, /No permission|not allowed in this channel/);
    }
});

test('confirmation preserves old content when empty and appends below trimmed old content', async () => {
    for (const [append, content, expected] of [
        ['N', '', 'Old text  \n'], ['Y', 'Extra text', 'Old text\nExtra text'], ['N', 'Replacement', 'Replacement']
    ]) {
        const state = fixture();
        const [confirmId] = await previewEdit(state, { append, content });
        await state.command.handleButton({ ...state.interaction, customId: confirmId });
        assert.equal(state.calls.find(([type]) => type === 'edit-message')[1].content, expected);
        assert.equal(state.calls.at(-1)[1].content, '### ✅  Bot message successfully updated!');
        assert.equal(state.interaction.client.editCache.size, 0);
    }
});

test('confirmation can add a JSON embed while preserving unrelated attachments and applying WW branding', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { embed: '{"title":"New embed"}' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.content, 'Old text  \n');
    assert.equal(payload.embeds[0].toJSON().title, 'New embed');
    assert.equal(payload.embeds[0].toJSON().footer.icon_url, 'attachment://ww_logo.png');
    assert.equal(payload.attachments[0].id, 'file-id');
    assert.equal(payload.files[0].name, 'ww_logo.png');
});

test('invalid JSON leaves the original message unchanged and keeps its existing error text', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { embed: '{"broken":' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
    assert.equal(state.calls.at(-1)[1].content, '❌ Invalid embed JSON.');
});

test('parallel confirmation previews remain independent and only their owner can confirm', async () => {
    const state = fixture();
    const [firstId] = await previewEdit(state, { content: 'First' });
    const [secondId, secondCancel] = await previewEdit(state, { content: 'Second' });
    assert.notEqual(firstId, secondId);
    await state.command.handleButton({ ...state.interaction, user: { id: 'other-user' }, customId: firstId });
    assert.equal(state.calls.at(-1)[1].content, '### ❌  No permission!');
    assert.equal(state.interaction.client.editCache.size, 2);
    await state.command.handleButton({ ...state.interaction, customId: secondCancel });
    assert.equal(state.calls.at(-1)[1].content, '### ❌  Edit cancelled.');
    assert.equal(state.interaction.client.editCache.size, 1);
    await state.command.handleButton({ ...state.interaction, customId: firstId });
    assert.equal(state.calls.find(([type]) => type === 'edit-message')[1].content, 'First');
});

test('expired confirmations do not edit the message', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { content: 'Expired' });
    state.interaction.client.editCache.get(confirmId).expiresAt = Date.now() - 1;
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
    assert.equal(state.interaction.client.editCache.size, 0);
});

test('slash edits log the source diff with White Walker logo and survive unavailable log channels', async () => {
    const state = fixture('officer-role', { logChannelID: '789' });
    state.interaction.client.channels.fetch = async id => {
        if (id === '456') return state.channel;
        return { send: async payload => state.calls.push(['send-log', payload]) };
    };
    await state.command.handleSlash(state.interaction);
    const payload = state.calls.find(([type]) => type === 'send-log')[1];
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, '🤖  Bot Message Edited  ✏️');
    assert.equal(embed.footer.text, 'White Walker Logs');
    assert.equal(embed.footer.icon_url, 'attachment://ww_logo.png');
    assert.equal(embed.fields.at(-1).value, '```diff\n- Old text\n+ New\n+ text\n```');
    state.calls.length = 0;
    state.interaction.client.channels.fetch = async id => {
        if (id === '456') return state.channel;
        throw new Error('Log access unavailable');
    };
    await state.command.handleSlash(state.interaction);
    assert.equal(state.calls.at(-1)[1], '### ✅  Message edited!');
});

test('ignored log channels skip audit delivery', async () => {
    const state = fixture('officer-role', { logChannelID: '789', ignoredLogChannels: ['456'] });
    state.interaction.client.channels.fetch = async id => {
        assert.equal(id, '456');
        return state.channel;
    };
    await state.command.handleSlash(state.interaction);
    assert.equal(state.calls.at(-1)[1], '### ✅  Message edited!');
});

test('source diff preserves internal whitespace and added empty lines, and stays within embed field limits', () => {
    assert.equal(EditBotMsg.formatMessageDiff('one  \ntwo', 'one  \n\nthree'),
        '```diff\n  one  \n- two\n+ *[ADDED EMPTY LINE]*\n+ three\n```');
    const long = Array.from({ length: 250 }, (_, index) => 'Unchanged line ' + index).join('\n');
    const diff = EditBotMsg.formatMessageDiff(long + '\nOld', long + '\nNew');
    assert.ok(diff.length <= 1024);
    assert.match(diff, /250 unchanged lines/);
    assert.match(diff, /- Old\n\+ New/);
});


test('confirmed embed replacement restores manually suppressed embeds and preserves other flags', async () => {
    const state = fixture();
    state.message.flags = new MessageFlagsBitField([MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications]);
    const [confirmId] = await previewEdit(state, { embed: '{"title":"Replacement"}' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.embeds[0].toJSON().title, 'Replacement');
    assert.equal(payload.flags, MessageFlags.SuppressNotifications);
    assert.equal(state.message.flags.has(MessageFlags.SuppressEmbeds), true);
});

test('text-only confirmation leaves existing embed suppression unchanged', async () => {
    const state = fixture();
    state.message.flags = new MessageFlagsBitField(MessageFlags.SuppressEmbeds);
    const [confirmId] = await previewEdit(state, { content: 'Updated text' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.content, 'Updated text');
    assert.equal(Object.hasOwn(payload, 'flags'), false);
    assert.equal(state.message.flags.has(MessageFlags.SuppressEmbeds), true);
});
