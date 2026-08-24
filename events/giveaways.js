const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../utils/jsonFile.js');

const DEFAULT_GIVEAWAY_COLOR = '#39FF14';
const GIVEAWAY_ACTIVE = 'active';
const GIVEAWAY_ENDED = 'ended';
const GIVEAWAY_DELETED = 'deleted';
const GIVEAWAY_STATUSES = new Set([GIVEAWAY_ACTIVE, GIVEAWAY_ENDED, GIVEAWAY_DELETED]);
const DEFAULT_GIVEAWAY_TITLE = 'White Walkers Giveaway  🎉';
const DEFAULT_GIVEAWAY_TITLE_URL = 'https://www.image2url.com/r2/default/images/1782683416790-135d9832-afcd-4777-a13a-e9239b831ba1.png';
const GIVEAWAY_FOOTER_TEXT = 'All winners are selected completely at random!';
const GIVEAWAY_BUTTON_ID = 'ww_giveaway:join_leave';
const GIVEAWAY_PARTICIPANTS_BUTTON_ID = 'ww_giveaway:participants';
const GIVEAWAY_PAGE_PREFIX = 'ww_giveaway:page';
const MAX_WINNERS = 100;
const REROLL_AUTOCOMPLETE_WINDOW_MS = 48 * 60 * 60 * 1000;
const GIVEAWAY_RECOVERY_WINDOW_MS = REROLL_AUTOCOMPLETE_WINDOW_MS;
const GIVEAWAY_LIST_PAGE_SIZE = 10;
const PARTICIPANTS_PAGE_SIZE = 30;
const STORAGE_VERSION = 2;
const GIVEAWAY_END_PACING_MS = 1000;
const GIVEAWAY_EDIT_DELAY_MS = 1500;
const GIVEAWAY_SAME_MESSAGE_EDIT_DELAY_MS = 6500;
const JSON_SOURCES = {
    MYSQL_FALLBACK: 'mysql_fallback',
    JSON_ONLY: 'json_only'
};
const DEFAULT_DATA_FILE = path.join(process.cwd(), 'data', 'giveaways.json');
const LOGO_PATH = path.join(process.cwd(), 'images', 'ww_logo.png');
const LOGO_ATTACHMENT_URL = 'attachment://ww_logo.png';
const LOOP_INTERVAL_MS = 60 * 1000;

const RELATIVE_TIME_RE = /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
const COLOR_NAMES = {
    red: '#FF0000',
    'dark red': '#8B0000',
    'light red': '#FF7F7F',
    crimson: '#DC143C',
    blue: '#3498DB',
    'dark blue': '#00008B',
    'light blue': '#ADD8E6',
    navy: '#000080',
    'navy blue': '#000080',
    'royal blue': '#4169E1',
    'sky blue': '#87CEEB',
    green: '#2ECC71',
    'neon green': '#39FF14',
    'dark green': '#006400',
    'light green': '#90EE90',
    lime: '#00FF00',
    'lime green': '#32CD32',
    'forest green': '#228B22',
    gold: '#F1C40F',
    yellow: '#FFFF00',
    'light yellow': '#FFFFE0',
    orange: '#E67E22',
    'dark orange': '#FF8C00',
    'light orange': '#FFD580',
    purple: '#9B59B6',
    'dark purple': '#4B0082',
    'light purple': '#C084FC',
    violet: '#8A2BE2',
    pink: '#E91E63',
    'hot pink': '#FF69B4',
    'light pink': '#FFB6C1',
    white: '#FFFFFF',
    black: '#000000',
    gray: '#95A5A6',
    grey: '#95A5A6',
    'dark gray': '#2F3136',
    'dark grey': '#2F3136',
    'light gray': '#D3D3D3',
    'light grey': '#D3D3D3',
    silver: '#C0C0C0',
    teal: '#1ABC9C',
    'dark teal': '#008080',
    'light teal': '#7FDBDA',
    cyan: '#00FFFF',
    aqua: '#00FFFF',
    brown: '#8B4513',
    maroon: '#800000'
};

const PAGINATION_SESSIONS = new Map();
const GIVEAWAY_REFRESHES = new Map();
const GIVEAWAY_MESSAGE_EDITS = {
    queue: Promise.resolve(),
    lastRouteEditAt: 0,
    lastMessageEditAt: new Map()
};

function parseStorageMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
}

function normalizeStatus(status) {
    const normalized = String(status || GIVEAWAY_ACTIVE).trim().toLowerCase();
    return GIVEAWAY_STATUSES.has(normalized) ? normalized : GIVEAWAY_ACTIVE;
}

function utcNowIso() {
    return new Date().toISOString();
}

function makeGiveawayId() {
    return `giveaway_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function makeDrawId(giveawayId, drawType) {
    return `${giveawayId}:${drawType}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeColorName(value) {
    return String(value || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function parseColor(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return DEFAULT_GIVEAWAY_COLOR;
    }

    const colorName = normalizeColorName(value);
    if (COLOR_NAMES[colorName]) {
        return COLOR_NAMES[colorName];
    }

    let hex = String(value).trim();
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
        return `#${hex.toUpperCase()}`;
    }

    throw new Error('Color must be a hex code like `#FF0000` or a supported color name like `dark red`.');
}

function colorInt(colorHex) {
    return Number.parseInt(parseColor(colorHex).replace('#', ''), 16);
}

function parseGiveawayEndTime(value, { now = new Date() } = {}) {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error('Duration is required.');
    }

    const relativeMs = parseRelativeDurationMs(text);
    if (relativeMs !== null) {
        return new Date(now.getTime() + relativeMs);
    }

    const normalized = text.replace(/Z$/, '+00:00');
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('Use a relative time like `5h 30m` or a datetime like `2026-07-01 18:30`.');
    }
    if (parsed <= now) {
        throw new Error('Giveaway end time must be in the future.');
    }
    return parsed;
}

function parseRelativeDurationMs(value) {
    let position = 0;
    let totalMs = 0;
    let matched = false;
    RELATIVE_TIME_RE.lastIndex = 0;

    for (const match of value.matchAll(RELATIVE_TIME_RE)) {
        const gap = value.slice(position, match.index);
        if (gap.trim()) return null;

        matched = true;
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        if (unit.startsWith('d')) totalMs += amount * 86400000;
        else if (unit.startsWith('h')) totalMs += amount * 3600000;
        else if (unit.startsWith('m')) totalMs += amount * 60000;
        else totalMs += amount * 1000;
        position = match.index + match[0].length;
    }

    if (!matched || value.slice(position).trim()) return null;
    if (totalMs <= 0) throw new Error('Duration must be greater than zero.');
    return totalMs;
}

function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).replace(' ', 'T');
    const withZone = /z$/i.test(text) || /[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
    const parsed = new Date(withZone);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mysqlDate(value = new Date()) {
    const date = parseDate(value) || new Date();
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function mysqlDateOrNull(value) {
    const date = parseDate(value);
    return date ? mysqlDate(date) : null;
}

function normalizeGiveawayDescription(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\\n/g, '\n').trim();
}

function normalizeRoleIds(value) {
    if (value === null || value === undefined || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.map(v => String(v)).filter(Boolean))];
}

function giveawayRequiredRoleIds(giveaway) {
    const roleIds = normalizeRoleIds(giveaway.required_role_ids);
    if (roleIds.length) return roleIds;
    return normalizeRoleIds(giveaway.required_role_id);
}

function userHasRequiredRole(member, requiredRoleIds) {
    const required = new Set(normalizeRoleIds(requiredRoleIds));
    if (!required.size) return true;
    return member.roles.cache.some(role => required.has(role.id));
}

function activeEntries(entries) {
    return entries.filter(entry => !entry.left_at);
}

function chooseWinners(entries, winnerCount, excludedUserIds = new Set()) {
    const excluded = new Set([...excludedUserIds].map(String));
    const active = activeEntries(entries);
    const eligible = active.filter(entry => !excluded.has(String(entry.user_id)));
    const needed = Math.min(Number(winnerCount), active.length);
    if (needed <= 0) return [];

    const selected = sample(eligible, Math.min(needed, eligible.length));
    if (selected.length < needed) {
        const previousWinners = active.filter(entry => excluded.has(String(entry.user_id)));
        selected.push(...sample(previousWinners, Math.min(needed - selected.length, previousWinners.length)));
    }
    return selected;
}

function sample(items, count) {
    const pool = [...items];
    const picked = [];
    while (pool.length && picked.length < count) {
        const index = crypto.randomInt(pool.length);
        picked.push(pool.splice(index, 1)[0]);
    }
    return picked;
}

function roleMentions(roleIds) {
    return normalizeRoleIds(roleIds).map(roleId => `<@&${roleId}>`).join(' ');
}

function messageLink(giveaway) {
    if (!giveaway.guild_id || !giveaway.channel_id || !giveaway.message_id) return null;
    return `https://discord.com/channels/${giveaway.guild_id}/${giveaway.channel_id}/${giveaway.message_id}`;
}

function logoFile() {
    if (!fs.existsSync(LOGO_PATH)) return null;
    return new AttachmentBuilder(LOGO_PATH, { name: 'ww_logo.png' });
}

function toJson(value) {
    return JSON.stringify(value ?? []);
}

function fromJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function emptyJsonData(source = JSON_SOURCES.MYSQL_FALLBACK) {
    return {
        version: STORAGE_VERSION,
        source,
        pendingSync: false,
        giveaways: {},
        entries: {},
        draws: {},
        pendingSyncGiveawayIds: [],
        pendingSyncEntryIds: [],
        pendingSyncDrawIds: []
    };
}

function entryKey(giveawayId, userId) {
    return `${giveawayId}:${userId}`;
}

function splitEntryKey(value) {
    const index = String(value).lastIndexOf(':');
    return [String(value).slice(0, index), String(value).slice(index + 1)];
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sortGiveawaysNewestFirst(giveaways) {
    return [...giveaways].sort((a, b) => {
        const left = `${a.starts_at || ''}:${a.created_at || ''}:${a.giveaway_id || ''}`;
        const right = `${b.starts_at || ''}:${b.created_at || ''}:${b.giveaway_id || ''}`;
        return right.localeCompare(left);
    });
}

function mergeById(idField, ...groups) {
    const merged = new Map();
    for (const group of groups) {
        for (const item of group || []) {
            const id = item?.[idField];
            if (id !== null && id !== undefined) merged.set(String(id), clone(item));
        }
    }
    return [...merged.values()];
}

class KeyedLockPool {
    constructor() {
        this.entries = new Map();
    }

    async run(key, task) {
        const normalizedKey = String(key);
        let entry = this.entries.get(normalizedKey);
        if (!entry) {
            entry = { tail: Promise.resolve(), users: 0 };
            this.entries.set(normalizedKey, entry);
        }

        entry.users += 1;
        const previous = entry.tail;
        let release;
        entry.tail = new Promise(resolve => {
            release = resolve;
        });

        await previous;
        try {
            return await task();
        } finally {
            release();
            entry.users -= 1;
            if (entry.users === 0 && this.entries.get(normalizedKey) === entry) {
                this.entries.delete(normalizedKey);
            }
        }
    }
}

const GIVEAWAY_LOCKS = new KeyedLockPool();

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function giveawayNeedsRecoveryCache(giveaway, now = new Date()) {
    if (giveaway?.status === GIVEAWAY_ACTIVE) return true;
    if (giveaway?.status !== GIVEAWAY_ENDED) return false;

    const endedAt = parseDate(giveaway.ended_at || giveaway.ends_at);
    return Boolean(endedAt && endedAt.getTime() >= now.getTime() - GIVEAWAY_RECOVERY_WINDOW_MS);
}

function mergeGiveawaySyncState(localGiveaway, mysqlGiveaway) {
    if (!mysqlGiveaway) return clone(localGiveaway);
    if (!localGiveaway) return clone(mysqlGiveaway);

    const rank = status => {
        if (status === GIVEAWAY_DELETED) return 2;
        if (status === GIVEAWAY_ENDED) return 1;
        return 0;
    };
    const localRank = rank(normalizeStatus(localGiveaway.status));
    const mysqlRank = rank(normalizeStatus(mysqlGiveaway.status));

    // Once MySQL has a final draw/deletion, a stale active fallback must never reopen it.
    if (mysqlRank > localRank || (mysqlRank > 0 && mysqlRank === localRank)) return clone(mysqlGiveaway);
    return clone(localGiveaway);
}

class GiveawayStore {
    constructor({ db, storageMode = process.env.STORAGE_MODE, dataFile = DEFAULT_DATA_FILE } = {}) {
        this.db = db;
        this.storageMode = parseStorageMode(storageMode);
        this.dataFile = dataFile;
        this.tempFile = `${dataFile}.tmp`;
        this.local = emptyJsonData(this.getJsonSource());
        this.cache = {
            giveaways: new Map(),
            entries: new Map(),
            draws: new Map()
        };
        this.queue = Promise.resolve();
        this.queueDepth = 0;
        this.syncPromise = null;
        this.mysqlOutage = false;
    }

    getJsonSource() {
        return this.storageMode === 'json' ? JSON_SOURCES.JSON_ONLY : JSON_SOURCES.MYSQL_FALLBACK;
    }

    hasMysqlConfig() {
        return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
    }

    canUseMysql() {
        return this.storageMode !== 'json' && this.db && this.hasMysqlConfig();
    }

    noteMysqlFailure(err) {
        if (this.db?.isDatabaseUnavailableError && !this.db.isDatabaseUnavailableError(err)) {
            console.error('[WW LOG] Unexpected MySQL giveaway storage error:', err);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const errorCode = this.db?.getErrorCode?.(err) || err?.causeCode || err?.code || err?.message || err;
        console.warn(
            `[WW LOG] MySQL giveaway storage unavailable (${errorCode}). ` +
            'Using the local recovery cache; writes will queue in JSON for synchronization.'
        );
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log('[WW LOG] MySQL giveaway storage restored; pending JSON data will synchronize automatically.');
    }

    async mysqlQuery(sql, params = []) {
        try {
            const result = await this.db.query(sql, params);
            this.noteMysqlRestored();
            return result;
        } catch (err) {
            this.noteMysqlFailure(err);
            throw err;
        }
    }

    enqueue(task) {
        const run = this.queue.catch(() => { }).then(async () => {
            this.queueDepth++;
            try {
                return await task();
            } finally {
                this.queueDepth--;
            }
        });
        this.queue = run.catch(() => { });
        return run;
    }

    async restore() {
        this.local = this.readJsonStore();
        if (this.storageMode === 'json') {
            this.local.source = JSON_SOURCES.JSON_ONLY;
            this.local.pendingSync = false;
            this.local.pendingSyncGiveawayIds = [];
            this.local.pendingSyncEntryIds = [];
            this.local.pendingSyncDrawIds = [];
            this.writeJsonStore();
            return false;
        }

        this.local.source = JSON_SOURCES.MYSQL_FALLBACK;
        if (this.canUseMysql()) {
            await this.syncPending().catch(err => {
                this.noteMysqlFailure(err);
            });
            await this.warmRecoveryCache().catch(err => {
                this.noteMysqlFailure(err);
            });
        }
        this.writeJsonStore();
        return this.canUseMysql();
    }

    readJsonStore() {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        if (!fs.existsSync(this.dataFile)) {
            const empty = emptyJsonData(this.getJsonSource());
            this.writeJsonData(empty);
            return empty;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            return {
                ...emptyJsonData(parsed.source || this.getJsonSource()),
                ...parsed,
                version: STORAGE_VERSION
            };
        } catch (err) {
            console.error('[WW LOG] Failed to read giveaway JSON storage:', err);
            return emptyJsonData(this.getJsonSource());
        }
    }

    writeJsonStore() {
        this.local.pendingSync = this.hasPendingSync();
        this.writeJsonData(this.local);
    }

    writeJsonData(data) {
        writeJsonIfChanged(this.dataFile, this.tempFile, data);
    }

    hasPendingSync() {
        return Boolean(
            this.local.pendingSyncGiveawayIds?.length ||
            this.local.pendingSyncEntryIds?.length ||
            this.local.pendingSyncDrawIds?.length
        );
    }

    markPending(key, value) {
        const values = new Set(this.local[key] || []);
        values.add(String(value));
        this.local[key] = [...values].sort();
        this.local.pendingSync = true;
    }

    clearPending(key, value) {
        this.local[key] = (this.local[key] || []).filter(item => String(item) !== String(value));
        this.local.pendingSync = this.hasPendingSync();
    }

    cacheGiveaway(giveaway) {
        if (giveaway?.giveaway_id) this.cache.giveaways.set(String(giveaway.giveaway_id), clone(giveaway));
    }

    cacheEntry(entry) {
        if (!entry?.giveaway_id || entry.user_id === null || entry.user_id === undefined) return;
        const giveawayId = String(entry.giveaway_id);
        const userId = String(entry.user_id);
        if (!this.cache.entries.has(giveawayId)) this.cache.entries.set(giveawayId, new Map());
        this.cache.entries.get(giveawayId).set(userId, clone(entry));
    }

    cacheDraw(draw) {
        if (!draw?.giveaway_id || !draw?.draw_id) return;
        const giveawayId = String(draw.giveaway_id);
        const drawId = String(draw.draw_id);
        if (!this.cache.draws.has(giveawayId)) this.cache.draws.set(giveawayId, new Map());
        this.cache.draws.get(giveawayId).set(drawId, clone(draw));
    }

    localSaveGiveaway(giveawayId, giveaway, pendingSync) {
        const saved = { ...clone(giveaway), giveaway_id: giveawayId };
        this.local.giveaways[giveawayId] = saved;
        if (pendingSync) this.markPending('pendingSyncGiveawayIds', giveawayId);
        this.cacheGiveaway(saved);
        this.writeJsonStore();
        return clone(saved);
    }

    localSaveEntry(giveawayId, userId, entry, pendingSync) {
        const saved = { ...clone(entry), giveaway_id: giveawayId, user_id: String(userId) };
        if (!this.local.entries[giveawayId]) this.local.entries[giveawayId] = {};
        this.local.entries[giveawayId][String(userId)] = saved;
        if (pendingSync) this.markPending('pendingSyncEntryIds', entryKey(giveawayId, userId));
        this.cacheEntry(saved);
        this.writeJsonStore();
        return clone(saved);
    }

    localSaveDraw(drawId, draw, pendingSync) {
        const saved = { ...clone(draw), draw_id: drawId };
        this.local.draws[drawId] = saved;
        if (pendingSync) this.markPending('pendingSyncDrawIds', drawId);
        this.cacheDraw(saved);
        this.writeJsonStore();
        return clone(saved);
    }

    async createGiveaway(giveaway) {
        const giveawayId = giveaway.giveaway_id || makeGiveawayId();
        return this.saveGiveaway(giveawayId, { ...giveaway, giveaway_id: giveawayId });
    }

    async saveGiveaway(giveawayId, giveaway) {
        return this.enqueue(async () => {
            const saved = { ...clone(giveaway), giveaway_id: giveawayId };
            if (this.storageMode === 'json') return this.localSaveGiveaway(giveawayId, saved, false);

            try {
                await this.syncPending();
                await this.mysqlSaveGiveaway(giveawayId, saved);
                this.clearPending('pendingSyncGiveawayIds', giveawayId);
                return this.localSaveGiveaway(giveawayId, saved, false);
            } catch (err) {
                this.noteMysqlFailure(err);
                return this.localSaveGiveaway(giveawayId, saved, true);
            }
        });
    }

    async updateGiveaway(giveawayId, fields) {
        return this.enqueue(async () => {
            const giveaway = await this.getGiveawayUnlocked(giveawayId);
            if (!giveaway) return null;
            return this.saveGiveawayUnlocked(giveawayId, { ...giveaway, ...fields });
        });
    }

    async saveGiveawayUnlocked(giveawayId, giveaway) {
        const saved = { ...clone(giveaway), giveaway_id: giveawayId };
        if (this.storageMode === 'json') return this.localSaveGiveaway(giveawayId, saved, false);
        try {
            await this.syncPendingNow();
            await this.mysqlSaveGiveaway(giveawayId, saved);
            this.clearPending('pendingSyncGiveawayIds', giveawayId);
            return this.localSaveGiveaway(giveawayId, saved, false);
        } catch (err) {
            this.noteMysqlFailure(err);
            return this.localSaveGiveaway(giveawayId, saved, true);
        }
    }

    async getGiveaway(giveawayId) {
        return this.getGiveawayUnlocked(giveawayId);
    }

    async getGiveawayUnlocked(giveawayId) {
        const local = this.local.giveaways[giveawayId];
        if (local && (this.storageMode === 'json' || (this.local.pendingSyncGiveawayIds || []).includes(giveawayId))) {
            this.cacheGiveaway(local);
            return clone(local);
        }

        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                const giveaway = await this.mysqlGetGiveaway(giveawayId);
                if (giveaway) this.cacheGiveaway(giveaway);
                return giveaway;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        const cached = this.cache.giveaways.get(String(giveawayId));
        return cached ? clone(cached) : (local ? clone(local) : null);
    }

    async getByMessageId(messageId) {
        const localEntry = Object.entries(this.local.giveaways).find(([, giveaway]) => String(giveaway.message_id) === String(messageId));
        if (localEntry && (this.storageMode === 'json' || (this.local.pendingSyncGiveawayIds || []).includes(localEntry[0]))) {
            return [localEntry[0], clone(localEntry[1])];
        }

        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                const result = await this.mysqlGetByMessageId(messageId);
                if (result[1]) this.cacheGiveaway(result[1]);
                return result;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        for (const [giveawayId, giveaway] of this.cache.giveaways.entries()) {
            if (String(giveaway.message_id) === String(messageId)) return [giveawayId, clone(giveaway)];
        }
        return localEntry ? [localEntry[0], clone(localEntry[1])] : [null, null];
    }

    async listGiveaways(status = GIVEAWAY_ACTIVE) {
        let giveaways = [];
        let loadedFromMysql = false;
        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                giveaways = await this.mysqlListGiveaways(status);
                giveaways.forEach(giveaway => this.cacheGiveaway(giveaway));
                loadedFromMysql = true;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        if (!loadedFromMysql) {
            giveaways = mergeById(
                'giveaway_id',
                Object.values(this.local.giveaways || {}),
                [...this.cache.giveaways.values()]
            );
        }
        giveaways = mergeById('giveaway_id', giveaways, this.pendingGiveaways());
        if (status && status !== 'all') giveaways = giveaways.filter(giveaway => giveaway.status === normalizeStatus(status));
        return sortGiveawaysNewestFirst(giveaways);
    }

    async listDueGiveaways(now = new Date()) {
        const giveaways = await this.listGiveaways(GIVEAWAY_ACTIVE);
        return giveaways.filter(giveaway => {
            const endsAt = parseDate(giveaway.ends_at);
            return endsAt && endsAt <= now;
        }).sort((a, b) => parseDate(a.ends_at) - parseDate(b.ends_at));
    }

    async saveEntry(giveawayId, userId, entry) {
        return this.enqueue(async () => {
            const saved = { ...clone(entry), giveaway_id: giveawayId, user_id: String(userId) };
            if (this.storageMode === 'json') return this.localSaveEntry(giveawayId, userId, saved, false);
            try {
                await this.syncPendingNow();
                await this.mysqlSaveEntry(giveawayId, userId, saved);
                this.clearPending('pendingSyncEntryIds', entryKey(giveawayId, userId));
                return this.localSaveEntry(giveawayId, userId, saved, false);
            } catch (err) {
                this.noteMysqlFailure(err);
                return this.localSaveEntry(giveawayId, userId, saved, true);
            }
        });
    }

    async getEntry(giveawayId, userId) {
        const local = this.local.entries[giveawayId]?.[String(userId)];
        if (local && (this.storageMode === 'json' || (this.local.pendingSyncEntryIds || []).includes(entryKey(giveawayId, userId)))) {
            this.cacheEntry(local);
            return clone(local);
        }

        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                const entry = await this.mysqlGetEntry(giveawayId, userId);
                if (entry) this.cacheEntry(entry);
                return entry;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        const cached = this.cache.entries.get(String(giveawayId))?.get(String(userId));
        return cached ? clone(cached) : (local ? clone(local) : null);
    }

    async listEntries(giveawayId, { activeOnly = false } = {}) {
        let entries = [];
        let loadedFromMysql = false;
        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                entries = await this.mysqlListEntries(giveawayId, { activeOnly });
                entries.forEach(entry => this.cacheEntry(entry));
                loadedFromMysql = true;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        if (!loadedFromMysql) {
            entries = mergeById(
                'user_id',
                Object.values(this.local.entries[String(giveawayId)] || {}),
                [...(this.cache.entries.get(String(giveawayId))?.values() || [])]
            );
        }
        entries = mergeById('user_id', entries, this.pendingEntriesForGiveaway(giveawayId));
        if (activeOnly) entries = activeEntries(entries);
        return entries.sort((a, b) => String(a.joined_at || '').localeCompare(String(b.joined_at || '')));
    }

    async saveDraw(drawId, draw) {
        return this.enqueue(async () => {
            const saved = { ...clone(draw), draw_id: drawId };
            if (this.storageMode === 'json') return this.localSaveDraw(drawId, saved, false);
            try {
                await this.syncPendingNow();
                await this.mysqlSaveDraw(drawId, saved);
                this.clearPending('pendingSyncDrawIds', drawId);
                return this.localSaveDraw(drawId, saved, false);
            } catch (err) {
                this.noteMysqlFailure(err);
                return this.localSaveDraw(drawId, saved, true);
            }
        });
    }

    async listDraws(giveawayId) {
        let draws = [];
        let loadedFromMysql = false;
        if (this.storageMode !== 'json' && this.canUseMysql()) {
            try {
                await this.syncPending();
                draws = await this.mysqlListDraws(giveawayId);
                draws.forEach(draw => this.cacheDraw(draw));
                loadedFromMysql = true;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }
        if (!loadedFromMysql) {
            draws = mergeById(
                'draw_id',
                Object.values(this.local.draws || {}).filter(draw => String(draw.giveaway_id) === String(giveawayId)),
                [...(this.cache.draws.get(String(giveawayId))?.values() || [])]
            );
        }
        draws = mergeById('draw_id', draws, this.pendingDrawsForGiveaway(giveawayId));
        return draws.sort((a, b) => String(a.drawn_at || '').localeCompare(String(b.drawn_at || '')));
    }

    pendingGiveaways() {
        return (this.local.pendingSyncGiveawayIds || [])
            .map(id => this.local.giveaways[id])
            .filter(Boolean)
            .map(clone);
    }

    pendingEntriesForGiveaway(giveawayId) {
        return (this.local.pendingSyncEntryIds || [])
            .map(key => {
                const [id, userId] = splitEntryKey(key);
                return String(id) === String(giveawayId) ? this.local.entries[id]?.[userId] : null;
            })
            .filter(Boolean)
            .map(clone);
    }

    pendingDrawsForGiveaway(giveawayId) {
        return (this.local.pendingSyncDrawIds || [])
            .map(id => this.local.draws[id])
            .filter(draw => draw && String(draw.giveaway_id) === String(giveawayId))
            .map(clone);
    }

    async syncPending() {
        if (this.storageMode === 'json' || !this.canUseMysql()) return false;
        if (this.queueDepth > 0) return this.syncPendingNow();
        if (this.syncPromise) return this.syncPromise;
        this.syncPromise = this.enqueue(() => this.syncPendingNow()).finally(() => {
            this.syncPromise = null;
        });
        return this.syncPromise;
    }

    async syncPendingNow() {
        if (this.storageMode === 'json' || !this.canUseMysql()) return false;
        this.local = this.readJsonStore();
        if (!this.hasPendingSync()) return false;
        this.local.source = JSON_SOURCES.MYSQL_FALLBACK;

        for (const giveawayId of [...(this.local.pendingSyncGiveawayIds || [])]) {
            const localGiveaway = this.local.giveaways[giveawayId];
            if (!localGiveaway) continue;
            const giveaway = mergeGiveawaySyncState(localGiveaway, await this.mysqlGetGiveaway(giveawayId));
            await this.mysqlSaveGiveaway(giveawayId, giveaway);
            this.local.giveaways[giveawayId] = clone(giveaway);
            this.cacheGiveaway(giveaway);
            this.clearPending('pendingSyncGiveawayIds', giveawayId);
        }

        for (const key of [...(this.local.pendingSyncEntryIds || [])]) {
            const [giveawayId, userId] = splitEntryKey(key);
            const entry = this.local.entries[giveawayId]?.[userId];
            if (!entry) continue;
            await this.mysqlSaveEntry(giveawayId, userId, entry);
            this.cacheEntry(entry);
            this.clearPending('pendingSyncEntryIds', key);
        }

        for (const drawId of [...(this.local.pendingSyncDrawIds || [])]) {
            const draw = this.local.draws[drawId];
            if (!draw) continue;
            await this.mysqlSaveDraw(drawId, draw);
            this.clearPending('pendingSyncDrawIds', drawId);
        }

        this.writeJsonStore();
        return true;
    }

    async warmRecoveryCache() {
        if (this.storageMode === 'json' || !this.canUseMysql()) return false;

        const now = new Date();
        const pendingGiveawayIds = new Set((this.local.pendingSyncGiveawayIds || []).map(String));
        const pendingEntryKeys = new Set((this.local.pendingSyncEntryIds || []).map(String));
        const pendingDrawIds = new Set((this.local.pendingSyncDrawIds || []).map(String));
        const remoteGiveaways = await this.mysqlListGiveaways('all');
        const nextGiveaways = new Map(remoteGiveaways.map(giveaway => [String(giveaway.giveaway_id), clone(giveaway)]));

        // Pending fallback writes take priority over older MySQL data during a recovery.
        for (const giveawayId of pendingGiveawayIds) {
            const giveaway = this.local.giveaways[giveawayId];
            if (giveaway) {
                nextGiveaways.set(
                    giveawayId,
                    mergeGiveawaySyncState(giveaway, nextGiveaways.get(giveawayId))
                );
            }
        }

        const recoveryIds = new Set();
        for (const giveaway of nextGiveaways.values()) {
            if (giveawayNeedsRecoveryCache(giveaway, now)) recoveryIds.add(String(giveaway.giveaway_id));
        }
        for (const key of pendingEntryKeys) recoveryIds.add(splitEntryKey(key)[0]);
        for (const drawId of pendingDrawIds) {
            const draw = this.local.draws[drawId];
            if (draw?.giveaway_id) recoveryIds.add(String(draw.giveaway_id));
        }

        const nextEntries = {};
        const nextDraws = {};
        for (const giveawayId of recoveryIds) {
            const entryMap = new Map(
                (await this.mysqlListEntries(giveawayId)).map(entry => [String(entry.user_id), clone(entry)])
            );
            for (const key of pendingEntryKeys) {
                const [entryGiveawayId, userId] = splitEntryKey(key);
                if (entryGiveawayId !== giveawayId) continue;
                const entry = this.local.entries[entryGiveawayId]?.[userId];
                if (entry) entryMap.set(String(userId), clone(entry));
            }
            if (entryMap.size) nextEntries[giveawayId] = Object.fromEntries(entryMap);

            const drawMap = new Map(
                (await this.mysqlListDraws(giveawayId)).map(draw => [String(draw.draw_id), clone(draw)])
            );
            for (const drawId of pendingDrawIds) {
                const draw = this.local.draws[drawId];
                if (draw && String(draw.giveaway_id) === giveawayId) {
                    drawMap.set(String(drawId), clone(draw));
                }
            }
            for (const draw of drawMap.values()) nextDraws[String(draw.draw_id)] = draw;
        }

        this.local.source = JSON_SOURCES.MYSQL_FALLBACK;
        this.local.giveaways = Object.fromEntries(nextGiveaways);
        this.local.entries = nextEntries;
        this.local.draws = nextDraws;
        this.cache = {
            giveaways: new Map(),
            entries: new Map(),
            draws: new Map()
        };
        nextGiveaways.forEach(giveaway => this.cacheGiveaway(giveaway));
        Object.values(nextEntries).forEach(entries => Object.values(entries).forEach(entry => this.cacheEntry(entry)));
        Object.values(nextDraws).forEach(draw => this.cacheDraw(draw));
        this.writeJsonStore();
        return true;
    }

    async mysqlSaveGiveaway(giveawayId, giveaway) {
        await this.mysqlQuery(`
            INSERT INTO giveaways (
                giveaway_id, guild_id, channel_id, message_id, name, prize,
                host_text, host_user_id, created_by_id, created_by_name,
                winners_total, required_role_id, status, starts_at, ends_at,
                ended_at, deleted_at, color_hex, thumbnail_url,
                winner_user_ids, giveaway_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                guild_id = VALUES(guild_id),
                channel_id = VALUES(channel_id),
                message_id = VALUES(message_id),
                name = VALUES(name),
                prize = VALUES(prize),
                host_text = VALUES(host_text),
                host_user_id = VALUES(host_user_id),
                created_by_id = VALUES(created_by_id),
                created_by_name = VALUES(created_by_name),
                winners_total = VALUES(winners_total),
                required_role_id = VALUES(required_role_id),
                status = VALUES(status),
                starts_at = VALUES(starts_at),
                ends_at = VALUES(ends_at),
                ended_at = VALUES(ended_at),
                deleted_at = VALUES(deleted_at),
                color_hex = VALUES(color_hex),
                thumbnail_url = VALUES(thumbnail_url),
                winner_user_ids = VALUES(winner_user_ids),
                giveaway_json = VALUES(giveaway_json)
        `, [
            giveawayId,
            giveaway.guild_id ?? null,
            giveaway.channel_id,
            giveaway.message_id ?? null,
            giveaway.name ?? null,
            giveaway.prize,
            giveaway.host_text ?? null,
            giveaway.host_user_id ?? null,
            giveaway.created_by_id ?? null,
            giveaway.created_by_name ?? null,
            Number(giveaway.winners_total || 1),
            giveaway.required_role_id ?? null,
            normalizeStatus(giveaway.status),
            mysqlDate(giveaway.starts_at),
            mysqlDate(giveaway.ends_at),
            mysqlDateOrNull(giveaway.ended_at),
            mysqlDateOrNull(giveaway.deleted_at),
            parseColor(giveaway.color_hex),
            giveaway.thumbnail_url ?? null,
            toJson(giveaway.winner_user_ids || []),
            JSON.stringify(giveaway)
        ]);
    }

    async mysqlGetGiveaway(giveawayId) {
        const [rows] = await this.mysqlQuery('SELECT giveaway_json FROM giveaways WHERE giveaway_id = ?', [giveawayId]);
        return rows[0] ? fromJson(rows[0].giveaway_json, null) : null;
    }

    async mysqlGetByMessageId(messageId) {
        const [rows] = await this.mysqlQuery('SELECT giveaway_id, giveaway_json FROM giveaways WHERE message_id = ? LIMIT 1', [messageId]);
        return rows[0] ? [rows[0].giveaway_id, fromJson(rows[0].giveaway_json, null)] : [null, null];
    }

    async mysqlListGiveaways(status) {
        const params = [];
        let sql = 'SELECT giveaway_json FROM giveaways';
        if (status && status !== 'all') {
            sql += ' WHERE status = ?';
            params.push(normalizeStatus(status));
        }
        sql += ' ORDER BY starts_at DESC, created_at DESC';
        const [rows] = await this.mysqlQuery(sql, params);
        return rows.map(row => fromJson(row.giveaway_json, {}));
    }

    async mysqlSaveEntry(giveawayId, userId, entry) {
        await this.mysqlQuery(`
            INSERT INTO giveaway_entries (
                giveaway_id, user_id, user_name, joined_at, left_at, entry_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                user_name = VALUES(user_name),
                joined_at = VALUES(joined_at),
                left_at = VALUES(left_at),
                entry_json = VALUES(entry_json)
        `, [
            giveawayId,
            String(userId),
            entry.user_name ?? null,
            mysqlDate(entry.joined_at),
            mysqlDateOrNull(entry.left_at),
            JSON.stringify(entry)
        ]);
    }

    async mysqlGetEntry(giveawayId, userId) {
        const [rows] = await this.mysqlQuery(
            'SELECT entry_json FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
            [giveawayId, String(userId)]
        );
        return rows[0] ? fromJson(rows[0].entry_json, null) : null;
    }

    async mysqlListEntries(giveawayId, { activeOnly = false } = {}) {
        const sql = activeOnly
            ? 'SELECT entry_json FROM giveaway_entries WHERE giveaway_id = ? AND left_at IS NULL ORDER BY joined_at ASC'
            : 'SELECT entry_json FROM giveaway_entries WHERE giveaway_id = ? ORDER BY joined_at ASC';
        const [rows] = await this.mysqlQuery(sql, [giveawayId]);
        return rows.map(row => fromJson(row.entry_json, {}));
    }

    async mysqlSaveDraw(drawId, draw) {
        await this.mysqlQuery(`
            INSERT INTO giveaway_draws (
                draw_id, giveaway_id, draw_type, drawn_by_id, drawn_at,
                eligible_count, winner_user_ids, draw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                giveaway_id = VALUES(giveaway_id),
                draw_type = VALUES(draw_type),
                drawn_by_id = VALUES(drawn_by_id),
                drawn_at = VALUES(drawn_at),
                eligible_count = VALUES(eligible_count),
                winner_user_ids = VALUES(winner_user_ids),
                draw_json = VALUES(draw_json)
        `, [
            drawId,
            draw.giveaway_id,
            draw.draw_type,
            draw.drawn_by_id ?? null,
            mysqlDate(draw.drawn_at),
            Number(draw.eligible_count || 0),
            toJson(draw.winner_user_ids || []),
            JSON.stringify(draw)
        ]);
    }

    async mysqlListDraws(giveawayId) {
        const [rows] = await this.mysqlQuery(
            'SELECT draw_json FROM giveaway_draws WHERE giveaway_id = ? ORDER BY drawn_at ASC',
            [giveawayId]
        );
        return rows.map(row => fromJson(row.draw_json, {}));
    }
}

function createGiveawayStore(options = {}) {
    return new GiveawayStore(options);
}

function buildGiveawayComponents(giveaway, { disabled = false } = {}) {
    if (giveaway.status === GIVEAWAY_DELETED) return [];
    if (giveaway.status === GIVEAWAY_ENDED) {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(GIVEAWAY_PARTICIPANTS_BUTTON_ID)
                    .setLabel('Participants')
                    .setEmoji('👥')
                    .setStyle(ButtonStyle.Secondary)
            )
        ];
    }

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(GIVEAWAY_BUTTON_ID)
                .setLabel('Enter Giveaway')
                .setEmoji('🎉')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled)
        )
    ];
}

