// Checks shared table setup, fresh installs, and recovery from failed DDL.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureScoutTables } = require('../features/pvp-scouting/ScoutSchema.js');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');

test('Gold, Silver and roster initialize the exact checked-in definitions once per database pool', async () => {
    const calls = [];
    const db = { async query(sql) { calls.push(sql); return [[], []]; } };
    const gold = new PvpScoutStore({ db, channelId: 'gold', server: 'gold' });
    const silver = new PvpScoutStore({ db, channelId: 'silver', server: 'silver' });
    const roster = new ScoutRosterStore({ db });
    await Promise.all([gold.ensureSchema(), silver.ensureSchema(), roster.ensureSchema()]);
    const expected = [...fs.readFileSync(path.join(__dirname, '../sql/create_pvp_scout_tables.sql'), 'utf8')
        .matchAll(/CREATE TABLE IF NOT EXISTS `[^`]+`[^;]+;/gu)].map(match => match[0]);
    assert.equal(calls.length, expected.length);
    assert.deepEqual([...calls].sort(), expected.sort());
    await Promise.all([gold.ensureSchema(), silver.ensureSchema(), roster.ensureSchema()]);
    assert.equal(calls.length, expected.length);
    const otherCalls = [];
    await ensureScoutTables({ async query(sql) { otherCalls.push(sql); } }, ['pvp_scout_messages']);
    assert.equal(otherCalls.length, 1);
});

test('failed scout table setup retries the failed statement without repeating completed tables', async () => {
    const calls = [];
    let fail = true;
    const db = { async query(sql) {
        const table = sql.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/u)[1];
        calls.push(table);
        if (table === 'pvp_scout_catchup' && fail) { fail = false; throw new Error('Database unavailable'); }
    } };
    const tables = ['pvp_scout_messages', 'pvp_scout_catchup', 'pvp_scout_message_feedback'];
    await assert.rejects(ensureScoutTables(db, tables), /Database unavailable/u);
    await ensureScoutTables(db, tables);
    assert.deepEqual(calls, ['pvp_scout_messages', 'pvp_scout_catchup', 'pvp_scout_catchup', 'pvp_scout_message_feedback']);
});

test('missing SQL definitions fail before changing the database', async () => {
    let calls = 0;
    const db = { async query() { calls++; } };
    await assert.rejects(ensureScoutTables(db, ['pvp_scout_messages', 'unknown_table']), /Missing scout table definition/u);
    assert.equal(calls, 0);
});
