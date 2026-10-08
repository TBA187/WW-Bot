const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeJsonIfChanged } = require('./jsonFile');
const { getLevelFromTotalXp } = require('./xpMath');

const COLUMNS = {
    message: ['message_xp', 'messages_sent', 'total_messages_sent'],
    reaction: ['reaction_xp', 'reactions_added', 'total_reactions_added'],
    command: ['command_xp', 'commands_used', 'total_commands_used'],
    voice: ['voice_xp', 'voice_minutes', 'total_voice_minutes']
};
const TRANSIENT_CODES = new Set(['DATABASE_UNAVAILABLE', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET',
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR',
    'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const copy = value => JSON.parse(JSON.stringify(value));

function validOperation(operation) {
    return operation && typeof operation.id === 'string' && /^[\da-f-]{36}$/iu.test(operation.id)
        && ['award', 'activity'].includes(operation.kind) && Object.hasOwn(COLUMNS, operation.actionType)
        && ['userId', 'guildId', 'xpType'].every(key => typeof operation[key] === 'string' && operation[key])
        && Number.isFinite(Date.parse(operation.occurredAt))
        && Number.isSafeInteger(operation.statCount) && operation.statCount > 0
        && Number.isSafeInteger(operation.xpGained) && operation.xpGained >= 0;
}

class XpStore {
    constructor({ db, filePath = path.join(__dirname, '../data/xp_pending.json'),
        shutdownSignal, retryMs = 5000, maxRetryMs = 60000, batchSize = 100, logger = console } = {}) {
        this.db = db;
        this.filePath = filePath;
        this.shutdownSignal = shutdownSignal;
        this.retryMs = retryMs;
        this.maxRetryMs = maxRetryMs;
        this.batchSize = batchSize;
        this.logger = logger;
        this.state = { version: 1, operations: [], specialTracks: null };
        this.loaded = false;
        this.handlers = new Map();
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.lastWarning = null;
        this.stopped = false;
    }

    restore() {
        if (this.loaded) return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.operations)
                || !saved.operations.every(validOperation)
                || new Set(saved.operations.map(operation => operation.id)).size !== saved.operations.length
                || !(saved.specialTracks === null || Array.isArray(saved.specialTracks))) {
                throw new Error(`Invalid XP recovery file: ${this.filePath}. Preserve it for recovery.`);
            }
            this.state = saved;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        this.loaded = true;
    }

    persist(state) {
        writeJsonIfChanged(this.filePath, `${this.filePath}.tmp`, state);
        this.state = state;
    }

    getSpecialTracks() {
        this.restore();
        return this.state.specialTracks === null ? null : copy(this.state.specialTracks);
    }

    saveSpecialTracks(tracks) {
        this.restore();
        this.persist({ ...this.state, specialTracks: copy(tracks) });
    }

    get pendingCount() {
        this.restore();
        return this.state.operations.length;
    }

    hasPending(guildId, xpType, userId) {
        this.restore();
        return this.state.operations.some(operation => !Object.hasOwn(operation, 'result')
            && operation.guildId === String(guildId) && operation.xpType === String(xpType)
            && (userId === undefined || operation.userId === String(userId)));
    }

    async record({ kind, userId, guildId, username, xpType, actionType, xpGained = 0, statCount = 1,
        channelId, trackInfo }, handler) {
        this.restore();
        if (this.stopped || this.shutdownSignal?.aborted) return;
        const operation = copy({ id: randomUUID(), kind, userId: String(userId), guildId: String(guildId),
            username, xpType: String(xpType), actionType, xpGained, statCount,
            occurredAt: new Date().toISOString(), channelId, trackInfo });
        if (!validOperation(operation)) throw new Error('Invalid XP/activity operation.');
        // Journal BEFORE the first database attempt, including while MySQL is healthy.
        this.persist({ ...this.state, operations: [...this.state.operations, operation] });
        if (handler) this.handlers.set(operation.id, handler);
        await this.flush();
    }

    async apply(operation) {
        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            try {
                await connection.query('INSERT INTO xp_applied_operations (operation_id) VALUES (?)', [operation.id]);
            } catch (error) {
                if (error.code !== 'ER_DUP_ENTRY') throw error;
                const [rows] = await connection.query(
                    'SELECT result_json FROM xp_applied_operations WHERE operation_id = ?', [operation.id]);
                if (!rows[0] || rows[0].result_json === null) throw new Error('XP receipt has no committed result.');
                const result = typeof rows[0].result_json === 'string' || Buffer.isBuffer(rows[0].result_json)
                    ? JSON.parse(rows[0].result_json) : rows[0].result_json;
                await connection.commit();
                this.db.health?.recordSuccess();
                return result;
            }

            const [xpColumn, statColumn, totalColumn] = COLUMNS[operation.actionType];
            const { userId, guildId, xpType, username, xpGained, statCount } = operation;
            const timestamp = Date.parse(operation.occurredAt) / 1000;
            let result = null;
            if (operation.kind === 'activity') {
                await connection.query(`
                    INSERT INTO xp_user_levels (user_id, guild_id, username, xp_type, xp_date, ${totalColumn})
                    VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), ?)
                    ON DUPLICATE KEY UPDATE username = VALUES(username),
                        xp_date = COALESCE(xp_date, VALUES(xp_date)), ${totalColumn} = ${totalColumn} + ?
                `, [userId, guildId, username, xpType, timestamp, statCount, statCount]);
            } else {
                await connection.query(`
                    INSERT INTO xp_user_levels (user_id, guild_id, xp_type, xp_date, xp_amount, level, username, ${xpColumn}, ${statColumn})
                    VALUES (?, ?, ?, FROM_UNIXTIME(?), ?, 0, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE xp_amount = xp_amount + ?, username = ?,
                        xp_date = COALESCE(xp_date, VALUES(xp_date)),
                        ${xpColumn} = ${xpColumn} + ?, ${statColumn} = ${statColumn} + ?
                `, [userId, guildId, xpType, timestamp, xpGained, username, xpGained, statCount,
                    xpGained, username, xpGained, statCount]);
                const [rows] = await connection.query(
                    'SELECT xp_amount, level FROM xp_user_levels WHERE user_id = ? AND guild_id = ? AND xp_type = ? FOR UPDATE',
                    [userId, guildId, xpType]);
                if (!rows[0]) throw new Error('XP update did not produce a user row.');
                result = { xp_amount: rows[0].xp_amount, level: rows[0].level,
                    correctLevel: getLevelFromTotalXp(rows[0].xp_amount) };
                if (result.correctLevel > result.level) {
                    await connection.query('UPDATE xp_user_levels SET level = ? WHERE user_id = ? AND guild_id = ? AND xp_type = ?',
                        [result.correctLevel, userId, guildId, xpType]);
                }
            }
            await connection.query('UPDATE xp_applied_operations SET result_json = ? WHERE operation_id = ?',
                [JSON.stringify(result), operation.id]);
            await connection.commit();
            this.db.health?.recordSuccess();
            return result;
        } catch (error) {
            await connection.rollback().catch(() => {});
            if (this.db.isDatabaseUnavailableError?.(error) || TRANSIENT_CODES.has(error.code)) {
                this.db.health?.recordFailure(error);
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    flush() {
        this.restore();
        if (this.flushing) return this.flushing;
        if (this.stopped || this.shutdownSignal?.aborted || !this.pendingCount || Date.now() < this.nextAttemptAt) {
            return Promise.resolve();
        }
        this.flushing = this.flushNow().finally(() => { this.flushing = null; });
        return this.flushing;
    }

    async flushNow() {
        let processed = 0;
        try {
            while (this.state.operations.length && processed < this.batchSize
                && !this.stopped && !this.shutdownSignal?.aborted) {
                const operation = this.state.operations[0];
                let result = operation.result;
                if (!Object.hasOwn(operation, 'result')) {
                    result = await this.apply(operation);
                    this.persist({ ...this.state, operations: this.state.operations.map(item =>
                        item.id === operation.id ? { ...item, result } : item) });
                }
                if (this.stopped || this.shutdownSignal?.aborted) return;
                if (operation.kind === 'award' && result.correctLevel > result.level) {
                    const handler = this.handlers.get(operation.id) || this.onAward;
                    if (!handler) return; // The ready client will finish saved level rewards.
                    await handler(operation, result);
                }
                this.persist({ ...this.state, operations: this.state.operations.filter(item => item.id !== operation.id) });
                this.handlers.delete(operation.id);
                processed++;
            }
            if (this.failures && !this.pendingCount) {
                this.logger.log('[XP QUEUE] MySQL recovered; all saved XP/activity updates synchronized.');
            }
            this.failures = 0;
            this.nextAttemptAt = 0;
            this.lastWarning = null;
        } catch (error) {
            if (this.stopped || this.shutdownSignal?.aborted) return;
            this.failures++;
            this.nextAttemptAt = Date.now() + Math.min(this.maxRetryMs, this.retryMs * (2 ** Math.min(this.failures - 1, 8)));
            const code = error.causeCode || error.code || error.message;
            if (!this.lastWarning || this.lastWarning.code !== code || Date.now() - this.lastWarning.at >= 300000) {
                this.lastWarning = { code, at: Date.now() };
                this.logger.warn(`[XP QUEUE] Recovery waiting (${code}); ${this.pendingCount} XP/activity update(s) saved in JSON for retry.`);
            }
        }
    }

    startSyncLoop() {
        if (this.timer || this.stopped || this.shutdownSignal?.aborted) return;
        this.timer = setInterval(() => this.flush().catch(error => this.logger.error('[XP QUEUE] Recovery failed:', error)), this.retryMs);
        this.timer.unref?.();
        return this.flush();
    }

    stopSyncLoop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = null;
        return this.flushing;
    }
}

function getXpStore(db) {
    if (!db.xpStore) db.xpStore = new XpStore({ db });
    return db.xpStore;
}

module.exports = { XpStore, getXpStore };