function buildGiveawayEmbed(giveaway, { participantCount = 0 } = {}) {
    const embed = new EmbedBuilder()
        .setTitle(giveawayEmbedTitle(giveaway))
        .setDescription(normalizeGiveawayDescription(giveaway.description) || null)
        .setColor(giveawayEmbedColor(giveaway))
        .setTimestamp(new Date());

    if (!customGiveawayName(giveaway)) {
        embed.setURL(DEFAULT_GIVEAWAY_TITLE_URL);
    }

    embed.addFields(
        { name: '<:man_of_culture:1186287184106496112> Host', value: fieldValue(giveaway.host_text || 'White Walkers Team'), inline: true },
        { name: '🎁 Prize', value: fieldValue(giveaway.prize || 'Unknown'), inline: true },
        { name: '🏆 Winners', value: fieldValue(giveaway.winners_total || 1), inline: true },
        { name: '👥 Participants', value: fieldValue(participantCount), inline: true }
    );

    const endsAt = giveaway.status === GIVEAWAY_ENDED ? giveaway.ended_at : giveaway.ends_at;
    const endsFieldName = giveaway.status === GIVEAWAY_ENDED ? '❌ Giveaway ended!' : '⏳ Ends';
    embed.addFields({ name: endsFieldName, value: fieldValue(discordTimestamp(endsAt, 'R') || 'Unknown'), inline: true });

    if (giveaway.status === GIVEAWAY_DELETED) {
        embed.addFields({ name: '📌 Status', value: fieldValue('Deleted'), inline: false });
    }

    const winnerIds = giveaway.winner_user_ids || [];
    if (winnerIds.length) {
        embed.addFields({
            name: winnerFieldName(winnerIds),
            value: fieldValue(winnerIds.map(userId => `<@${userId}>`).join(', ')),
            inline: false
        });
    }

    const requiredRoleIds = giveawayRequiredRoleIds(giveaway);
    if (requiredRoleIds.length) {
        embed.addFields({
            name: requiredRolesFieldName(requiredRoleIds),
            value: fieldValue(roleMentions(requiredRoleIds)),
            inline: false
        });
    }

    if (giveaway.thumbnail_url) {
        embed.setThumbnail(giveaway.thumbnail_url);
    } else if (fs.existsSync(LOGO_PATH)) {
        embed.setThumbnail(LOGO_ATTACHMENT_URL);
    }

    applyGiveawayFooter(embed);
    return embed;
}

