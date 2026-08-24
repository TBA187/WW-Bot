const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../../utils/jsonFile.js');

const STORAGE_VERSION = 1;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const VALID_STORAGE_MODES = new Set(['auto', 'mysql', 'json']);
const LEGACY_SATURDAY_NOTIFICATION_KEY = 'saturday_contests';
const SATURDAY_NOTIFICATION_KEYS = ['bug_catching_contest', 'fish_catching_contest'];

function parseStorageMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    return VALID_STORAGE_MODES.has(mode) ? mode : 'auto';
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function toIso(value, fallback = new Date().toISOString()) {
    if (!value) return fallback;
    if (value instanceof Date) return value.toISOString();

    const text = String(value);
    const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function toMysqlDate(value) {
    const date = new Date(value);
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const pad = number => String(number).padStart(2, '0');

    return `${safeDate.getUTCFullYear()}-${pad(safeDate.getUTCMonth() + 1)}-${pad(safeDate.getUTCDate())} ` +
        `${pad(safeDate.getUTCHours())}:${pad(safeDate.getUTCMinutes())}:${pad(safeDate.getUTCSeconds())}`;
}

function subscriptionId(notificationKey, userId) {
    return `${notificationKey}:${userId}`;
}

function emptyStore(source) {
    return {
        version: STORAGE_VERSION,
        source,
        pendingSync: false,
        settings: {},
        subscriptions: {},
        pendingSettings: [],
        pendingSubscriptions: []
    };
}

class NotificationStore {
    constructor({
        db,
        guildId,
        definitions,
        storageMode = process.env.STORAGE_MODE,
        dataFile = path.join(__dirname, '..', '..', 'data', 'notifications.json')
    } = {}) {
        this.db = db;
        this.guildId = String(guildId || '');
        this.definitions = [...(definitions || [])];
        this.definitionsByKey = new Map(this.definitions.map(definition => [definition.key, definition]));
        this.definitionOrder = new Map(this.definitions.map((definition, index) => [definition.key, index]));
        this.storageMode = parseStorageMode(storageMode);
        this.dataFile = dataFile;
        this.tempFile = `${dataFile}.tmp`;
        this.local = emptyStore(this.getJsonSource());
        this.settingsCache = new Map();
        this.subscriptionsCache = new Map();
        this.syncPromise = null;
        this.syncLoop = null;
        this.mysqlOutage = false;
    }

    getJsonSource() {
        return this.storageMode === 'json' ? 'json_only' : 'mysql_fallback';
    }

    canUseMysql() {
        return this.storageMode !== 'json' && Boolean(this.db?.hasRequiredConfig);
    }

    noteMysqlFailure(err) {
        if (this.db?.isDatabaseUnavailableError && !this.db.isDatabaseUnavailableError(err)) {
            console.error('[PRO NOTIFICATIONS] Unexpected MySQL storage error:', err);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const errorCode = this.db?.getErrorCode?.(err) || err?.causeCode || err?.code || err?.message || err;
        console.warn(
            `[PRO NOTIFICATIONS] MySQL storage unavailable (${errorCode}). ` +
            'Using JSON; pending settings and subscriptions will retry automatically.'
        );
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log('[PRO NOTIFICATIONS] MySQL storage restored; pending JSON data is synchronizing.');
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

    readJsonStore() {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });

        if (!fs.existsSync(this.dataFile)) {
            const data = emptyStore(this.getJsonSource());
            this.writeJsonData(data);
            return data;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            return {
                ...emptyStore(parsed.source || this.getJsonSource()),
                ...parsed,
                version: STORAGE_VERSION,
                settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
                subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
                pendingSettings: Array.isArray(parsed.pendingSettings) ? parsed.pendingSettings : [],
                pendingSubscriptions: Array.isArray(parsed.pendingSubscriptions) ? parsed.pendingSubscriptions : []
            };
        } catch (err) {
            console.error('[PRO NOTIFICATIONS] Failed to read notification JSON storage:', err);
            return emptyStore(this.getJsonSource());
        }
    }

    writeJsonData(data = this.local) {
        writeJsonIfChanged(this.dataFile, this.tempFile, data);
    }

    writeJsonStore() {
        this.local.pendingSync = this.hasPendingSync();
        this.writeJsonData(this.local);
    }

    hasPendingSync() {
        return Boolean(this.local.pendingSettings.length || this.local.pendingSubscriptions.length);
    }

    markPending(collection, value) {
        const entries = new Set(this.local[collection] || []);
        entries.add(String(value));
        this.local[collection] = [...entries].sort();
        this.local.pendingSync = true;
    }

    clearPending(collection, value) {
        this.local[collection] = (this.local[collection] || [])
            .filter(entry => String(entry) !== String(value));
        this.local.pendingSync = this.hasPendingSync();
    }

    normalizeSetting(record, definition) {
        const now = new Date().toISOString();
        return {
            guild_id: this.guildId,
            notification_key: definition.key,
            enabled: Number(record?.enabled) !== 0,
            created_at: toIso(record?.created_at, definition.createdAt),
            updated_at: toIso(record?.updated_at, now)
        };
    }

    normalizeSubscription(record) {
        const now = new Date().toISOString();
        return {
            guild_id: this.guildId,
            notification_key: String(record.notification_key),
            user_id: String(record.user_id),
            enabled: Number(record.enabled) === 1 || record.enabled === true,
            created_at: toIso(record.created_at, now),
            updated_at: toIso(record.updated_at, now)
        };
    }

    rebuildCache() {
        this.settingsCache.clear();
        this.subscriptionsCache.clear();

        for (const definition of this.definitions) {
            const setting = this.normalizeSetting(this.local.settings[definition.key], definition);
            this.local.settings[definition.key] = setting;
            this.settingsCache.set(definition.key, clone(setting));
        }

        for (const record of Object.values(this.local.subscriptions)) {
            if (!record || !this.definitionsByKey.has(String(record.notification_key)) || !record.user_id) continue;
            const normalized = this.normalizeSubscription(record);
            this.local.subscriptions[subscriptionId(normalized.notification_key, normalized.user_id)] = normalized;
            this.subscriptionsCache.set(
                subscriptionId(normalized.notification_key, normalized.user_id),
                clone(normalized)
            );
        }
    }

    ensureDefaultSettings({ markPending = false } = {}) {
        for (const definition of this.definitions) {
            if (this.local.settings[definition.key]) continue;
            this.local.settings[definition.key] = this.normalizeSetting(null, definition);
            if (markPending) this.markPending('pendingSettings', definition.key);
        }
        this.rebuildCache();
    }

    migrateLegacySaturdayContests() {
        const legacySetting = this.local.settings[LEGACY_SATURDAY_NOTIFICATION_KEY];
        if (legacySetting) {
            for (const notificationKey of SATURDAY_NOTIFICATION_KEYS) {
                const definition = this.definitionsByKey.get(notificationKey);
                if (!definition || this.local.settings[notificationKey]) continue;

                this.local.settings[notificationKey] = this.normalizeSetting({
                    ...legacySetting,
                    notification_key: notificationKey
                }, definition);
                if (this.storageMode !== 'json') {
                    this.markPending('pendingSettings', notificationKey);
                }
            }
        }

        for (const legacySubscription of Object.values(this.local.subscriptions)) {
            if (legacySubscription?.notification_key !== LEGACY_SATURDAY_NOTIFICATION_KEY) continue;

            for (const notificationKey of SATURDAY_NOTIFICATION_KEYS) {
                if (!this.definitionsByKey.has(notificationKey)) continue;
                const id = subscriptionId(notificationKey, legacySubscription.user_id);
                if (this.local.subscriptions[id]) continue;

                this.local.subscriptions[id] = this.normalizeSubscription({
                    ...legacySubscription,
                    notification_key: notificationKey
                });
                if (this.storageMode !== 'json') {
                    this.markPending('pendingSubscriptions', id);
                }
            }
        }
    }

    markAllSettingsPending() {
        for (const definition of this.definitions) {
            this.markPending('pendingSettings', definition.key);
        }
    }

    async restore() {
        this.local = this.readJsonStore();
        const hadSettings = Object.keys(this.local.settings).length > 0;
        this.migrateLegacySaturdayContests();
        this.ensureDefaultSettings();

        if (this.storageMode === 'json') {
            this.local.source = 'json_only';
            this.writeJsonStore();
            return false;
        }

        if (!this.canUseMysql()) {
            if (!hadSettings) this.markAllSettingsPending();
            this.local.source = 'mysql_fallback';
            this.writeJsonStore();
            return false;
        }

        try {
            if (hadSettings && this.hasPendingSync()) {
                await this.syncPending();
            }
            const [settings, subscriptions] = await Promise.all([
                this.mysqlListSettings(),
                this.mysqlListSubscriptions()
            ]);

            this.local.settings = {};
            this.local.subscriptions = {};
            this.local.pendingSettings = [];
            this.local.pendingSubscriptions = [];

            for (const row of settings) {
                const definition = this.definitionsByKey.get(String(row.notification_key));
                if (String(row.notification_key) === LEGACY_SATURDAY_NOTIFICATION_KEY) {
                    this.local.settings[LEGACY_SATURDAY_NOTIFICATION_KEY] = row;
                    continue;
                }
                if (!definition) continue;
                this.local.settings[definition.key] = this.normalizeSetting(row, definition);
            }

            for (const row of subscriptions) {
                if (
                    String(row.notification_key) !== LEGACY_SATURDAY_NOTIFICATION_KEY &&
                    !this.definitionsByKey.has(String(row.notification_key))
                ) continue;
                const subscription = this.normalizeSubscription(row);
                this.local.subscriptions[subscriptionId(subscription.notification_key, subscription.user_id)] = subscription;
            }

            this.migrateLegacySaturdayContests();
            this.ensureDefaultSettings({ markPending: true });
            await this.syncPending();
            this.local.source = 'mysql_fallback';
            this.writeJsonStore();
            return true;
        } catch (err) {
            this.noteMysqlFailure(err);
            if (!hadSettings) this.markAllSettingsPending();
            this.local.source = 'mysql_fallback';
            this.writeJsonStore();
            return false;
        }
    }

    async syncPending() {
        if (this.storageMode === 'json' || !this.canUseMysql()) return false;
        if (this.syncPromise) return this.syncPromise;

        this.syncPromise = (async () => {
            for (const notificationKey of [...this.local.pendingSettings]) {
                const setting = this.local.settings[notificationKey];
                if (!setting) continue;
                await this.mysqlSaveSetting(setting);
                this.clearPending('pendingSettings', notificationKey);
            }

            for (const id of [...this.local.pendingSubscriptions]) {
                const subscription = this.local.subscriptions[id];
                if (!subscription) continue;
                await this.mysqlSaveSubscription(subscription);
                this.clearPending('pendingSubscriptions', id);
            }

            this.writeJsonStore();
            return true;
        })().finally(() => {
            this.syncPromise = null;
        });

        return this.syncPromise;
    }

    startSyncLoop() {
        if (this.syncLoop) return;

        this.syncLoop = setInterval(() => {
            this.syncPending().catch(err => {
                this.noteMysqlFailure(err);
            });
        }, SYNC_INTERVAL_MS);
        this.syncLoop.unref?.();
    }

    getSetting(notificationKey) {
        const definition = this.definitionsByKey.get(String(notificationKey));
        if (!definition) return null;

        const setting = this.settingsCache.get(definition.key)
            || this.normalizeSetting(null, definition);
        return clone(setting);
    }

    listNotificationStates() {
        return this.definitions
            .map(definition => {
                const setting = this.getSetting(definition.key);
                return {
                    ...definition,
                    enabled: setting.enabled,
                    createdAt: setting.created_at,
                    updatedAt: setting.updated_at
                };
            })
            .sort((left, right) => {
                const dateDifference = new Date(right.createdAt) - new Date(left.createdAt);
                return dateDifference ||
                    (this.definitionOrder.get(left.key) - this.definitionOrder.get(right.key));
            });
    }

    async setGuildNotificationEnabled(notificationKey, enabled) {
        const definition = this.definitionsByKey.get(String(notificationKey));
        if (!definition) throw new Error('Unknown notification.');

        const current = this.getSetting(definition.key);
        const saved = this.normalizeSetting({
            ...current,
            enabled: enabled ? 1 : 0,
            updated_at: new Date().toISOString()
        }, definition);

        this.local.settings[definition.key] = saved;
        this.settingsCache.set(definition.key, clone(saved));
        if (this.storageMode !== 'json') {
            this.markPending('pendingSettings', definition.key);
        }
        this.writeJsonStore();

        try {
            await this.syncPending();
        } catch (err) {
            this.noteMysqlFailure(err);
        }

        return clone(saved);
    }

    getUserSubscriptionKeys(userId) {
        const id = String(userId);
        return this.definitions
            .filter(definition => this.subscriptionsCache.get(subscriptionId(definition.key, id))?.enabled)
            .map(definition => definition.key);
    }

    getEnabledUserIds(notificationKey) {
        const key = String(notificationKey);
        return [...this.subscriptionsCache.values()]
            .filter(subscription => subscription.notification_key === key && subscription.enabled)
            .map(subscription => subscription.user_id)
            .sort((left, right) => left.localeCompare(right));
    }

    async setUserSubscriptions(userId, enabledKeys) {
        const id = String(userId);
        const enabled = new Set((enabledKeys || []).map(String));
        const now = new Date().toISOString();

        for (const definition of this.definitions) {
            const idKey = subscriptionId(definition.key, id);
            const current = this.subscriptionsCache.get(idKey);
            const saved = this.normalizeSubscription({
                ...current,
                notification_key: definition.key,
                user_id: id,
                enabled: enabled.has(definition.key),
                created_at: current?.created_at || now,
                updated_at: now
            });

            this.local.subscriptions[idKey] = saved;
            this.subscriptionsCache.set(idKey, clone(saved));
            if (this.storageMode !== 'json') {
                this.markPending('pendingSubscriptions', idKey);
            }
        }

        this.writeJsonStore();

        try {
            await this.syncPending();
        } catch (err) {
            this.noteMysqlFailure(err);
        }

        return this.getUserSubscriptionKeys(id);
    }

    async mysqlListSettings() {
        const [rows] = await this.mysqlQuery(`
            SELECT guild_id, notification_key, enabled, created_at, updated_at
            FROM guild_notification_settings
            WHERE guild_id = ?
        `, [this.guildId]);
        return rows;
    }

    async mysqlListSubscriptions() {
        const [rows] = await this.mysqlQuery(`
            SELECT guild_id, notification_key, user_id, enabled, created_at, updated_at
            FROM user_notification_subscriptions
            WHERE guild_id = ?
        `, [this.guildId]);
        return rows;
    }

    async mysqlSaveSetting(setting) {
        await this.mysqlQuery(`
            INSERT INTO guild_notification_settings (
                guild_id, notification_key, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                updated_at = VALUES(updated_at)
        `, [
            setting.guild_id,
            setting.notification_key,
            setting.enabled ? 1 : 0,
            toMysqlDate(setting.created_at),
            toMysqlDate(setting.updated_at)
        ]);
    }

    async mysqlSaveSubscription(subscription) {
        await this.mysqlQuery(`
            INSERT INTO user_notification_subscriptions (
                guild_id, notification_key, user_id, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                updated_at = VALUES(updated_at)
        `, [
            subscription.guild_id,
            subscription.notification_key,
            subscription.user_id,
            subscription.enabled ? 1 : 0,
            toMysqlDate(subscription.created_at),
            toMysqlDate(subscription.updated_at)
        ]);
    }
}

module.exports = NotificationStore;
