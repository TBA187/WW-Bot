// Mirrors application warnings and errors to Discord, with secrets removed and repeated alerts grouped.
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { escapeMarkdown } = require('discord.js');
const { stripBotLogPrefix } = require('./logFormat.js');

const TRANSIENT_CONNECTION_CODES = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENOTFOUND|PROTOCOL_CONNECTION_LOST|ER_CON_COUNT_ERROR)$/u;

// Pair known outage and recovery messages by subsystem. Other console logs stay local.
const STATUS_EVENTS = [
    { key: 'forum:pro-forum-shop', component: 'PRO Forum Shop', warning: /^\[WW LOG\] PRO Forum Shop monitor is unavailable\./u,
        recovery: /^\[WW LOG\] PRO Forum Shop monitor connection restored\./u },
    { key: 'forum:pro-dungeon-shop', component: 'PRO Dungeon Shop', warning: /^\[WW LOG\] PRO Dungeon Shop monitor is unavailable\./u,
        recovery: /^\[WW LOG\] PRO Dungeon Shop monitor connection restored\./u },
    { key: 'forum:applications', component: 'Guild Applications', warning: /^\[WW LOG\] PRO Forum application monitor is unavailable\./u,
        recovery: /^\[WW LOG\] PRO Forum application monitor connection restored\./u },
    { key: 'discord:interaction-warmup', component: 'Discord', warning: /^\[WW LOG\] Discord interaction connection warmup failed\b/u,
        recovery: /^\[WW LOG\] Discord interaction connection warmup recovered\./u },
    { key: 'runtime:memory-pressure', component: 'Bot runtime', warning: /^\[RUNTIME MEMORY\] (?:WARNING|CRITICAL):/u,
        recovery: /^\[RUNTIME MEMORY\] Recovered below 75%:/u },
    { key: 'database:mysql', component: 'MySQL', warning: /^\[DB LOG\] MySQL is still unavailable after /u,
        recovery: /^\[DB LOG\] MySQL connection restored after /u },
    { key: 'database:guild-settings', component: 'MySQL', warning: /^\[WW LOG\] Guild settings MySQL unavailable\b/u,
        recovery: /^\[WW LOG\] Guild settings MySQL restored\b/u },
    { key: 'database:tba-shop-checkpoints', component: 'MySQL', warning: /^\[WW LOG\] Shared TBA forum shop checkpoints unavailable\b/u,
        recovery: /^\[WW LOG\] Shared TBA forum shop checkpoints restored\b/u },
    { key: 'database:guild-applications', component: 'MySQL', warning: /^\[WW LOG\] MySQL Guild Application storage (?:unavailable|failed)\b/u,
        recovery: /^\[WW LOG\] MySQL Guild Application storage restored\b/u },
    { key: 'database:pro-notifications', component: 'MySQL', warning: /^\[PRO NOTIFICATIONS\] MySQL storage unavailable\b/u,
        recovery: /^\[PRO NOTIFICATIONS\] MySQL storage restored\b/u },
    ...['Gold', 'Silver'].map(server => ({ key: `database:pvp-king:${server.toLowerCase()}`, component: 'MySQL',
        warning: new RegExp(`^\\[WW LOG\\] MySQL PvP King ${server} storage unavailable\\b`, 'u'),
        recovery: new RegExp(`^\\[WW LOG\\] MySQL PvP King ${server} storage restored\\b`, 'u') })),
    { key: 'database:member-audit', component: 'MySQL', warning: /^\[WW LOG\] Member audit history unavailable\b/u,
        recovery: /^\[WW LOG\] Member audit MySQL storage restored\b/u },
    { key: 'database:xp-queue', component: 'MySQL', warning: /^\[XP QUEUE\] Recovery waiting\b/u,
        recovery: /^\[XP QUEUE\] MySQL recovered\b/u },
    { key: 'storage:guild-applications-json', component: 'Guild Applications',
        warning: /^\[WW LOG\] Guild Application local JSON storage (?:cannot write|failed)\b/u,
        recovery: /^\[WW LOG\] Guild Application local JSON storage restored\./u }
];

