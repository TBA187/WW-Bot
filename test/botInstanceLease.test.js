'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotInstanceLease } = require('../db/BotInstanceLease.js');

function fakeLeaseDatabase() {
    const rows = new Map();
    const query = async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.startsWith('create table')) return [{ affectedRows: 0 }, []];
        if (normalized.startsWith('select owner_id')) {
            const current = rows.get(String(params[0]));
            return [[...(current ? [{ owner_id: current.ownerId, expired: current.expired ? 1 : 0 }] : [])], []];
        }
        if (normalized.startsWith('insert into bot_instance_leases')) {
            rows.set(String(params[0]), { ownerId: String(params[1]), expired: false });
            return [{ affectedRows: 1 }, []];
        }
        if (normalized.startsWith('update bot_instance_leases')) {
            const current = rows.get(String(params[1]));
            const affectedRows = current?.ownerId === String(params[2]) ? 1 : 0;
            if (affectedRows) current.expired = false;
            return [{ affectedRows }, []];
        }
        if (normalized.startsWith('delete from bot_instance_leases')) {
            const current = rows.get(String(params[0]));
            const affectedRows = current?.ownerId === String(params[1]) ? 1 : 0;
            if (affectedRows) rows.delete(String(params[0]));
            return [{ affectedRows }, []];
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
    };
    const db = {
        hasRequiredConfig: true,
        query,
        async getConnection() {
            return {
                async beginTransaction() {},
                async commit() {},
                async rollback() {},
                query,
                release() {}
            };
        }
    };
    return { db, rows };
}

test('only one process can hold the bot lease and a clean shutdown releases it', async () => {
    const { db } = fakeLeaseDatabase();
    const first = new BotInstanceLease({ db, leaseKey: 'bot:test', ownerId: 'first', storageMode: 'auto' });
    const second = new BotInstanceLease({ db, leaseKey: 'bot:test', ownerId: 'second', storageMode: 'auto' });

    assert.deepEqual(await first.acquire(), { acquired: true, enforced: true });
    const rejected = await second.acquire();
    assert.equal(rejected.acquired, false);
    assert.equal(rejected.enforced, true);
    assert.equal(rejected.ownerId, 'first');

    assert.equal(await first.release(), true);
    assert.deepEqual(await second.acquire(), { acquired: true, enforced: true });
    assert.equal(await second.heartbeat(), true);
    await second.release();
});

test('an unprotected process acquires the lease when MySQL recovers', async () => {
    const { db } = fakeLeaseDatabase();
    let unavailable = true;
    const originalQuery = db.query;
    db.query = async (...args) => {
        if (unavailable) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        return originalQuery(...args);
    };
    db.getConnection = async () => {
        if (unavailable) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        return {
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            query: originalQuery,
            release() {}
        };
    };
    const lease = new BotInstanceLease({ db, leaseKey: 'bot:recovery', ownerId: 'recovering', storageMode: 'auto' });

    const initial = await lease.acquire();
    assert.equal(initial.acquired, true);
    assert.equal(initial.enforced, false);

    unavailable = false;
    assert.equal(await lease.heartbeat(), true);
    assert.equal(lease.enforced, true);
    await lease.release();
});
