// Render saved scout authors as Discord mentions when they are still in the server.
'use strict';

function plainUsername(value) {
    return String(value || 'Unknown').trim().slice(0, 128)
        .replace(/</gu, '‹').replace(/>/gu, '›');
}

async function authorDisplay(guild, row) {
    const id = String(row?.author_id || '');
    // A saved Discord user ID is enough to render the author mention. Avoid a
    // REST lookup for each scout source; it adds latency and the embed disables
    // mention notifications anyway. Fall back to the saved username if no ID
    // is available.
    if (/^\d{17,20}$/u.test(id)) return `<@${id}>`;
    return plainUsername(row?.author_username);
}

async function authorDisplays(guild, rows) {
    const seen = new Set();
    const authors = [];
    for (const row of rows) {
        const key = String(row?.author_id || '') || `name:${String(row?.author_username || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        authors.push(row);
    }
    return (await Promise.all(authors.map(row => authorDisplay(guild, row)))).join(', ') || 'Unknown';
}

module.exports = { authorDisplay, authorDisplays };
