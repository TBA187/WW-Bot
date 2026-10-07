// Cancel pending startup work and delays when the bot shuts down.
'use strict';

function shutdownError() {
    return Object.assign(new Error('Bot startup or background work was cancelled for shutdown.'), {
        code: 'BOT_SHUTTING_DOWN'
    });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw shutdownError();
}

function abortable(pending, { signal, timeoutMs, timeoutCode = 'OPERATION_TIMEOUT' } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            handler(value);
        };
        const onAbort = () => finish(reject, shutdownError());
        // Observe the original operation even if cancellation wins the race.
        Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs > 0) timer = setTimeout(() => finish(reject,
            Object.assign(new Error('The operation exceeded its response deadline.'), { code: timeoutCode })), timeoutMs);
    });
}

function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(shutdownError());
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(shutdownError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

class StartupLifecycle {
    constructor() { this.controller = new AbortController(); }
    get signal() { return this.controller.signal; }
    get stopping() { return this.signal.aborted; }
    stop() { this.controller.abort(); }
    check() { throwIfAborted(this.signal); }
    async run(work) {
        this.check();
        const result = await abortable(Promise.resolve().then(() => { this.check(); return work(); }), { signal: this.signal });
        this.check();
        return result;
    }

    async preload(work, { timeoutMs = 1500, timeoutCode, onTimeout, onError }) {
        return this.run(() => {
            const pending = Promise.resolve().then(() => { this.check(); return work(); }).catch(error => {
                // Keep observing the cache fill after the startup deadline expires.
                if (!this.stopping) onError(error);
            });
            return abortable(pending, { signal: this.signal, timeoutMs, timeoutCode }).catch(error => {
                this.check();
                if (error.code !== timeoutCode) throw error;
                onTimeout(error);
            });
        });
    }
}

module.exports = { abortable, abortableDelay, shutdownError, StartupLifecycle, throwIfAborted };
