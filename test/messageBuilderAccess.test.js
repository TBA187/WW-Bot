// Message-builder controls recheck staff membership when an existing preview is used.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageFlags } = require('discord.js');
const SendMessage = require('../commands/send_message.js');

for (const method of ['handleButton', 'handleSelect', 'handleModal']) {
    test(`${method} rejects a builder owner whose staff role was removed`, async () => {
        const command = new SendMessage({ officerRoleID: 'officer' });
        command.controller[method] = () => assert.fail('Unauthorized control reached the builder');
        const replies = [];
        const interaction = { customId: 'send_message:session:action', user: { id: 'owner' },
            member: { roles: { cache: new Collection() } }, async reply(payload) { replies.push(payload); } };
        assert.equal(await command[method](interaction), true);
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
        assert.match(replies[0].content, /No permission/);
    });

    test(`${method} preserves staff controls and ignores unrelated component IDs`, async () => {
        const command = new SendMessage({ officerRoleID: 'officer' });
        let handled = 0;
        command.controller[method] = async () => { handled++; return true; };
        const interaction = { customId: 'send_message:session:action', member: { roles: ['officer'] } };
        assert.equal(await command[method](interaction), true);
        assert.equal(await command[method]({ customId: 'unrelated' }), false);
        assert.equal(handled, 1);
    });
}
