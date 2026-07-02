const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PvpKingStorage = require('../commands/pvp-king/utils/pvpKingStorage.js');

function tempDataFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pvp-storage-'));
    return path.join(dir, 'pvp_king_data.json');
}

function withDbEnv(fn) {
    const old = {
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_NAME: process.env.DB_NAME
    };

    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'tester';
    process.env.DB_NAME = 'ww_test';

    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (old.DB_HOST === undefined) delete process.env.DB_HOST;
            else process.env.DB_HOST = old.DB_HOST;

            if (old.DB_USER === undefined) delete process.env.DB_USER;
            else process.env.DB_USER = old.DB_USER;

            if (old.DB_NAME === undefined) delete process.env.DB_NAME;
            else process.env.DB_NAME = old.DB_NAME;
        });
}

class FakeDb {
    constructor() {
        this.calls = [];
        this.failWrites = false;
        this.failReads = false;
        this.connections = [];
        this.beginCount = 0;
        this.commitCount = 0;
        this.rollbackCount = 0;
        this.stats = [];
        this.cooldowns = [];
        this.history = [];
        this.nextHistoryId = 1;
        this.nextCooldownId = 1;
    }

    async getConnection() {
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        return connection;
    }

    async query(sql, params = []) {
        this.calls.push({ sql, params });
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

        if (this.failReads && normalized.startsWith('select')) {
            const err = new Error('database unavailable');
            err.code = 'ECONNRESET';
            throw err;
        }

        if (this.failWrites && !normalized.startsWith('select')) {
            const err = new Error('database unavailable');
            err.code = 'ECONNRESET';
            throw err;
        }

        if (normalized.startsWith('select user_id')) return [this.stats];
        if (normalized.startsWith('select id, challenger_id')) return [this.cooldowns];
        if (normalized.startsWith('select * from pvp_king_history')) return [this.history];
        if (normalized.startsWith('select id from pvp_king_history where sync_event_id')) {
            return [this.history.filter(row => row.sync_event_id === params[0]).map(row => ({ id: row.id }))];
        }
        if (normalized.startsWith('select crowned_at from pvp_king_stats')) {
            const row = this.stats.find(stat => String(stat.user_id) === String(params[0]));
            return [[row ? { crowned_at: row.crowned_at } : undefined].filter(Boolean)];
        }
        if (normalized.startsWith('select total_wins')) {
            return [this.stats.filter(row => String(row.user_id) === String(params[0]))];
        }
        if (normalized.startsWith('select challenger_id, last_challenge')) {
            return [this.cooldowns.filter(row =>
                String(row.king_id) === String(params[0]) &&
                row.notify_on_expire === 1 &&
                row.last_challenge
            )];
        }
        if (normalized.startsWith('select * from pvp_king_history order by id desc limit 1 offset 1')) {
            const rows = [...this.history].sort((a, b) => b.id - a.id);
            return [[rows[1]].filter(Boolean)];
        }
        if (normalized.startsWith('select * from pvp_king_history order by id desc limit 1')) {
            const rows = [...this.history].sort((a, b) => b.id - a.id);
            return [[rows[0]].filter(Boolean)];
        }

        if (normalized.startsWith('insert into pvp_king_cooldowns')) {
            const existing = this.cooldowns.find(row => String(row.challenger_id) === String(params[0]));
            const row = {
                id: existing?.id ?? this.nextCooldownId++,
                challenger_id: String(params[0]),
                challenger_name: params[1],
                king_id: String(params[2]),
                king_name: params[3],
                last_challenge: params[4] ?? '2026-01-01 00:00:00',
                notify_on_expire: existing?.notify_on_expire ?? params[5] ?? 0
            };
            if (existing) Object.assign(existing, row);
            else this.cooldowns.push(row);
            return [{ affectedRows: existing ? 2 : 1 }];
        }

        if (normalized.startsWith('update pvp_king_cooldowns set last_challenge = null where king_id')) {
            let affectedRows = 0;
            for (const row of this.cooldowns) {
                if (String(row.king_id) === String(params[0])) {
                    row.last_challenge = null;
                    affectedRows++;
                }
            }
            return [{ affectedRows }];
        }

        if (normalized.startsWith('update pvp_king_cooldowns set last_challenge = null where id in')) {
            const ids = new Set(params.map(Number));
            let affectedRows = 0;
            for (const row of this.cooldowns) {
                if (ids.has(Number(row.id))) {
                    row.last_challenge = null;
                    affectedRows++;
                }
            }
            return [{ affectedRows }];
        }

        if (normalized.startsWith('update pvp_king_cooldowns set notify_on_expire')) {
            const row = this.cooldowns.find(cooldown => String(cooldown.challenger_id) === String(params[1]));
            if (!row) return [{ affectedRows: 0 }];
            row.notify_on_expire = params[0] ? 1 : 0;
            return [{ affectedRows: 1 }];
        }

        if (normalized.startsWith('insert into pvp_king_stats')) {
            const userId = String(params[0]);
            let row = this.stats.find(stat => String(stat.user_id) === userId);
            const isNewKingStats = normalized.includes('first_crowned');
            if (!row) {
                row = {
                    user_id: userId,
                    king_name: params[1],
                    total_wins: 1,
                    total_crown_losses: 0,
                    current_streak: 1,
                    longest_streak: 1,
                    first_crowned: isNewKingStats ? params[2] : null,
                    crowned_at: isNewKingStats ? params[3] : params[2]
                };
                this.stats.push(row);
                return [{ affectedRows: 1 }];
            }

            row.king_name = params[1];
            row.total_wins += 1;
            row.current_streak = isNewKingStats ? 1 : row.current_streak + 1;
            row.longest_streak = Math.max(row.longest_streak, row.current_streak);
            row.crowned_at = isNewKingStats ? params[3] : params[2];
            return [{ affectedRows: 2 }];
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('total_crown_losses = total_crown_losses + 1')) {
            const row = this.stats.find(stat => String(stat.user_id) === String(params[0]));
            if (!row) return [{ affectedRows: 0 }];
            row.total_crown_losses += 1;
            row.current_streak = 0;
            return [{ affectedRows: 1 }];
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('total_wins = greatest(total_wins - 1, 0)')) {
            const row = this.stats.find(stat => String(stat.user_id) === String(params[2]));
            if (!row) return [{ affectedRows: 0 }];
            row.total_wins = Math.max(row.total_wins - 1, 0);
            row.current_streak = 0;
            row.longest_streak = params[0];
            row.crowned_at = params[1];
            return [{ affectedRows: 1 }];
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('current_streak = ?')) {
            const userId = String(params[1]);
            const row = this.stats.find(stat => String(stat.user_id) === userId);
            if (!row) return [{ affectedRows: 0 }];
            if (normalized.includes('total_crown_losses = greatest')) {
                row.total_crown_losses = Math.max(row.total_crown_losses - 1, 0);
            }
            row.current_streak = params[0];
            return [{ affectedRows: 1 }];
        }

        if (normalized.startsWith('delete from pvp_king_history')) {
            const before = this.history.length;
            if (normalized.includes('sync_event_id')) {
                this.history = this.history.filter(row => row.sync_event_id !== params[0]);
            } else {
                this.history = this.history.filter(row => Number(row.id) !== Number(params[0]));
            }
            return [{ affectedRows: before - this.history.length }];
        }

        if (normalized.startsWith('delete from pvp_king_stats')) {
            const before = this.stats.length;
            this.stats = this.stats.filter(row => String(row.user_id) !== String(params[0]));
            return [{ affectedRows: before - this.stats.length }];
        }

        if (normalized.startsWith('insert into pvp_king_history')) {
            this.history.push({
                id: this.nextHistoryId++,
                king_id: params[0],
                king_name: params[1],
                type: params[2],
                total_wins_after: params[3],
                streak_after: params[4],
                longest_streak_after: params[5],
                last_crowned: params[6],
                created_at: params[7],
                sync_event_id: params[8] ?? null
            });
            return [{ affectedRows: 1, insertId: this.nextHistoryId - 1 }];
        }

        return [{ affectedRows: 1 }];
    }
}

