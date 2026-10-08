/**
 * @fileoverview Verify command, button, select-menu and modal routing for the message-builder package.
 * Exercise interaction ownership and session routing without connecting to Discord.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the actual index router dispatches message-builder buttons, channel selections and modals before unrelated handlers', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const interactionSource = source.slice(source.indexOf("client.on('interactionCreate'"), source.lastIndexOf('\nbootstrap();'));
    for (const [kind, method] of [['button', 'handleButton'], ['channel', 'handleSelect'], ['string', 'handleSelect'], ['modal', 'handleModal']]) {
        let handler;
        const calls = [];
        const builder = { [method]: async interaction => { calls.push(interaction); return true; } };
        const unexpected = () => assert.fail('The builder must be dispatched first');
        vm.runInNewContext(interactionSource, {
            client: { on: (event, callback) => { assert.equal(event, 'interactionCreate'); handler = callback; } },
            lifecycle: { stopping: false },
            commandMap: new Map([['unrelated', {
                handleButton: unexpected, handleSelect: unexpected, handleModal: unexpected
            }], ['send_message', builder]]),
            handleGuildForumFeedbackButton: unexpected,
            console, Date, Set, MessageFlags: { Ephemeral: 64 }
        });
        const interaction = {
            customId: kind === 'modal' ? 'send_message:modal:session:title' : 'send_message:session:action',
            isAutocomplete: () => false,
            isButton: () => kind === 'button',
            isStringSelectMenu: () => kind === 'string',
            isUserSelectMenu: () => false,
            isChannelSelectMenu: () => kind === 'channel',
            isModalSubmit: () => kind === 'modal'
        };
        await handler(interaction);
        assert.deepEqual(calls, [interaction]);
    }
});
