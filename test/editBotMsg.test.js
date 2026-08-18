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
