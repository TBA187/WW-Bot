'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { OcrWorkerPool, sharedOcrWorkerPool, configureImageMemory } = require('../utils/runtimeMemoryOcr.js');
const { PvpScoutOcr } = require('../features/pvp-scouting/PvpScoutOcr.js');
const { GuildApplicationOcr } = require('../features/guild-applications/parsing/GuildApplicationOcr.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function timers() {
    const active = new Map();
    return {
        active,
        setTimeout(callback, delay) {
            const timer = { unref() {} };
            active.set(timer, { callback, delay });
            return timer;
        },
        clearTimeout(timer) { active.delete(timer); },
        expire() {
            const [timer, { callback }] = active.entries().next().value;
            active.delete(timer);
            callback();
        }
    };
}

test('Gold, Silver and guild OCR share one production pool while injected factories remain isolated', () => {
    const gold = new PvpScoutOcr();
    const silver = new PvpScoutOcr();
    const guild = new GuildApplicationOcr();
    for (const ocr of [gold, silver, guild]) assert.equal(ocr.workerPool, sharedOcrWorkerPool);
    const custom = new GuildApplicationOcr({ workerFactory: async () => ({}) });
    assert.notEqual(custom.workerPool, sharedOcrWorkerPool);
});

test('OCR tasks across features cannot overlap and share a single worker', async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    let creates = 0;
    let activeRecognizes = 0;
    let maxRecognizes = 0;
    let calls = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        creates++;
        return {
            async recognize() {
                calls++;
                activeRecognizes++;
                maxRecognizes = Math.max(maxRecognizes, activeRecognizes);
                if (calls === 1) {
                    firstStarted.resolve();
                    await firstRelease.promise;
                }
                activeRecognizes--;
                return { data: { text: 'Name: Rega', confidence: 90 } };
            },
            async terminate() {}
        };
    } });
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const gold = new PvpScoutOcr({ workerPool: pool });
    const silver = new PvpScoutOcr({ workerPool: pool });
    gold.download = silver.download = async () => ({ buffer: image });
    const guild = new GuildApplicationOcr({ workerPool: pool });
    const first = gold.analyzeAttachment({ id: 'first', url: 'image' }, 'message');
    await firstStarted.promise;
    const second = silver.analyzeAttachment({ id: 'second', url: 'image' }, 'message');
    const third = guild.resolveIgn({ forumUsername: 'Rega' }, { fields: {} }, [{ buffer: image, url: 'card' }]);
    assert.equal(pool.snapshot().pending, 3);
    assert.equal(calls, 1);
    firstRelease.resolve();
    const [goldResult, silverResult, guildResult] = await Promise.all([first, second, third]);
    assert.equal(goldResult.error, null);
    assert.equal(silverResult.error, null);
    assert.equal(guildResult.ign, 'Rega');
    assert.equal(maxRecognizes, 1);
    assert.equal(creates, 1);
    assert.deepEqual(pool.snapshot(), { workers: 1, creating: false, pending: 0 });
    await pool.close();
});

test('idle workers terminate and the next request recreates them', async () => {
    const clock = timers();
    let creates = 0;
    let terminates = 0;
    const pool = new OcrWorkerPool({ ...clock, idleTimeoutMs: 100, workerFactory: async () => {
        creates++;
        return { async terminate() { terminates++; } };
    } });
    const first = await pool.run(() => pool.getWorker());
    assert.equal(clock.active.size, 1);
    assert.equal([...clock.active.values()][0].delay, 100);
    clock.expire();
    await pool.queue;
    assert.equal(terminates, 1);
    assert.equal(pool.snapshot().workers, 0);
    assert.equal(clock.active.size, 0);
    const second = await pool.run(() => pool.getWorker());
    assert.notEqual(first, second);
    assert.equal(creates, 2);
    await pool.close();
    assert.equal(terminates, 2);
    assert.equal(clock.active.size, 0);
});

test('a queued or active task cancels idle termination and shutdown waits for it', async () => {
    const clock = timers();
    const release = deferred();
    let terminates = 0;
    const pool = new OcrWorkerPool({ ...clock, workerFactory: async () => ({ async terminate() { terminates++; } }) });
    await pool.run(() => pool.getWorker());
    const task = pool.run(async () => { await pool.getWorker(); await release.promise; });
    assert.equal(clock.active.size, 0);
    const closing = pool.close();
    await Promise.resolve();
    assert.equal(terminates, 0);
    release.resolve();
    await Promise.all([task, closing]);
    assert.equal(terminates, 1);
    assert.equal(clock.active.size, 0);
});

test('worker creation failure and OCR rejection do not poison the shared queue', async () => {
    let attempts = 0;
    const worker = { async terminate() {} };
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        if (++attempts === 1) throw new Error('initialization failed');
        return worker;
    } });
    await assert.rejects(pool.run(() => pool.getWorker()), /initialization failed/u);
    assert.equal(await pool.run(() => pool.getWorker()), worker);
    await assert.rejects(pool.run(() => { throw new Error('scan failed'); }), /scan failed/u);
    assert.equal(await pool.run(() => 'next scan'), 'next scan');
    assert.equal(await pool.queue, undefined);
    assert.equal(pool.snapshot().pending, 0);
    await pool.close();
});

test('directly injected workers stay available until explicit close', async () => {
    const clock = timers();
    let terminates = 0;
    const worker = { async terminate() { terminates++; } };
    const pool = new OcrWorkerPool({ ...clock, worker });
    assert.equal(await pool.run(() => pool.getWorker()), worker);
    assert.equal(clock.active.size, 0);
    await pool.close();
    assert.equal(terminates, 1);
});

test('a failed recognition discards its worker before the next feature reuses the pool', async () => {
    let creates = 0;
    const terminated = [];
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        const id = ++creates;
        return {
            async recognize() {
                if (id === 1) throw new Error('failed with a temporary whitelist');
                return { data: { text: 'Name: Rega' } };
            },
            async terminate() { terminated.push(id); }
        };
    } });
    await assert.rejects(pool.run(() => pool.recognize(Buffer.from('image'))), /temporary whitelist/u);
    assert.deepEqual(terminated, [1]);
    assert.equal(pool.snapshot().workers, 0);
    const result = await pool.run(() => pool.recognize(Buffer.from('image')));
    assert.equal(result.data.text, 'Name: Rega');
    assert.equal(creates, 2);
    await pool.close();
    assert.deepEqual(terminated, [1, 2]);
});

test('image memory limits configure each sharp implementation once', () => {
    const calls = [];
    const fakeSharp = { cache: value => calls.push(value), concurrency: value => calls.push(value) };
    configureImageMemory(fakeSharp);
    configureImageMemory(fakeSharp);
    assert.deepEqual(calls, [{ memory: 16, files: 0, items: 32 }, 1]);
});

test('Tesseract string rejections retain their message for contextual error reporting', async () => {
    let terminated = false;
    const pool = new OcrWorkerPool({ worker: {
        async recognize() { throw 'decoder could not read the image'; },
        async terminate() { terminated = true; }
    } });
    await assert.rejects(pool.run(() => pool.recognize(Buffer.from('invalid'))),
        error => error instanceof Error && error.message === 'decoder could not read the image');
    assert.equal(terminated, true);
    assert.equal(pool.snapshot().workers, 0);
});