function customGiveawayName(giveaway) {
    const name = String(giveaway.name || '').trim();
    return name || null;
}

function giveawayEmbedTitle(giveaway) {
    return customGiveawayName(giveaway) || DEFAULT_GIVEAWAY_TITLE;
}

function giveawayEmbedColor(giveaway) {
    if ([GIVEAWAY_ENDED, GIVEAWAY_DELETED].includes(giveaway.status)) {
        return colorInt('#FF0000');
    }
    return colorInt(giveaway.color_hex || DEFAULT_GIVEAWAY_COLOR);
}

function fieldValue(value) {
    return `- **${value}**`;
}

function requiredRolesFieldName(roleIds) {
    return `🔒 ${roleIds.length === 1 ? 'Required Role' : 'Required Roles'}`;
}

function winnerFieldName(winnerIds) {
    return `🏆 ${winnerIds.length === 1 ? 'Winner' : 'Winners'}`;
}

function giveawayMessageContent(giveaway) {
    if ([GIVEAWAY_ENDED, GIVEAWAY_DELETED].includes(giveaway.status)) {
        return '### 🎉  Giveaway Ended!';
    }

    const lines = [];
    const pingRoleIds = normalizeRoleIds(giveaway.ping_role_ids);
    if (pingRoleIds.length) lines.push(roleMentions(pingRoleIds));
    lines.push('### 🎉  Active Giveaway!  🎉');
    return lines.join('\n');
}

