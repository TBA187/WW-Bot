// Check server preference transactions without changing current/former membership history.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');

function fixture(initial = null, failUpdate = false) {
    let row = initial ? { ...initial } : null, backup;
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push('begin'); backup = row && { ...row }; },
        async query(sql, params) {
            const query = sql.trim().replace(/\s+/gu, ' '); calls.push({ query, params });
            if (query.startsWith('INSERT INTO guild_members')) {
                const [, id, username, globalName, nickname, normalized, status] = params;
                row = { ...row, discord_id: id, username, global_name: globalName,
                    server_nickname: nickname, server_nickname_normalized: normalized,
                    status: status === 'current' ? 'current' : row?.status || status,
                    selected_server: row?.selected_server || null };
                return [{ affectedRows: 1 }];
            }
            if (query.startsWith('SELECT selected_server')) return [[{ selected_server: row.selected_server }]];
            if (query.startsWith('UPDATE guild_members SET selected_server')) {
                if (failUpdate) throw new Error('Controlled write failure');
                row.selected_server = params[0]; return [{ affectedRows: 1 }];
            }
            throw new Error(`Unexpected preference SQL: ${query}`);
        },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); row = backup; },
        release() { calls.push('release'); }
    };
    const store = new ScoutRosterStore({ guildMemberRoleID: 'role', db: {
        async getConnection() { calls.push('connection'); return connection; },
        async query(sql, params) { calls.push({ query: sql, params }); return [row ? [{ ...row }] : []]; }
    } });
    store.schemaReady = true;
    return { store, calls, row: () => row };
}

function member(current = true) {
    return { user: { id: 'user', username: 'Account', globalName: 'Global' }, nickname: 'IGN',
        roles: { cache: new Set(current ? ['role'] : []) } };
}

test('a new guild member gets a profile and one server, which can be switched or cleared', async () => {
    const f = fixture();
    assert.deepEqual(await f.store.setSelectedServer('guild', member(), 'gold', { toggle: true }), { previous: null, selected: 'gold' });
    assert.equal(f.row().status, 'current'); assert.equal(f.row().server_nickname, 'IGN');
    assert.deepEqual(await f.store.setSelectedServer('guild', member(), 'silver', { toggle: true }), { previous: 'gold', selected: 'silver' });
    assert.deepEqual(await f.store.setSelectedServer('guild', member(), 'silver', { toggle: true }), { previous: 'silver', selected: null });
    assert.equal(f.row().selected_server, null);
    assert.equal(f.calls.filter(call => call === 'commit').length, 3);
    assert.equal(f.calls.filter(call => call === 'release').length, 3);
    assert.ok(f.calls.some(call => call.query?.endsWith('FOR UPDATE')));
});

test('settings-only accounts stay other, and former members retain their history', async () => {
    const other = fixture();
    await other.store.setSelectedServer('guild', member(false), 'gold', { toggle: true });
    assert.equal(other.row().status, 'other');
    const former = fixture({ status: 'former', first_seen_at: 'original', former_at: 'original departure', selected_server: 'gold' });
    await former.store.setSelectedServer('guild', member(false), 'silver', { toggle: true });
    assert.equal(former.row().status, 'former'); assert.equal(former.row().former_at, 'original departure');
    assert.equal(former.row().first_seen_at, 'original');
});

test('an officer with no prior membership can later become a current guild member', async () => {
    const f = fixture({ status: 'other', selected_server: 'silver' });
    await f.store.setSelectedServer('guild', member(), 'gold', { toggle: true });
    assert.equal(f.row().status, 'current'); assert.equal(f.row().selected_server, 'gold');
});

test('failed preference writes roll back the profile and always release the connection', async () => {
    const f = fixture({ status: 'former', selected_server: 'gold' }, true);
    await assert.rejects(f.store.setSelectedServer('guild', member(), 'silver', { toggle: true }), /Controlled write failure/u);
    assert.deepEqual(f.row(), { status: 'former', selected_server: 'gold' });
    assert.deepEqual(f.calls.slice(-2), ['rollback', 'release']);
    assert.equal(f.calls.includes('commit'), false);
});

test('stored preferences are available by guild/user and invalid servers never access storage', async () => {
    const f = fixture({ selected_server: 'silver' });
    assert.equal(await f.store.getSelectedServer('guild', 'user'), 'silver');
    assert.deepEqual(f.calls[0].params, ['guild', 'user']);
    f.calls.length = 0;
    await assert.rejects(f.store.setSelectedServer('guild', member(), 'bronze', { toggle: true }), /Select Gold, Silver, or Cross Server/u);
    assert.equal(f.calls.length, 0);
});

test('initial setup saves the same selection idempotently and caches confirmed preferences', async () => {
    const f = fixture();
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), undefined);
    assert.deepEqual(await f.store.setSelectedServer('guild', member(), 'gold'), { previous: null, selected: 'gold' });
    assert.deepEqual(await f.store.setSelectedServer('guild', member(), 'gold'), { previous: 'gold', selected: 'gold' });
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), 'gold');
});

