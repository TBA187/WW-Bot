// Checks loading responses and control restoration during scout navigation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withButtonLoading } = require('../utils/interactionLoading.js');

test('modal interactions can show a loading status before the final result', async () => {
    const calls = [];
    const interaction = {
        async deferReply(options) { calls.push(['defer', options]); },
        async editReply(payload) { calls.push(['edit', payload]); }
    };

    await withButtonLoading(interaction, async () => {
        calls.push(['work']);
        return { content: 'Search results', embeds: [], components: [] };
    }, { loadingContent: 'Searching scouts…' });

    assert.deepEqual(calls.map(([kind]) => kind), ['defer', 'edit', 'work', 'edit']);
    assert.equal(calls[1][1].content, 'Searching scouts…');
    assert.equal(calls[3][1].content, 'Search results');
});
