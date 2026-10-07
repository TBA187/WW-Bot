// Cover database shutdown and refusing work after the pool has closed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseHealthTracker } = require('../db/DatabaseHealthTracker.js');
const abortHelpers = require('../utils/abortable.js');

// Load the actual pool factory/wrappers with fake drivers and no real credentials.
function databaseFixture() {
    const pools = [];
    const module = { exports: {} };
    const context = {
        module, process: { env: { STORAGE_MODE: 'json' } },
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, AbortController,
        require(name) {
            if (name === 'dotenv') return { config() {} };
            if (name === './DatabaseHealthTracker.js') return { DatabaseHealthTracker };
            if (name === '../utils/abortable.js') return abortHelpers;
            if (name === 'mysql2/promise') return { createPool(config) {
                const pool = {
                    config, calls: 0, endCalls: 0,
                    query: async () => { pool.calls++; return [[{ ok: 1 }]]; },
                    getConnection: async () => ({ query: pool.query, release() {}, destroy() {} }),
                    end: async () => { pool.endCalls++; }
                };
                pools.push(pool);
                return pool;
            } };
            throw new Error(`Unexpected fixture import: ${name}`);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../db/db-conn.js'), 'utf8'), context);
    return { db: module.exports, pools };
}

test('database creates only the feature pool with no lease pool', async () => {
    const { db, pools } = databaseFixture();
    assert.equal(pools.length, 1);
    assert.equal(db.createLeasePool, undefined);
    await db.end();
});

test('closing the database is idempotent and refuses further queries and borrows cleanly', async () => {
    const { db } = databaseFixture();
    await db.initPromise;
    await db.end();
    await db.end();
    assert.equal(db.endCalls, 1);
    await assert.rejects(db.query('late query'), { code: 'BOT_SHUTTING_DOWN' });
    await assert.rejects(db.getConnection(), { code: 'BOT_SHUTTING_DOWN' });
    assert.equal(db.calls, 0);
});
