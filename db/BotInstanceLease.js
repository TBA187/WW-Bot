'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 90 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

class BotInstanceLease {
    constructor(options = {}) {
        this.db = options.db;
        this.storageMode = String(options.storageMode ?? process.env.STORAGE_MODE ?? 'auto').toLowerCase();
        this.leaseKey = String(options.leaseKey || 'white-walker-bot');
        this.ownerId = String(options.ownerId || `${process.pid}:${crypto.randomUUID()}`);
        this.leaseMs = positiveNumber(options.leaseMs, DEFAULT_LEASE_MS);
        this.heartbeatMs = Math.min(
            positiveNumber(options.heartbeatMs, DEFAULT_HEARTBEAT_MS),
            Math.max(1000, Math.floor(this.leaseMs / 2))
        );
        this.timer = null;
        this.acquired = false;
        this.enforced = false;
        this.schemaReady = false;
        this.unavailableLogged = false;
    }

    canUseMysql() {
        return this.storageMode !== 'json' && Boolean(this.db?.hasRequiredConfig);
    }

    async ensureSchema() {
        if (this.schemaReady) return true;
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS bot_instance_leases (
                lease_key VARCHAR(191) NOT NULL,
                owner_id VARCHAR(191) NOT NULL,
                acquired_at DATETIME(3) NOT NULL,
                heartbeat_at DATETIME(3) NOT NULL,
                expires_at DATETIME(3) NOT NULL,
                PRIMARY KEY (lease_key),
                KEY idx_bot_instance_leases_expires_at (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        this.schemaReady = true;
        return true;
    }

    noteUnavailable(error) {
        if (this.unavailableLogged) return;
        this.unavailableLogged = true;
        const code = this.db?.getErrorCode?.(error) || error?.code || error?.message || 'UNKNOWN';
        console.warn(
            `[WW LOG] Single-instance protection is temporarily unavailable (${code}). ` +
            'Do not run another copy of the bot until MySQL is restored.'
        );
    }

    noteRestored() {
        if (!this.unavailableLogged) return;
        this.unavailableLogged = false;
        console.log('[WW LOG] Single-instance protection restored.');
    }

    async acquire() {
        if (!this.canUseMysql()) {
            this.noteUnavailable(new Error('MYSQL_NOT_CONFIGURED'));
            this.acquired = true;
            this.enforced = false;
            return { acquired: true, enforced: false };
        }

        let connection;
        try {
            await this.ensureSchema();
            connection = await this.db.getConnection();
            await connection.beginTransaction();
            const [rows] = await connection.query(`
                SELECT owner_id, expires_at <= UTC_TIMESTAMP(3) AS expired
                FROM bot_instance_leases
                WHERE lease_key = ?
                FOR UPDATE
            `, [this.leaseKey]);
            const current = rows[0] || null;
            const available = !current || current.owner_id === this.ownerId || Number(current.expired) === 1;

            if (!available) {
                await connection.commit();
                this.acquired = false;
                this.enforced = true;
                return { acquired: false, enforced: true, ownerId: String(current.owner_id) };
            }

            await connection.query(`
                INSERT INTO bot_instance_leases (
                    lease_key, owner_id, acquired_at, heartbeat_at, expires_at
                ) VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))
                ON DUPLICATE KEY UPDATE
                    owner_id = VALUES(owner_id),
                    acquired_at = VALUES(acquired_at),
                    heartbeat_at = VALUES(heartbeat_at),
                    expires_at = VALUES(expires_at)
            `, [this.leaseKey, this.ownerId, Math.round(this.leaseMs * 1000)]);
            await connection.commit();
            this.acquired = true;
            this.enforced = true;
            this.noteRestored();
            return { acquired: true, enforced: true };
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            this.noteUnavailable(error);
            this.acquired = true;
            this.enforced = false;
            return { acquired: true, enforced: false, error };
        } finally {
            connection?.release();
        }
    }

    async heartbeat() {
        if (!this.acquired) return false;
        if (!this.enforced) {
            const lease = await this.acquire();
            return lease.acquired;
        }
        try {
            const [result] = await this.db.query(`
                UPDATE bot_instance_leases
                SET heartbeat_at = UTC_TIMESTAMP(3),
                    expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
                WHERE lease_key = ? AND owner_id = ?
            `, [Math.round(this.leaseMs * 1000), this.leaseKey, this.ownerId]);
            this.noteRestored();
            return Number(result?.affectedRows || 0) === 1;
        } catch (error) {
            this.noteUnavailable(error);
            return true;
        }
    }

    start(onLeaseLost) {
        if (this.timer || !this.acquired) return;
        this.timer = setInterval(async () => {
            const retained = await this.heartbeat();
            if (retained) return;
            this.stop();
            this.acquired = false;
            console.error('[WW LOG] This process lost the active bot lease. Disconnecting to prevent duplicate messages.');
            await onLeaseLost?.();
        }, this.heartbeatMs);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async release() {
        this.stop();
        if (!this.acquired || !this.enforced) {
            this.acquired = false;
            return false;
        }
        try {
            const [result] = await this.db.query(
                'DELETE FROM bot_instance_leases WHERE lease_key = ? AND owner_id = ?',
                [this.leaseKey, this.ownerId]
            );
            return Number(result?.affectedRows || 0) === 1;
        } catch (error) {
            this.noteUnavailable(error);
            return false;
        } finally {
            this.acquired = false;
        }
    }
}

module.exports = {
    BotInstanceLease,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_LEASE_MS
};
