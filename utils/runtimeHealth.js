// Distinguish process memory (including OCR workers) from container accounting.
'use strict';

const fs = require('node:fs/promises');
const v8 = require('node:v8');

const MIB = 1024 * 1024;

function positiveBytes(value) {
    const number = Number(String(value).trim());
    return Number.isFinite(number) && number > 0 ? number : null;
}

async function readContainerMemory(readFile = fs.readFile) {
    for (const paths of [
        ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.stat', 'file'],
        ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes',
            '/sys/fs/cgroup/memory/memory.stat', 'total_cache']
    ]) {
        try {
            const [current, limit, stat] = await Promise.all([
                readFile(paths[0], 'utf8'), readFile(paths[1], 'utf8'), readFile(paths[2], 'utf8').catch(() => '')
            ]);
            const used = positiveBytes(current), maximum = positiveBytes(limit);
            // v1 represents an unlimited container with an enormous sentinel.
            if (used === null || maximum === null || maximum >= Number.MAX_SAFE_INTEGER) continue;
            const cache = new RegExp(`^${paths[3]}\\s+(\\d+)$`, 'mu').exec(stat)?.[1];
            return { used, limit: maximum, fileCache: cache === undefined ? null : Number(cache) };
        } catch { /* Windows and hosts without a readable cgroup still report process memory. */ }
    }
    return null;
}

function discordCacheCounts(client) {
    let messages = 0, members = 0;
    for (const channel of client?.channels?.cache?.values?.() || []) messages += channel.messages?.cache?.size || 0;
    for (const guild of client?.guilds?.cache?.values?.() || []) members += guild.members?.cache?.size || 0;
    return { messages, members, users: client?.users?.cache?.size || 0 };
}

function formatMemorySample({ memory, heapLimit, container, caches, peakRss, ocr }) {
    const mib = bytes => (bytes / MIB).toFixed(1);
    const fields = [
        `RSS ${mib(memory.rss)} MiB (peak sampled ${mib(peakRss)} MiB)`,
        `main heap ${mib(memory.heapUsed)}/${mib(memory.heapTotal)} MiB (limit ${mib(heapLimit)} MiB)`,
        `external ${mib(memory.external)} MiB`, `buffers ${mib(memory.arrayBuffers || 0)} MiB`,
        ...(container ? [`container ${mib(container.used)}/${mib(container.limit)} MiB (${(100 * container.used / container.limit).toFixed(1)}%)`,
            ...(container.fileCache !== null ? [`container file cache ${mib(container.fileCache)} MiB`] : [])] : []),
        `Discord caches: ${caches.messages} messages, ${caches.members} members, ${caches.users} users`,
        ...(ocr ? [`OCR: ${ocr.workers} worker(s), ${ocr.pending} queued/active task(s)${ocr.creating ? ', initializing' : ''}${ocr.processId ? `, isolated process ${ocr.processId}` : ''}`] : [])
    ];
    return `[RUNTIME MEMORY] ${fields.join('; ')}.`;
}

class RuntimeHealth {
    constructor({ client, consoleObject = console, memoryUsage = () => process.memoryUsage(),
        heapLimit = () => v8.getHeapStatistics().heap_size_limit, containerMemory = readContainerMemory,
        ocrSnapshot = () => null, intervalMs = 30 * 60_000, schedule = setInterval, cancel = clearInterval } = {}) {
        this.client = client; this.console = consoleObject; this.memoryUsage = memoryUsage;
        this.heapLimit = heapLimit; this.containerMemory = containerMemory;
        this.ocrSnapshot = ocrSnapshot;
        this.intervalMs = intervalMs; this.schedule = schedule; this.cancel = cancel;
        this.timer = null; this.started = false; this.stopped = false; this.sampling = false; this.peakRss = 0;
    }

    async sample() {
        if (this.sampling || this.stopped) return;
        this.sampling = true;
        try {
            const container = await this.containerMemory();
            if (this.stopped) return;
            const memory = this.memoryUsage();
            this.peakRss = Math.max(this.peakRss, memory.rss);
            this.console.log(formatMemorySample({ memory, heapLimit: this.heapLimit(), container,
                caches: discordCacheCounts(this.client), peakRss: this.peakRss, ocr: this.ocrSnapshot() }));
        } catch { /* Health reporting must never interrupt commands or shutdown. */ }
        finally { this.sampling = false; }
    }

    start() {
        if (this.started || this.stopped) return;
        this.started = true;
        void this.sample();
        this.timer = this.schedule(() => { void this.sample(); }, this.intervalMs);
        this.timer.unref?.();
    }

    stop() {
        this.stopped = true;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
    }
}

module.exports = { RuntimeHealth, readContainerMemory, discordCacheCounts, formatMemorySample };
