'use strict';

function pageFromLink(href, topicUrl) {
    if (!href) return 1;
    try {
        const topic = new URL(topicUrl);
        const link = new URL(href, topicUrl);
        if (link.origin !== topic.origin) return 1;
        const topicId = topic.pathname.match(/\/topic\/(\d+)/i)?.[1];
        if (topicId) {
            if (link.pathname.match(/\/topic\/(\d+)/i)?.[1] !== topicId) return 1;
        } else if (link.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/$/, '')
            !== topic.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/$/, '')) return 1;
        const page = Number(link.pathname.match(/\/page\/(\d+)/i)?.[1] || 1);
        return Number.isSafeInteger(page) && page > 0 ? page : 1;
    } catch { return 1; }
}

function discoverForumLastPage($, topicUrl) {
    const pages = [1];
    // Post bodies can quote pagination or link to other topics; only page chrome counts.
    $('[data-ips-pagination-pages], [data-page]').each((_, element) => {
        if ($(element).closest('article').length) return;
        const page = Number($(element).attr('data-ips-pagination-pages') || $(element).attr('data-page'));
        if (Number.isSafeInteger(page) && page > 0) pages.push(page);
    });
    $('link[rel="last"], a[href*="/page/"]').each((_, element) => {
        if ($(element).closest('article').length) return;
        pages.push(pageFromLink($(element).attr('href'), topicUrl));
    });
    return Math.max(...pages);
}

module.exports = { discoverForumLastPage };
