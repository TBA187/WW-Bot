'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProForumClient, ForumRequestError } = require('../features/guild-applications/forum/ProForumClient.js');
const { TbaForumShopClient, TbaForumRequestError } = require('../features/tba-forum-shops/TbaForumShopClient.js');

for (const [label, Client, ErrorType] of [['Applications', ProForumClient, ForumRequestError], ['Shops', TbaForumShopClient, TbaForumRequestError]]) {
    for (const method of ['html', 'image']) {
        test(`${label} aborts a stalled ${method} body even after successful HTTP headers`, async () => {
            const keepAlive = setInterval(() => {}, 1000);
            let aborted = false;
            const client = new Client({ topicUrl: 'https://example.com/forum/topic/1-test/', requestTimeoutMs: 20, imageTimeoutMs: 20,
                fetch: async (url, { signal }) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
                    text: readBody, arrayBuffer: readBody }) });
            function readBody() {
                return new Promise((resolve, reject) => {
                    // The fake body reacts to the same signal as a real fetch stream.
                    client.lastSignal.addEventListener('abort', () => {
                        aborted = true;
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    }, { once: true });
                });
            }
            const originalFetch = client.fetch;
            client.fetch = async (url, options) => { client.lastSignal = options.signal; return originalFetch(url, options); };
            try {
                await assert.rejects(method === 'html' ? client.fetchPage(1) : client.downloadImage('https://example.com/card.png', 0),
                    error => error instanceof ErrorType && /timed out/u.test(error.message));
                assert.equal(aborted, true);
            } finally { clearInterval(keepAlive); }
        });
    }
    test(`${label} rejects empty HTTP-200 challenge/login pages`, async () => {
        const client = new Client({ topicUrl: 'https://example.com/forum/topic/1-test/',
            fetch: async () => ({ ok: true, text: async () => '<html>Please log in</html>' }) });
        await assert.rejects(client.fetchPage(1), error => error instanceof ErrorType && /readable posts/u.test(error.message));
    });
    test(`${label} rejects partial extraction so the unreadable post cannot be skipped`, () => {
        const client = new Client({ topicUrl: 'https://example.com/forum/topic/1-test/' });
        assert.throws(() => client.extractPosts(`<article data-commentid="1" data-ips-hook="postWrapper">
            <div data-role="commentContent">Readable post</div></article>
            <article data-ips-hook="postWrapper"><div data-role="commentContent">Missing post ID</div></article>`, 1), ErrorType);
    });
}

for (const [label, Client] of [['Applications', ProForumClient], ['Shops', TbaForumShopClient]]) {
    test(`${label} page counts ignore foreign-topic links and pagination quoted inside posts`, () => {
        const client = new Client({ topicUrl: 'https://example.com/forum/topic/123-current-topic/' });
        const parsed = client.extractPosts(`<link rel="last" href="/forum/topic/123-current-topic/page/4/">
            <a href="/forum/topic/999-another-topic/page/999/">Another topic</a>
            <a href="https://another.example.com/forum/topic/123-current-topic/page/500/">Another host</a>
            <a href="/forum/topic/123-renamed-slug/page/5/">Next page</a>
            <article data-commentid="1"><div data-role="commentContent">
                <a href="/forum/topic/123-current-topic/page/88/" data-page="88">Quoted old pagination</a>
            </div></article>`, 1);
        assert.equal(parsed.lastPage, 5);
    });
}
