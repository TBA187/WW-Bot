class DatabaseUnavailableError extends Error {
    constructor(lastError, retryAfterMs = 0) {
        const causeCode = lastError?.causeCode || lastError?.code || 'UNKNOWN';
        const retryText = retryAfterMs > 0
            ? ` Next health probe in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`
            : '';
        super(`MySQL is temporarily unavailable (${causeCode}).${retryText}`);
        this.name = 'DatabaseUnavailableError';
        this.code = 'DATABASE_UNAVAILABLE';
        this.causeCode = causeCode;
        this.retryAfterMs = Math.max(0, retryAfterMs);
        this.cause = lastError;
        this.isCircuitOpen = true;
    }
}

function formatDuration(ms) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

class DatabaseHealthTracker {
    constructor({
        logger = console,
        now = () => Date.now(),
        baseCooldownMs = 5000,
        maxCooldownMs = 60000,
        statusLogIntervalMs = 5 * 60 * 1000
    } = {}) {
        this.logger = logger;
        this.now = now;
        this.baseCooldownMs = Math.max(1, baseCooldownMs);
        this.maxCooldownMs = Math.max(this.baseCooldownMs, maxCooldownMs);
        this.statusLogIntervalMs = Math.max(1, statusLogIntervalMs);
        this.lastSuccessAt = 0;
        this.reset();
    }

    reset() {
        this.outageStartedAt = null;
        this.nextProbeAt = 0;
        this.lastStatusLogAt = 0;
        this.lastError = null;
        this.failureCount = 0;
        this.blockedOperationCount = 0;
    }

    isUnavailable() {
        return this.outageStartedAt !== null;
    }

    retryAfterMs() {
        return Math.max(0, this.nextProbeAt - this.now());
    }

    canAttempt() {
        return !this.isUnavailable() || this.retryAfterMs() === 0;
    }

    cooldownForFailure(failureCount) {
        const exponent = Math.min(Math.max(0, failureCount - 1), 8);
        return Math.min(this.maxCooldownMs, this.baseCooldownMs * (2 ** exponent));
    }

    recordFailure(error, { attemptStartedAt = this.now() } = {}) {
        if (attemptStartedAt < this.lastSuccessAt) return;

        const now = this.now();
        const firstFailure = !this.isUnavailable();
        if (firstFailure) {
            this.outageStartedAt = now;
            this.lastStatusLogAt = now;
        }

        this.failureCount++;
        this.lastError = error;
        this.nextProbeAt = now + this.cooldownForFailure(this.failureCount);

        const errorCode = error?.causeCode || error?.code || error?.message || 'UNKNOWN';
        if (firstFailure) {
            const errorDetail = error?.message && error.message !== errorCode
                ? `: ${error.message}`
                : '';
            this.logger.warn(
                `[DB LOG] MySQL connectivity issue detected (${errorCode}${errorDetail}). ` +
                'Query retries and feature fallbacks are active.'
            );
            return;
        }

        this.logStatusIfDue();
    }

    recordBlockedOperation() {
        if (!this.isUnavailable()) return;
        this.blockedOperationCount++;
        this.logStatusIfDue();
    }

    logStatusIfDue() {
        const now = this.now();
        if (!this.isUnavailable() || now - this.lastStatusLogAt < this.statusLogIntervalMs) return;

        this.lastStatusLogAt = now;
        const errorCode = this.lastError?.causeCode || this.lastError?.code || 'UNKNOWN';
        this.logger.warn(
            `[DB LOG] MySQL is still unavailable after ${formatDuration(now - this.outageStartedAt)} ` +
            `(${errorCode}; ${this.failureCount} failed attempt(s), ${this.blockedOperationCount} deferred operation(s)). ` +
            `Next probe in ${Math.max(1, Math.ceil(this.retryAfterMs() / 1000))}s.`
        );
        this.blockedOperationCount = 0;
    }

    unavailableError() {
        this.recordBlockedOperation();
        return new DatabaseUnavailableError(this.lastError, this.retryAfterMs());
    }

    recordSuccess() {
        const now = this.now();
        this.lastSuccessAt = now;
        if (!this.isUnavailable()) return false;

        const durationMs = now - this.outageStartedAt;
        const failureCount = this.failureCount;
        this.logger.log(
            `[DB LOG] MySQL connection restored after ${formatDuration(durationMs)} ` +
            `(${failureCount} failed connection/query attempt(s)).`
        );
        this.reset();
        this.lastSuccessAt = now;
        return true;
    }
}

module.exports = {
    DatabaseHealthTracker,
    DatabaseUnavailableError,
    formatDuration
};
