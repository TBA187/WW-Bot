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

test('shop store creates one small file and preserves both topic checkpoints', () => {
    const dataFile = tempFile();
    const store = new TbaForumShopStore({ dataFile });
    const shops = [
        { key: 'forumShop', topicUrl: 'https://example.com/forum-shop/' },
        { key: 'dungeonShop', topicUrl: 'https://example.com/dungeon-shop/' }
    ];

    store.initialize(shops);
    store.updateShop('forumShop', { initialized: true, lastSeenPostId: '100', lastPage: 7 });
    store.initialize(shops);

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(Object.keys(data.shops), ['forumShop', 'dungeonShop']);
    assert.equal(data.shops.forumShop.lastSeenPostId, '100');
    assert.equal(data.shops.forumShop.lastPage, 7);
    assert.equal(data.shops.dungeonShop.initialized, false);
});
