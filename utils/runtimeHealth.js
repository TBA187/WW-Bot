// The bot's RSS excludes isolated OCR processes; container accounting includes them.
'use strict';

const fs = require('node:fs/promises');
const v8 = require('node:v8');
const { runtimeActivity } = require('./runtimeActivity.js');

const MIB = 1024 * 1024;
const MEMORY_BUDGET_BYTES = 512 * MIB;
const WARNING_RATIO = 0.80;
const CRITICAL_RATIO = 0.90;
const RECOVERY_RATIO = 0.75;
const ALERT_COOLDOWN_MS = 10 * 60_000;

function positiveBytes(value) {
    const number = Number(String(value).trim());
    return Number.isFinite(number) && number > 0 ? number : null;
}

async function readContainerMemory(readFile = fs.readFile) {
    for (const paths of [
        ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.stat', 'file', 'inactive_file'],
        ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes',
            '/sys/fs/cgroup/memory/memory.stat', 'total_cache', 'total_inactive_file']
    ]) {
        try {
            const [current, limit, stat] = await Promise.all([
                readFile(paths[0], 'utf8'), readFile(paths[1], 'utf8'), readFile(paths[2], 'utf8').catch(() => '')
            ]);
            const used = positiveBytes(current), maximum = positiveBytes(limit);
            // v1 represents an unlimited container with an enormous sentinel.
            if (used === null || maximum === null || maximum >= Number.MAX_SAFE_INTEGER) continue;
            const cache = new RegExp(`^${paths[3]}\\s+(\\d+)$`, 'mu').exec(stat)?.[1];
            const inactive = new RegExp(`^${paths[4]}\\s+(\\d+)$`, 'mu').exec(stat)?.[1];
            const inactiveFile = inactive === undefined ? null : Number(inactive);
            // Match Pterodactyl/Docker's working-set calculation, not total file cache.
            const workingSet = inactiveFile !== null && inactiveFile <= used ? used - inactiveFile : null;
            return { used, limit: maximum, fileCache: cache === undefined ? null : Number(cache), inactiveFile, workingSet };
        } catch { /* Windows and hosts without a readable cgroup still report process memory. */ }
    }
    return null;
}

async function readContainerPeak(readFile = fs.readFile) {
    for (const file of ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes']) {
        try {
            const peak = positiveBytes(await readFile(file, 'utf8'));
            if (peak !== null && peak < Number.MAX_SAFE_INTEGER) return peak;
        } catch { /* Older kernels and non-Linux hosts may not expose a high-water mark. */ }
    }
    return null;
}

function effectiveMemoryLimit(container) {
    return Math.min(MEMORY_BUDGET_BYTES, positiveBytes(container?.limit) ?? MEMORY_BUDGET_BYTES);
}

function discordCacheCounts(client) {
    let messages = 0, members = 0;
    for (const channel of client?.channels?.cache?.values?.() || []) messages += channel.messages?.cache?.size || 0;
    for (const guild of client?.guilds?.cache?.values?.() || []) members += guild.members?.cache?.size || 0;
    return { messages, members, users: client?.users?.cache?.size || 0 };
}

function containerDetails(container) {
    if (!container) return [];
    const mib = bytes => (bytes / MIB).toFixed(1);
    return [
        ...(Number.isFinite(container.fileCache) ? [`container file cache ${mib(container.fileCache)} MiB`] : []),
        `inactive file cache ${Number.isFinite(container.inactiveFile) ? `${mib(container.inactiveFile)} MiB` : 'unavailable'}`,
        `panel-equivalent estimate ${Number.isFinite(container.workingSet) ? `${mib(container.workingSet)} MiB` : 'unavailable'}`
    ];
}

function jobDetails(activity) {
    const seconds = ms => (ms / 1000).toFixed(1);
    const jobs = (activity?.active || []).slice(0, 8).map(job => `${job.name} (${seconds(job.elapsedMs)}s)`);
    const recent = (activity?.recent || []).slice(-8).map(job => `${job.name} (${seconds(job.elapsedMs)}s, ended ${seconds(job.endedAgoMs)}s ago)`);
    return [`active jobs: ${jobs.join(', ') || 'none'}`, `recent jobs: ${recent.join(', ') || 'none'}`];
}