function statusEventFor(text, field) {
    return STATUS_EVENTS.find(status => status[field].test(text)) || null;
}

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
        this.statusMessages = new Map();
        this.ready = false;
    }

    run(context, work) { return this.context.run({ ...this.context.getStore(), ...context }, work); }

    install() {
        if (this.original.size) return;
        for (const level of ['log', 'warn', 'error']) {
            const original = this.console[level];
            if (typeof original !== 'function') continue;
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
        if (level === 'log') {
            const recovered = statusEventFor(typeof args[0] === 'string' ? args[0] : '', 'recovery');
            if (recovered) this.recoverStatus(recovered, redactDiagnostic(args.map(diagnosticText).join('\n'), this.secrets));
            return;
        }
        if (!['warn', 'error'].includes(level)) return;
        const text = args.map(diagnosticText).join('\n');
        const clean = redactDiagnostic(text, this.secrets);
        // The log channel can fail too. Keep that failure in the console without a feedback loop.
        if (/^\[WW LOG\] Could not send (?:bot (?:diagnostic|recovery) log|scout (?:publication|action|member edit) log)/u.test(text)) return;
        const context = this.context.getStore() || {};
        const error = args.find(value => value && typeof value === 'object' && (value.code || value.causeCode));
        const code = error?.causeCode || error?.code || /\b(?:E[A-Z_]{3,}|PROTOCOL_[A-Z_]+|DATABASE_UNAVAILABLE|DEP\d+)\b/u.exec(clean)?.[0];
        const status = statusEventFor(clean, 'warning');
        if (consoleOnlyDiagnostic(level, clean, code)) return;
        const databaseStatus = level === 'warn' && /^\[DB LOG\] MySQL is still unavailable after /u.test(clean);
        const autocompleteStatus = level === 'warn' && /^\[WW LOG\] \/scout autocomplete missed its Discord response deadline /u.test(clean);
        const runtimeWarning = /^Node runtime warning:/u.test(clean);
        const systemStatus = status || autocompleteStatus || runtimeWarning;
        const reportId = systemStatus ? undefined : context.reportId;
        // Group persistent connectivity problems even when their error code changes.
        const category = databaseStatus ? 'database-outage' : autocompleteStatus ? 'autocomplete-deadline'
            : `${status?.key || context.component || ''}:` + clean.replace(/\b\d+(?:\.\d+)?(?:ms|s|m)?\b/gu, '#');
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
        if (status) {
            event.status = 'unavailable';
            event.statusKey = status.key;
            event.component = status.component;
        }
        this.recent.delete(key); this.recent.set(key, { at: now, repeats: 0, statusKey: status?.key });
        if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value);
        if (status) {
            if (!this.ready && !this.statusMessages.has(status.key)) this.statusMessages.set(status.key, Promise.resolve(null));
        }
        if (this.ready) this.deliver(event);
        else {
            this.waiting.set(key, event);
            if (this.waiting.size > 100) this.waiting.delete(this.waiting.keys().next().value);
        }
    }

    deliver(event) {
        try {
            const { previousAlert, ...outgoing } = event;
            const previousMessage = this.statusMessages.get(event.statusKey);
            const pending = event.status === 'recovered'
                ? Promise.resolve(previousAlert).then(messageId => this.ready && messageId
                    ? this.send({ ...outgoing, replyTo: messageId }) : null)
                : this.send(outgoing);
            if (event.status === 'unavailable' && event.statusKey) {
                // Keep only the ID, and retain the last delivered alert if a repeat fails.
                const tracked = Promise.resolve(pending)
                    .then(message => message?.id ? String(message.id) : previousMessage ?? null)
                    .catch(() => previousMessage ?? null);
                this.statusMessages.set(event.statusKey, tracked);
            } else if (pending?.catch) void pending.catch(() => {});
        } catch { /* Console output remains available if Discord logging is unavailable. */ }
    }

    recoverStatus(status, text) {
        if (!this.statusMessages.has(status.key)) return;
        const previousAlert = this.statusMessages.get(status.key);
        for (const [key, recent] of this.recent) if (recent.statusKey === status.key) this.recent.delete(key);
        for (const [key, waiting] of this.waiting) if (waiting.statusKey === status.key) this.waiting.delete(key);
        this.statusMessages.delete(status.key);
        // If Discord was not ready, neither the warning nor recovery has been
        // delivered; discard the stale queued warning instead of posting it later.
        if (!this.ready) return;
        const event = { level: 'log', status: 'recovered', statusKey: status.key,
            message: escapeMarkdown(stripBotLogPrefix(text)).slice(0, 3500), component: status.component,
            timestamp: new Date(this.now()).toISOString(), previousAlert };
        this.deliver(event);
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
        this.original.clear(); this.waiting.clear(); this.statusMessages.clear(); this.ready = false;
    }
}

module.exports = { DiscordDiagnosticLogger, redactDiagnostic };
