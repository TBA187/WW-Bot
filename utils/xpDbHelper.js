// ==========================
// Utility - XP Database Helper
// ==========================

function parseJsonArray(value) {
    if (!value) return [];

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('[XP DB HELPER] Error parsing JSON array:', err);
        return [];
    }
}

function parseJsonObject(value) {
    if (!value) return null;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
        console.error('[XP DB HELPER] Error parsing JSON object:', err);
        return null;
    }
}

function normalizeXpType(value) {
    if (value === null || value === undefined) return null;

    const xpType = String(value).trim();
    return xpType || null;
}

function getXpTypeFromTrackInfo(trackInfo) {
    if (!trackInfo) return null;

    return normalizeXpType(trackInfo.dbTrackName)
        || normalizeXpType(trackInfo.xpType)
        || normalizeXpType(trackInfo.id)
        || (trackInfo.type === 'global' ? 'global' : null);
}

function mapTrackRow(row) {
    return {
        id: row.id,
        name: row.name,
        roleIds: parseJsonArray(row.role_ids),
        channelIds: parseJsonArray(row.channel_ids),
        levelRewards: parseJsonArray(row.level_rewards),
        sendLevelUpMsg: row.send_level_up_msg === 1,
        tagUserLevelUpMsg: row.tag_user_level_up_msg === 1,
        cooldownOverrides: parseJsonObject(row.cooldown_overrides),
        color: row.color,
        createdAt: row.created_at
    };
}

const SPECIAL_TRACKS_CACHE_TTL_MS = Number(process.env.XP_TRACK_CACHE_TTL_MS || 60000);
const OUTAGE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const outageWarnings = new WeakMap();
let specialTracksRequest = null;
let specialTracksCache = {
    expiresAt: 0,
    tracks: null
};

function reportXpDatabaseError(db, error, { context, write = false, fallback = '', prefix = '[XP DB HELPER]' }) {
    const unavailable = error?.code === 'DATABASE_UNAVAILABLE' || error?.isCircuitOpen
        || db?.isDatabaseUnavailableError?.(error);
    if (!unavailable) {
        console.error(`${prefix} ${context}:`, error);
        return;
    }

    // The pool already reports the outage and recovery. Keep XP's fallback
    // notices brief, with separate notices for reads and unsaved writes.
    const outageStartedAt = db.health?.outageStartedAt ?? null;
    let state = outageWarnings.get(db);
    if (!state || state.outageStartedAt !== outageStartedAt) {
        state = { outageStartedAt, loggedAt: new Map() };
        outageWarnings.set(db, state);
    }
    const kind = write ? 'write' : 'read';
    const now = Date.now();
    const lastLog = state.loggedAt.get(kind);
    if (lastLog !== undefined && now - lastLog < OUTAGE_LOG_INTERVAL_MS) return;
    state.loggedAt.set(kind, now);
    const code = db.getErrorCode?.(error) || error.causeCode || error.code || 'UNKNOWN';
    const detail = write
        ? 'XP/activity updates could not be completed; failed operations are not queued for replay.'
        : fallback;
    console.warn(`${prefix} ${context}: MySQL unavailable (${code}).${detail ? ` ${detail}` : ''}`);
}

/**
 * Fetch all special XP tracks from the database.
 * @param {object} db - MySQL database connection pool
 * @returns {Promise<Array>} Array of track objects
 */
async function fetchSpecialTracks(db) {
    const now = Date.now();
    if (specialTracksCache.tracks && now < specialTracksCache.expiresAt) {
        return specialTracksCache.tracks;
    }

    // Message, reaction and command events can request the same refresh.
    if (specialTracksRequest) return specialTracksRequest;
    const request = loadSpecialTracks(db);
    specialTracksRequest = request;
    try {
        return await request;
    } finally {
        if (specialTracksRequest === request) specialTracksRequest = null;
    }
}

async function loadSpecialTracks(db) {
    try {
        const [rows] = await db.query(`
            SELECT id, name, role_ids, channel_ids, level_rewards,
                   send_level_up_msg, tag_user_level_up_msg,
                   cooldown_overrides, color, created_at
            FROM xp_channel_tracks
        `);

        const tracks = rows.map(mapTrackRow);
        specialTracksCache = {
            expiresAt: Date.now() + SPECIAL_TRACKS_CACHE_TTL_MS,
            tracks
        };

        return tracks;
    } catch (err) {
        reportXpDatabaseError(db, err, {
            context: 'Error fetching special tracks',
            fallback: specialTracksCache.tracks ? 'Using cached special XP tracks.' : 'No cached special XP tracks are available.'
        });
        if (specialTracksCache.tracks) {
            return specialTracksCache.tracks;
        }

        return [];
    }
}

/**
 * Fetch a specific track by ID from the database.
 * @param {object} db - MySQL database connection pool
 * @param {number} trackId - The track ID
 * @returns {Promise<Object|null>} Track object or null if not found
 */
