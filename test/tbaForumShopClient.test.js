'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TbaForumShopClient } = require('../features/tba-forum-shops/TbaForumShopClient.js');

const TOPIC_URL = 'https://pokemonrevolution.net/forum/topic/123-test-shop/';

test('shop client separates quoted text from the original message and builds a direct post link', () => {
    const client = new TbaForumShopClient({ topicUrl: TOPIC_URL, fetch: async () => null });
    const html = `
        <div data-ips-pagination-pages="4"></div>
        <article data-ips-hook="postWrapper" data-commentid="456">
            <h3 data-ips-hook="postUsername"><a href="/forum/profile/10-buyer/">BuyerName</a></h3>
            <time datetime="2026-07-14T12:34:00.000Z"></time>
            <div data-role="commentContent">
                <p>I would like to buy this.</p>
                <p><a href="/forum/topic/999-details/">Service details</a></p>
                <blockquote class="ipsQuote"><p>Quoted shop text</p></blockquote>
                <div data-role="memberSignature">Buyer signature</div>
                <div class="ipsEdited">Edited by BuyerName</div>
                <img alt="proof-image.png" src="/uploads/proof-image.png">
            </div>
        </article>`;

    const parsed = client.extractPosts(html, 3);
    assert.equal(parsed.lastPage, 4);
    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.posts[0].forumUsername, 'BuyerName');
    assert.equal(parsed.posts[0].postUrl, `${TOPIC_URL.replace(/\/$/, '')}/page/3/#findComment-456`);
    assert.match(parsed.posts[0].bodyText, /I would like to buy this\./);
    assert.match(parsed.posts[0].bodyText, /\[Service details\]\(https:\/\/pokemonrevolution\.net\/forum\/topic\/999-details\/\)/);
    assert.doesNotMatch(parsed.posts[0].bodyText, /Quoted shop text/);
    assert.equal(parsed.posts[0].quotedBodyText, 'Quoted shop text');
    assert.match(parsed.posts[0].bodyText, /Buyer signature/);
    assert.match(parsed.posts[0].bodyText, /Edited by BuyerName/);
    assert.match(parsed.posts[0].bodyText, /proof-image\.png/);
    assert.deepEqual(parsed.posts[0].imageUrls, [
        'https://pokemonrevolution.net/uploads/proof-image.png'
    ]);
    assert.deepEqual(parsed.posts[0].extractionWarnings, []);
});

test('shop client reads Retry-After when the forum rate limits a request', async () => {
    const client = new TbaForumShopClient({
        topicUrl: TOPIC_URL,
        fetch: async () => ({
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '90' })
        })
    });

    await assert.rejects(
        () => client.fetchPage(1),
        error => error.status === 429 && error.retryAfterMs === 90_000
    );
});

test('shop client falls back to alternate post markup and records missing details', () => {
    const client = new TbaForumShopClient({ topicUrl: TOPIC_URL, fetch: async () => null });
    const parsed = client.extractPosts(`
        <article data-commentid="789">
            <div class="ipsComment_content"><p>Fallback customer message</p></div>
        </article>`, 1);

    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.posts[0].forumUsername, 'Unknown Forum User');
    assert.equal(parsed.posts[0].bodyText, 'Fallback customer message');
    assert.deepEqual(parsed.posts[0].extractionWarnings.sort(), [
        'forum username',
        'message layout',
        'post timestamp'
    ]);
});

test('shop client rejects an invalid image body even when the server says it is PNG', async () => {
    const client = new TbaForumShopClient({
        topicUrl: TOPIC_URL,
        fetch: async () => ({
            ok: true,
            headers: new Headers({
                'content-type': 'image/png',
                'content-length': '9'
            }),
            arrayBuffer: async () => Buffer.from('not-image')
        })
    });

    await assert.rejects(
        () => client.downloadImage('https://example.com/broken.png', 0),
        /did not contain a valid image/
    );
});
