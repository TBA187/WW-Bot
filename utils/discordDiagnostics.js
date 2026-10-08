// Mirrors application warnings and errors to Discord, with secrets removed and repeated alerts grouped.
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { escapeMarkdown } = require('discord.js');
const { stripBotLogPrefix } = require('./logFormat.js');

const TRANSIENT_CONNECTION_CODES = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENOTFOUND|PROTOCOL_CONNECTION_LOST|ER_CON_COUNT_ERROR)$/u;

function consoleOnlyDiagnostic(level, text, code) {
    // Node prints this first, then the warning listener supplies a structured copy.
    if (/^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning:/u.test(text)) return true;
    // The host's older ts-node loader emits this deprecation; it is not a bot failure.
    if (level === 'warn' && code === 'DEP0180' && /^Node runtime warning:\nDeprecationWarning:/u.test(text)) return true;
    if (level !== 'warn') return false;
    if (/^\[WW LOG\] (?:Scout autocomplete will refresh in the background \(AUTOCOMPLETE_PRELOAD_TIMEOUT\)|Player server preferences will refresh when used \(SERVER_PREFERENCE_PRELOAD_TIMEOUT\))\./u.test(text)) return true;
    // The shared database health tracker reports an outage again if it persists.
    if (TRANSIENT_CONNECTION_CODES.test(String(code || ''))
        && (/^\[DB LOG\] MySQL connectivity issue detected /u.test(text)
            || /^\[WW LOG\] MySQL PvP King storage unavailable .*Using the synchronized JSON snapshot;/su.test(text)
            || /^\[PRO NOTIFICATIONS\] MySQL storage unavailable .*Using JSON;/su.test(text)
            || /^\[WW LOG\] Could not preload (?:scout autocomplete; background refresh will retry|player server preferences; lookups will retry):/u.test(text))) return true;
    return false;
}

function diagnosticText(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value && typeof value === 'object') {
        // REST and MySQL errors can contain credentials, request bodies and SQL.
        // Include only the fields useful for an operator's first diagnosis.
        return ['command', 'interactionId', 'code', 'causeCode', 'message', 'reason']
            .filter(key => value[key] != null).map(key => `${key}: ${String(value[key])}`).join('\n') || 'Additional diagnostic data omitted.';
    }
    return String(value ?? '');
}

function redactDiagnostic(value, secrets = []) {
    let text = String(value);
    for (const secret of secrets.filter(secret => typeof secret === 'string' && secret.length >= 4)) {
        text = text.split(secret).join('[redacted]');
    }
    return text
        .replace(/(\/interactions\/\d+\/)[^/\s?]+/giu, '$1[redacted]')
        .replace(/(\/webhooks\/\d+\/)[^/\s?]+/giu, '$1[redacted]')
        .replace(/\b(Bot|Bearer)\s+[^\s,;]+/giu, '$1 [redacted]')
        .replace(/((?:password|token|secret|authorization)\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]')
        .replace(/(mysql(?:s)?:\/\/)[^@\s]+@/giu, '$1[redacted]@');
}

class DiscordDiagnosticLogger {
    constructor({ send, consoleObject = console, secrets = [], repeatMs = 5 * 60 * 1000, now = () => Date.now() }) {
        this.send = send; this.console = consoleObject; this.secrets = secrets;
        this.repeatMs = repeatMs; this.now = now; this.context = new AsyncLocalStorage();
        this.recent = new Map(); this.waiting = new Map(); this.original = new Map();
        this.ready = false;
    }

    run(context, work) { return this.context.run({ ...this.context.getStore(), ...context }, work); }

    install() {
        if (this.original.size) return;
        for (const level of ['warn', 'error']) {
            const original = this.console[level];
            const wrapper = (...args) => {
                original.apply(this.console, args);
                try { this.capture(level, args); }
                catch { /* Diagnostic delivery must never disrupt the original operation. */ }
            };
            this.original.set(level, { original, wrapper });
            this.console[level] = wrapper;
        }
    }

    capture(level, args) {
        const text = args.map(diagnosticText).join('\n');
        // The log channel can fail too. Keep that failure in the console without a feedback loop.
        if (/^\[WW LOG\] Could not send (?:bot diagnostic log|scout publication log|scout action log)/u.test(text)) return;
        const context = this.context.getStore() || {};
        const error = args.find(value => value && typeof value === 'object' && (value.code || value.causeCode));
        const clean = redactDiagnostic(text, this.secrets);
        const code = error?.causeCode || error?.code || /\b(?:E[A-Z_]{3,}|PROTOCOL_[A-Z_]+|DATABASE_UNAVAILABLE|DEP\d+)\b/u.exec(clean)?.[0];
        if (consoleOnlyDiagnostic(level, clean, code)) return;
        const databaseStatus = level === 'warn' && /^\[DB LOG\] MySQL is still unavailable after /u.test(clean);
        const autocompleteStatus = level === 'warn' && /^\[WW LOG\] \/scout autocomplete missed its Discord response deadline /u.test(clean);
        const runtimeWarning = /^Node runtime warning:/u.test(clean);
        const systemStatus = databaseStatus || autocompleteStatus || runtimeWarning;
        const reportId = systemStatus ? undefined : context.reportId;
        // Group persistent connectivity problems even when their error code changes.
        const category = databaseStatus ? 'database-outage' : autocompleteStatus ? 'autocomplete-deadline'
            : `${context.component || ''}:` + clean.replace(/\b\d+(?:\.\d+)?(?:ms|s|m)?\b/gu, '#');
        const repeatMs = databaseStatus ? 30 * 60_000 : autocompleteStatus ? 15 * 60_000 : this.repeatMs;
        const key = createHash('sha256').update(`${level}:${reportId || ''}:${category}`).digest('hex');
        const previous = this.recent.get(key), now = this.now();
        if (previous && now - previous.at < repeatMs) { previous.repeats++; return; }
        const event = { level, message: escapeMarkdown(stripBotLogPrefix(clean)).slice(0, 3500), component: databaseStatus ? 'MySQL'
                : autocompleteStatus ? 'PvP scouting' : runtimeWarning ? 'Bot runtime' : context.component
                || (/MySQL|\[DB LOG\]|Pool is closed/iu.test(clean) ? 'MySQL'
                    : /scout/iu.test(clean) ? 'PvP scouting' : /Discord|interaction/iu.test(clean) ? 'Discord' : 'Bot runtime'),
            reportId, messageId: systemStatus ? undefined : context.messageId,
            code, repeats: previous?.repeats || 0,
            timestamp: new Date(now).toISOString() };
        this.recent.delete(key); this.recent.set(key, { at: now, repeats: 0 });
        if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value);
        if (this.ready) this.deliver(event);
        else {
            this.waiting.set(key, event);
            if (this.waiting.size > 100) this.waiting.delete(this.waiting.keys().next().value);
        }
    }

    deliver(event) {
        try {
            const pending = this.send(event);
            if (pending?.catch) void pending.catch(() => {});
        } catch { /* Console output remains available if Discord logging is unavailable. */ }
    }

    start() {
        this.ready = true;
        for (const event of this.waiting.values()) this.deliver(event);
        this.waiting.clear();
    }

    stop() {
        for (const [level, { original, wrapper }] of this.original) {
            if (this.console[level] === wrapper) this.console[level] = original;
        }
        this.original.clear(); this.waiting.clear(); this.ready = false;
    }
}

module.exports = { DiscordDiagnosticLogger, redactDiagnostic };
