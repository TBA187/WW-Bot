'use strict';

const fs = require('node:fs');

// This entry point loads only OCR, never bot configuration, Discord or MySQL.
function serveOcrProcess(createWorker = (...args) => require('tesseract.js').createWorker(...args)) {
    let pool;
    let queue = Promise.resolve();
    const respond = response => {
        if (!process.connected) return;
        // The OS retains the high-water mark even when a short image job has
        // already released its allocations before the next parent sample.
        process.send({ ...response, memory: {
            rss: process.memoryUsage.rss(), peakRss: process.resourceUsage().maxRSS * 1024
        } });
    };
    process.on('disconnect', () => process.exit(0));
    process.on('message', message => {
        queue = queue.then(async () => {
            const { id, action, args } = message;
            try {
                let result;
                if (action === 'initialize' && !pool) {
                    const options = args[0];
                    fs.mkdirSync(options.cachePath, { recursive: true });
                    const { OcrWorkerPool } = require('./runtimeMemoryOcr.js');
                    pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
                        let initialized = false;
                        const worker = await createWorker('eng', 1, { ...options, logger: () => {}, errorHandler: error => {
                            // v7 startup failures can otherwise leave createWorker pending.
                            // A fatal error exits only this helper; the parent rejects the job.
                            if (!initialized) throw new Error(String(error));
                        } });
                        initialized = true;
                        return worker;
                    } });
                    await pool.getWorker();
                    result = { ready: true };
                } else if (action === 'recognize' && pool) {
                    result = await pool.recognize(...args);
                } else if (action === 'scout' && pool) {
                    const { PvpScoutOcr } = require('../features/pvp-scouting/PvpScoutOcr.js');
                    const [attachment, messageId, opponentIgn, context, options] = args;
                    result = await new PvpScoutOcr({ ...options, workerPool: pool })
                        .analyzeAttachment(attachment, messageId, opponentIgn, context);
                } else if (action === 'guild' && pool) {
                    const { GuildApplicationOcr } = require('../features/guild-applications/parsing/GuildApplicationOcr.js');
                    const [post, parserResult, images, options] = args;
                    result = await new GuildApplicationOcr({ ...options, workerPool: pool }).resolveIgn(post, parserResult, images);
                } else if (action === 'memory') {
                    result = process.memoryUsage();
                } else throw new Error('Invalid OCR helper request.');
                respond({ id, result });
            } catch (error) {
                respond({ id, error: error?.message || String(error) });
            }
        }).catch(() => process.exit(1));
    });
}

if (require.main === module) serveOcrProcess();
module.exports = { serveOcrProcess };
