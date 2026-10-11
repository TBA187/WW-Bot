'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OCR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const configuredSharp = new WeakSet();

// Image pipelines otherwise keep libvips' default 50 MiB cache and can use
// every CPU advertised by the host, even in a small shared container.
function configureImageMemory(sharp) {
    if (configuredSharp.has(sharp)) return;
    sharp.cache({ memory: 16, files: 0, items: 32 });
    sharp.concurrency(1);
    configuredSharp.add(sharp);
}

class OcrWorkerPool {
    constructor(options = {}) {
        this.worker = options.worker || null;
        this.workerPromise = null;
        this.workerFactory = options.workerFactory || (async () => {
            const { createWorker } = require('tesseract.js');
            const cachePath = options.cachePath || path.join(process.cwd(), 'data', 'tesseract-cache');
            fs.mkdirSync(cachePath, { recursive: true });
            let initialized = false;
            const worker = await createWorker('eng', 1, { logger: () => {}, cachePath, errorHandler: error => {
                // Preserve Tesseract's fatal initialization behavior: v7 can
                // otherwise leave createWorker pending after a startup error.
                // Once ready, job rejections reach our contextual scan handlers
                // without Tesseract rethrowing them as uncaught process errors.
                if (!initialized) throw new Error(String(error));
            } });
            initialized = true;
            return worker;
        });
        // A directly injected worker cannot be recreated by a custom factory.
        this.idleTimeoutMs = options.idleTimeoutMs ?? (options.worker && !options.workerFactory ? 0 : OCR_IDLE_TIMEOUT_MS);
        this.setTimeout = options.setTimeout || setTimeout;
        this.clearTimeout = options.clearTimeout || clearTimeout;
        this.queue = Promise.resolve();
        this.pending = 0;
        this.idleTimer = null;
    }

    clearIdleTimer() {
        if (this.idleTimer !== null) this.clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    scheduleIdleRelease() {
        this.clearIdleTimer();
        if (this.pending || !this.worker || this.idleTimeoutMs <= 0) return;
        this.idleTimer = this.setTimeout(() => {
            this.idleTimer = null;
            this.close().catch(error => {
                console.warn('[WW LOG] Could not release the idle OCR worker:', error?.message || error);
            });
        }, this.idleTimeoutMs);
        this.idleTimer?.unref?.();
    }

    // Serialize complete tasks, including their multiple recognize calls. All
    // production OCR users share this queue, so Gold, Silver and forum scans
    // never each allocate a Tesseract runtime at the same time.
    run(task) {
        this.pending++;
        this.clearIdleTimer();
        const result = this.queue.then(task);
        const settled = result.finally(() => {
            this.pending--;
            this.scheduleIdleRelease();
        });
        // Store a promise with no result to avoid retaining the last OCR output.
        this.queue = settled.then(() => undefined, () => undefined);
        return settled;
    }

    async getWorker() {
        if (this.worker) return this.worker;
        if (!this.workerPromise) this.workerPromise = Promise.resolve().then(this.workerFactory);
        const creating = this.workerPromise;
        try {
            this.worker = await creating;
            this.scheduleIdleRelease();
            return this.worker;
        } finally {
            if (this.workerPromise === creating) this.workerPromise = null;
        }
    }

    async recognize(...args) {
        const worker = await this.getWorker();
        try {
            return await worker.recognize(...args);
        } catch (error) {
            // Tesseract restores per-call parameters only after a successful
            // scan. A failed scan must not leak its whitelist/PSM to another
            // feature, or leave a damaged runtime alive in the shared pool.
            if (this.worker === worker) this.worker = null;
            try {
                if (worker?.terminate) await worker.terminate();
            } catch (releaseError) {
                console.warn('[WW LOG] Could not release the failed OCR worker:', releaseError?.message || releaseError);
            }
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    close() {
        return this.run(async () => {
            const worker = this.worker || (this.workerPromise ? await this.workerPromise.catch(() => null) : null);
            this.worker = null;
            this.workerPromise = null;
            if (worker?.terminate) await worker.terminate();
        });
    }

    snapshot() {
        return { workers: this.worker ? 1 : 0, creating: Boolean(this.workerPromise), pending: this.pending };
    }
}

const sharedOcrWorkerPool = new OcrWorkerPool();

function ocrWorkerPoolFor(options = {}) {
    if (options.workerPool) return options.workerPool;
    // Tests and callers supplying a custom factory/cache keep an isolated pool.
    if (options.worker || options.workerFactory || options.cachePath || options.idleTimeoutMs !== undefined) {
        return new OcrWorkerPool(options);
    }
    return sharedOcrWorkerPool;
}

module.exports = { OCR_IDLE_TIMEOUT_MS, OcrWorkerPool, sharedOcrWorkerPool, ocrWorkerPoolFor, configureImageMemory };