test('role changes finish before commit and a failed role change rolls back the preference', async () => {
    const f = fixture({ selected_server: 'gold', status: 'current' });
    await assert.rejects(f.store.setSelectedServer('guild', member(), 'silver', {
        async beforeCommit(result) {
            assert.deepEqual(result, { previous: 'gold', selected: 'silver' });
            assert.equal(f.calls.includes('commit'), false);
            throw new Error('Controlled role failure');
        }
    }), /Controlled role failure/u);
    assert.equal(f.row().selected_server, 'gold');
    assert.equal(f.calls.includes('commit'), false);
    assert.deepEqual(f.calls.slice(-2), ['rollback', 'release']);
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), undefined);
});

test('hydration supports immediate autocomplete and does not overwrite a selection saved during the read', async () => {
    const f = fixture({ selected_server: 'silver', discord_id: 'user' });
    let releaseRead;
    f.store.db.query = async () => new Promise(resolve => { releaseRead = () => resolve([[{ discord_id: 'user', selected_server: 'gold' }]]); });
    const hydration = f.store.hydrateSelectedServers('guild');
    await new Promise(resolve => setImmediate(resolve));
    f.store.rememberSelectedServer('guild', 'user', 'silver');
    releaseRead();
    await hydration;
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), 'silver');
    assert.equal(f.store.getCachedSelectedServer('guild', 'missing-user'), null);
    assert.equal(f.store.getCachedSelectedServer('other-guild', 'missing-user'), undefined);
});

test('a preference read started before a saved change returns the newer confirmed preference', async () => {
    const f = fixture({ selected_server: 'gold', discord_id: 'user' });
    let releaseRead;
    f.store.getMember = async () => new Promise(resolve => { releaseRead = () => resolve({ selected_server: 'gold' }); });
    const read = f.store.getSelectedServer('guild', 'user');
    f.store.rememberSelectedServer('guild', 'user', 'silver');
    releaseRead();
    assert.equal(await read, 'silver');
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), 'silver');
});

test('concurrent cold preference reads share one query and clean up after completion', async () => {
    const f = fixture({ selected_server: 'gold', discord_id: 'user' });
    let reads = 0, releaseRead;
    f.store.getMember = async () => {
        reads++;
        return new Promise(resolve => { releaseRead = () => resolve({ selected_server: 'gold' }); });
    };
    const first = f.store.getSelectedServer('guild', 'user');
    const second = f.store.getSelectedServer('guild', 'user');
    assert.equal(reads, 1);
    releaseRead();
    assert.deepEqual(await Promise.all([first, second]), ['gold', 'gold']);
    assert.equal(f.store.selectedServerRequests.size, 0);
});

test('failed cold preference reads clean up the request so another interaction can retry', async () => {
    const f = fixture();
    f.store.getMember = async () => { throw new Error('Controlled read failure'); };
    await assert.rejects(f.store.getSelectedServer('guild', 'user'), /Controlled read failure/u);
    assert.equal(f.store.selectedServerRequests.size, 0);
    f.store.getMember = async () => ({ selected_server: 'silver' });
    assert.equal(await f.store.getSelectedServer('guild', 'user'), 'silver');
});

test('failure reconciliation forces a fresh preference read instead of sharing an older query', async () => {
    const f = fixture();
    let completeOld;
    let reads = 0;
    f.store.getMember = async () => {
        reads++;
        return reads === 1 ? new Promise(resolve => { completeOld = () => resolve({ selected_server: 'gold' }); })
            : { selected_server: 'silver' };
    };
    const old = f.store.getSelectedServer('guild', 'user');
    assert.equal(await f.store.getSelectedServer('guild', 'user', { fresh: true }), 'silver');
    completeOld();
    assert.equal(await old, 'silver');
    assert.equal(f.store.getCachedSelectedServer('guild', 'user'), 'silver');
    assert.equal(f.store.selectedServerRequests.size, 0);
});

test('roster profile updates and role changes leave the server preference untouched', async () => {
    const f = fixture({ selected_server: 'silver' });
    await f.store.saveMember(member(), 'guild', 'current');
    await f.store.saveMember(member(false), 'guild', 'former');
    await f.store.updateMemberProfile(member(), 'guild');
    await f.store.handleMemberRemove(member(false), 'guild');
    for (const call of f.calls.filter(value => value.query)) assert.doesNotMatch(call.query, /selected_server/u);
    const remove = f.calls.find(call => call.query?.includes("status = IF(status = 'current', 'former', status)"));
    assert.ok(remove, 'leaving the server must not turn settings-only accounts into former guild members');
});

test('settings-only names are excluded from scout member warnings and OCR member context', async () => {
    const f = fixture({ discord_id: 'user', status: 'other', server_nickname: 'IGN', username: 'Account' });
    assert.deepEqual(await f.store.ocrMemberContext('guild', 'user'), { memberNames: [], authorNames: [] });
    f.store.friendlyRowForIgn = async () => null;
    assert.equal(await f.store.noticeForIgn('guild', 'IGN'), null);
});
