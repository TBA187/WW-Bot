require('dotenv').config();
const mysql = require('mysql2/promise');

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
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 300000, // 5 minutes in milliseconds
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

db.query = async function queryWithRetry(sql, params, retries = 2) {
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await rawQuery(sql, params);
        } catch (err) {
            lastErr = err;

            if (!shouldRetryDbError(err) || attempt === retries) {
                throw err;
            }

            const delayMs = getRetryDelayMs(err, attempt);
            console.warn(`[DB LOG] Transient query error (${err.code}). Retrying in ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }

    throw lastErr;
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
            console.log('[DB LOG] Successfully connected to MySQL!');
            return true;
        } catch (err) {
            const errorCode = err.code || err.message;
            console.error(`[DB LOG] Connection attempt ${attempt} failed:`, errorCode);

            if (!shouldRetryDbError(err)) {
                console.error('[DB LOG] Database unavailable due to non-transient startup error.');
                return false;
            }

            if (maxStartupRetries > 0 && attempt >= maxStartupRetries) {
                console.error('[DB LOG] Max startup retries reached. Database unavailable.');
                return false;
            }

            const delayMs = getStartupRetryDelayMs(err, attempt);
            console.log(`[DB LOG] Database is unavailable (${errorCode}). Waiting ${Math.round(delayMs / 1000)} seconds before retrying...`);
            await sleep(delayMs);
        }
    }
};

db.hasRequiredConfig = hasRequiredDbConfig;
db.isTransientDbError = shouldRetryDbError;
db.initPromise = connectWithRetry();

module.exports = db;