function formatMemorySample({ memory, heapLimit, container, caches, peakRss, ocr,
    osPeakRss, containerPeak, window, activity, sampleIntervalMs = 5000, activeSampleIntervalMs = 1000 }) {
    const mib = bytes => (bytes / MIB).toFixed(1);
    const fields = [
        `RSS ${mib(memory.rss)} MiB (peak sampled ${mib(peakRss)} MiB)`,
        `main heap ${mib(memory.heapUsed)}/${mib(memory.heapTotal)} MiB (limit ${mib(heapLimit)} MiB)`,
        `external ${mib(memory.external)} MiB`, `buffers ${mib(memory.arrayBuffers || 0)} MiB`,
        ...(osPeakRss ? [`bot process OS lifetime peak ${mib(osPeakRss)} MiB`] : []),
        ...(container ? [`container ${mib(container.used)}/${mib(effectiveMemoryLimit(container))} MiB (${(100 * container.used / effectiveMemoryLimit(container)).toFixed(1)}%)`,
            ...containerDetails(container)] : []),
        ...(!container ? [`container accounting unavailable; bot process RSS excludes isolated OCR; budget ${mib(MEMORY_BUDGET_BYTES)} MiB`] : []),
        ...(containerPeak ? [`container OS lifetime peak ${mib(containerPeak)} MiB (may include earlier bot runs)`] : []),
        `Discord caches: ${caches.messages} messages, ${caches.members} members, ${caches.users} users`,
        ...(ocr ? [`OCR: ${ocr.workers} worker(s), ${ocr.pending} queued/active task(s)${ocr.creating ? ', initializing' : ''}${ocr.processId ? `, isolated process ${ocr.processId}` : ''}`] : []),
        ...(ocr?.peakProcessRss ? [`OCR process OS peak since bot start ${mib(ocr.peakProcessRss)} MiB`] : []),
        ...(window ? [
            `since previous report: ${window.samples} samples (${sampleIntervalMs / 1000}s idle / ${activeSampleIntervalMs / 1000}s during OCR or memory pressure); bot RSS peak ${mib(window.peakRss)} MiB` +
                (window.peakContainer !== null ? `; container peak ${mib(window.peakContainer)} MiB${window.peakContainerOcrActive ? ' (OCR queued/active)' : ''}; jobs at sampled peak: ${window.peakJobs || 'none'}` : ''),
            `OCR interval: ${window.ocrStarted} task(s) queued, ${window.ocrCompleted} completed, ${window.ocrFailed} failed; sampled max ${window.ocrWorkers} worker(s), ${window.ocrPending} queued/active task(s)`
        ] : []),
        ...jobDetails(activity)
    ];
    return `[RUNTIME MEMORY] ${fields.join('; ')}.`;
}

class RuntimeHealth {
    constructor({ client, consoleObject = console, memoryUsage = () => process.memoryUsage(),
        heapLimit = () => v8.getHeapStatistics().heap_size_limit, containerMemory = readContainerMemory,
        rssUsage = () => process.memoryUsage.rss(), processPeak = () => process.resourceUsage().maxRSS * 1024,
        containerPeak = readContainerPeak, ocrSnapshot = () => null, activitySnapshot = () => runtimeActivity.snapshot(), now = Date.now,
        intervalMs = 30 * 60_000, sampleIntervalMs = 5000, activeSampleIntervalMs = 1000,
        schedule = setInterval, cancel = clearInterval } = {}) {
        this.client = client; this.console = consoleObject; this.memoryUsage = memoryUsage;
        this.heapLimit = heapLimit; this.containerMemory = containerMemory;
        this.ocrSnapshot = ocrSnapshot;
        this.activitySnapshot = activitySnapshot;
        this.rssUsage = rssUsage; this.processPeak = processPeak; this.containerPeak = containerPeak; this.now = now;
        this.intervalMs = intervalMs; this.sampleIntervalMs = sampleIntervalMs; this.schedule = schedule; this.cancel = cancel;
        this.activeSampleIntervalMs = activeSampleIntervalMs;
        this.timer = null; this.started = false; this.stopped = false; this.sampling = false; this.peakRss = 0;
        this.lastSampleAt = null; this.lastReportAt = null; this.lastAlertAt = 0; this.alertLevel = 0;
        this.ocrBaseline = { started: 0, completed: 0, failed: 0 };
        this.resetWindow();
    }

    resetWindow() {
        this.window = { samples: 0, peakRss: 0, peakContainer: null, peakContainerOcrActive: false, peakJobs: '',
            ocrStarted: 0, ocrCompleted: 0, ocrFailed: 0, ocrWorkers: 0, ocrPending: 0 };
    }

    recordSample(memory, container, ocr, activity) {
        this.peakRss = Math.max(this.peakRss, memory.rss);
        const window = this.window;
        window.samples++;
        window.peakRss = Math.max(window.peakRss, memory.rss);
        if (container && (window.peakContainer === null || container.used > window.peakContainer)) {
            window.peakContainer = container.used;
            window.peakContainerOcrActive = Boolean(ocr?.pending || ocr?.creating);
            window.peakJobs = (activity?.active || []).slice(0, 8).map(job => job.name).join(', ');
        }
        window.ocrWorkers = Math.max(window.ocrWorkers, ocr?.workers || 0);
        window.ocrPending = Math.max(window.ocrPending, ocr?.pending || 0);
        window.ocrStarted = Math.max(0, (ocr?.tasksStarted || 0) - this.ocrBaseline.started);
        window.ocrCompleted = Math.max(0, (ocr?.tasksCompleted || 0) - this.ocrBaseline.completed);
        window.ocrFailed = Math.max(0, (ocr?.tasksFailed || 0) - this.ocrBaseline.failed);
    }

