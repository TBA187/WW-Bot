require('dotenv').config();
const mysql = require('mysql2/promise');

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 300000, // 5 minutes in milliseconds
    maxIdle: 5,
    idleTimeout: 300000, // 5 minutes
});

const TRANSIENT_DB_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'PROTOCOL_CONNECTION_LOST'
]);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const rawQuery = db.query.bind(db);

function shouldRetryDbError(err) {
    return err && TRANSIENT_DB_ERROR_CODES.has(err.code);
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

            const delayMs = 750 * (attempt + 1);
            console.warn(`[DB LOG] Transient query error (${err.code}). Retrying in ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }

    throw lastErr;
};

// DB Retry Function
const connectWithRetry = async (retries = 3, delayMs = 5000) => {
    for (let i = 0; i < retries; i++) {
        try {
            const [rows] = await db.query('SELECT 1 + 1 AS result;');
            console.log('[DB LOG] ✅ Successfully connected to MySQL!');
            return;
        } catch (err) {
            console.error(`[DB LOG] ❌ Connection attempt ${i + 1} failed:`, err.code);

            if (i < retries - 1) {
                console.log(`[DB LOG] ⏳ Retrying in ${delayMs / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                console.error('[DB LOG] 🚨 Max retries reached. Database unavailable.');
                process.exit(1);
            }
        }
    }
};

db.initPromise = connectWithRetry();

module.exports = db;
