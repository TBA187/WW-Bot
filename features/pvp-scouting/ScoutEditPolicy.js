'use strict';

const { diffChars } = require('diff');
const { matchSpeciesHeading } = require('./PokemonTeamParser.js');
const { sameValue } = require('./ScoutChanges.js');
const { scoutVersion } = require('./PvpScoutStore.js');

// Only correct a misspelled species to its exact recognized spelling. A small
// character count alone is unsafe (e.g. changing a rating or removing "not").
function isSafeScoutTypo(previous, proposal) {
    const before = scoutVersion(previous), after = scoutVersion(proposal);
    if (previous.is_deleted || previous.reviewed_by_id || previous.staffOverrides?.locked
        || previous.staffOverrides?.hidden || before.reviewStatus !== 'not_required'
        || after.reviewStatus !== 'not_required' || after.classification !== 'scout'
        || !before.ign || !after.teamText) return false;
    for (const key of ['ign', 'rating', 'attachments', 'replyToId', 'authorId']) {
        if (!sameValue(key, before[key], after[key])) return false;
    }
    const a = before.content.split('\n'), b = after.content.split('\n');
    if (a.length !== b.length) return false;
    const changed = a.map((line, i) => line === b[i] ? -1 : i).filter(i => i >= 0);
    if (changed.length !== 1) return false;
    const index = changed[0];
    const oldLine = a[index].replace(/^\s*\[?/u, ''), newLine = b[index].replace(/^\s*\[?/u, '');
    const oldHeading = matchSpeciesHeading(oldLine, { allowTypo: true });
    const newHeading = matchSpeciesHeading(newLine);
    if (!oldHeading?.species || oldHeading.kind === 'exact' || !newHeading?.species
        || newHeading.kind !== 'exact' || oldHeading.species !== newHeading.species
        || oldLine.slice(oldHeading.end) !== newLine.slice(newHeading.end)) return false;
    const edits = diffChars(a[index], b[index]).filter(part => part.added || part.removed);
    return edits.every(part => /^[a-zA-Z]+$/u.test(part.value))
        && edits.reduce((n, part) => n + part.count, 0) <= 2;
}

module.exports = { isSafeScoutTypo };