function applyGiveawayFooter(embed) {
    if (fs.existsSync(LOGO_PATH)) {
        embed.setFooter({ text: GIVEAWAY_FOOTER_TEXT, iconURL: LOGO_ATTACHMENT_URL });
    } else {
        embed.setFooter({ text: GIVEAWAY_FOOTER_TEXT });
    }
    return embed;
}

async function sendGiveawayMessage(channel, giveaway, config) {
    const entries = await config.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
    const embed = buildGiveawayEmbed(giveaway, { participantCount: entries.length });
    const file = logoFile();
    const payload = {
        content: giveawayMessageContent(giveaway),
        embeds: [embed],
        components: buildGiveawayComponents(giveaway),
        allowedMentions: { parse: [], roles: normalizeRoleIds(giveaway.ping_role_ids) }
    };
    if (file) payload.files = [file];
    return channel.send(payload);
}

async function replyWithGiveawayMessage(interaction, giveaway, config) {
    const entries = await config.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
    const embed = buildGiveawayEmbed(giveaway, { participantCount: entries.length });
    const file = logoFile();
    const payload = {
        content: giveawayMessageContent(giveaway),
        embeds: [embed],
        components: buildGiveawayComponents(giveaway),
        allowedMentions: { parse: [], roles: normalizeRoleIds(giveaway.ping_role_ids) }
    };
    if (file) payload.files = [file];

    if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.reply(payload);
    }
    return interaction.fetchReply();
}

async function pacedGiveawayMessageEdit(message, payload) {
    const previous = GIVEAWAY_MESSAGE_EDITS.queue;
    let release;
    GIVEAWAY_MESSAGE_EDITS.queue = new Promise(resolve => {
        release = resolve;
    });

    await previous;
    try {
        const now = Date.now();
        const messageKey = `${message.channelId || message.channel?.id || 'unknown'}:${message.id}`;
        const routeWait = GIVEAWAY_EDIT_DELAY_MS - (now - GIVEAWAY_MESSAGE_EDITS.lastRouteEditAt);
        const messageWait = GIVEAWAY_SAME_MESSAGE_EDIT_DELAY_MS - (
            now - (GIVEAWAY_MESSAGE_EDITS.lastMessageEditAt.get(messageKey) || 0)
        );
        await wait(Math.max(0, routeWait, messageWait));
        return await message.edit(payload);
    } finally {
        const finishedAt = Date.now();
        const messageKey = `${message.channelId || message.channel?.id || 'unknown'}:${message.id}`;
        GIVEAWAY_MESSAGE_EDITS.lastRouteEditAt = finishedAt;
        GIVEAWAY_MESSAGE_EDITS.lastMessageEditAt.set(messageKey, finishedAt);
        if (GIVEAWAY_MESSAGE_EDITS.lastMessageEditAt.size > 512) {
            const cutoff = finishedAt - Math.max(60000, GIVEAWAY_SAME_MESSAGE_EDIT_DELAY_MS * 4);
            for (const [key, editedAt] of GIVEAWAY_MESSAGE_EDITS.lastMessageEditAt) {
                if (editedAt < cutoff) GIVEAWAY_MESSAGE_EDITS.lastMessageEditAt.delete(key);
            }
        }
        release();
    }
}

function refreshGiveawayMessage(client, config, giveaway, { disabled = null } = {}) {
    if (!giveaway?.giveaway_id) return Promise.resolve();

    const giveawayId = String(giveaway.giveaway_id);
    let pending = GIVEAWAY_REFRESHES.get(giveawayId);
    if (!pending) {
        pending = { giveaway: null, disabled: null, dirty: false, promise: null };
        GIVEAWAY_REFRESHES.set(giveawayId, pending);
    }

    pending.giveaway = clone(giveaway);
    pending.disabled = disabled;
    pending.dirty = true;
    if (pending.promise) return pending.promise;

    pending.promise = (async () => {
        while (pending.dirty) {
            pending.dirty = false;
            await refreshGiveawayMessageNow(client, config, pending.giveaway, { disabled: pending.disabled });
        }
    })().finally(() => {
        GIVEAWAY_REFRESHES.delete(giveawayId);
    });
    return pending.promise;
}

