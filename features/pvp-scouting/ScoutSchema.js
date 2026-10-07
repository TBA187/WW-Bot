// Shares scout table setup across stores using the checked-in SQL definitions.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const initialized = new WeakMap();
let definitions;

function tableDefinitions() {
    if (!definitions) {
        const source = fs.readFileSync(path.join(__dirname, '../../sql/create_pvp_scout_tables.sql'), 'utf8');
        definitions = new Map([...source.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`[^;]+;/gu)]
            .map(match => [match[1], match[0]]));
    }
    return definitions;
}

async function ensureScoutTables(db, tables) {
    const statements = tableDefinitions();
    // Validate the requested tables before executing any statement.
    for (const table of tables) if (!statements.has(table)) throw new Error(`Missing scout table definition: ${table}`);
    if (!initialized.has(db)) initialized.set(db, new Map());
    const requests = initialized.get(db);
    for (const table of tables) {
        if (!requests.has(table)) {
            const request = Promise.resolve().then(() => db.query(statements.get(table))).catch(error => {
                requests.delete(table);
                throw error;
            });
            requests.set(table, request);
        }
        await requests.get(table);
    }
}

module.exports = { ensureScoutTables };
