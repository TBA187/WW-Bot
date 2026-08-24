require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const { DatabaseHealthTracker } = require('./DatabaseHealthTracker.js');

const STORAGE_MODE = String(process.env.STORAGE_MODE || 'auto').toLowerCase();
const hasRequiredDbConfig = Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 1),
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    enableKeepAlive: true,
    keepAliveInitialDelay: Number(process.env.DB_KEEPALIVE_DELAY_MS || 30000),
    supportBigNumbers: true,
    bigNumberStrings: true,
    maxIdle: Number(process.env.DB_MAX_IDLE || 1),
    idleTimeout: 300000, // 5 minutes
});

const TRANSIENT_DB_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'PROTOCOL_CONNECTION_LOST',
    'ER_CON_COUNT_ERROR'
]);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const rawQuery = db.query.bind(db);
const rawGetConnection = db.getConnection.bind(db);
const health = new DatabaseHealthTracker({
    baseCooldownMs: Number(process.env.DB_RETRY_COOLDOWN_MS || 5000),
    maxCooldownMs: Number(process.env.DB_RETRY_MAX_COOLDOWN_MS || 60000),
    statusLogIntervalMs: Number(process.env.DB_STATUS_LOG_INTERVAL_MS || 5 * 60 * 1000)
});
let recoveryProbe = null;

function shouldRetryDbError(err) {
    return err && TRANSIENT_DB_ERROR_CODES.has(err.code);
}

function getRetryDelayMs(err, attempt) {
    if (err?.code === 'ER_CON_COUNT_ERROR') {
        return 5000 * (attempt + 1);
    }

    if (err?.code === 'EAI_AGAIN') {
        return 2000 * (attempt + 1);
    }

    return 750 * (attempt + 1);
}

function getStartupRetryDelayMs(err, attempt) {
    if (err?.code === 'ER_CON_COUNT_ERROR') {
        return Math.min(60000, 15000 * attempt);
    }

    return Math.min(30000, getRetryDelayMs(err, attempt - 1));
}

function databaseErrorCode(err) {
    return err?.causeCode || err?.cause?.code || err?.code || err?.message || 'UNKNOWN';
}

function isDatabaseUnavailableError(err) {
    return Boolean(
        err?.code === 'DATABASE_UNAVAILABLE' ||
        err?.isCircuitOpen ||
        shouldRetryDbError(err) ||
        shouldRetryDbError(err?.cause)
    );
}

async function ensureDatabaseAttemptAllowed() {
    if (!health.isUnavailable()) return;
    if (!health.canAttempt()) throw health.unavailableError();

    if (!recoveryProbe) {
        recoveryProbe = (async () => {
            const attemptStartedAt = Date.now();
            try {
                await rawQuery('SELECT 1 AS db_health_check');
                health.recordSuccess();
            } catch (err) {
                if (shouldRetryDbError(err)) {
                    health.recordFailure(err, { attemptStartedAt });
                    throw health.unavailableError();
                }
                throw err;
            }
        })().finally(() => {
            recoveryProbe = null;
        });
    }

    return recoveryProbe;
}

db.query = async function queryWithRetry(sql, params, retries = 2) {
    await ensureDatabaseAttemptAllowed();
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptStartedAt = Date.now();
        try {
            const result = await rawQuery(sql, params);
            health.recordSuccess();
            return result;
        } catch (err) {
            lastErr = err;

            if (!shouldRetryDbError(err)) {
                throw err;
            }

            health.recordFailure(err, { attemptStartedAt });
            if (attempt === retries) throw err;

            const delayMs = getRetryDelayMs(err, attempt);
            await sleep(delayMs);
        }
    }

    throw lastErr;
};

db.getConnection = async function getConnectionWithHealthTracking() {
    await ensureDatabaseAttemptAllowed();
    const attemptStartedAt = Date.now();
    try {
        const connection = await rawGetConnection();
        health.recordSuccess();
        return connection;
    } catch (err) {
        if (shouldRetryDbError(err)) health.recordFailure(err, { attemptStartedAt });
        throw err;
    }
};

// Startup uses rawQuery so the query retry wrapper does not create nested retry loops.
const connectWithRetry = async () => {
    if (STORAGE_MODE === 'json') {
        console.log('[DB LOG] STORAGE_MODE=json. Skipping startup MySQL connection check.');
        return false;
    }

    if (!hasRequiredDbConfig) {
        console.warn('[DB LOG] MySQL credentials are incomplete. Database-backed features will be unavailable until configured.');
        return false;
    }

    const defaultStartupRetries = ['auto', 'mysql', 'json'].includes(STORAGE_MODE) ? 3 : 0;
    const maxStartupRetries = Number(process.env.DB_STARTUP_MAX_RETRIES || defaultStartupRetries);
    let attempt = 0;

    while (true) {
        attempt++;

        try {
            await rawQuery('SELECT 1 + 1 AS result;');
            health.recordSuccess();
            console.log('[DB LOG] Successfully connected to MySQL!');
            return true;
        } catch (err) {
            const errorCode = err.code || err.message;

            if (!shouldRetryDbError(err)) {
                console.error(`[DB LOG] MySQL startup check failed with a non-transient error (${errorCode}).`);
                return false;
            }

            health.recordFailure(err);

            if (maxStartupRetries > 0 && attempt >= maxStartupRetries) {
                console.error(
                    `[DB LOG] MySQL startup check exhausted ${attempt} attempt(s). ` +
                    'The bot will start with feature fallbacks and continue health probes.'
                );
                return false;
            }

            const delayMs = getStartupRetryDelayMs(err, attempt);
            await sleep(delayMs);
        }
    }
};

db.hasRequiredConfig = hasRequiredDbConfig;
db.isTransientDbError = shouldRetryDbError;
db.isDatabaseUnavailableError = isDatabaseUnavailableError;
db.getErrorCode = databaseErrorCode;
db.health = health;
db.initPromise = connectWithRetry();

module.exports = db;