async function refreshGiveawayMessageNow(client, config, giveaway, { disabled = null } = {}) {
    if (!giveaway?.message_id) return;
    const channel = await getChannel(client, giveaway.channel_id);
    if (!channel) return;

    let message;
    try {
        message = await channel.messages.fetch(giveaway.message_id);
    } catch {
        return;
    }

    const entries = await config.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
    const embed = buildGiveawayEmbed(giveaway, { participantCount: entries.length });
    const shouldDisable = disabled ?? giveaway.status !== GIVEAWAY_ACTIVE;
    await pacedGiveawayMessageEdit(message, {
        content: giveawayMessageContent(giveaway),
        embeds: [embed],
        components: buildGiveawayComponents(giveaway, { disabled: shouldDisable }),
        allowedMentions: { parse: [] }
    }).catch(() => { });
}

async function deleteGiveawayMessage(client, config, giveaway) {
    if (!giveaway?.message_id) return;
    const channel = await getChannel(client, giveaway.channel_id);
    if (!channel) return;
    try {
        const message = await channel.messages.fetch(giveaway.message_id);
        await message.delete();
    } catch {
        await refreshGiveawayMessage(client, config, giveaway, { disabled: true });
    }
}

function withGiveawayLock(giveawayId, task) {
    return GIVEAWAY_LOCKS.run(giveawayId, task);
}

async function endGiveaway(client, config, giveaway, { actor = null, drawType, winnerCount = null, announceInteraction = null } = {}) {
    return withGiveawayLock(giveaway.giveaway_id, () => endGiveawayLocked(
        client,
        config,
        giveaway,
        { actor, drawType, winnerCount, announceInteraction }
    ));
}

async function endGiveawayLocked(client, config, giveaway, { actor = null, drawType, winnerCount = null, announceInteraction = null } = {}) {
    const giveawayId = String(giveaway.giveaway_id);
    const current = await config.giveawayStore.getGiveaway(giveawayId);
    if (!current) return [giveaway, []];

    const existingDraws = await config.giveawayStore.listDraws(giveawayId);
    if (drawType === 'end') {
        const previousEndDraw = [...existingDraws].reverse().find(draw => draw.draw_type === 'end');
        if (current.status !== GIVEAWAY_ACTIVE) {
            return [current, (current.winner_user_ids || previousEndDraw?.winner_user_ids || []).map(String)];
        }

        // If the process stopped after recording the draw, finish that same draw instead of choosing again.
        if (previousEndDraw) {
            const winnerIds = (previousEndDraw.winner_user_ids || []).map(String);
            const endedAt = previousEndDraw.drawn_at || utcNowIso();
            const recovered = await config.giveawayStore.updateGiveaway(giveawayId, {
                status: GIVEAWAY_ENDED,
                ended_at: endedAt,
                winner_user_ids: winnerIds
            }) || {
                ...current,
                status: GIVEAWAY_ENDED,
                ended_at: endedAt,
                winner_user_ids: winnerIds
            };
            await refreshGiveawayMessage(client, config, recovered, { disabled: true });
            await announceGiveawayDraw(client, recovered, winnerIds, { drawType, interaction: announceInteraction });
            return [recovered, winnerIds];
        }
    } else if (drawType === 'reroll' && current.status !== GIVEAWAY_ENDED) {
        return [current, (current.winner_user_ids || []).map(String)];
    }

    const entries = await config.giveawayStore.listEntries(giveawayId, { activeOnly: true });
    const count = winnerCount || Number(current.winners_total || 1);
    const excluded = new Set();
    if (drawType === 'reroll') {
        for (const draw of existingDraws) {
            for (const userId of draw.winner_user_ids || []) excluded.add(String(userId));
        }
        for (const userId of current.winner_user_ids || []) excluded.add(String(userId));
    }

    const winners = chooseWinners(entries, count, excluded);
    const winnerIds = winners.map(entry => String(entry.user_id));
    const now = utcNowIso();
    const drawId = makeDrawId(giveawayId, drawType);
    const draw = {
        draw_id: drawId,
        giveaway_id: giveawayId,
        draw_type: drawType,
        drawn_by_id: actor?.id ?? null,
        drawn_by_name: actor?.displayName ?? actor?.username ?? null,
        drawn_at: now,
        eligible_count: activeEntries(entries).length,
        winner_user_ids: winnerIds
    };
    await config.giveawayStore.saveDraw(drawId, draw);

    const updates = { winner_user_ids: winnerIds };
    if (drawType === 'end') {
        updates.status = GIVEAWAY_ENDED;
        updates.ended_at = now;
    } else {
        updates.last_rerolled_at = now;
    }

    const updated = await config.giveawayStore.updateGiveaway(giveawayId, updates) || { ...current, ...updates };
    await refreshGiveawayMessage(client, config, updated, { disabled: true });
    await announceGiveawayDraw(client, updated, winnerIds, { drawType, interaction: announceInteraction });
    return [updated, winnerIds];
}

async function announceGiveawayDraw(client, giveaway, winnerIds, { drawType, interaction = null }) {
    const content = drawAnnouncementContent(giveaway, winnerIds, { drawType });
    if (interaction) {
        if (interaction.replied) return;
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content, allowedMentions: { users: winnerIds } });
            } else {
                await interaction.reply({ content, allowedMentions: { users: winnerIds } });
            }
        } catch {
            // The command handler will finish the deferred response with its own status message.
        }
        return;
    }

    const channel = await getChannel(client, giveaway.channel_id);
    if (!channel) return;
    const message = await fetchGiveawayMessage(channel, giveaway);
    try {
        if (message) {
            await message.reply({ content, allowedMentions: { users: winnerIds }, failIfNotExists: false });
        } else {
            await channel.send({ content, allowedMentions: { users: winnerIds } });
        }
    } catch {
        // Announcement failure should not undo an ended giveaway.
    }
}

async function fetchGiveawayMessage(channel, giveaway) {
    if (!giveaway?.message_id) return null;
    return channel.messages.fetch(giveaway.message_id).catch(() => null);
}

function drawAnnouncementContent(giveaway, winnerIds, { drawType }) {
    const title = drawType === 'reroll' ? 'Giveaway rerolled!' : 'Giveaway ended!';
    const emoji = drawType === 'reroll' ? '🔁' : '🎉';
    const prize = String(giveaway.prize || 'the prize');
    const heading = `${emoji}  ${linkTextToGiveaway(giveaway, title)}`;
    if (!winnerIds.length) {
        return `### ${heading}\n- Nobody joined this giveaway.`;
    }
    const mentions = winnerIds.map(userId => `<@${userId}>`).join(', ');
    return `### ${heading}\n- Congratulations ${mentions}! You won **${prize}  <:man_of_culture:1186287184106496112>**`;
}

function linkTextToGiveaway(giveaway, text) {
    const link = messageLink(giveaway);
    return link ? `[${text}](${link})` : text;
}

function giveawayActionEmbed(giveaway, { joined }) {
    const emoji = joined ? '✅' : '❌';
    const action = joined ? 'joined' : 'left';
    return applyGiveawayFooter(new EmbedBuilder()
        .setDescription(
            `### ${emoji} You ${action} the ${linkTextToGiveaway(giveaway, 'Giveaway!')}\n` +
            `- Prize: **${giveaway.prize || 'Unknown'}**`
        )
        .setColor(colorInt(joined ? DEFAULT_GIVEAWAY_COLOR : '#FF0000'))
        .setTimestamp(new Date()));
}

async function sendGiveawayActionFeedback(interaction, embed) {
    const payload = { embeds: [embed], flags: MessageFlags.Ephemeral };
    const file = logoFile();
    if (file) payload.files = [file];
    await interaction.followUp(payload);
}

async function handleGiveawayButton(interaction, config) {
    if (interaction.customId === GIVEAWAY_BUTTON_ID) {
        await handleJoinLeave(interaction, config);
        return true;
    }
    if (interaction.customId === GIVEAWAY_PARTICIPANTS_BUTTON_ID) {
        await handleParticipantsButton(interaction, config);
        return true;
    }
    if (interaction.customId.startsWith(`${GIVEAWAY_PAGE_PREFIX}:`)) {
        await handlePaginationButton(interaction);
        return true;
    }
    return false;
}

