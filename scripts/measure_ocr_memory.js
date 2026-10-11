'use strict';

// Offline process-memory benchmark; does not load bot configuration, connect to
// Discord/MySQL, or download language data. Run: node --expose-gc scripts/measure_ocr_memory.js
const fs = require('node:fs');
const path = require('node:path');

const cachePath = path.join(__dirname, '..', 'data', 'tesseract-cache');
const languageFile = path.join(cachePath, 'eng.traineddata');

async function measure() {
    if (!fs.existsSync(languageFile)) throw new Error(`Offline OCR benchmark requires the existing language cache: ${languageFile}`);
    const { createWorker } = require('tesseract.js');
    const sharp = require('sharp');
    const { configureImageMemory } = require('../utils/runtimeMemoryOcr.js');
    configureImageMemory(sharp);
    const workers = [];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sample = label => {
        global.gc?.();
        const usage = process.memoryUsage();
        const mib = bytes => Number((bytes / 1048576).toFixed(1));
        console.log(JSON.stringify({ label, rssMiB: mib(usage.rss), heapMiB: mib(usage.heapUsed), externalMiB: mib(usage.external) }));
    };
    try {
        sample('baseline: modules loaded, no OCR worker');
        const image = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#ffffff' } })
            .withMetadata({ density: 96 }).png().toBuffer();
        for (let count = 1; count <= 3; count++) {
            // A cache miss only tries this local directory. No CDN fallback.
            const worker = await createWorker('eng', 1, {
                logger: () => {}, cachePath, langPath: cachePath, gzip: false, cacheMethod: 'readOnly'
            });
            workers.push(worker);
            await worker.recognize(image);
            await pause(150);
            sample(`${count} OCR worker(s), after a 1080p scan`);
        }
        while (workers.length > 1) await workers.pop().terminate();
        await pause(500);
        sample('only one worker retained');
        await workers.pop().terminate();
        await pause(500);
        sample('all workers terminated');
    } finally {
        for (const worker of workers) await worker.terminate().catch(() => {});
    }
}

measure().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
