const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    GIVEAWAY_ACTIVE,
    GIVEAWAY_ENDED,
    createGiveawayStore,
    endGiveaway,
    giveawayEndedWithinRerollWindow,
    handleGiveawayButton,
    mergeGiveawaySyncState
} = require('../events/giveaways.js');

function tempDataFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-giveaways-'));
    return path.join(directory, 'giveaways.json');
}

function giveaway(overrides = {}) {
    return {
        giveaway_id: 'giveaway-1',
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        message_id: null,
        prize: 'Prize',
        winners_total: 1,
        status: GIVEAWAY_ACTIVE,
        starts_at: '2026-08-18T00:00:00.000Z',
        ends_at: '2026-08-18T01:00:00.000Z',
        ended_at: null,
        winner_user_ids: [],
        ...overrides
    };
}

function emptyClient() {
    return {
        channels: {
            cache: { get: () => null },
            fetch: async () => null
        }
    };
}

function lifecycleStore(initialGiveaway, { entries = [], draws = [] } = {}) {
    let current = { ...initialGiveaway };
    const savedDraws = [...draws];
    return {
        savedDraws,
        async getGiveaway() {
            return { ...current };
        },
        async listEntries() {
            return entries.map(entry => ({ ...entry }));
        },
        async listDraws() {
            return savedDraws.map(draw => ({ ...draw }));
        },
        async saveDraw(_, draw) {
            savedDraws.push({ ...draw });
            return { ...draw };
        },
        async updateGiveaway(_, updates) {
            current = { ...current, ...updates };
            return { ...current };
        }
    };
}

test('concurrent end attempts create one draw and keep the same winners', async () => {
    const initial = giveaway();
    const store = lifecycleStore(initial, {
        entries: [
            { giveaway_id: initial.giveaway_id, user_id: 'user-1', joined_at: initial.starts_at, left_at: null },
            { giveaway_id: initial.giveaway_id, user_id: 'user-2', joined_at: initial.starts_at, left_at: null }
        ]
    });
    const config = { giveawayStore: store };

    const [first, second] = await Promise.all([
        endGiveaway(emptyClient(), config, initial, { drawType: 'end' }),
        endGiveaway(emptyClient(), config, initial, { drawType: 'end' })
    ]);

    assert.equal(store.savedDraws.length, 1);
    assert.equal(first[0].status, GIVEAWAY_ENDED);
    assert.equal(second[0].status, GIVEAWAY_ENDED);
    assert.deepEqual(first[1], second[1]);
});

test('an unfinished end draw is resumed instead of selecting a second winner', async () => {
    const initial = giveaway();
    const previousDraw = {
        draw_id: 'giveaway-1:end:previous',
        giveaway_id: initial.giveaway_id,
        draw_type: 'end',
        drawn_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-2']
    };
    const store = lifecycleStore(initial, { draws: [previousDraw] });

    const [ended, winnerIds] = await endGiveaway(emptyClient(), { giveawayStore: store }, initial, {
        drawType: 'end'
    });

    assert.equal(store.savedDraws.length, 1);
    assert.equal(ended.status, GIVEAWAY_ENDED);
    assert.deepEqual(winnerIds, ['user-2']);
});

test('a stale Join button cannot add an entry after the giveaway has ended', async () => {
    const ended = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-1']
    });
    let savedEntries = 0;
    const store = {
        async getByMessageId() {
            // Discord can hand us an interaction from the old, still-visible button.
            return [ended.giveaway_id, { ...giveaway(), message_id: 'message-1' }];
        },
        async getGiveaway() {
            return { ...ended };
        },
        async saveEntry() {
            savedEntries += 1;
        }
    };
    const replies = [];
    const interaction = {
        customId: 'ww_giveaway:join_leave',
        user: { id: 'user-2', bot: false },
        message: { id: 'message-1' },
        member: { id: 'user-2', roles: { cache: { some: () => false } } },
        deferReply: async () => {},
        editReply: async content => replies.push(content)
    };

    await handleGiveawayButton(interaction, { giveawayStore: store });

    assert.equal(savedEntries, 0);
    assert.deepEqual(replies, ['This giveaway is no longer active.']);
});

test('a stale active JSON fallback cannot reopen an ended MySQL giveaway', () => {
    const local = giveaway({ status: GIVEAWAY_ACTIVE });
    const remote = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-1']
    });

    assert.deepEqual(mergeGiveawaySyncState(local, remote), remote);
});

