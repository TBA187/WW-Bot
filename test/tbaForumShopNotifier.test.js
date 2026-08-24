'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TbaForumShopNotifier,
    splitQuotedMessage
} = require('../features/tba-forum-shops/TbaForumShopNotifier.js');

test('quoted message formatting makes every line small and italic', () => {
    assert.deepEqual(splitQuotedMessage('First line\nSecond line'), [
        '-# *First line*\n-# *Second line*'
    ]);
});

test('shop notifier sends the dynamic shop DM to the configured owner', async () => {
    const sent = [];
    const owner = { async send(payload) { sent.push(payload); return { id: 'dm-1' }; } };
    const client = {
        users: {
            cache: new Map([['291142291073269761', owner]]),
            async fetch() { throw new Error('cache should be used'); }
        }
    };
    const notifier = new TbaForumShopNotifier({
        client,
        ownerID: '291142291073269761',
        botTimezone: 'Etc/UTC'
    });
    const shop = {
        key: 'dungeonShop',
        name: 'PRO Dungeon Shop',
        emoji: '🏰',
        topicUrl: 'https://example.com/dungeon-shop/'
    };
    const post = {
        forumUsername: 'CustomerName',
        postUrl: 'https://example.com/dungeon-shop/#findComment-500',
        postedAt: '2026-07-14T12:34:00.000Z',
        quotedBodyText: 'Original offer from Tba7',
        bodyText: 'Can I book a Victini run?'
    };

    await notifier.notify(shop, post);
    assert.equal(sent.length, 1);
    assert.equal(
        sent[0].content,
        `### ${shop.emoji}\u2002<@291142291073269761>, there's a new message in the [PRO Dungeon Shop!](<${shop.topicUrl}>)`
    );
    const embed = sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'CustomerName');
    assert.equal(embed.url, shop.topicUrl);
    assert.equal(embed.description, `**Message Link:\u2002[Click Here!](<${post.postUrl}>)**`);
    assert.deepEqual(embed.fields, [
        { name: 'Quoted Message:', value: '-# *Original offer from Tba7*', inline: false },
        { name: 'Message Content:', value: post.bodyText, inline: false }
    ]);
    assert.equal(embed.color, 0x00008b);
    assert.equal(embed.footer.text, 'Forum Message Sent: July 14, 2026 12:34');
});

test('shop notifier puts the first image in the embed and batches all remaining images', async () => {
    const sent = [];
    const owner = {
        async send(payload) {
            sent.push(payload);
            return { id: `dm-${sent.length}` };
        }
    };
    const notifier = new TbaForumShopNotifier({
        client: {
            users: {
                cache: new Map([['owner', owner]]),
                async fetch() { return owner; }
            }
        },
        ownerID: 'owner'
    });
    const images = Array.from({ length: 22 }, (_, index) => ({
        buffer: Buffer.from(`image-${index}`),
        name: `image-${index}.png`,
        url: `https://example.com/image-${index}.png`
    }));

    await notifier.notify({
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/'
    }, {
        forumUsername: 'Buyer',
        postUrl: 'https://example.com/forum-shop/#findComment-1',
        postedAt: '2026-07-14T12:00:00.000Z',
        bodyText: 'Interested'
    }, images);

    assert.equal(sent.length, 4);
    assert.equal(sent[0].files.length, 1);
    assert.equal(sent[0].embeds[0].toJSON().color, 0xffd700);
    assert.equal(sent[0].embeds[0].toJSON().image.url, 'attachment://image-0.png');
    assert.equal(sent[1].content, '**Additional Images:**');
    assert.equal(sent[1].files.length, 10);
    assert.equal(sent[2].files.length, 10);
    assert.equal(sent[3].files.length, 1);
});

test('shop notifier adds a warning only when forum details or images could not be fetched', () => {
    const notifier = new TbaForumShopNotifier({
        client: { users: { cache: new Map() } },
        ownerID: 'owner'
    });
    const payload = notifier.buildPayload({
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/'
    }, {
        forumUsername: 'Unknown Forum User',
        postUrl: 'https://example.com/forum-shop/#findComment-10',
        postedAt: null,
        bodyText: '',
        extractionWarnings: ['forum username', 'post timestamp']
    }, [{
        url: 'https://example.com/unavailable.png',
        buffer: null,
        name: 'unavailable.png',
        error: new Error('download failed')
    }]);

    const embed = payload.embeds[0].toJSON();
    assert.match(embed.description, /Some information could not be fetched/);
    assert.equal(embed.image.url, 'https://example.com/unavailable.png');
    assert.equal(embed.fields[0].value, '*N/A*');
});

test('shop notifier never sends a DM for the ignored Tba7 author', async () => {
    let sends = 0;
    const owner = { async send() { sends++; } };
    const notifier = new TbaForumShopNotifier({
        client: { users: { cache: new Map([['owner', owner]]) } },
        ownerID: 'owner'
    });

    const result = await notifier.notify({
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/'
    }, {
        forumUsername: ' TBA7 ',
        postUrl: 'https://example.com/forum-shop/#findComment-1',
        postedAt: '2026-07-14T12:00:00.000Z',
        bodyText: 'BUMP'
    });

    assert.equal(result, null);
    assert.equal(sends, 0);
});

test('shop notifier skips a forum post already present in the owner DM history', async () => {
    let sends = 0;
    const postUrl = 'https://example.com/forum-shop/#findComment-500';
    const existing = {
        id: 'existing-dm',
        author: { id: 'bot-user' },
        content: '',
        embeds: [{ data: { description: `**Message Link:** [Click Here](<${postUrl}>)` } }]
    };
    const owner = {
        async createDM() {
            return {
                messages: {
                    async fetch() { return new Map([[existing.id, existing]]); }
                }
            };
        },
        async send() {
            sends++;
            return { id: 'new-dm' };
        }
    };
    const notifier = new TbaForumShopNotifier({
        client: {
            user: { id: 'bot-user' },
            users: { cache: new Map([['owner', owner]]) }
        },
        ownerID: 'owner'
    });

    const result = await notifier.notify({
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/'
    }, {
        postId: '500',
        forumUsername: 'Buyer',
        postUrl,
        postedAt: '2026-07-14T12:00:00.000Z',
        bodyText: 'Interested'
    });

    assert.equal(result, existing);
    assert.equal(sends, 0);
});
