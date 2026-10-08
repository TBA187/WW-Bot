/**
 * @fileoverview Write monthly bot logs and maintain retention, storage caps and free-space targets.
 * Remove completed monthly files when needed while always preserving the active log.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;
const CAPACITY_WARNING = 'Log maintenance could not reach its configured storage target without deleting the active monthly log; the active log was kept.';

function nonnegativeInteger(value) {
    return Math.max(0, Math.trunc(Number(value) || 0));
}

function escapeRegex(value) {
    return value.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
}

/**
 * Append to the local calendar month's log and prune only completed matching logs.
 * Synchronous writes preserve output through the bot's process.exit shutdown path.
 */
class MonthlyFileHandler {
    constructor(basePath, retentionMonths, {
        maxTotalBytes = 0,
        minFreeBytes = 0,
        cleanupTargetFreeBytes = 0,
        now = () => new Date(),
        fsImpl = fs
    } = {}) {
        this.basePath = path.resolve(basePath);
        this.retentionMonths = retentionMonths;
        this.maxTotalBytes = nonnegativeInteger(maxTotalBytes);
        this.minFreeBytes = nonnegativeInteger(minFreeBytes);
        this.cleanupTargetFreeBytes = Math.max(this.minFreeBytes, nonnegativeInteger(cleanupTargetFreeBytes));
        this.baseFilename = '';
        this._fs = fsImpl;
        this._now = now;
        this._fd = null;
        this._month = null;
        this._pendingMaintenanceMessages = [];

        const parsed = path.parse(this.basePath);
        this._directory = parsed.dir;
        this._stem = parsed.name;
        this._suffix = parsed.ext || '.log';
        this._namePattern = new RegExp('^' + escapeRegex(this._stem) + '-\\d{4}-\\d{2}' + escapeRegex(this._suffix) + '$');
        this._openForMonth(this._now());
    }

    write(formattedText) {
        this._openForMonth(this._now());
        this._fs.writeFileSync(this._fd, String(formattedText) + '\n', { encoding: 'utf8' });
    }

    close() {
        if (this._fd === null) return;
        const fd = this._fd;
        this._fd = null;
        this._fs.closeSync(fd);
    }

    enforceLimits() {
        const messages = this._pendingMaintenanceMessages.splice(0);
        messages.push(...this._pruneOldLogs());
        return messages;
    }

    _monthlyPath(month) {
        return path.join(this._directory, this._stem + '-' + month + this._suffix);
    }

    _openForMonth(now) {
        const month = String(now.getFullYear()).padStart(4, '0') + '-' + String(now.getMonth() + 1).padStart(2, '0');
        if (month === this._month && this._fd !== null) return;
        this.close();
        const filename = this._monthlyPath(month);
        this._fs.mkdirSync(this._directory, { recursive: true });
        this._fd = this._fs.openSync(filename, 'a');
        this._month = month;
        this.baseFilename = filename;
        this._pendingMaintenanceMessages.push(...this._pruneOldLogs());
    }

    _matchingLogFiles() {
        try {
            return this._fs.readdirSync(this._directory)
                .filter(name => this._namePattern.test(name))
                .map(name => path.join(this._directory, name));
        } catch {
            return [];
        }
    }

    _fileSize(filename) {
        try {
            return Math.max(0, this._fs.statSync(filename).size);
        } catch {
            return 0;
        }
    }

    _freeDiskBytes() {
        try {
            const stats = this._fs.statfsSync(this._directory, { bigint: true });
            return Number(stats.bavail * stats.bsize);
        } catch {
            return null;
        }
    }

    _pruneOldLogs() {
        let files = this._matchingLogFiles().sort().reverse();
        const deleted = [];
        const currentPath = this._month ? this._monthlyPath(this._month) : null;
        const retained = new Set(files.includes(currentPath) ? [currentPath] : []);
        for (const filename of files) {
            if (retained.size >= this.retentionMonths) break;
            retained.add(filename);
        }
        for (const filename of files) {
            if (retained.has(filename)) continue;
            try {
                this._fs.unlinkSync(filename);
                deleted.push(filename);
            } catch {
                // A failed deletion must never prevent logging or prune other data.
            }
        }

        files = this._matchingLogFiles();
        let totalBytes = files.reduce((total, filename) => total + this._fileSize(filename), 0);
        let freeBytes = this._freeDiskBytes();
        const diskRecoveryNeeded = freeBytes !== null && this.minFreeBytes > 0 && freeBytes < this.minFreeBytes;
        const targetFreeBytes = diskRecoveryNeeded ? this.cleanupTargetFreeBytes : 0;
        const completedFiles = files.filter(filename => filename !== currentPath).sort();

        while (completedFiles.length && (
            (this.maxTotalBytes > 0 && totalBytes > this.maxTotalBytes) ||
            (targetFreeBytes > 0 && (freeBytes || 0) < targetFreeBytes)
        )) {
            const filename = completedFiles.shift();
            const size = this._fileSize(filename);
            try {
                this._fs.unlinkSync(filename);
            } catch {
                continue;
            }
            deleted.push(filename);
            totalBytes = Math.max(0, totalBytes - size);
            freeBytes = this._freeDiskBytes();
        }

        const messages = [];
        if (deleted.length) {
            messages.push('Log maintenance deleted ' + deleted.length + ' completed monthly log file(s) to enforce retention/storage limits.');
        }
        const capacityUnresolved = this.maxTotalBytes > 0 && totalBytes > this.maxTotalBytes;
        const diskUnresolved = targetFreeBytes > 0 && (freeBytes === null || freeBytes < targetFreeBytes);
        if ((capacityUnresolved || diskUnresolved) && !completedFiles.length) messages.push(CAPACITY_WARNING);
        return messages;
    }
}

function createMonthlyFileHandler(basePath, {
    retentionMonths,
    maxTotalMib,
    minFreeMib,
    cleanupTargetFreeMib,
    ...overrides
}) {
    return new MonthlyFileHandler(basePath, retentionMonths, {
        maxTotalBytes: maxTotalMib * MIB,
        minFreeBytes: minFreeMib * MIB,
        cleanupTargetFreeBytes: cleanupTargetFreeMib * MIB,
        ...overrides
    });
}

module.exports = { MonthlyFileHandler, createMonthlyFileHandler, MIB };
