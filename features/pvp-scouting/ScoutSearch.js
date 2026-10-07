// Resolves search terms with the scouting dictionary and matches details on one Pokémon at a time.
'use strict';

const { recognizedTerms, nameKey } = require('./PokemonTeamParser.js');
const { utcDate } = require('./ScoutArchiveView.js');

const detailTermCache = new Map();
const DETAIL_TERM_CACHE_SIZE = 4096;
const MAX_CACHED_DETAIL_TEXT = 1000;

function detailQuery(input) {
    const terms = [];
    for (const part of String(input || '').split(',')) {
        const { found, leftover } = recognizedTerms(part.trim(), { allowTypo: true });
        if (!found.length || nameKey(leftover)) {
            throw new Error(`“${part.trim() || '(empty term)'}” is not a recognized move, ability, item, or nature. Separate each requirement with a comma.`);
        }
        for (const term of found) {
            if (!terms.some(existing => existing.kind === term.kind && existing.name === term.name)) terms.push(term);
        }
    }
    return terms;
}

function detailTermKeys(text) {
    const source = String(text);
    if (source.length <= MAX_CACHED_DETAIL_TEXT && detailTermCache.has(source)) {
        const cached = detailTermCache.get(source);
        detailTermCache.delete(source);
        detailTermCache.set(source, cached);
        return cached;
    }
    // A note saying “no Healing Wish” or “not banded” is not evidence of that move or item.
    const positive = source.replace(/\b(?:no|not|without)\s+([^,;:)\n]+)/giu, (original, clause) => {
        const first = recognizedTerms(clause).found[0];
        if (!first || !nameKey(clause).startsWith(nameKey(first.written))) return original;
        let key = '';
        for (const word of clause.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
            key += nameKey(word[0]);
            if (key === nameKey(first.written)) return clause.slice(word.index + word[0].length);
        }
        return original;
    });
    // Stored teams already pass through the parser. Resolve names and aliases
    // here without repeating fuzzy dictionary scans for every archived row.
    const { found } = recognizedTerms(positive);
    const keys = new Set(found.map(term => `${term.kind}\u0000${term.name}`));
    if (source.length <= MAX_CACHED_DETAIL_TEXT) {
        detailTermCache.set(source, keys);
        while (detailTermCache.size > DETAIL_TERM_CACHE_SIZE) detailTermCache.delete(detailTermCache.keys().next().value);
    }
    return keys;
}

function matchesDetails(text, requirements = []) {
    if (!requirements.length) return true;
    const found = detailTermKeys(text);
    return requirements.every(required => found.has(`${required.kind}\u0000${required.name}`));
}

function reportDateRange(reports) {
    const dates = reports.map(report => utcDate((report.root || report).created_at)).filter(Boolean).sort();
    if (!dates.length) return '';
    return ` (${dates[0]}${dates.length > 1 ? ` — ${dates.at(-1)}` : ''})`;
}

function suggestionLabel({ name, server, count, latest, oppositeServer, oppositeCount, oppositeLatest }) {
    const date = utcDate(latest);
    const base = `${server === 'silver' ? '🥈' : '🥇'} ${name}`
        + (Number.isInteger(count) ? ` — Scout Reports: ${count}` : '')
        + (date ? ` (${date})` : '');
    const oppositeDate = utcDate(oppositeLatest);
    const opposite = Number.isInteger(oppositeCount) && oppositeCount > 0
        ? `\u2002— ${oppositeServer === 'silver' ? '🥈' : '🥇'} Scout Reports: ${oppositeCount}${oppositeDate ? ` (${oppositeDate})` : ''}`
        : '';
    let label = base + opposite;
    if (label.length > 100 && opposite) {
        // Keep the full IGN and newly added opposite-server details visible;
        // drop the primary server's date only when Discord's label limit requires it.
        label = `${base.replace(date ? ` (${date})` : '', '')}${opposite}`;
        if (label.length > 100) {
            const prefix = `${server === 'silver' ? '🥈' : '🥇'} `;
            const details = label.slice(base.startsWith(prefix) ? prefix.length + String(name).length : 0);
            const availableNameLength = Math.max(0, 100 - prefix.length - details.length);
            const visibleName = String(name).length > availableNameLength && availableNameLength > 0
                ? `${String(name).slice(0, availableNameLength - 1)}…` : String(name).slice(0, availableNameLength);
            label = `${prefix}${visibleName}${details}`;
        }
    }
    return label.slice(0, 100);
}

module.exports = { detailQuery, matchesDetails, reportDateRange, suggestionLabel };
