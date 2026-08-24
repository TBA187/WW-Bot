'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TbaForumShopStore } = require('../features/tba-forum-shops/TbaForumShopStore.js');

function tempFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-tba-shops-')), 'tba_forum_shops.json');
}

test('shop store creates one small file and preserves both topic checkpoints', async () => {
    const dataFile = tempFile();
    const store = new TbaForumShopStore({ dataFile });
    const shops = [
        { key: 'forumShop', topicUrl: 'https://example.com/forum-shop/' },
        { key: 'dungeonShop', topicUrl: 'https://example.com/dungeon-shop/' }
    ];

    await store.initialize(shops);
    await store.updateShop('forumShop', { initialized: true, lastSeenPostId: '100', lastPage: 7 });
    await store.initialize(shops);

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(Object.keys(data.shops), ['forumShop', 'dungeonShop']);
    assert.equal(data.shops.forumShop.lastSeenPostId, '100');
    assert.equal(data.shops.forumShop.lastPage, 7);
    assert.equal(data.shops.dungeonShop.initialized, false);
});

test('two hosts merge through the shared MySQL checkpoint without moving backward', async () => {
    const rows = new Map();
    const db = {
        hasRequiredConfig: true,
        async query(sql, params = []) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
            if (normalized.startsWith('create table')) return [{ affectedRows: 0 }, []];
            if (normalized.startsWith('select shop_key')) {
                const row = rows.get(String(params[0]));
                return [[...(row ? [row] : [])], []];
            }
            if (normalized.startsWith('insert into tba_forum_shop_checkpoints')) {
                const [key, topicUrl, initialized, lastSeenPostId, lastPage] = params;
                const current = rows.get(String(key));
                const reset = current && current.topic_url !== topicUrl;
                const currentPost = reset ? 0 : Number(current?.last_seen_post_id || 0);
                const incomingPost = Number(lastSeenPostId || 0);
                rows.set(String(key), {
                    shop_key: String(key),
                    topic_url: topicUrl,
                    initialized: reset ? initialized : Math.max(Number(current?.initialized || 0), Number(initialized)),
                    last_seen_post_id: incomingPost >= currentPost ? lastSeenPostId : current.last_seen_post_id,
                    last_page: reset ? lastPage : Math.max(Number(current?.last_page || 1), Number(lastPage || 1))
                });
                return [{ affectedRows: current ? 2 : 1 }, []];
            }
            throw new Error(`Unexpected SQL: ${normalized}`);
        }
    };
    const shop = { key: 'forumShop', topicUrl: 'https://example.com/forum-shop/' };
    const firstHost = new TbaForumShopStore({
        db,
        hasMysqlCredentials: true,
        dataFile: tempFile()
    });
    const secondHost = new TbaForumShopStore({
        db,
        hasMysqlCredentials: true,
        dataFile: tempFile()
    });

    await firstHost.initialize([shop]);
    await secondHost.initialize([shop]);
    await firstHost.updateShop(shop.key, { initialized: true, lastSeenPostId: '500', lastPage: 12 });

    const synchronized = await secondHost.getShop(shop.key);
    assert.equal(synchronized.initialized, true);
    assert.equal(synchronized.lastSeenPostId, '500');
    assert.equal(synchronized.lastPage, 12);

    await secondHost.updateShop(shop.key, { lastSeenPostId: '499', lastPage: 11 });
    assert.equal((await firstHost.getShop(shop.key)).lastSeenPostId, '500');
});
