'use strict';

// Reads forum retry hints and combines them with each monitor's outage backoff.
function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        const milliseconds = seconds * 1000;
        return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
    }
    const dateMs = Date.parse(value);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function forumRetryDelay(intervalMs, failureCount, maxBackoffMs, retryAfterMs) {
    const exponential = Math.min(maxBackoffMs, intervalMs * (2 ** Math.min(failureCount - 1, 6)));
    const serverDelay = Number(retryAfterMs);
    // The local cap limits exponential retries; a server's longer wait still applies.
    return Math.max(exponential, Number.isFinite(serverDelay) ? serverDelay : 0);
}

module.exports = { forumRetryDelay, parseRetryAfter };