async function handleJoinLeave(interaction, config) {
    if (interaction.user.bot) {
        await interaction.reply({ content: 'Bots cannot enter giveaways.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!interaction.message) {
        await interaction.reply({ content: 'Could not find this giveaway message.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [giveawayId] = await config.giveawayStore.getByMessageId(interaction.message.id);
    if (!giveawayId) {
        await interaction.editReply('That giveaway could not be found.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (!member) {
        await interaction.editReply('Could not verify your server membership.');
        return;
    }

    const result = await withGiveawayLock(giveawayId, async () => {
        const giveaway = await config.giveawayStore.getGiveaway(giveawayId);
        if (!giveaway || giveaway.status !== GIVEAWAY_ACTIVE) return { type: 'inactive' };

        if (giveawayHasEnded(giveaway)) {
            await endGiveawayLocked(interaction.client, config, giveaway, { actor: null, drawType: 'end' });
            return { type: 'ended' };
        }

        const requiredRoleIds = giveawayRequiredRoleIds(giveaway);
        if (requiredRoleIds.length && !userHasRequiredRole(member, requiredRoleIds)) {
            return { type: 'missing_role', requiredRoleIds };
        }

        const now = utcNowIso();
        let entry = await config.giveawayStore.getEntry(giveawayId, member.id);
        let joined;
        if (entry && !entry.left_at) {
            entry.left_at = now;
            joined = false;
        } else {
            entry = {
                giveaway_id: giveawayId,
                user_id: member.id,
                user_name: member.displayName || member.user?.username || member.user?.tag || member.id,
                joined_at: now,
                left_at: null
            };
            joined = true;
        }

        await config.giveawayStore.saveEntry(giveawayId, member.id, entry);
        return { type: 'saved', giveaway, joined };
    });

    if (result.type === 'inactive') {
        await interaction.editReply('This giveaway is no longer active.');
        return;
    }
    if (result.type === 'ended') {
        await interaction.editReply('This giveaway has ended.');
        return;
    }
    if (result.type === 'missing_role') {
        await interaction.editReply(`You need one of these roles to enter this giveaway: ${roleMentions(result.requiredRoleIds)}`);
        return;
    }

    // Entry feedback should stay fast while the shared refresh queue updates the counter safely.
    void refreshGiveawayMessage(interaction.client, config, result.giveaway).catch(err => {
        console.error('[WW LOG] Giveaway participant refresh failed:', err);
    });
    await sendGiveawayActionFeedback(interaction, giveawayActionEmbed(result.giveaway, { joined: result.joined }));
}

async function handleParticipantsButton(interaction, config) {
    if (!interaction.message) {
        await interaction.reply({ content: 'Could not find this giveaway message.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, giveaway] = await config.giveawayStore.getByMessageId(interaction.message.id);
    if (!giveaway) {
        await interaction.editReply('That giveaway could not be found.');
        return;
    }
    await sendParticipantEmbeds(interaction, config, giveaway);
}

function giveawayHasEnded(giveaway, now = new Date()) {
    if (giveaway.status !== GIVEAWAY_ACTIVE) return true;
    const endsAt = parseDate(giveaway.ends_at);
    return endsAt ? endsAt <= now : false;
}

async function sendParticipantEmbeds(interaction, config, giveaway) {
    const entries = await config.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
    const embeds = buildParticipantEmbeds(giveaway, entries, interaction.guild);
    await sendEmbedFollowUp(interaction, embeds);
}

async function sendEmbedFollowUp(interaction, embeds) {
    const [embed] = embeds;
    if (embeds.length <= 1) {
        await interaction.editReply({ embeds: [embed] });
        return;
    }
    const session = createPaginationSession(interaction.user.id, embeds);
    await interaction.editReply({ embeds: [embed], components: buildPaginationComponents(session) });
}

function createPaginationSession(ownerId, embeds) {
    const id = crypto.randomBytes(6).toString('hex');
    const session = { id, ownerId, embeds, index: 0, createdAt: Date.now() };
    PAGINATION_SESSIONS.set(id, session);
    return session;
}

function buildPaginationComponents(session) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${GIVEAWAY_PAGE_PREFIX}:${session.id}:prev`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(session.index <= 0),
            new ButtonBuilder()
                .setCustomId(`${GIVEAWAY_PAGE_PREFIX}:${session.id}:next`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(session.index >= session.embeds.length - 1)
        )
    ];
}

async function handlePaginationButton(interaction) {
    const [, , sessionId, direction] = interaction.customId.split(':');
    const session = PAGINATION_SESSIONS.get(sessionId);
    if (!session) {
        await interaction.reply({ content: 'This pagination expired. Run the command again.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (interaction.user.id !== session.ownerId) {
        await interaction.reply({ content: 'Only the command user can use these buttons.', flags: MessageFlags.Ephemeral });
        return;
    }

    session.index = direction === 'next'
        ? Math.min(session.embeds.length - 1, session.index + 1)
        : Math.max(0, session.index - 1);
    await interaction.update({ embeds: [session.embeds[session.index]], components: buildPaginationComponents(session) });
}

function buildParticipantEmbeds(giveaway, entries, guild = null) {
    const pages = chunked(entries, PARTICIPANTS_PAGE_SIZE);
    if (!pages.length) pages.push([]);
    return pages.map((pageEntries, pageIndex) => {
        const embed = applyGiveawayFooter(new EmbedBuilder()
            .setTitle(`Participants - ${giveawayDisplayLabel(giveaway, { guild })}`)
            .setColor(colorInt(giveaway.color_hex || DEFAULT_GIVEAWAY_COLOR))
            .setDescription(participantPageDescription(pageEntries, pageIndex, entries.length))
            .setTimestamp(new Date()));

        embed.addFields(
            { name: 'Total Participants', value: String(entries.length), inline: true },
            { name: 'Page', value: `${pageIndex + 1}/${pages.length}`, inline: true }
        );
        const link = messageLink(giveaway);
        if (link) embed.addFields({ name: 'Giveaway', value: `[Jump to Giveaway](${link})`, inline: true });
        return embed;
    });
}

function participantPageDescription(entries, pageIndex, totalEntries) {
    if (!entries.length) return 'No active participants found.';
    const offset = pageIndex * PARTICIPANTS_PAGE_SIZE;
    const lines = entries.map((entry, index) => {
        const joinedAt = discordTimestampPair(entry.joined_at) || 'Unknown';
        return `**${offset + index + 1}.** <@${entry.user_id}> - Joined: ${joinedAt}`;
    });
    const shownTo = offset + entries.length;
    return `${lines.join('\n')}\n\nShowing ${offset + 1}-${shownTo} of ${totalEntries} participant(s).`;
}

function buildGiveawayListEmbeds(giveaways, status, guild = null) {
    const statusLabel = statusLabelText(status);
    const pages = chunked(giveaways, GIVEAWAY_LIST_PAGE_SIZE);
    if (!pages.length) pages.push([]);

    return pages.map((pageGiveaways, pageIndex) => {
        const embed = applyGiveawayFooter(new EmbedBuilder()
            .setTitle(`Giveaways - ${statusLabel}`)
            .setColor(colorInt(DEFAULT_GIVEAWAY_COLOR))
            .setTimestamp(new Date()));

        if (!giveaways.length) {
            embed.setDescription(`No ${statusLabel.toLowerCase()} giveaways found.`);
        } else {
            const start = pageIndex * GIVEAWAY_LIST_PAGE_SIZE + 1;
            const end = start + pageGiveaways.length - 1;
            embed.setDescription(`Page ${pageIndex + 1}/${pages.length} - Showing ${start}-${end} of ${giveaways.length} giveaway(s).`);
        }

        pageGiveaways.forEach((giveaway, offset) => {
            const displayIndex = giveaways.length - (pageIndex * GIVEAWAY_LIST_PAGE_SIZE + offset);
            embed.addFields({
                name: giveawayListFieldTitle(giveaway, { index: displayIndex, guild }),
                value: giveawayListFieldValue(giveaway),
                inline: false
            });
        });
        return embed;
    });
}

function giveawayListFieldTitle(giveaway, { index = null, guild = null } = {}) {
    const status = String(giveaway.status || 'unknown').replace(/^./, char => char.toUpperCase());
    return `${giveawayDisplayLabel(giveaway, { index, guild })} - ${status}`.slice(0, 256);
}

function giveawayListFieldValue(giveaway) {
    const endsAt = giveaway.status === GIVEAWAY_ENDED ? giveaway.ended_at : giveaway.ends_at;
    const startText = discordTimestampPair(giveaway.starts_at) || 'Unknown';
    const endText = discordTimestampPair(endsAt) || 'Unknown';
    const lines = [
        `**Prize:** ${giveaway.prize || 'Unknown'}`,
        `**Winners:** ${giveaway.winners_total || 1}`,
        `**Participants:** ${giveaway.participant_count ?? activeEntries(giveaway.entries || []).length}`,
        `**Starts:** ${startText}`,
        `**Ends:** ${endText}`,
        `**ID:** \`${giveaway.giveaway_id}\``
    ];
    const link = messageLink(giveaway);
    if (link) lines.push(`**Giveaway:** [Jump to Giveaway](${link})`);
    return lines.join('\n').slice(0, 1024);
}

function giveawayDisplayLabel(giveaway, { index = null, guild = null } = {}) {
    const prefix = index !== null && index !== undefined ? `ID: ${index}. ` : '';
    return `${prefix}${giveawayHostDisplayLabel(giveaway, guild)} (${String(giveaway.prize || 'Unknown').trim()})`;
}

function giveawayHostDisplayLabel(giveaway, guild = null) {
    const hostUserId = hostUserIdFromGiveaway(giveaway);
    if (hostUserId) {
        const member = guild?.members?.cache?.get(String(hostUserId));
        if (member) return userDisplayName(member);
        const storedName = String(giveaway.host_display_name || giveaway.created_by_name || '').trim();
        if (storedName) return escapeDisplayMentions(storedName);
        return `User ${hostUserId}`;
    }
    const hostText = String(giveaway.host_text || '').trim();
    if (hostText) return escapeDisplayMentions(hostText);
    return escapeDisplayMentions(String(giveaway.created_by_name || 'White Walkers Team'));
}

function hostUserIdFromGiveaway(giveaway) {
    for (const value of [giveaway.host_user_id, mentionUserId(giveaway.host_text)]) {
        if (value) return String(value);
    }
    return null;
}

function mentionUserId(value) {
    const match = String(value || '').trim().match(/^<@!?(\d+)>$/);
    return match ? match[1] : null;
}

function userDisplayName(user) {
    return String(user.nickname || user.displayName || user.globalName || user.username || user.user?.username || user.id || 'Unknown');
}

function escapeDisplayMentions(value) {
    return String(value).replace(/<@!?/g, '@').replace(/<@&/g, '@').replace(/>/g, '').replace(/@everyone/g, '@\u200beveryone').replace(/@here/g, '@\u200bhere');
}

function discordTimestamp(value, style) {
    const date = parseDate(value);
    return date ? `<t:${Math.floor(date.getTime() / 1000)}:${style}>` : null;
}

function discordTimestampPair(value) {
    const longText = discordTimestamp(value, 'F');
    const relativeText = discordTimestamp(value, 'R');
    return longText && relativeText ? `${longText} (${relativeText})` : longText;
}

function statusLabelText(status) {
    if (status === 'all') return 'All';
    if (status === GIVEAWAY_ENDED) return 'Ended';
    if (status === GIVEAWAY_DELETED) return 'Deleted';
    return 'Active';
}

function chunked(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function memberFromInteraction(interaction) {
    if (interaction.member?.roles?.cache) return interaction.member;
    if (!interaction.guild) return null;
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function getChannel(client, channelId) {
    if (!channelId) return null;
    return client.channels.cache.get(String(channelId)) || client.channels.fetch(String(channelId)).catch(() => null);
}

function giveawayEndedWithinRerollWindow(giveaway, now = new Date()) {
    const endedAt = parseDate(giveaway.ended_at || giveaway.ends_at);
    if (!endedAt) return false;
    const diff = now.getTime() - endedAt.getTime();
    return diff >= 0 && diff <= REROLL_AUTOCOMPLETE_WINDOW_MS;
}

async function giveawayAutocomplete(interaction, config, { status, recentEndedOnly = false } = {}) {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const records = await config.giveawayStore.listGiveaways(status);
    const filtered = recentEndedOnly ? records.filter(record => giveawayEndedWithinRerollWindow(record)) : records;
    const total = filtered.length;
    const choices = [];
    for (const [offset, record] of filtered.entries()) {
        const label = giveawayDisplayLabel(record, { index: total - offset, guild: interaction.guild }).slice(0, 100);
        if (focused && !label.toLowerCase().includes(focused) && !String(record.giveaway_id).toLowerCase().includes(focused)) {
            continue;
        }
        choices.push({ name: label, value: String(record.giveaway_id).slice(0, 100) });
        if (choices.length >= 25) break;
    }
    return choices;
}

function validateWinnerCount(value) {
    const count = Number(value);
    if (!Number.isInteger(count)) throw new Error('Winners must be a number.');
    if (count < 1) throw new Error('Winners must be at least 1.');
    if (count > MAX_WINNERS) throw new Error(`Winners cannot be higher than ${MAX_WINNERS}.`);
    return count;
}

function resolveRoleIds(guild, value) {
    if (value === null || value === undefined || String(value).trim() === '') return [];
    if (!guild) throw new Error('Roles can only be used inside a server.');

    const text = String(value).trim();
    const roleIds = [];
    const notFound = [];
    const notRoles = [];
    const addRoleId = roleId => {
        if (!roleIds.includes(roleId)) roleIds.push(roleId);
    };

    for (const match of text.matchAll(/<@(?!&)[^>]*>|<#[^>]*>|@everyone|@here/g)) {
        notRoles.push(match[0]);
    }

    for (const part of text.split(/[,;\n|]+/).map(item => item.trim()).filter(Boolean)) {
        if (/^@/.test(part) && !/^<@&\d+>$/.test(part) && !findRoleByName(guild, part.replace(/^@+/, ''))) {
            notRoles.push(part);
        }
    }

    if (notRoles.length) {
        throw new Error(`**${uniqueList(notRoles).join(', ')}** is not a role! Only roles are accepted!\n- Type the **@** prefix and select a role.`);
    }

    for (const match of text.matchAll(/<@&(\d+)>|\b(\d{15,25})\b/g)) {
        const roleId = match[1] || match[2];
        if (!guild.roles.cache.has(roleId)) notFound.push(roleId);
        else addRoleId(roleId);
    }

    const textWithoutIds = text.replace(/<@&\d+>|\b\d{15,25}\b/g, ' ').trim();
    if (textWithoutIds) {
        const roleNames = textWithoutIds.split(/[,;\n|]+/).map(part => part.trim()).filter(Boolean);
        for (const roleName of roleNames) {
            const role = findRoleByName(guild, roleName.replace(/^@+/, ''));
            if (!role) notFound.push(roleName);
            else addRoleId(role.id);
        }
    }

    if (notFound.length) throw new Error(`Could not find role(s): **${uniqueList(notFound).join(', ')}**\n- Type the **@** prefix and select a role.`);
    if (!roleIds.length) throw new Error('Please mention one or more valid roles.');
    return roleIds;
}

function uniqueList(values) {
    return [...new Set(values.map(value => String(value)).filter(Boolean))];
}

function findRoleByName(guild, roleName) {
    const target = String(roleName).trim().toLowerCase().replace(/\s+/g, ' ');
    return guild.roles.cache.find(role => role.name.trim().toLowerCase().replace(/\s+/g, ' ') === target) || null;
}

function canManageGiveaways(member, config) {
    if (!member?.roles?.cache) return false;
    const allowed = new Set([config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean).map(String));
    return member.roles.cache.some(role => allowed.has(role.id));
}

function giveawayChannelOnlyError(config, commandName = 'create') {
    return `### The \`/giveaway ${commandName}\` command can only be used in <#${config.giveawayChannelID}>`;
}

function shouldRestrictGiveawayChannel(config) {
    return Boolean(config.giveawayChannelID);
}

function drawSummary(action, giveaway, winnerIds, guild = null) {
    const winners = winnerIds.length ? winnerIds.map(userId => `<@${userId}>`).join(', ') : 'No winners';
    const label = winnerIds.length === 1 ? 'Winner' : 'Winners';
    const giveawayLabel = giveawayDisplayLabel(giveaway, { guild });
    const giveawayLink = linkTextToGiveaway(giveaway, giveawayLabel);
    if (action === 'Rerolled') {
        return `Rerolled Giveaway: **${giveawayLink}**\n- ${label}: ${winners}`;
    }
    if (action === 'Ended') {
        return `Ended Giveaway: **${giveawayLink}**\n- ${label}: ${winners}`;
    }

    return `${action} **${giveawayLabel}**. ${label}: ${winners}`;
}

function startGiveawayLoop(client, config) {
    if (client.giveawayLoop) return;
    const runDueGiveaways = async () => {
        if (client.giveawayLoopRunning) return;
        client.giveawayLoopRunning = true;
        try {
            await config.giveawayStore.syncPending?.();
            const dueGiveaways = await config.giveawayStore.listDueGiveaways(new Date());
            for (const [index, giveaway] of dueGiveaways.entries()) {
                try {
                    const current = await config.giveawayStore.getGiveaway(giveaway.giveaway_id);
                    if (current?.status === GIVEAWAY_ACTIVE) {
                        await endGiveaway(client, config, current, { actor: null, drawType: 'end' });
                    }
                } catch (err) {
                    console.error(`[WW LOG] Could not end giveaway ${giveaway.giveaway_id || 'unknown'}:`, err);
                }
                if (index + 1 < dueGiveaways.length) await wait(GIVEAWAY_END_PACING_MS);
            }
        } catch (err) {
            console.error('[WW LOG] Giveaway loop failed:', err);
        } finally {
            client.giveawayLoopRunning = false;
        }
    };

    client.giveawayLoop = setInterval(() => {
        void runDueGiveaways();
    }, LOOP_INTERVAL_MS);
    client.giveawayLoop.unref?.();
    void runDueGiveaways();
}

module.exports = {
    DEFAULT_GIVEAWAY_COLOR,
    GIVEAWAY_ACTIVE,
    GIVEAWAY_DELETED,
    GIVEAWAY_ENDED,
    MAX_WINNERS,
    buildGiveawayEmbed,
    buildGiveawayListEmbeds,
    canManageGiveaways,
    createGiveawayStore,
    drawSummary,
    endGiveaway,
    giveawayAutocomplete,
    giveawayChannelOnlyError,
    giveawayDisplayLabel,
    giveawayEndedWithinRerollWindow,
    giveawayHasEnded,
    handleGiveawayButton,
    makeGiveawayId,
    mergeGiveawaySyncState,
    normalizeGiveawayDescription,
    parseColor,
    parseGiveawayEndTime,
    resolveRoleIds,
    sendGiveawayMessage,
    replyWithGiveawayMessage,
    sendEmbedFollowUp,
    sendParticipantEmbeds,
    shouldRestrictGiveawayChannel,
    startGiveawayLoop,
    utcNowIso,
    validateWinnerCount,
    deleteGiveawayMessage,
    refreshGiveawayMessage,
    withGiveawayLock
};
