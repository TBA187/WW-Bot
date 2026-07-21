'use strict';

// Checks both shop topics and sends the owner a DM for each new customer message.
const {
    IGNORED_FORUM_USERNAME,
    MAX_BACKOFF_MS,
    MONITOR_INTERVAL_MS
} = require('./constants.js');
const { TbaForumRequestError } = require('./TbaForumShopClient.js');

function postNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function uniquePosts(pages) {
    const byId = new Map();
    for (const page of pages) {
        for (const post of page.posts || []) byId.set(String(post.postId), post);
    }
    return [...byId.values()].sort((a, b) => postNumber(a.postId) - postNumber(b.postId));
}

class TbaForumShopMonitor {
    constructor(options = {}) {
        this.shops = options.shops || [];
        this.store = options.store;
        this.notifier = options.notifier;
        this.enabled = Number(options.enabled) === 1;
        this.ignoredUsername = String(options.ignoredUsername || IGNORED_FORUM_USERNAME).trim().toLowerCase();
        this.intervalMs = options.intervalMs || MONITOR_INTERVAL_MS;
        this.maxBackoffMs = options.maxBackoffMs || MAX_BACKOFF_MS;
        this.clock = options.clock || (() => Date.now());
        this.timers = new Map();
        this.shopStates = new Map();
        this.started = false;
    }

    stateFor(shop) {
        if (!this.shopStates.has(shop.key)) {
            this.shopStates.set(shop.key, {
                failureCount: 0,
                forumUnavailable: false,
                nextAttemptAt: 0,
                running: false
            });
        }
        return this.shopStates.get(shop.key);
    }

    async start() {
        if (this.started) return;
        this.started = true;
        try {
            this.store.initialize(this.shops);
            if (!this.enabled) return;
            if (this.shops.length !== 2) throw new Error('Both TBA PRO Forum shop URLs must be configured.');

            for (const shop of this.shops) {
                this.scheduleShop(shop, Math.max(0, Number(shop.startDelayMs) || 0));
            }
        } catch (error) {
            this.started = false;
            throw error;
        }
    }

    stop() {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.started = false;
    }

    scheduleShop(shop, delayMs) {
        const existing = this.timers.get(shop.key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            this.timers.delete(shop.key);
            if (!this.started) return;

            await this.runShopOnce(shop);
            if (!this.started) return;

            const state = this.stateFor(shop);
            const retryDelay = Math.max(0, state.nextAttemptAt - this.clock());
            this.scheduleShop(shop, retryDelay || this.intervalMs);
        }, delayMs);
        timer.unref?.();
        this.timers.set(shop.key, timer);
    }

    forumRestored(shop, state) {
        if (state.forumUnavailable) console.log(`[WW LOG] ${shop.name} monitor connection restored.`);
        state.forumUnavailable = false;
        state.failureCount = 0;
        state.nextAttemptAt = 0;
    }

    forumFailed(shop, state, error) {
        state.failureCount++;
        const exponential = Math.min(
            this.maxBackoffMs,
            this.intervalMs * (2 ** Math.min(state.failureCount - 1, 6))
        );
        const delay = Math.min(this.maxBackoffMs, Math.max(exponential, error.retryAfterMs || 0));
        state.nextAttemptAt = this.clock() + delay;
        if (!state.forumUnavailable) {
            console.warn(`[WW LOG] ${shop.name} monitor is unavailable. Retrying in ${Math.ceil(delay / 60000)} minute(s):`, error.message);
        }
        state.forumUnavailable = true;
    }

    async runShopOnce(shop) {
        const state = this.stateFor(shop);
        if (state.running || this.clock() < state.nextAttemptAt) return false;

        state.running = true;
        try {
            await this.scanShop(shop);
            this.forumRestored(shop, state);
            return true;
        } catch (error) {
            if (error instanceof TbaForumRequestError) this.forumFailed(shop, state, error);
            else console.error(`[WW LOG] ${shop.name} monitor failed:`, error);
            return false;
        } finally {
            state.running = false;
        }
    }

    async runOnce() {
        if (!this.enabled) return false;
        const results = [];
        for (const shop of this.shops) results.push(await this.runShopOnce(shop));
        return results.every(Boolean);
    }

    async readablePage(shop, firstPage, page) {
        const result = page === 1 ? firstPage : await shop.forumClient.fetchPage(page);
        if (!(result.posts || []).length) {
            throw new TbaForumRequestError(`${shop.name} page ${page} did not contain any readable forum posts.`);
        }
        return result;
    }

    async fetchPages(shop, firstPage, startPage, lastPage, lastSeenPostId) {
        const pages = new Map();
        for (let page = startPage; page <= lastPage; page++) {
            pages.set(page, await this.readablePage(shop, firstPage, page));
        }

        // Page sizes can change. Walk backward until the saved post boundary is visible again.
        const boundary = postNumber(lastSeenPostId);
        let earliestPage = startPage;
        const boundaryFound = () => [...pages.values()].some(result =>
            (result.posts || []).some(post => postNumber(post.postId) <= boundary)
        );
        while (boundary > 0 && earliestPage > 1 && !boundaryFound()) {
            earliestPage--;
            pages.set(earliestPage, await this.readablePage(shop, firstPage, earliestPage));
        }

        return [...pages.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, result]) => result);
    }

    async setBaseline(shop, firstPage, lastPage) {
        const pages = [firstPage];
        if (lastPage > 1) {
            const finalPage = await shop.forumClient.fetchPage(lastPage);
            if (!(finalPage.posts || []).length) {
                throw new TbaForumRequestError(`The final page of ${shop.name} did not contain any readable forum posts.`);
            }
            pages.push(finalPage);
        }
        const latest = uniquePosts(pages).at(-1);
        if (!latest) throw new TbaForumRequestError(`No forum posts were found while baselining ${shop.name}.`);
        this.store.updateShop(shop.key, {
            initialized: true,
            lastSeenPostId: latest?.postId || null,
            lastPage
        });
        console.log(`[WW LOG] ${shop.name} baseline set at forum post ${latest?.postId || 'none'}.`);
    }

    async scanShop(shop) {
        const state = this.store.getShop(shop.key);
        const firstPage = await shop.forumClient.fetchPage(1);
        const lastPage = Math.max(1, Number(firstPage.lastPage) || 1);

        if (!state?.initialized || state.topicUrl !== shop.topicUrl) {
            await this.setBaseline(shop, firstPage, lastPage);
            return;
        }

        const startPage = Math.max(1, Math.min(Number(state.lastPage) || 1, lastPage));
        const pages = await this.fetchPages(shop, firstPage, startPage, lastPage, state.lastSeenPostId);
        const unseen = uniquePosts(pages).filter(post => postNumber(post.postId) > postNumber(state.lastSeenPostId));

        for (const post of unseen) {
            if (String(post.forumUsername || '').trim().toLowerCase() !== this.ignoredUsername) {
                const downloadedImages = await shop.forumClient.downloadPostImages(post);
                await this.notifier.notify(shop, post, downloadedImages);
            }
            this.store.updateShop(shop.key, {
                lastSeenPostId: post.postId,
                lastPage
            });
        }

        if (!unseen.length && Number(state.lastPage) !== lastPage) {
            this.store.updateShop(shop.key, { lastPage });
        }
    }
}

module.exports = {
    TbaForumShopMonitor,
    postNumber,
    uniquePosts
};
