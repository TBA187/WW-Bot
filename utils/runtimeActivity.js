'use strict';

// Keep only names and timings, never job payloads, member lists, or downloaded images.
class RuntimeActivity {
    constructor({ now = Date.now, recentMs = 120000, maxRecent = 8 } = {}) {
        Object.assign(this, { now, recentMs, maxRecent });
        this.active = new Map();
        this.recent = [];
    }

    begin(name) {
        const token = Symbol();
        const job = { name, startedAt: this.now() };
        this.active.set(token, job);
        return () => {
            if (!this.active.delete(token)) return;
            const endedAt = this.now();
            this.recent.push({ ...job, endedAt });
            this.recent = this.recent.filter(item => endedAt - item.endedAt <= this.recentMs).slice(-this.maxRecent);
        };
    }

    snapshot() {
        const now = this.now();
        this.recent = this.recent.filter(job => now - job.endedAt <= this.recentMs);
        return {
            active: [...this.active.values()].map(job => ({ name: job.name, elapsedMs: Math.max(0, now - job.startedAt) })),
            recent: this.recent.map(job => ({ name: job.name, elapsedMs: Math.max(0, job.endedAt - job.startedAt),
                endedAgoMs: Math.max(0, now - job.endedAt) }))
        };
    }
}

const runtimeActivity = new RuntimeActivity();
module.exports = { RuntimeActivity, runtimeActivity };
