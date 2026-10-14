// Combine observations of one battle without repeating Pokémon or losing source text.
'use strict';

const { matchSpeciesHeading, nameKey, recognizedTerms, sameTeamSpecies } = require('./PokemonTeamParser.js');

function detailParts(detail) {
    const raw = String(detail || '').trim().replace(/^[:;–—\s-]+/u, '');
    const attributes = { item: [], ability: [], nature: [], other: [] };
    const moves = [];
    if (!raw || /^[-–—]+$/u.test(raw)) return { attributes, moves, extra: '' };
    // Do not turn speculation, negation or prose into confirmed observations.
    if (/\b(?:not|no|without|maybe|might|probably|possibly|seems|unsure|unknown|before|don't)\b/iu.test(raw)) {
        return { attributes, moves, extra: raw };
    }
    const text = raw.replace(/\b(?:Item|Ability|Nature|Other)\s*:/giu, '')
        .replace(/\bz[- ]?moves?\b/giu, () => { attributes.other.push('Z-Move'); return ' '; })
        .replace(/\+\s*speed\b/giu, () => { attributes.other.push('+Speed'); return ' '; });
    const { found, leftover } = recognizedTerms(text, { allowTypo: true });
    const remaining = leftover.replace(/\b(?:item|ability|nature|other|with|and|holding|holds|has|using|is|a|the|moves?)\b/giu, '').trim();
    if (remaining) return { attributes: { item: [], ability: [], nature: [], other: [] }, moves, extra: raw };
    for (const term of found) {
        const values = term.kind === 'move' ? moves : attributes[term.kind];
        if (values && !values.includes(term.name)) values.push(term.name);
    }
    return { attributes, moves, extra: '' };
}

function mergedLine(entry) {
    if (entry.lines.length === 1) return entry.lines[0].line;
    const attributes = { item: [], ability: [], nature: [], other: [] };
    const moves = [], extras = [];
    for (const observation of entry.lines) {
        const detail = detailParts(observation.detail);
        // New items, abilities and natures supersede earlier observations.
        for (const kind of ['item', 'ability', 'nature']) {
            if (detail.attributes[kind].length) attributes[kind] = detail.attributes[kind];
        }
        for (const value of detail.attributes.other) if (!attributes.other.includes(value)) attributes.other.push(value);
        for (const move of detail.moves) if (!moves.includes(move)) moves.push(move);
        if (detail.extra && !extras.some(extra => nameKey(extra) === nameKey(detail.extra))) extras.push(detail.extra);
    }
    const labels = { item: 'Item', ability: 'Ability', nature: 'Nature', other: 'Other' };
    const metadata = Object.entries(attributes).filter(([, values]) => values.length)
        .map(([kind, values]) => `${labels[kind]}: ${values.join(', ')}`);
    return `- ${entry.label}${metadata.length ? ` (${metadata.join('; ')})` : ''}`
        + (moves.length ? `: ${moves.join(', ')}` : '') + (extras.length ? `; ${extras.join('; ')}` : '');
}

function mergeTeamLines(lines) {
    const entries = [], unassigned = [];
    for (const value of lines) {
        const body = String(value || '').trim().replace(/^[-•]\s*/u, '');
        if (!body || /^(?:none|n\/?a|null|[-–—\s]*)$/iu.test(body)) continue;
        const heading = matchSpeciesHeading(body, { allowTypo: true, allowBroadAlias: true });
        if (!heading?.species) { if (!unassigned.includes(body)) unassigned.push(body); continue; }
        let entry = entries.find(existing => sameTeamSpecies(existing.species, heading.species));
        if (!entry) {
            entry = { species: heading.species, label: body.slice(0, heading.end), lines: [] };
            entries.push(entry);
        } else if (heading.species === entry.species || heading.species.startsWith(`${entry.species}-`)) {
            entry.species = heading.species;
            entry.label = body.slice(0, heading.end);
        }
        const line = `- ${body}`;
        if (!entry.lines.some(observation => observation.line === line)) {
            entry.lines.push({ line, detail: body.slice(heading.end) });
        }
    }
    return { teamText: entries.slice(0, 6).map(mergedLine).join('\n'),
        overflow: entries.slice(6).map(mergedLine), unassigned };
}

function teamMergeNotice(merged) {
    return merged.overflow.length
        ? '*This report contains more than six Pokémon across its sources and needs source review. Extra source details are preserved in the original messages.*'
        : '';
}

module.exports = { mergeTeamLines, teamMergeNotice };
