'use strict';

// Wires the standalone shop monitor without pulling in guild-application behavior.
const { TbaForumShopClient } = require('./TbaForumShopClient.js');
const { TbaForumShopMonitor } = require('./TbaForumShopMonitor.js');
const { TbaForumShopNotifier } = require('./TbaForumShopNotifier.js');
const { TbaForumShopStore } = require('./TbaForumShopStore.js');
const {
    DUNGEON_SHOP_START_DELAY_MS,
    FORUM_SHOP_START_DELAY_MS
} = require('./constants.js');

function createTbaForumShopMonitor(options = {}) {
    const config = options.config || {};
    const shopDefinitions = [
        {
            key: 'forumShop',
            name: 'PRO Forum Shop',
            emoji: '🛒',
            topicUrl: config.tbaProForumShop,
            startDelayMs: FORUM_SHOP_START_DELAY_MS
        },
        {
            key: 'dungeonShop',
            name: 'PRO Dungeon Shop',
            emoji: '🏰',
            topicUrl: config.tbaProDungeonShop,
            startDelayMs: DUNGEON_SHOP_START_DELAY_MS
        }
    ].filter(shop => String(shop.topicUrl || '').trim());

    const shops = shopDefinitions.map(shop => ({
        ...shop,
        forumClient: new TbaForumShopClient({
            topicUrl: shop.topicUrl,
            fetch: options.fetch
        })
    }));
    const store = options.store || new TbaForumShopStore({
        db: options.db,
        storageMode: options.storageMode,
        dataFile: options.dataFile
    });
    const notifier = options.notifier || new TbaForumShopNotifier({
        client: options.client,
        ownerID: config.ownerID,
        botTimezone: config.botTimezone
    });

    return new TbaForumShopMonitor({
        shops,
        store,
        notifier,
        enabled: config.tbaProForumNotifications,
        intervalMs: options.intervalMs
    });
}

module.exports = {
    TbaForumShopClient,
    TbaForumShopMonitor,
    TbaForumShopNotifier,
    TbaForumShopStore,
    createTbaForumShopMonitor
};
