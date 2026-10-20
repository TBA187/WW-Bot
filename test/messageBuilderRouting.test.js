/**
 * @fileoverview Verify command, button, select-menu and modal routing for the message-builder package.
 * Exercise interaction ownership and session routing without connecting to Discord.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionHandler } = require('../app/interactionRouter.js');
const { InteractionDiagnostics, setInteractionContext } = require('../utils/interactionDiagnostics.js');

test('the application router dispatches message-builder buttons, channel selections and modals before unrelated handlers', async () => {
    for (const [kind, method] of [['button', 'handleButton'], ['channel', 'handleSelect'], ['string', 'handleSelect'], ['modal', 'handleModal']]) {
        const calls = [];
        const builder = { [method]: async interaction => { calls.push(interaction); return true; } };
        const unexpected = () => assert.fail('The builder must be dispatched first');
        const handler = createInteractionHandler({
            lifecycle: { stopping: false },
            interactionDiagnostics: { track() {}, describe() {} },
            commandMap: new Map([['unrelated', {
                handleButton: unexpected, handleSelect: unexpected, handleModal: unexpected
            }], ['send_message', builder]]),
            forumFeedbackButton: unexpected
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

test('the actual router reports expired crowns with timing and retry guidance, and redacts other acknowledgement errors', async () => {
    for (const [code, waitMs] of [[10062, 3508], [40060, 3508], ['ECONNRESET', 3508], ['ECONNRESET', 350]]) {
        let elapsed = 0;
        const printed = [], replies = [];
        const consoleObject = { warn: (...args) => printed.push(args), error: (...args) => printed.push(args) };
        const diagnostics = new InteractionDiagnostics({ consoleObject, now: () => 1000, clock: () => elapsed,
            eventLoopUtilization: () => ({ active: 0 }) });
        const interaction = {
            id: '123', commandName: 'pvp_crown', channelId: 'silver-channel', createdTimestamp: 807, user: { id: 'officer' },
            isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false,
            isUserSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => false,
            isMessageContextMenuCommand: () => false, isChatInputCommand: () => true,
            deferReply: async () => {
                elapsed = waitMs;
                throw Object.assign(new Error('https://discord.com/api/interactions/123/private-token/callback private-secret'), { code, status: 404 });
            },
            reply: async payload => { replies.push(payload); }
        };
        const crown = { execute: async i => {
            setInteractionContext(i, { server: 'Silver', targetId: 'winner', phase: 'acknowledging crown', crownSaved: false });
            await i.deferReply();
            assert.fail('A rejected acknowledgement must not start crown processing');
        } };
        const handler = createInteractionHandler({
            lifecycle: { stopping: false }, interactionDiagnostics: diagnostics, botDiagnostics: { secrets: ['private-secret'] },
            commandMap: new Map([['pvp_crown', crown]]), consoleObject });
        await handler(interaction);
        assert.equal(printed.length, 1);
        const output = JSON.stringify(printed);
        assert.ok(output.includes(`${waitMs} ms awaiting acknowledgement`));
        assert.ok(output.includes(`${waitMs + 193} ms old after acknowledgement`));
        assert.match(output, /server Silver/u);
        assert.doesNotMatch(output, /private-token|private-secret/u);
        if (code === 10062) {
            assert.match(output, /No crown or defense was recorded.*Retry the command/u);
            assert.equal(replies.length, 0);
        } else if (code === 40060) {
            assert.match(output, /Check \/pvp_history before retrying/u);
            assert.doesNotMatch(output, /Retry the command/u);
            assert.equal(replies.length, 0);
        } else {
            assert.equal(replies.length, waitMs < 3000 ? 1 : 0);
        }
    }
});