class FakeConnection {
    constructor(db) {
        this.db = db;
        this.released = false;
    }

    async beginTransaction() {
        this.db.beginCount++;
    }

    async commit() {
        this.db.commitCount++;
    }

    async rollback() {
        this.db.rollbackCount++;
    }

    release() {
        this.released = true;
    }

    async query(sql, params = []) {
        return this.db.query(sql, params);
    }
}

test('STORAGE_MODE=json uses only the local JSON store', async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'json', dataFile: file });

    await storage.restore();
    await storage.recordNewKingStats('100', 'Json King');
    await storage.recordNewKingStats('100', 'Json King');

    const stats = await storage.getStats('100');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(fakeDb.calls.length, 0);
    assert.equal(stored.source, 'json_only');
    assert.equal(stored.pendingSync, false);
    assert.equal(stats.total_wins, 2);
    assert.equal(stats.current_streak, 1);
});

test('MySQL write failure stores pending fallback operations', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    fakeDb.failWrites = true;
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    await storage.upsertChallengeCooldown('200', 'Challenger', '300', 'King');

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cooldown = await storage.getCooldown('200');

    assert.equal(stored.source, 'mysql_fallback');
    assert.equal(stored.pendingSync, true);
    assert.equal(stored.state.operations.length, 1);
    assert.equal(cooldown.king_id, '300');
}));