    pressureEvent(memory, container, now) {
        const used = container?.used ?? memory.rss;
        const limit = effectiveMemoryLimit(container);
        const ratio = used / limit;
        const level = ratio >= CRITICAL_RATIO ? 2 : ratio >= WARNING_RATIO ? 1 : 0;
        if (level && (!this.alertLevel || level > this.alertLevel || now - this.lastAlertAt >= ALERT_COOLDOWN_MS)) {
            return { level, used, limit, ratio };
        } else if (this.alertLevel && ratio < RECOVERY_RATIO) {
            return { level: 0, used, limit, ratio };
        }
        return null;
    }

    reportPressure(event, memory, container, ocr, activity, now) {
        if (!event) return;
        const { level, used, limit, ratio } = event;
        const source = container ? 'container total including cache' : 'bot RSS only; isolated OCR excluded';
        const label = level ? level === 2 ? 'CRITICAL' : 'WARNING' : 'Recovered below 75%';
        const details = [...containerDetails(container), `bot RSS ${(memory.rss / MIB).toFixed(1)} MiB`,
            `main heap ${(memory.heapUsed / MIB).toFixed(1)}/${(memory.heapTotal / MIB).toFixed(1)} MiB`,
            `OCR ${ocr?.pending || 0} queued/active task(s)${ocr?.creating ? ', initializing' : ''}`,
            ...jobDetails(activity)];
        this.console[level ? 'warn' : 'log'](`[RUNTIME MEMORY] ${label}: ${(used / MIB).toFixed(1)}/${(limit / MIB).toFixed(1)} MiB (${(ratio * 100).toFixed(1)}%; ${source}); ${details.join('; ')}.`);
        this.alertLevel = level;
        if (level) this.lastAlertAt = now;
    }

    async sample({ report = true } = {}) {
        if (this.sampling || this.stopped) return;
        this.sampling = true;
        try {
            const ocr = this.ocrSnapshot();
            const tickTime = this.now();
            const reportDue = report || this.lastReportAt === null || tickTime - this.lastReportAt >= this.intervalMs;
            const sampleEvery = ocr?.pending || ocr?.creating || this.alertLevel
                ? this.activeSampleIntervalMs : this.sampleIntervalMs;
            // Idle ticks only inspect in-memory OCR state and the clock. No file
            // reads or process memory calls are made until a sample is due.
            if (!reportDue && this.lastSampleAt !== null && tickTime - this.lastSampleAt < sampleEvery) return;
            const container = await this.containerMemory();
            if (this.stopped) return;
            const now = this.now();
            // The fast RSS accessor avoids walking all allocated pages on every tick.
            let memory = reportDue ? this.memoryUsage() : { rss: this.rssUsage() };
            const pressure = this.pressureEvent(memory, container, now);
            // Collect heap details only for a report or an actual alert transition.
            if (pressure && !reportDue) memory = this.memoryUsage();
            const activity = this.activitySnapshot();
            this.lastSampleAt = tickTime;
            this.recordSample(memory, container, ocr, activity);
            this.reportPressure(pressure, memory, container, ocr, activity, now);
            if (reportDue) {
                const containerPeak = await this.containerPeak().catch(() => null);
                if (this.stopped) return;
                this.console.log(formatMemorySample({ memory, heapLimit: this.heapLimit(), container,
                    caches: discordCacheCounts(this.client), peakRss: this.peakRss, ocr,
                    osPeakRss: this.processPeak(), containerPeak, window: this.window, activity,
                    sampleIntervalMs: this.sampleIntervalMs, activeSampleIntervalMs: this.activeSampleIntervalMs }));
                this.lastReportAt = now;
                this.ocrBaseline = { started: ocr?.tasksStarted || 0, completed: ocr?.tasksCompleted || 0, failed: ocr?.tasksFailed || 0 };
                this.resetWindow();
            }
        } catch { /* Health reporting must never interrupt commands or shutdown. */ }
        finally { this.sampling = false; }
    }

    start() {
        if (this.started || this.stopped) return;
        this.started = true;
        void this.sample();
        this.timer = this.schedule(() => { void this.sample({ report: false }); }, Math.min(this.sampleIntervalMs, this.activeSampleIntervalMs));
        this.timer.unref?.();
    }

    stop() {
        this.stopped = true;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
    }
}

module.exports = { RuntimeHealth, readContainerMemory, discordCacheCounts, formatMemorySample, MEMORY_BUDGET_BYTES };
