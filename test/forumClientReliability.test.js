'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProForumClient, ForumRequestError } = require('../features/guild-applications/forum/ProForumClient.js');
const { TbaForumShopClient, TbaForumRequestError } = require('../features/tba-forum-shops/TbaForumShopClient.js');
const { readResponseBuffer } = require('../utils/readResponseBuffer.js');

test('bounded downloads preserve valid chunks and release their stream reader', async () => {
    const body = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close();
    } });
    const buffer = await readResponseBuffer({ body, headers: new Headers() }, 3, () => new Error('too large'));
    assert.deepEqual(buffer, Buffer.from([1, 2, 3]));
    assert.equal(body.locked, false);
});

for (const [label, Client, ErrorType] of [['Applications', ProForumClient, ForumRequestError], ['Shops', TbaForumShopClient, TbaForumRequestError]]) {
    test(`${label} stops oversized image streams without trusting Content-Length`, async () => {
        for (const declaredSize of [null, '1', '12']) {
            let pulled = 0, cancelled = false;
            const headers = new Headers({ 'content-type': 'image/png' });
            if (declaredSize) headers.set('content-length', declaredSize);
            const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(3)); },
                cancel() { cancelled = true; } }, { highWaterMark: 0 });
            const client = new Client({ topicUrl: 'https://example.com/forum/topic/1-test/', maxImageBytes: 5,
                fetch: async () => ({ ok: true, headers, body }) });
            await assert.rejects(client.downloadImage('https://example.com/image.png', 0),
                error => error instanceof ErrorType && /exceeds|larger than/.test(error.message));
            assert.equal(cancelled, true);
            assert.equal(body.locked, false);
            assert.equal(pulled, declaredSize === '12' ? 0 : 2);
        }
    });
    test(`${label} cancels unused bodies after HTTP and content-type errors`, async () => {
        for (const ok of [false, true]) {
            let cancelled = false;
            const client = new Client({ topicUrl: 'https://example.com/forum/topic/1-test/',
                fetch: async () => ({ ok, status: 522, headers: new Headers({ 'content-type': 'text/html' }),
                    body: new ReadableStream({ cancel() { cancelled = true; } }) }) });
            await assert.rejects(client.downloadImage('https://example.com/image.png', 0), ErrorType);
            assert.equal(cancelled, true);
        }
    });
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
