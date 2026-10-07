// Keeps each reported team together while fitting Discord's embed limits.
'use strict';

const MAX_DESCRIPTION = 4096;
const MAX_EMBED_TEXT = 6000;
const MAX_EMBEDS = 10;
const SEPARATOR = '\n\n';

function pageError(message, pageIndex, entryIndex) {
    const error = new Error(message);
    error.code = 'SCOUT_TEAM_PAGE_TOO_LARGE';
    error.pageIndex = pageIndex;
    if (entryIndex !== undefined) error.entryIndex = entryIndex;
    return error;
}

function buildPage(entries, pageIndex, pageCount, options) {
    const { title, headerForPage, footerForPage } = options;
    const header = String(headerForPage(pageIndex, entries.length, entries) || '');
    const footer = String(footerForPage(pageIndex, entries.length, pageCount) || '');
    if (header.length > MAX_DESCRIPTION) return { problem: 'The page header exceeds 4,096 characters.' };
    if (footer.length > 2048) return { problem: 'The page footer exceeds 2,048 characters.' };

    const descriptions = header ? [header] : [];
    for (const entry of entries) {
        const block = entry.block;
        if (block.length > MAX_DESCRIPTION) return { problem: 'One complete team exceeds the 4,096-character description limit.' };
        const last = descriptions.length - 1;
        const joined = last < 0 ? block : `${descriptions[last]}${descriptions[last] && block ? SEPARATOR : ''}${block}`;
        if (last >= 0 && joined.length <= MAX_DESCRIPTION) descriptions[last] = joined;
        else descriptions.push(block);
        if (descriptions.length > MAX_EMBEDS) return { problem: 'The page needs more than 10 embeds.' };
    }
    if (!descriptions.length) descriptions.push('');
    const textLength = title.length + footer.length
        + descriptions.reduce((sum, description) => sum + description.length, 0);
    if (textLength > MAX_EMBED_TEXT) return { problem: 'The complete page exceeds Discord\'s shared 6,000-character embed limit.' };
    return { page: { entries: [...entries], descriptions, title, footer } };
}

function packForPageCount(entries, pageCount, options) {
    if (!entries.length) {
        const candidate = buildPage([], 0, pageCount, options);
        if (candidate.problem) throw pageError(candidate.problem, 0);
        return [candidate.page];
    }

    const pages = [];
    let index = 0;
    while (index < entries.length) {
        const pageIndex = pages.length;
        const selected = [];
        let page;
        while (index < entries.length && selected.length < options.maxTeams) {
            const candidate = buildPage([...selected, entries[index]], pageIndex, pageCount, options);
            if (candidate.problem) {
                if (!selected.length) {
                    throw pageError(`Cannot display team ${index + 1} without shortening it: ${candidate.problem}`,
                        pageIndex, index);
                }
                break;
            }
            selected.push(entries[index]);
            page = candidate.page;
            index += 1;
        }
        pages.push(page);
    }
    return pages;
}

function packTeamPages(entries, {
    title = '', headerForPage = () => '', footerForPage = () => '', maxTeams = 10
} = {}) {
    if (!Array.isArray(entries) || entries.some(entry => typeof entry?.block !== 'string')) {
        throw new TypeError('Team page entries must be an array with a complete block string for every team.');
    }
    if (typeof headerForPage !== 'function' || typeof footerForPage !== 'function') {
        throw new TypeError('Team page header and footer formatters must be functions.');
    }
    if (!Number.isInteger(maxTeams) || maxTeams < 1 || maxTeams > 10) {
        throw new RangeError('Team pages can contain between 1 and 10 complete teams.');
    }
    title = String(title || '');
    if (title.length > 256) throw pageError('The page title exceeds 256 characters.', 0);
    const options = { title, headerForPage, footerForPage, maxTeams };

    // A longer page count can lengthen every footer. Repack until those final
    // footer labels and the number of pages agree.
    let pageCount = Math.max(1, Math.ceil(entries.length / maxTeams));
    while (true) {
        const pages = packForPageCount(entries, pageCount, options);
        if (pages.length === pageCount) return pages;
        if (pages.length < pageCount) {
            throw new Error('Team page footer formatting changed the page count non-monotonically.');
        }
        pageCount = pages.length;
    }
}

module.exports = { packTeamPages };
