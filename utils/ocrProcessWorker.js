'use strict';

// Runs OCR in a child process and handles request deadlines, failures, and cleanup.
const { fork } = require('node:child_process');
const path = require('node:path');

// Keep Tesseract behind IPC. Ending a worker thread can leave
// native allocator arenas resident in the bot; ending this process releases them.
async function createOcrProcessWorker({ cachePath, workerOptions = {}, forkProcess = fork,
    scriptPath = path.join(__dirname, 'ocrProcessEntry.js'), timeoutMs = 120_000 } = {}) {
    const child = forkProcess(scriptPath, [], {
        execArgv: [], windowsHide: true, serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2' }
    });
    const pending = new Map();
    let nextId = 0, ended = false, stopping = false, killTimer;
    let lastMemory = null;
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const rejectPending = error => {
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
        pending.clear();
    };
    child.on('message', message => {
        if (Number.isFinite(message?.memory?.rss) && Number.isFinite(message?.memory?.peakRss)) {
            lastMemory = { rss: message.memory.rss, peakRss: message.memory.peakRss };
        }
        const task = pending.get(message?.id);
        if (!task) return;
        pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error(message.error));
        else task.resolve(message.result);
    });
    child.once('exit', (code, signal) => {
        ended = true;
        clearTimeout(killTimer);
        rejectPending(new Error(`OCR helper exited (${signal || code}).`));
        resolveExit();
    });
    child.on('error', error => {
        rejectPending(error);
        // Failed spawn has no process and therefore no exit event.
        if (!child.pid) { ended = true; resolveExit(); }
    });
    child.once('disconnect', () => {
        if (!stopping) {
            rejectPending(new Error('OCR helper disconnected.'));
            void terminate();
        }
    });

    function request(action, args, deadlineMs = timeoutMs) {
        if (ended || stopping) return Promise.reject(new Error('OCR helper is closed.'));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                rejectPending(new Error(`OCR helper ${action} timed out.`));
                void terminate();
            }, deadlineMs);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            const failedSend = error => {
                if (error) { rejectPending(error); void terminate(); }
            };
            try { child.send({ id, action, args }, failedSend); }
            catch (error) { failedSend(error); }
        });
    }

    function terminate() {
        if (ended || stopping) return exited;
        stopping = true;
        rejectPending(new Error('OCR helper was stopped.'));
        child.kill();
        // A stuck native call must not keep the helper or shutdown alive forever.
        killTimer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
        killTimer.unref?.();
        return exited;
    }

    try {
        await request('initialize', [{ cachePath, ...workerOptions }]);
        return { processId: child.pid, recognize: (...args) => request('recognize', args),
            analyzeScout: (...args) => request('scout', args, Math.max(timeoutMs, 10 * 60_000)),
            resolveGuild: (...args) => request('guild', args, Math.max(timeoutMs, 10 * 60_000)),
            memoryUsage: () => request('memory', []), memorySnapshot: () => lastMemory, terminate };
    } catch (error) {
        await terminate();
        throw error;
    }
}

module.exports = { createOcrProcessWorker };
