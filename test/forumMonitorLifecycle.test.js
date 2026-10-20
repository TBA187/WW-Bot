'use strict';

// Covers forum backoff and shutdown while requests or deliveries are still in flight.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildApplicationMonitor } = require('../features/guild-applications/GuildApplicationMonitor.js');
const { GuildApplicationVoteReminder } = require('../features/guild-applications/discord/GuildApplicationVoteReminder.js');
const { TbaForumShopMonitor } = require('../features/tba-forum-shops/TbaForumShopMonitor.js');
const { parseRetryAfter } = require('../utils/forumRetry.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('both forum monitors honor a server wait longer than the local backoff cap', t => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(Date, 'now', () => 1_000);
    const retryAfterMs = 48 * 60 * 60 * 1000;
    const application = new GuildApplicationMonitor();
    application.forumFailed({ retryAfterMs });
    assert.equal(application.nextAttemptAt, 1_000 + retryAfterMs);
    const shops = new TbaForumShopMonitor({ clock: () => 1_000 });
    const shop = { key: 'one', name: 'Test shop' };
    const state = shops.stateFor(shop);
    shops.forumFailed(shop, state, { retryAfterMs });
    assert.equal(state.nextAttemptAt, 1_000 + retryAfterMs);
});

test('Retry-After accepts seconds and HTTP dates without retaining overflowing delays', t => {
    t.mock.method(Date, 'now', () => Date.parse('2026-10-18T12:00:00Z'));
    assert.equal(parseRetryAfter('120'), 120_000);
    assert.equal(parseRetryAfter('Sun, 18 Oct 2026 12:05:00 GMT'), 300_000);
    assert.equal(parseRetryAfter('invalid'), null);
    assert.equal(parseRetryAfter('1e308'), null);
});

test('long shop retry timers cannot overflow into a busy loop', t => {
    const scheduled = [];
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { unref() {} };
        scheduled.push({ callback, delay, timer });
        return timer;
    });
    t.mock.method(global, 'clearTimeout', () => {});
    const monitor = new TbaForumShopMonitor();
    monitor.scheduleShop({ key: 'one' }, 3_000_000_000);
    assert.equal(scheduled[0].delay, 2_147_483_647);
    monitor.stop();
    monitor.scheduleShop({ key: 'one' }, 10);
    assert.equal(scheduled.length, 1);
});

function applicationMonitor(forumClient, notifier) {
    const saved = new Map();
    const store = {
        async isInitialized() { return true; },
        async pendingNotifications() { return []; },
        async pendingNonApplicationAlerts() { return []; },
        getCheckpoint() { return { lastPage: 1, lastPostId: '1' }; },
        async knownPostIds() { return new Set(['1']); },
        async saveRecord(record) { saved.set(record.postId, { ...record }); return record; },
        async updateCheckpoint() {},
        stopSyncLoop() {}
    };
    const monitor = new GuildApplicationMonitor({
        store, forumClient, notifier,
        parser: { parse() { return { classification: 'application', fields: { ign: 'Player' }, reasons: [] }; } },
        ocr: { async close() {} }
    });
    return { monitor, saved };
}

function post(id) {
    return { postId: String(id), page: 1, forumUsername: `Player${id}`,
        bodyText: `IGN: Player${id}`, imageUrls: [], postedAt: '2026-10-18T12:00:00Z' };
}

test('application shutdown during attachment download leaves the alert pending and sends nothing', async () => {
    const download = deferred(), downloading = deferred();
    let sent = 0;
    const { monitor, saved } = applicationMonitor({
        async fetchPage() { return { lastPage: 1, posts: [post(1), post(2), post(3)] }; },
        async downloadPostImages() { downloading.resolve(); return download.promise; }
    }, { async notify(record) { sent++; return record; } });
    const running = monitor.runOnce();
    await downloading.promise;
    await monitor.stop();
    download.resolve([]);
    assert.equal(await running, false);
    assert.equal(sent, 0);
    assert.equal(saved.get('2').notificationStatus, 'pending');
    assert.equal(saved.has('3'), false);
});

test('application shutdown during the first page fetch cannot start later page requests', async () => {
    const page = deferred(), fetching = deferred();
    let fetches = 0;
    const { monitor } = applicationMonitor({
        async fetchPage() { fetches++; fetching.resolve(); return page.promise; }
    });
    const running = monitor.runOnce();
    await fetching.promise;
    await monitor.stop();
    page.resolve({ lastPage: 3, posts: [post(1)] });
    assert.equal(await running, false);
    assert.equal(fetches, 1);
});

test('application shutdown saves an in-flight delivery before leaving later posts pending', async () => {
    const delivery = deferred(), sending = deferred();
    const { monitor, saved } = applicationMonitor({
        async fetchPage() { return { lastPage: 1, posts: [post(1), post(2), post(3)] }; },
        async downloadPostImages() { return []; }
    }, { async notify(record) {
        sending.resolve();
        await delivery.promise;
        return { ...record, notificationStatus: 'notified', officerMessageId: 'sent-message' };
    } });
    const running = monitor.runOnce();
    await sending.promise;
    await monitor.stop();
    delivery.resolve();
    assert.equal(await running, false);
    assert.equal(saved.get('2').officerMessageId, 'sent-message');
    assert.equal(saved.get('2').notificationStatus, 'notified');
    assert.equal(saved.has('3'), false);
});

test('shop shutdown saves an in-flight delivery before leaving later posts pending', async () => {
    const delivery = deferred(), sending = deferred();
    const sent = [], saved = [];
    const shop = { key: 'one', name: 'Test shop', topicUrl: 'https://example.com/topic/', forumClient: {
        async fetchPage() { return { lastPage: 1, posts: [post(1), post(2), post(3)] }; },
        async downloadPostImages() { return []; }
    } };
    const monitor = new TbaForumShopMonitor({ shops: [shop], enabled: 1,
        store: {
            async getShop() { return { initialized: true, topicUrl: shop.topicUrl, lastPage: 1, lastSeenPostId: '1' }; },
            async updateShop(key, patch) { saved.push(patch); }
        },
        notifier: { async notify(selectedShop, selectedPost) {
            sent.push(selectedPost.postId); sending.resolve(); await delivery.promise;
        } }
    });
    const running = monitor.runOnce();
    await sending.promise;
    monitor.stop();
    delivery.resolve();
    assert.equal(await running, false);
    assert.deepEqual(sent, ['2']);
    assert.deepEqual(saved, [{ lastSeenPostId: '2', lastPage: 1 }]);
});

test('vote-reminder shutdown does not fetch guilds after a pending storage read completes', async () => {
    const candidates = deferred();
    const reminder = new GuildApplicationVoteReminder({
        store: { voteReminderCandidates: () => candidates.promise }
    });
    const running = reminder.runOnce();
    reminder.stop();
    candidates.resolve([{ postId: '2' }]);
    assert.equal(await running, false);
    assert.equal(await reminder.runOnce(), false);
    assert.equal(reminder.running, false);
});