test('a terminal fallback update can still close an active MySQL giveaway', () => {
    const local = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-2']
    });
    const remote = giveaway({ status: GIVEAWAY_ACTIVE });

    assert.deepEqual(mergeGiveawaySyncState(local, remote), local);
});

test('a failed slash-command response never falls back to replying to the giveaway message', async () => {
    const initial = giveaway({ message_id: null });
    const store = lifecycleStore(initial, {
        entries: [{ giveaway_id: initial.giveaway_id, user_id: 'user-1', joined_at: initial.starts_at, left_at: null }]
    });
    let sentToChannel = 0;
    const client = {
        channels: {
            cache: {
                get: () => ({
                    send: async () => { sentToChannel += 1; }
                })
            },
            fetch: async () => null
        }
    };
    const interaction = {
        deferred: true,
        replied: false,
        editReply: async () => {
            throw new Error('interaction expired');
        }
    };

    await endGiveaway(client, { giveawayStore: store }, initial, {
        drawType: 'end',
        announceInteraction: interaction
    });

    assert.equal(sentToChannel, 0);
});

class MirrorDb {
    constructor(records) {
        this.records = records;
        this.fail = false;
    }

    async query(sql, params = []) {
        if (this.fail) throw Object.assign(new Error('database unavailable'), { code: 'ECONNRESET' });
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.startsWith('select giveaway_json from giveaways')) {
            return [this.records.giveaways.map(record => ({ giveaway_json: JSON.stringify(record) }))];
        }
        if (normalized.startsWith('select entry_json from giveaway_entries')) {
            const giveawayId = String(params[0]);
            return [(this.records.entries[giveawayId] || []).map(record => ({ entry_json: JSON.stringify(record) }))];
        }
        if (normalized.startsWith('select draw_json from giveaway_draws')) {
            const giveawayId = String(params[0]);
            return [(this.records.draws[giveawayId] || []).map(record => ({ draw_json: JSON.stringify(record) }))];
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
    }
}

test('the recovery mirror keeps active and recent giveaway entries and draws available during an outage', async () => {
    const active = giveaway({ giveaway_id: 'active' });
    const recent = giveaway({
        giveaway_id: 'recent',
        status: GIVEAWAY_ENDED,
        ended_at: new Date().toISOString(),
        winner_user_ids: ['user-2']
    });
    const old = giveaway({
        giveaway_id: 'old',
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-01T00:00:00.000Z',
        winner_user_ids: ['user-3']
    });
    const db = new MirrorDb({
        giveaways: [active, recent, old],
        entries: {
            active: [{ giveaway_id: 'active', user_id: 'user-1', joined_at: active.starts_at, left_at: null }],
            recent: [{ giveaway_id: 'recent', user_id: 'user-2', joined_at: recent.starts_at, left_at: null }],
            old: [{ giveaway_id: 'old', user_id: 'user-3', joined_at: old.starts_at, left_at: null }]
        },
        draws: {
            active: [],
            recent: [{ draw_id: 'recent:end', giveaway_id: 'recent', draw_type: 'end', drawn_at: recent.ended_at, winner_user_ids: ['user-2'] }],
            old: [{ draw_id: 'old:end', giveaway_id: 'old', draw_type: 'end', drawn_at: old.ended_at, winner_user_ids: ['user-3'] }]
        }
    });
    const file = tempDataFile();
    const savedEnvironment = {
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_NAME: process.env.DB_NAME
    };
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'bot';
    process.env.DB_NAME = 'ww_bot';

    try {
        const store = createGiveawayStore({ db, dataFile: file });
        await store.restore();

        const mirror = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(Object.keys(mirror.giveaways).sort(), ['active', 'old', 'recent']);
        assert.deepEqual(Object.keys(mirror.entries).sort(), ['active', 'recent']);
        assert.deepEqual(Object.keys(mirror.draws).sort(), ['recent:end']);

        db.fail = true;
        assert.deepEqual((await store.listEntries('active', { activeOnly: true })).map(entry => entry.user_id), ['user-1']);
        assert.deepEqual((await store.listDraws('recent')).map(draw => draw.draw_id), ['recent:end']);
    } finally {
        for (const [key, value] of Object.entries(savedEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('rerolls reject giveaways that ended more than 48 hours ago', () => {
    assert.equal(giveawayEndedWithinRerollWindow(giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-15T00:00:00.000Z'
    }), new Date('2026-08-18T01:00:00.000Z')), false);
    assert.equal(giveawayEndedWithinRerollWindow(giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-17T01:00:00.000Z'
    }), new Date('2026-08-18T01:00:00.000Z')), true);
});
