// Track command and XP cooldowns, dropping expired entries during normal use.
'use strict';

class CommandCooldowns {
    constructor({ now = Date.now, sweepIntervalMs = 60_000 } = {}) {
        this.now = now;
        this.sweepIntervalMs = sweepIntervalMs;
        this.nextSweep = 0;
        this.entries = new Map();
    }

    onCooldown(userId, command, seconds) {
        const now = this.now();
        if (now >= this.nextSweep) {
            for (const [key, expires] of this.entries) {
                if (expires <= now) this.entries.delete(key);
            }
            this.nextSweep = now + this.sweepIntervalMs;
        }
        const key = `${userId}:${command}`;
        if (now < (this.entries.get(key) ?? 0)) return true;
        this.entries.set(key, now + seconds * 1000);
        return false;
    }
}

module.exports = { CommandCooldowns };
