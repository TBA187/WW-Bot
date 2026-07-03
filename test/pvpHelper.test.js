const assert = require('node:assert/strict');
const test = require('node:test');

const {
    memberHasAnyRole,
    refreshGuildMembers,
    requireAnyRole,
    requirePvpChannel,
    replyMissingMemberOption,
    resolveSinglePvpKing,
    stopIfOnCooldown
} = require('../commands/pvp-king/utils/pvpHelper.js');

function roleCache(ids) {
    return {
        some(fn) {
            return ids.some(id => fn({ id }));
        }
    };
}

function memberCollection(members) {
    return {
        size: members.length,
        first() {
            return members[0] ?? null;
        }
    };
}

function fakeGuild(kingMembers = []) {
    return {
        channels: {
            cache: {
                get(id) {
                    return id === 'log'
                        ? { send: async () => null }
                        : null;
                }
            }
        },
        roles: {
            cache: {
                get(id) {
                    return id === 'king-role'
                        ? { id, members: memberCollection(kingMembers) }
                        : null;
                }
            }
        },
        members: {
            fetch: async () => null
        }
    };
}

test('memberHasAnyRole detects allowed roles', () => {
    const member = { roles: { cache: roleCache(['a', 'b']) } };

    assert.equal(memberHasAnyRole(member, ['b', 'c']), true);
    assert.equal(memberHasAnyRole(member, ['x']), false);
});

test('requireAnyRole replies when member lacks permission', async () => {
    const replies = [];
    const interaction = {
        member: { roles: { cache: roleCache(['member']) } },
        reply: async payload => replies.push(payload)
    };

    assert.equal(await requireAnyRole(interaction, ['admin']), false);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, '### ❌  No permission!');
});

test('requirePvpChannel blocks wrong channels', async () => {
    const replies = [];
    const interaction = {
        channelId: 'wrong',
        reply: async payload => replies.push(payload)
    };

    assert.equal(await requirePvpChannel(interaction, 'right', 'pvp_crown'), false);
    assert.equal(replies[0].content, '### ❌  The `/pvp_crown` command can only be used in <#right>');
});

test('replyMissingMemberOption allows custom missing-user messages', async () => {
    const replies = [];
    const interaction = {
        options: {
            getMember() {
                return null;
            }
        },
        reply: async payload => replies.push(payload)
    };

    const member = await replyMissingMemberOption(interaction, 'target', 'custom missing user');

    assert.equal(member, null);
    assert.equal(replies[0].content, 'custom missing user');
});

test('stopIfOnCooldown replies and stops when command is cooling down', async () => {
    const replies = [];
    const interaction = {
        user: { id: 'user' },
        reply: async payload => replies.push(payload)
    };

    const stopped = await stopIfOnCooldown(interaction, () => true, 'pvp_test', 2);

    assert.equal(stopped, true);
    assert.equal(replies[0].content, '### ⏳ Slow down!');
});

function fakeInteraction(kingMembers = []) {
    const edits = [];

    return {
        guild: fakeGuild(kingMembers),
        editReply: async payload => edits.push(payload),
        edits
    };
}

test('resolveSinglePvpKing handles zero, one, and multiple kings', async () => {
    const noKingInteraction = fakeInteraction([]);
    const oneKingInteraction = fakeInteraction([{ id: 'king' }]);
    const manyKingsInteraction = fakeInteraction([{ id: 'a' }, { id: 'b' }]);

    const noKing = await resolveSinglePvpKing(noKingInteraction, {
        logChannelID: 'log',
        pvpKingRoleID: 'king-role',
        ownerID: 'owner',
        noKingReply: 'no king',
        multipleKingsReply: 'many kings'
    });

    const oneKing = await resolveSinglePvpKing(oneKingInteraction, {
        logChannelID: 'log',
        pvpKingRoleID: 'king-role',
        ownerID: 'owner'
    });

    const manyKings = await resolveSinglePvpKing(manyKingsInteraction, {
        logChannelID: 'log',
        pvpKingRoleID: 'king-role',
        ownerID: 'owner',
        noKingReply: 'no king',
        multipleKingsReply: 'many kings'
    });

    assert.equal(noKing.ok, false);
    assert.equal(noKing.reason, 'no_king');
    assert.equal(oneKing.ok, true);
    assert.equal(oneKing.currentKing.id, 'king');
    assert.equal(manyKings.ok, false);
    assert.equal(manyKings.reason, 'multiple_kings');
    assert.equal(noKingInteraction.edits[0].content, 'no king');
    assert.equal(manyKingsInteraction.edits[0].content, 'many kings');
});

test('resolveSinglePvpKing does not refresh all members when the king is cached', async () => {
    let fetchCount = 0;
    const interaction = fakeInteraction([{ id: 'king' }]);
    interaction.guild.members.fetch = async () => {
        fetchCount++;
    };

    const result = await resolveSinglePvpKing(interaction, {
        logChannelID: 'log',
        pvpKingRoleID: 'king-role',
        ownerID: 'owner',
        contextLabel: '/pvp_challenge'
    });

    assert.equal(result.ok, true);
    assert.equal(result.currentKing.id, 'king');
    assert.equal(fetchCount, 0);
});

test('refreshGuildMembers catches refresh failures', async () => {
    const oldError = console.error;
    console.error = () => { };
    const guild = {
        members: {
            fetch: async () => {
                const err = new Error('rate limited');
                err.code = 'RATE_LIMITED';
                throw err;
            }
        }
    };

    try {
        await assert.doesNotReject(() => refreshGuildMembers(guild, 'unit test'));
    } finally {
        console.error = oldError;
    }
});
