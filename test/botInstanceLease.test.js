'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BotInstanceLease,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_LEASE_MS
} = require('../db/BotInstanceLease.js');

function fakeLeaseDatabase(now = () => Date.now()) {
    const rows = new Map();
    const query = async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.startsWith('create table')) return [{ affectedRows: 0 }, []];
        if (normalized.startsWith('select owner_id')) {
            const current = rows.get(String(params[0]));
            return [[...(current ? [{
                owner_id: current.ownerId,
                expired: current.expiresAtMs <= now() ? 1 : 0,
                remaining_seconds: Math.max(0, Math.ceil((current.expiresAtMs - now()) / 1000))
            }] : [])], []];
        }
        if (normalized.startsWith('insert into bot_instance_leases')) {
            rows.set(String(params[0]), {
                ownerId: String(params[1]),
                expiresAtMs: now() + Number(params[2]) / 1000
            });
            return [{ affectedRows: 1 }, []];
        }
        if (normalized.startsWith('update bot_instance_leases')) {
            const current = rows.get(String(params[1]));
            const affectedRows = current?.ownerId === String(params[2]) ? 1 : 0;
            if (affectedRows) current.expiresAtMs = now() + Number(params[0]) / 1000;
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

test('a stopped process leaves a lease that expires within 30 seconds', async () => {
    let nowMs = 0;
    const { db } = fakeLeaseDatabase(() => nowMs);
    const first = new BotInstanceLease({ db, leaseKey: 'bot:expiry', ownerId: 'first' });
    const second = new BotInstanceLease({ db, leaseKey: 'bot:expiry', ownerId: 'second' });

    assert.equal(DEFAULT_LEASE_MS, 30_000);
    assert.equal(DEFAULT_HEARTBEAT_MS, 10_000);
    assert.equal((await first.acquire()).acquired, true);
    assert.equal((await second.acquire()).remainingSeconds, 30);

    nowMs = 29_000;
    assert.equal((await second.acquire()).remainingSeconds, 1);
    nowMs = 30_000;
    assert.equal((await second.acquire()).acquired, true);
    await second.release();
});

test('heartbeats keep a running process protected past the initial expiry', async () => {
    let nowMs = 0;
    const { db } = fakeLeaseDatabase(() => nowMs);
    const first = new BotInstanceLease({ db, leaseKey: 'bot:heartbeat', ownerId: 'first' });
    const second = new BotInstanceLease({ db, leaseKey: 'bot:heartbeat', ownerId: 'second' });

    await first.acquire();
    nowMs = 20_000;
    assert.equal(await first.heartbeat(), true);
    nowMs = 35_000;
    assert.equal((await second.acquire()).acquired, false);
    await first.release();
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