test('fallback sync replays history with sync_event_id and clears JSON', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    fakeDb.failWrites = true;
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    await storage.insertHistory('300', 'King', 'crown', 1, 1, 1, null);

    fakeDb.failWrites = false;
    await storage.syncFallbackOperations();

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const historyInsert = fakeDb.calls.find(call => String(call.sql).includes('sync_event_id'));

    assert.ok(historyInsert);
    assert.equal(stored.pendingSync, false);
    assert.equal(stored.state.operations.length, 0);
    assert.match(historyInsert.params[8], /^pvp_/);
}));

test('recordCrownEvent commits dependent MySQL writes in one transaction', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    fakeDb.stats.push({
        user_id: 'old',
        king_name: 'Old King',
        total_wins: 3,
        total_crown_losses: 0,
        current_streak: 3,
        longest_streak: 3,
        first_crowned: '2026-01-01 00:00:00',
        crowned_at: '2026-01-02 00:00:00'
    });
    fakeDb.cooldowns.push({
        id: fakeDb.nextCooldownId++,
        challenger_id: 'waiter',
        challenger_name: 'Waiter',
        king_id: 'old',
        king_name: 'Old King',
        last_challenge: '2026-01-01 00:00:00',
        notify_on_expire: 1
    });

    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });
    await storage.restore();
    const result = await storage.recordCrownEvent({
        oldKingId: 'old',
        oldKingName: 'Old King',
        newKingId: 'new',
        newKingName: 'New King',
        createdAt: '2026-01-03 00:00:00'
    });

    assert.equal(fakeDb.beginCount, 1);
    assert.equal(fakeDb.commitCount, 1);
    assert.equal(fakeDb.rollbackCount, 0);
    assert.equal(result.stats.total_wins, 1);
    assert.equal(fakeDb.history.length, 1);
    assert.equal(fakeDb.stats.find(row => row.user_id === 'old').current_streak, 0);
    assert.equal(fakeDb.cooldowns.find(row => row.challenger_id === 'old').king_id, 'new');
}));

test('successful MySQL storage leaves fallback JSON empty', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    await storage.recordCrownEvent({
        newKingId: 'new',
        newKingName: 'New King',
        createdAt: '2026-01-03 00:00:00'
    });

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.source, 'mysql_fallback');
    assert.equal(stored.pendingSync, false);
    assert.deepEqual(stored.state.stats, []);
    assert.deepEqual(stored.state.cooldowns, []);
    assert.deepEqual(stored.state.history, []);
    assert.deepEqual(stored.state.operations, []);
}));

test('recordCrownEvent rolls back MySQL failure and stores one fallback event', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    fakeDb.failWrites = true;
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    await storage.recordCrownEvent({
        oldKingId: 'old',
        oldKingName: 'Old King',
        newKingId: 'new',
        newKingName: 'New King',
        createdAt: '2026-01-03 00:00:00'
    });

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fakeDb.rollbackCount, 1);
    assert.equal(stored.pendingSync, true);
    assert.equal(stored.state.operations.length, 1);
    assert.equal(stored.state.operations[0].type, 'crownEvent');
}));

test('concurrent fallback sync callers share one queued sync', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    storage.state.operations.push({
        type: 'crownEvent',
        sync_event_id: 'pvp_test_sync',
        created_at: '2026-01-03 00:00:00',
        new_king_id: 'new',
        new_king_name: 'New King',
        old_king_id: null,
        old_king_name: null,
        is_defense: 0
    });
    storage.writeJsonStore('mysql_fallback', true);

    await Promise.all(Array.from({ length: 100 }, () => storage.syncFallbackOperations()));

    const historyRows = fakeDb.history.filter(row => row.sync_event_id === 'pvp_test_sync');
    assert.equal(historyRows.length, 1);
    assert.equal(fakeDb.commitCount, 1);
}));

test('pending fallback reads use local state when sync cannot reach MySQL', async () => withDbEnv(async () => {
    const file = tempDataFile();
    const fakeDb = new FakeDb();
    const storage = new PvpKingStorage({ db: fakeDb, storageMode: 'auto', dataFile: file });

    await storage.restore();
    fakeDb.failWrites = true;
    await storage.recordCrownEvent({
        newKingId: 'local',
        newKingName: 'Local King',
        createdAt: '2026-01-03 00:00:00'
    });
    fakeDb.failReads = true;

    const stats = await storage.getStats('local');

    assert.equal(stats.king_name, 'Local King');
}));

test('reverse-style local operations remove fallback history and stats', async () => {
    const file = tempDataFile();
    const storage = new PvpKingStorage({ db: new FakeDb(), storageMode: 'json', dataFile: file });

    await storage.restore();
    await storage.recordNewKingStats('400', 'Wrong King');
    await storage.insertHistory('400', 'Wrong King', 'crown', 1, 1, 1, null);

    const history = await storage.latestHistory();
    await storage.deleteHistory(history.id);
    await storage.deleteStats('400');

    const remainingHistory = await storage.latestHistory();
    const remainingStats = await storage.getStats('400');

    assert.equal(remainingHistory, null);
    assert.equal(remainingStats, null);
});