async function fetchTrackById(db, trackId) {
    try {
        const [rows] = await db.query(`
            SELECT id, name, role_ids, channel_ids, level_rewards,
                   send_level_up_msg, tag_user_level_up_msg,
                   cooldown_overrides, color, created_at
            FROM xp_channel_tracks
            WHERE id = ?
        `, [trackId]);

        if (rows.length === 0) return null;
        return mapTrackRow(rows[0]);
    } catch (err) {
        reportXpDatabaseError(db, err, { context: `Error fetching track ${trackId}` });
        return null;
    }
}

/**
 * Resolve user-facing track input into the value stored in xp_user_levels.xp_type.
 * Blank/global input resolves to the global track; numeric input resolves by
 * track ID; non-numeric input resolves by exact track name for typed input.
 */
async function resolveXpTrack(db, trackInput) {
    const input = (trackInput || '').trim();

    if (!input || input.toLowerCase() === 'global') {
        return {
            xpType: 'global',
            displayName: 'Global',
            isGlobal: true,
            roleIds: [],
            channelIds: []
        };
    }

    const isNumericId = /^\d+$/.test(input);
    const tracks = await fetchSpecialTracks(db);
    const track = tracks.find(candidate => {
        if (isNumericId) return String(candidate.id) === input;
        return String(candidate.name || '').toLowerCase() === input.toLowerCase();
    });

    if (!track) {
        return null;
    }

    return {
        ...track,
        xpType: track.id.toString(),
        displayName: track.name,
        isGlobal: false
    };
}

function formatTrackChoiceName(row) {
    const suffix = ` (ID: ${row.id})`;
    const name = row.name || `Track ${row.id}`;
    const maxNameLength = Math.max(1, 100 - suffix.length);
    return `${name.slice(0, maxNameLength)}${suffix}`;
}

/**
 * Fetch autocomplete choices for XP track options. Choice values are numeric IDs
 * so selected slash-command values map directly to xp_user_levels.xp_type.
 */
async function fetchXpTrackAutocompleteChoices(db, focusedValue) {
    try {
        const [rows] = await db.query(
            `SELECT id, name FROM xp_channel_tracks WHERE name LIKE ? ORDER BY name LIMIT 25`,
            [`%${focusedValue || ''}%`]
        );

        return rows.map(row => ({
            name: formatTrackChoiceName(row),
            value: row.id.toString()
        }));
    } catch (err) {
        reportXpDatabaseError(db, err, { context: 'Autocomplete error' });
        return [];
    }
}

/**
 * Increment raw per-track activity counters. These counters represent eligible
 * XP-system activity before cooldown checks, while processXp tracks awarded XP.
 */
async function recordRawActivity(db, userId, guildId, username, xpType, actionType, statCount = 1) {
    const columnByAction = {
        message: 'total_messages_sent',
        reaction: 'total_reactions_added',
        command: 'total_commands_used',
        voice: 'total_voice_minutes'
    };

    const totalColumn = columnByAction[actionType];
    if (!totalColumn || statCount <= 0) return;

    const safeXpType = normalizeXpType(xpType);
    if (!safeXpType) {
        console.error(`[XP DB HELPER] Refusing to record raw ${actionType} activity without a valid xp_type.`);
        return;
    }

    try {
        const query = `
            INSERT INTO xp_user_levels (user_id, guild_id, username, xp_type, xp_date, ${totalColumn})
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            ON DUPLICATE KEY UPDATE
                username = VALUES(username),
                xp_date = COALESCE(xp_date, CURRENT_TIMESTAMP),
                ${totalColumn} = ${totalColumn} + ?
        `;

        await db.query(query, [userId, guildId, username, safeXpType, statCount, statCount]);
    } catch (err) {
        reportXpDatabaseError(db, err, { context: `Error recording raw ${actionType} activity`, write: true });
    }
}

/**
 * Fetch rewards by their IDs from the database.
 * @param {object} db - MySQL database connection pool
 * @param {Array<number>} rewardIds - Array of reward IDs
 * @returns {Promise<Array>} Array of reward objects
 */
async function fetchRewardsByIds(db, rewardIds) {
    if (!rewardIds || rewardIds.length === 0) return [];

    try {
        const placeholders = rewardIds.map(() => '?').join(',');
        const [rows] = await db.query(`
            SELECT id, level, description, role_id
            FROM xp_rewards
            WHERE id IN (${placeholders})
            ORDER BY level ASC
        `, rewardIds);

        return rows.map(row => ({
            id: row.id,
            level: row.level,
            description: row.description,
            roleId: row.role_id
        }));
    } catch (err) {
        reportXpDatabaseError(db, err, { context: 'Error fetching rewards by IDs' });
        return [];
    }
}

module.exports = {
    fetchSpecialTracks,
    fetchTrackById,
    fetchRewardsByIds,
    resolveXpTrack,
    getXpTypeFromTrackInfo,
    fetchXpTrackAutocompleteChoices,
    reportXpDatabaseError,
    recordRawActivity
};
