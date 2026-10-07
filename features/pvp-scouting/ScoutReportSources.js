// Keep an author's multipart report separate from information supplied in replies.
'use strict';

const { hasImageEvidence, isClearlyOffTopicText, splitScoutText } = require('./PvpScoutParser.js');
const { reportContextSpecies } = require('./PokemonTeamParser.js');

// Formatting is pure, so revisiting unchanged reports can reuse the result.
// Bound both entry count and text size to keep long-running bots predictable.
const teamDisplayCache = new Map();
const TEAM_CACHE_ENTRIES = 200;
const TEAM_CACHE_CHARACTERS = 200_000;
let teamDisplayCacheCharacters = 0;

function sameAuthor(left, right) {
    if (left?.author_id && right?.author_id) return String(left.author_id) === String(right.author_id);
    const leftName = String(left?.author_username || '').trim().toLowerCase();
    const rightName = String(right?.author_username || '').trim().toLowerCase();
    return Boolean(leftName && rightName && leftName === rightName);
}

function compareSources(left, right) {
    const dateDifference = (new Date(left.created_at).getTime() || 0) - (new Date(right.created_at).getTime() || 0);
    if (dateDifference) return dateDifference;
    return String(left.message_id || '').localeCompare(String(right.message_id || ''), 'en', { numeric: true });
}

function partitionReportSources(row, sources = []) {
    const rootId = String(row.root_message_id || row.message_id);
    const family = sources.filter(source => !source.root_message_id
        || String(source.root_message_id) === rootId || String(source.message_id) === rootId);
    const unique = new Map(family.map(source => [String(source.message_id), source]));
    // The currently reviewed row can include a proposed edit or refreshed image URL.
    unique.set(String(row.message_id), row);
    const rootSource = unique.get(rootId) || row;
    const visible = [...unique.values()].filter(source => source.review_status !== 'not_scout' && !source.is_deleted
        && (String(source.message_id) === String(rootSource.message_id)
            || source.staffOverrides?.relation || hasImageEvidence(source.attachments) || !isClearlyOffTopicText(source.message_content)))
        .sort(compareSources);
    const originalSources = visible.filter(source => String(source.message_id) === String(rootSource.message_id)
        || sameAuthor(source, rootSource));
    const originalIds = new Set(originalSources.map(source => String(source.message_id)));
    const remaining = visible.filter(source => !originalIds.has(String(source.message_id)));
    const familyIds = new Set(visible.map(source => String(source.message_id)));
    const previousReplies = new Map();
    const replies = remaining.filter(source => {
        const previous = previousReplies.get(String(source.author_id));
        const elapsed = new Date(source.created_at) - new Date(previous?.created_at);
        const isReply = source.staffOverrides?.relation === 'reply'
            || source.reply_to_id && familyIds.has(String(source.reply_to_id)) && !sameAuthor(source, rootSource)
            || previous && elapsed >= 0 && elapsed <= 15 * 60 * 1000;
        if (isReply) previousReplies.set(String(source.author_id), source);
        return Boolean(isReply);
    });
    const replyIds = new Set(replies.map(source => String(source.message_id)));
    return {
        rootSource,
        originalSources: originalSources.some(source => String(source.message_id) === String(rootSource.message_id))
            ? [rootSource, ...originalSources.filter(source => String(source.message_id) !== String(rootSource.message_id))]
            : originalSources,
        replies,
        additionalSources: remaining.filter(source => !replyIds.has(String(source.message_id))),
        visibleSources: visible
    };
}

function reportSourceDetails(source, ign, root = source) {
    const protectedDetails = source.review_status === 'corrected' || source.staffOverrides?.locked;
    const legacyFields = !protectedDetails && source.team_text
        && source.team_text === source.message_content && source.notes === source.message_content;
    const grouped = source.root_message_id && String(source.root_message_id) !== String(source.message_id);
    const parsed = !protectedDetails && (legacyFields || !source.team_text)
        ? splitScoutText(source.message_content, ign, {
            allowContextualDetails: Boolean(grouped), contextSpecies: reportContextSpecies(root)
        }) : null;
    return {
        teamText: legacyFields ? parsed?.teamText || null : source.team_text || parsed?.teamText || null,
        notes: parsed?.teamText && source.notes === source.message_content ? parsed.notes : source.notes ?? parsed?.notes ?? null
    };
}

function mergeOriginalReport(originalSources, ign) {
    const messages = [];
    const teams = [];
    const notes = [];
    const ocrResults = [];
    const attachments = [];
    for (const source of originalSources) {
        const content = String(source.message_content || '').trim();
        if (content && !messages.includes(content)) messages.push(content);
        const { teamText: team, notes: sourceNotes } = reportSourceDetails(source, ign, originalSources[0]);
        for (const line of teamDisplayText(team, ign).split(/\r?\n/u).filter(Boolean)) {
            if (!teams.includes(line)) teams.push(line);
        }
        if (sourceNotes && !notes.includes(sourceNotes)) notes.push(sourceNotes);
        ocrResults.push(...(source.ocrResults || []));
        attachments.push(...(source.attachments || []));
    }
    return { messageText: messages.join('\n'), teamText: teams.join('\n'), notes: notes.join('\n'), ocrResults, attachments };
}

function teamDisplayText(team, ign) {
    const key = JSON.stringify([String(team || ''), String(ign || '')]);
    if (teamDisplayCache.has(key)) {
        const cached = teamDisplayCache.get(key);
        teamDisplayCache.delete(key);
        teamDisplayCache.set(key, cached);
        return cached;
    }
    // All scout views share this layout. Expand compact rosters, but retain a
    // single Pokémon's saved details instead of rewriting its notes or moves.
    const formatted = String(team || '').split(/\r?\n/u).flatMap(line => {
        const body = line.trim().replace(/^[-•]\s*/u, '').replace(/\*\*|__|`/gu, '');
        if (!body) return [];
        const parsed = splitScoutText(body, ign);
        const entries = String(parsed.teamText || '').split('\n').filter(Boolean);
        return entries.length > 1
            ? [...entries, ...(parsed.notes ? [`- ${parsed.notes}`] : [])] : [`- ${body}`];
    }).join('\n');
    const characters = key.length + formatted.length;
    if (characters <= TEAM_CACHE_CHARACTERS) {
        teamDisplayCache.set(key, formatted);
        teamDisplayCacheCharacters += characters;
        while (teamDisplayCache.size > TEAM_CACHE_ENTRIES || teamDisplayCacheCharacters > TEAM_CACHE_CHARACTERS) {
            const oldest = teamDisplayCache.keys().next().value;
            teamDisplayCacheCharacters -= oldest.length + teamDisplayCache.get(oldest).length;
            teamDisplayCache.delete(oldest);
        }
    }
    return formatted;
}

function reportHasTeam(root, sources) {
    return partitionReportSources(root, sources).visibleSources.some(source => {
        const { teamText, notes } = reportSourceDetails(source, root.opponent_ign, root);
        if (!(source.review_status === 'corrected' || teamText !== notes || !notes)) return false;
        // Counting needs only the presence of a team, not its formatted moves.
        return String(teamText || '').split(/\r?\n/u).some(line => {
            const body = line.trim().replace(/^[-•]\s*/u, '').replace(/\*\*|__|`/gu, '');
            return !/^(?:[-—–\s]*|\*?none\*?|n\/?a|null)$/iu.test(body);
        });
    });
}

module.exports = { mergeOriginalReport, partitionReportSources, reportSourceDetails, reportHasTeam, sameAuthor, teamDisplayText };
