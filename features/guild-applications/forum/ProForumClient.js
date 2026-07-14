'use strict';

// Fetches the PRO topic and reduces each forum post to the text and images the monitor needs.
const cheerio = require('cheerio');
const path = require('path');
const {
    TOPIC_URL,
    IGNORED_FORUM_USER_ID,
    IGNORED_FORUM_USERNAME,
    MAX_IMAGE_BYTES,
    IMAGE_DOWNLOAD_TIMEOUT_MS,
    FORUM_REQUEST_TIMEOUT_MS
} = require('../constants.js');

class ForumRequestError extends Error {
    constructor(message, { status = null, retryAfterMs = null, cause = null } = {}) {
        super(message);
        this.name = 'ForumRequestError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.cause = cause;
    }
}

function cleanText(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[\t\f\v]+/g, ' ')
        .replace(/[ \u00a0]+\n/g, '\n')
        .replace(/\n[ \u00a0]+/g, '\n')
        .replace(/[ \u00a0]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(value);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function parseProfileIdentity(profileUrl) {
    const match = String(profileUrl || '').match(/\/profile\/(\d+)-([^/?#]+)/i);
    return {
        forumUserId: match?.[1] || null,
        profileSlug: match?.[2] ? decodeURIComponent(match[2]).replace(/-/g, ' ') : null
    };
}

function normalizeImageUrl(value) {
    try {
        const url = new URL(String(value || ''));
        url.hash = '';
        url.search = '';
        return url.href;
    } catch {
        return String(value || '').trim();
    }
}

function isIgnoredForumAuthor(forumUserId, forumUsername, ignoredUsernames = []) {
    const names = new Set([
        IGNORED_FORUM_USERNAME,
        ...(Array.isArray(ignoredUsernames) ? ignoredUsernames : [])
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
    return String(forumUserId || '') === IGNORED_FORUM_USER_ID
        || names.has(String(forumUsername || '').trim().toLowerCase());
}

function isIgnoredImageElement($, image) {
    const node = $(image);
    const className = String(node.attr('class') || '').toLowerCase();
    const alt = String(node.attr('alt') || '').toLowerCase();
    const source = String(node.attr('data-src') || node.attr('src') || '').toLowerCase();
    const width = Number.parseInt(node.attr('width'), 10);
    const height = Number.parseInt(node.attr('height'), 10);

    return className.includes('ipsemoji')
        || className.includes('emoji')
        || node.attr('data-emoticon') != null
        || alt === 'emoji'
        || /(?:twitter\/twemoji|twemoji@)/i.test(source)
        || (Number.isFinite(width) && Number.isFinite(height) && width <= 64 && height <= 64);
}

function precedingNodeText($, image, boundary) {
    const parts = [];
    let current = image;

    for (let depth = 0; current && depth < 5; depth++) {
        let sibling = current.prev;
        while (sibling && parts.join(' ').length < 600) {
            const text = sibling.type === 'text' ? sibling.data : $(sibling).text();
            if (text?.trim()) parts.push(text.trim());
            sibling = sibling.prev;
        }
        current = current.parent;
        if (!current || current === boundary) break;
    }

    return parts.join(' ').slice(0, 600);
}

function imageHintText($, image, boundary) {
    const node = $(image);
    const link = node.closest('a[href]');
    const section = node.closest('p, li, div, section').first();
    const sectionText = section.length && section[0] !== boundary
        ? section.clone().find('img').remove().end().text()
        : '';

    return cleanText([
        node.attr('alt'),
        node.attr('title'),
        link.attr('title'),
        link.attr('href'),
        node.attr('data-src'),
        node.attr('src'),
        sectionText,
        precedingNodeText($, image, boundary)
    ].filter(Boolean).join(' ')).toLowerCase();
}

function trainerCardImageScore(hintText) {
    const hint = String(hintText || '').toLowerCase();
    let score = 0;

    if (/screen\s*shot[^\n]{0,50}(?:pok(?:e|é)mon\s*)?(?:id|trainer\s*card)/iu.test(hint)) score += 140;
    if (/trainer[\s_-]*card|pok(?:e|é)mon[\s_-]*(?:id|card)/iu.test(hint)) score += 110;
    if (/\b(?:player|trainer)[\s_-]*id\b/iu.test(hint)) score += 90;
    if (/\b(?:id|card)\.(?:png|jpe?g|webp|gif)\b/iu.test(hint)) score += 45;
    if (/screen\s*shot|screenshot/iu.test(hint)) score += 15;

    return score;
}

class ProForumClient {
    constructor(options = {}) {
        this.topicUrl = options.topicUrl || TOPIC_URL;
        this.fetch = options.fetch || global.fetch;
        this.requestTimeoutMs = options.requestTimeoutMs || FORUM_REQUEST_TIMEOUT_MS;
        this.imageTimeoutMs = options.imageTimeoutMs || IMAGE_DOWNLOAD_TIMEOUT_MS;
        this.maxImageBytes = options.maxImageBytes || MAX_IMAGE_BYTES;
        this.templateImageUrls = new Set((options.templateImageUrls || []).map(normalizeImageUrl).filter(Boolean));
        this.ignoredUsernames = Array.isArray(options.ignoredUsers) ? options.ignoredUsers : [];

        if (typeof this.fetch !== 'function') {
            throw new TypeError('ProForumClient requires a fetch implementation.');
        }
    }

    pageUrl(page = 1) {
        const normalized = Math.max(1, Number(page) || 1);
        if (normalized === 1) return this.topicUrl;
        return `${this.topicUrl.replace(/\/$/, '')}/page/${normalized}/`;
    }

    directPostUrl(page, postId) {
        return `${this.pageUrl(page)}#findComment-${postId}`;
    }

    async request(url, timeoutMs = this.requestTimeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref?.();

        try {
            const response = await this.fetch(url, {
                signal: controller.signal,
                headers: {
                    'user-agent': 'WhiteWalkerDiscordBot/1.0 (+guild application monitor)',
                    accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8'
                },
                redirect: 'follow'
            });

            if (!response.ok) {
                throw new ForumRequestError(`PRO Forum request failed with HTTP ${response.status}.`, {
                    status: response.status,
                    retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
                });
            }

            return response;
        } catch (err) {
            if (err instanceof ForumRequestError) throw err;
            const message = err?.name === 'AbortError'
                ? `PRO Forum request timed out after ${timeoutMs}ms.`
                : `PRO Forum request failed: ${err?.message || err}`;
            throw new ForumRequestError(message, { cause: err });
        } finally {
            clearTimeout(timeout);
        }
    }

    discoverLastPage($) {
        const candidates = [1];
        const lastHref = $('link[rel="last"]').attr('href');
        const hrefMatch = String(lastHref || '').match(/\/page\/(\d+)/i);
        if (hrefMatch) candidates.push(Number(hrefMatch[1]));

        $('[data-ips-pagination-pages]').each((_, element) => {
            const value = Number($(element).attr('data-ips-pagination-pages'));
            if (Number.isFinite(value)) candidates.push(value);
        });

        $('[data-page]').each((_, element) => {
            const value = Number($(element).attr('data-page'));
            if (Number.isFinite(value)) candidates.push(value);
        });

        $('a[href*="/page/"]').each((_, element) => {
            const match = String($(element).attr('href') || '').match(/\/page\/(\d+)/i);
            if (match) candidates.push(Number(match[1]));
        });

        return Math.max(...candidates.filter(Number.isFinite));
    }

    contentText($, content) {
        const clone = content.clone();
        clone.find('blockquote.ipsQuote, [data-role="memberSignature"], .ipsEdited, [data-el="edited"], script, style, noscript').remove();
        clone.find('br').replaceWith('\n');
        clone.find('p, div, li, section').each((_, element) => {
            $(element).append('\n');
        });
        // Attachment filenames are not application content. The image itself is handled separately.
        clone.find('img').remove();
        return cleanText(clone.text());
    }

    extractImageUrls($, content, pageUrl, { includeDecorative = false } = {}) {
        const clone = content.clone();
        clone.find('blockquote.ipsQuote, [data-role="memberSignature"], .ipsEdited, [data-el="edited"]').remove();
        const candidates = [];

        clone.find('img').each((index, element) => {
            if (!includeDecorative && isIgnoredImageElement($, element)) return;
            const image = $(element);
            const parentHref = image.closest('a[href]').attr('href');
            const raw = parentHref || image.attr('data-src') || image.attr('src');
            if (!raw || /^(?:data:|javascript:)/i.test(raw)) return;

            try {
                const resolved = new URL(raw, pageUrl);
                if (!/^https?:$/.test(resolved.protocol)) return;
                if (/\/(?:profile|topic)\//i.test(resolved.pathname) && !/uploads|monthly|attachment/i.test(resolved.pathname)) return;
                if (!includeDecorative && this.templateImageUrls.has(normalizeImageUrl(resolved.href))) return;
                candidates.push({
                    url: resolved.href,
                    index,
                    score: trainerCardImageScore(imageHintText($, element, clone[0]))
                });
            } catch {
                // Bad attachment URLs are ignored; the forum post link remains available.
            }
        });

        const seen = new Set();
        return candidates
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .filter(candidate => {
                if (seen.has(candidate.url)) return false;
                seen.add(candidate.url);
                return true;
            })
            .map(candidate => candidate.url);
    }

    registerTemplateImages($, content, pageUrl) {
        const urls = this.extractImageUrls($, content, pageUrl, { includeDecorative: true });
        urls.forEach(url => this.templateImageUrls.add(normalizeImageUrl(url)));
    }

    getTemplateImageUrls() {
        return [...this.templateImageUrls];
    }

    extractPosts(html, page) {
        const $ = cheerio.load(html);
        const pageUrl = this.pageUrl(page);
        const posts = [];

        $('article[data-ips-hook="postWrapper"], article[data-commentid]').each((_, article) => {
            const wrapper = $(article);
            const idFromAttribute = wrapper.attr('data-commentid');
            const idFromAnchor = wrapper.find('[id^="findComment-"]').first().attr('id')?.match(/findComment-(\d+)/i)?.[1];
            const idFromWrapper = wrapper.attr('id')?.match(/(?:comment|post)[-_]?(\d+)/i)?.[1];
            const postId = idFromAttribute || idFromAnchor || idFromWrapper;
            const content = wrapper.find('[data-role="commentContent"]').first();
            if (!postId || !content.length) return;

            const authorLink = wrapper.find('[data-ips-hook="postUsername"] a[href*="/profile/"]').first();
            const fallbackAuthor = wrapper.find('[data-ips-hook="postUsername"]').first();
            const profileUrl = authorLink.attr('href') ? new URL(authorLink.attr('href'), pageUrl).href : null;
            const identity = parseProfileIdentity(profileUrl);
            const authorName = cleanText(authorLink.text() || fallbackAuthor.text()) || 'Unknown';
            const time = wrapper.find('time[datetime]').first();
            const postedAt = time.attr('datetime') || time.attr('title') || null;
            const ignoredAuthor = isIgnoredForumAuthor(identity.forumUserId, authorName, this.ignoredUsernames);

            // Remember the owner's template assets so copied versions do not become application images.
            if (ignoredAuthor) this.registerTemplateImages($, content, pageUrl);

            posts.push({
                postId: String(postId),
                page: Number(page),
                postUrl: this.directPostUrl(page, postId),
                forumUserId: identity.forumUserId,
                forumUsername: authorName,
                profileUrl,
                profileSlug: identity.profileSlug,
                postedAt,
                bodyText: this.contentText($, content),
                imageUrls: ignoredAuthor ? [] : this.extractImageUrls($, content, pageUrl)
            });
        });

        return { $, posts, lastPage: this.discoverLastPage($) };
    }

    async fetchPage(page = 1) {
        const response = await this.request(this.pageUrl(page));
        const html = await response.text();
        const parsed = this.extractPosts(html, page);
        return { page: Number(page), html, posts: parsed.posts, lastPage: parsed.lastPage };
    }

    imageFilename(url, index, contentType = '') {
        let extension = '';
        try {
            extension = path.extname(new URL(url).pathname).slice(0, 8);
        } catch {
            extension = '';
        }
        if (!/^\.[a-z0-9]{2,7}$/i.test(extension)) {
            const subtype = contentType.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg');
            extension = subtype && /^[a-z0-9]+$/i.test(subtype) ? `.${subtype}` : '.png';
        }
        return `trainer-card-${index + 1}${extension}`;
    }

    async downloadImage(url, index = 0) {
        const response = await this.request(url, this.imageTimeoutMs);
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (!contentType.startsWith('image/')) {
            throw new ForumRequestError(`Forum attachment is not an image: ${url}`);
        }
        if (contentLength > this.maxImageBytes) {
            throw new ForumRequestError(`Forum image exceeds ${this.maxImageBytes} bytes: ${url}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > this.maxImageBytes) {
            throw new ForumRequestError(`Forum image exceeds ${this.maxImageBytes} bytes: ${url}`);
        }

        return {
            url,
            buffer,
            contentType,
            name: this.imageFilename(url, index, contentType)
        };
    }

    async downloadPostImages(post, limit = Infinity) {
        const results = [];
        for (const [index, url] of post.imageUrls.slice(0, limit).entries()) {
            try {
                results.push(await this.downloadImage(url, index));
            } catch (error) {
                results.push({ url, buffer: null, contentType: null, name: this.imageFilename(url, index), error });
            }
        }
        return results;
    }
}

module.exports = {
    ForumRequestError,
    ProForumClient,
    cleanText,
    parseProfileIdentity,
    trainerCardImageScore,
    normalizeImageUrl
};
