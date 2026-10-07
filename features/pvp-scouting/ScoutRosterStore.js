// Stores guild profiles, server preferences and the friendly-player list.
'use strict';
const { ensureScoutTables } = require('./ScoutSchema.js');


const { cleanIgn, normalizeIgn } = require('./PvpScoutParser.js');
const { abortable } = require('../../utils/abortable.js');

const FRIENDLY_LOOKUP_TTL_MS = 15_000;
const MAX_FRIENDLY_LOOKUPS = 200;

function profileFor(member) {
    const user = member?.user || member;
    const id = String(user?.id || member?.id || '');
    if (!id) throw new Error('A Discord user is required.');
    const username = String(user?.username || user?.globalName || 'Unknown user').slice(0, 128);
    const nick = member?.nickname ?? member?.nick;
    const nickname = nick ? String(nick).slice(0, 128) : null;
    return {
        discordId: id,
        username,
        globalName: user?.globalName || user?.global_name || null,
        nickname,
        nicknameNormalized: normalizeIgn(nickname)
    };
}

function profileChanged(row, profile) {
    return row.username !== profile.username
        || (row.server_nickname || null) !== profile.nickname
        || (row.server_nickname_normalized || null) !== (profile.nicknameNormalized || null)
        || (row.global_name || null) !== profile.globalName;
}

function ignAliases(value) {
    const values = String(value || '').split(/\s*(?:\/|\||•)\s*/u);
    return [...new Set(values.flatMap(part => [
        part,
        // Members often add a rank or title after their IGN, e.g. "Name (Lord)".
        part.replace(/\s*\([^)]*\)\s*$/u, '')
    ]).map(cleanIgn).filter(Boolean))];
}

class ScoutRosterStore {
    constructor(options = {}) {
        this.db = options.db;
        this.guildMemberRoleID = String(options.guildMemberRoleID || '');
        this.schemaReady = false;
        this.schemaPromise = null;
        this.seedPromises = new Map();
        this.memberNamesCache = null;
        this.friendlyIgnCache = new Map();
        this.friendlyIgnRequests = new Map();
        this.friendlyIgnRevision = 0;
        this.selectedServerCache = new Map();
        this.selectedServerRevisions = new Map();
        this.selectedServerRevision = 0;
        this.selectedServerHydratedGuilds = new Set();
        this.selectedServerHydration = new Map();
        this.selectedServerRequests = new Map();
    }

    async ensureSchema() {
        if (this.schemaReady) return;
        if (this.schemaPromise) return this.schemaPromise;
        if (!this.db?.query) throw new Error('The scout roster database is unavailable.');

        this.schemaPromise = (async () => {
            await ensureScoutTables(this.db, [
                'pvp_scout_friendly_list',
                'guild_members',
                'pvp_scout_member_seed'
            ]);
            this.schemaReady = true;
        })().catch(error => {
            this.schemaPromise = null;
            throw error;
        });
        return this.schemaPromise;
    }

    async hasSeededGuild(guildId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(
            'SELECT guild_id FROM pvp_scout_member_seed WHERE guild_id = ? LIMIT 1',
            [String(guildId)]
        );
        return rows.length > 0;
    }

    async seedCurrentGuildMembers(guild, roleId) {
        if (!guild?.id || !roleId) return { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded: false };
        const guildId = String(guild.id);
        if (this.seedPromises.has(guildId)) return this.seedPromises.get(guildId);
        const task = (async () => {
            await this.ensureSchema();
            const alreadySeeded = await this.hasSeededGuild(guildId);
            // Fetch the complete roster on every startup, including after the first seed.
            // A failed fetch must not turn stored members into former members.
            const members = await guild.members.fetch();
            const [rows] = await this.db.query(
                'SELECT discord_id, username, global_name, server_nickname, server_nickname_normalized, status FROM guild_members WHERE guild_id = ?',
                [guildId]
            );
            const [friends] = await this.db.query(
                'SELECT discord_id, username, server_nickname, server_nickname_normalized FROM pvp_scout_friendly_list WHERE guild_id = ? AND discord_id IS NOT NULL',
                [guildId]
            );
            const savedMembers = new Map(rows.map(row => [String(row.discord_id), row]));
            const savedFriends = new Map();
            for (const row of friends) {
                const id = String(row.discord_id);
                const profiles = savedFriends.get(id) || [];
                profiles.push(row);
                savedFriends.set(id, profiles);
            }
            const result = { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded };
            for (const member of members.values()) {
                const profile = profileFor(member);
                const row = savedMembers.get(profile.discordId);
                const current = member.roles.cache.has(String(roleId));
                const changedProfile = Boolean(row && profileChanged(row, profile))
                    || (savedFriends.get(profile.discordId) || []).some(friend => profileChanged(friend, profile));
                if (current && (!row || row.status !== 'current')) {
                    await this.saveMember(member, guildId, 'current');
                    if (row) result.restored++;
                    else result.added++;
                } else if (!current && row?.status === 'current') {
                    await this.saveMember(member, guildId, 'former');
                    result.former++;
                } else if (changedProfile) {
                    await this.updateMemberProfile(member, guildId);
                }
                if (changedProfile) result.updated++;
            }
            for (const row of rows) {
                if (row.status !== 'current' || members.has(String(row.discord_id))) continue;
                // Keep the last known profile and history for people who left the server.
                await this.saveMember({
                    user: { id: String(row.discord_id), username: row.username, globalName: row.global_name },
                    nickname: row.server_nickname
                }, guildId, 'former');
                result.former++;
            }
            if (!alreadySeeded) {
                await this.db.query(
                    'INSERT IGNORE INTO pvp_scout_member_seed (guild_id) VALUES (?)',
                    [guildId]
                );
            }
            return result;
        })().finally(() => this.seedPromises.delete(guildId));
        this.seedPromises.set(guildId, task);
        return task;
    }

    async saveMember(member, guildId, status = 'current') {
        await this.ensureSchema();
        const profile = profileFor(member);
        const state = status === 'former' ? 'former' : 'current';
        await this.db.query(`
            INSERT INTO guild_members
                (guild_id, discord_id, username, server_nickname, server_nickname_normalized,
                 status, role_added_at, former_at, global_name)
            VALUES (?, ?, ?, ?, ?, ?, IF(? = 'current', CURRENT_TIMESTAMP(3), NULL),
                    IF(? = 'former', CURRENT_TIMESTAMP(3), NULL), ?)
            ON DUPLICATE KEY UPDATE
                username = VALUES(username),
                global_name = VALUES(global_name),
                server_nickname = VALUES(server_nickname),
                server_nickname_normalized = VALUES(server_nickname_normalized),
                role_added_at = IF(VALUES(status) = 'current' AND status <> 'current', CURRENT_TIMESTAMP(3), role_added_at),
                former_at = IF(VALUES(status) = 'current', NULL, CURRENT_TIMESTAMP(3)),
                status = VALUES(status)
        `, [String(guildId), profile.discordId, profile.username, profile.nickname,
            profile.nicknameNormalized, state, state, state, profile.globalName]);
        await this.db.query(`
            UPDATE pvp_scout_friendly_list
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?
            WHERE guild_id = ? AND discord_id = ?
        `, [profile.username, profile.nickname, profile.nicknameNormalized, String(guildId), profile.discordId]);
        this.memberNamesCache = null;
        this.invalidateFriendlyIgnCache();
        return profile;
    }

    async handleMemberUpdate(oldMember, newMember, guildId, roleId) {
        const id = String(newMember?.guild?.id || newMember?.guildId || guildId || '');
        if (!id || id !== String(guildId)) return;
        const hadRole = Boolean(oldMember?.roles?.cache?.has(String(roleId)));
        const hasRole = Boolean(newMember?.roles?.cache?.has(String(roleId)));
        if (hasRole) await this.saveMember(newMember, id, 'current');
        else if (hadRole) await this.saveMember(newMember, id, 'former');
        else await this.updateMemberProfile(newMember, id);
    }

    async handleMemberAdd(member, guildId, roleId) {
        if (String(member?.guild?.id || member?.guildId || '') !== String(guildId)) return;
        if (member.roles?.cache?.has(String(roleId))) await this.saveMember(member, guildId, 'current');
        else await this.updateMemberProfile(member, guildId);
    }

    async handleMemberRemove(member, guildId) {
        await this.ensureSchema();
        const profile = profileFor(member);
        await this.db.query(`
            UPDATE guild_members
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?,
                former_at = IF(status = 'current', CURRENT_TIMESTAMP(3), former_at),
                status = IF(status = 'current', 'former', status)
            WHERE guild_id = ? AND discord_id = ?
        `, [profile.username, profile.nickname, profile.nicknameNormalized, String(guildId), profile.discordId]);
        await this.db.query(`
            UPDATE pvp_scout_friendly_list
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?
            WHERE guild_id = ? AND discord_id = ?
        `, [profile.username, profile.nickname, profile.nicknameNormalized, String(guildId), profile.discordId]);
        this.memberNamesCache = null;
        this.invalidateFriendlyIgnCache();
    }

    async updateMemberProfile(member, guildId) {
        await this.ensureSchema();
        const profile = profileFor(member);
        await this.db.query(`
            UPDATE guild_members
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?, global_name = ?
            WHERE guild_id = ? AND discord_id = ?
        `, [profile.username, profile.nickname, profile.nicknameNormalized, profile.globalName, String(guildId), profile.discordId]);
        await this.db.query(`
            UPDATE pvp_scout_friendly_list
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?
            WHERE guild_id = ? AND discord_id = ?
        `, [profile.username, profile.nickname, profile.nicknameNormalized, String(guildId), profile.discordId]);
        this.memberNamesCache = null;
        this.invalidateFriendlyIgnCache();
    }

    async saveFriendly(guildId, ign, member = null) {
        await this.ensureSchema();
        const name = cleanIgn(ign);
        const key = normalizeIgn(name);
        if (!name || !key) throw new Error('Enter a valid in-game name (2–32 letters, numbers, dots, dashes, or underscores).');
        const profile = member ? profileFor(member) : null;
        await this.db.query(`
            INSERT INTO pvp_scout_friendly_list
                (guild_id, ign, ign_normalized, discord_id, username, server_nickname, server_nickname_normalized)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                ign = VALUES(ign),
                discord_id = COALESCE(VALUES(discord_id), discord_id),
                username = COALESCE(VALUES(username), username),
                server_nickname = COALESCE(VALUES(server_nickname), server_nickname),
                server_nickname_normalized = COALESCE(VALUES(server_nickname_normalized), server_nickname_normalized)
        `, [String(guildId), name, key, profile?.discordId || null, profile?.username || null,
            profile?.nickname || null, profile?.nicknameNormalized || null]);
        this.invalidateFriendlyIgnCache();
        const [rows] = await this.db.query(
            'SELECT * FROM pvp_scout_friendly_list WHERE guild_id = ? AND ign_normalized = ? LIMIT 1',
            [String(guildId), key]
        );
        return rows[0] || null;
    }

    async editFriendly(guildId, entryId, ign) {
        await this.ensureSchema();
        const name = cleanIgn(ign);
        const key = normalizeIgn(name);
        if (!name || !key) throw new Error('Enter a valid in-game name (2–32 letters, numbers, dots, dashes, or underscores).');
        await this.db.query(`
            UPDATE pvp_scout_friendly_list SET ign = ?, ign_normalized = ?
            WHERE guild_id = ? AND entry_id = ?
        `, [name, key, String(guildId), String(entryId)]);
        this.invalidateFriendlyIgnCache();
    }

    async listFriendly(guildId, limit = 25, offset = 0) {
        await this.ensureSchema();
        const [[rows], [countRows]] = await Promise.all([
            this.db.query(`SELECT * FROM pvp_scout_friendly_list WHERE guild_id = ?
                ORDER BY ign_normalized LIMIT ? OFFSET ?`, [String(guildId), limit, offset]),
            this.db.query('SELECT COUNT(*) AS total FROM pvp_scout_friendly_list WHERE guild_id = ?', [String(guildId)])
        ]);
        return { rows, total: Number(countRows[0]?.total || 0) };
    }

    async removeFriendly(guildId, entryId) {
        await this.ensureSchema();
        await this.db.query(
            'DELETE FROM pvp_scout_friendly_list WHERE guild_id = ? AND entry_id = ?',
            [String(guildId), String(entryId)]
        );
        this.invalidateFriendlyIgnCache();
    }

    invalidateFriendlyIgnCache() {
        this.friendlyIgnRevision++;
        this.friendlyIgnCache.clear();
        this.friendlyIgnRequests.clear();
    }

    async friendlyRowForIgn(guildId, ignNormalized) {
        await this.ensureSchema();
        const cacheKey = `${String(guildId)}:${String(ignNormalized)}`;
        const cached = this.friendlyIgnCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.row;
        this.friendlyIgnCache.delete(cacheKey);
        if (this.friendlyIgnRequests.has(cacheKey)) return this.friendlyIgnRequests.get(cacheKey);
        const revision = this.friendlyIgnRevision;
        const request = this.db.query(`
            SELECT * FROM pvp_scout_friendly_list
            WHERE guild_id = ? AND ign_normalized = ? LIMIT 1
        `, [String(guildId), ignNormalized]).then(([rows]) => {
            if (revision !== this.friendlyIgnRevision) return this.friendlyRowForIgn(guildId, ignNormalized);
            const row = rows[0] || null;
            this.friendlyIgnCache.set(cacheKey, { row, expiresAt: Date.now() + FRIENDLY_LOOKUP_TTL_MS });
            while (this.friendlyIgnCache.size > MAX_FRIENDLY_LOOKUPS) this.friendlyIgnCache.delete(this.friendlyIgnCache.keys().next().value);
            return row;
        }).finally(() => {
            if (this.friendlyIgnRequests.get(cacheKey) === request) this.friendlyIgnRequests.delete(cacheKey);
        });
        this.friendlyIgnRequests.set(cacheKey, request);
        return request;
    }

    async listMembers(guildId, status, limit = 25, offset = 0) {
        await this.ensureSchema();
        const state = status === 'former' ? 'former' : 'current';
        const [[rows], [countRows]] = await Promise.all([
            this.db.query(`SELECT * FROM guild_members WHERE guild_id = ? AND status = ?
                ORDER BY COALESCE(server_nickname, username), discord_id LIMIT ? OFFSET ?`,
            [String(guildId), state, limit, offset]),
            this.db.query('SELECT COUNT(*) AS total FROM guild_members WHERE guild_id = ? AND status = ?',
                [String(guildId), state])
        ]);
        return { rows, total: Number(countRows[0]?.total || 0) };
    }

    async getMember(guildId, discordId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(
            'SELECT * FROM guild_members WHERE guild_id = ? AND discord_id = ? LIMIT 1',
            [String(guildId), String(discordId)]
        );
        return rows[0] || null;
    }

    async getSelectedServer(guildId, discordId, { fresh = false } = {}) {
        const key = `${String(guildId)}:${String(discordId)}`;
        if (!fresh && this.selectedServerRequests.has(key)) return this.selectedServerRequests.get(key);
        if (fresh) this.selectedServerRevisions.set(key, ++this.selectedServerRevision);
        const revision = this.selectedServerRevisions.get(key) || 0;
        const request = this.getMember(guildId, discordId).then(row => {
            const selected = row?.selected_server || null;
            // A read started before a selection was saved must not replace it in the cache.
            if ((this.selectedServerRevisions.get(key) || 0) === revision) this.selectedServerCache.set(key, selected);
            return this.selectedServerCache.get(key) ?? null;
        }).finally(() => {
            if (this.selectedServerRequests.get(key) === request) this.selectedServerRequests.delete(key);
        });
        this.selectedServerRequests.set(key, request);
        return request;
    }

    getCachedSelectedServer(guildId, discordId) {
        const key = `${String(guildId)}:${String(discordId)}`;
        if (this.selectedServerCache.has(key)) return this.selectedServerCache.get(key);
        return this.selectedServerHydratedGuilds.has(String(guildId)) ? null : undefined;
    }

    rememberSelectedServer(guildId, discordId, server) {
        const key = `${String(guildId)}:${String(discordId)}`;
        this.selectedServerCache.set(key, server);
        this.selectedServerRevisions.set(key, ++this.selectedServerRevision);
    }

    async hydrateSelectedServers(guildId) {
        const guild = String(guildId);
        if (this.selectedServerHydration.has(guild)) return this.selectedServerHydration.get(guild);
        const revision = this.selectedServerRevision;
        const task = (async () => {
            await this.ensureSchema();
            const [rows] = await this.db.query(
                'SELECT discord_id, selected_server FROM guild_members WHERE guild_id = ?', [guild]);
            for (const row of rows) {
                const key = `${guild}:${String(row.discord_id)}`;
                if ((this.selectedServerRevisions.get(key) || 0) <= revision) {
                    this.selectedServerCache.set(key, row.selected_server || null);
                }
            }
            this.selectedServerHydratedGuilds.add(guild);
            return rows.length;
        })().finally(() => this.selectedServerHydration.delete(guild));
        this.selectedServerHydration.set(guild, task);
        return task;
    }

    async setSelectedServer(guildId, member, server, { toggle = false, beforeCommit } = {}) {
        if (server !== null && !['gold', 'silver', 'cross'].includes(server)) throw new Error('Select Gold, Silver, or Cross Server.');
        await this.ensureSchema();
        const profile = profileFor(member);
        const current = Boolean(member.roles?.cache?.has(this.guildMemberRoleID)
            || (Array.isArray(member.roles) && member.roles.includes(this.guildMemberRoleID)));
        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            // The upsert locks this profile before reading its preference. Repeated
            // clicks and separate panels cannot overwrite a selection mid-save.
            await connection.query(`INSERT INTO guild_members
                (guild_id, discord_id, username, global_name, server_nickname, server_nickname_normalized, status, role_added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, IF(? = 'current', CURRENT_TIMESTAMP(3), NULL))
                ON DUPLICATE KEY UPDATE username = VALUES(username), global_name = VALUES(global_name),
                    server_nickname = VALUES(server_nickname), server_nickname_normalized = VALUES(server_nickname_normalized),
                    role_added_at = IF(VALUES(status) = 'current' AND status <> 'current', CURRENT_TIMESTAMP(3), role_added_at),
                    former_at = IF(VALUES(status) = 'current', NULL, former_at),
                    status = IF(VALUES(status) = 'current', 'current', status)`,
            [String(guildId), profile.discordId, profile.username, profile.globalName, profile.nickname,
                profile.nicknameNormalized, current ? 'current' : 'other', current ? 'current' : 'other']);
            const [rows] = await connection.query(`SELECT selected_server FROM guild_members
                WHERE guild_id = ? AND discord_id = ? FOR UPDATE`, [String(guildId), profile.discordId]);
            const previous = rows[0]?.selected_server || null;
            const selected = toggle && previous === server ? null : server;
            await connection.query(`UPDATE guild_members SET selected_server = ?
                WHERE guild_id = ? AND discord_id = ?`, [selected, String(guildId), profile.discordId]);
            // Role changes use this same row lock, so another selection cannot
            // commit while Discord is still applying the current one.
            if (beforeCommit) await beforeCommit({ previous, selected });
            await connection.commit();
            this.memberNamesCache = null;
            this.rememberSelectedServer(guildId, profile.discordId, selected);
            return { previous, selected };
        } catch (error) {
            await connection.rollback().catch(() => {});
            this.selectedServerCache.delete(`${String(guildId)}:${profile.discordId}`);
            this.selectedServerHydratedGuilds.delete(String(guildId));
            throw error;
        } finally {
            connection.release();
        }
    }

    async editMember(guildId, discordId, username, nickname) {
        await this.ensureSchema();
        const cleanUsername = String(username || '').trim().slice(0, 128);
        if (!cleanUsername) throw new Error('Discord username cannot be empty.');
        const cleanNickname = String(nickname || '').trim().slice(0, 128) || null;
        await this.db.query(`
            UPDATE guild_members
            SET username = ?, server_nickname = ?, server_nickname_normalized = ?
            WHERE guild_id = ? AND discord_id = ?
        `, [cleanUsername, cleanNickname, normalizeIgn(cleanNickname), String(guildId), String(discordId)]);
        this.memberNamesCache = null;
    }

    async removeMember(guildId, discordId) {
        await this.ensureSchema();
        await this.db.query(
            'DELETE FROM guild_members WHERE guild_id = ? AND discord_id = ?',
            [String(guildId), String(discordId)]
        );
        this.memberNamesCache = null;
        this.rememberSelectedServer(guildId, discordId, null);
    }

    async memberRowsForGuild(guildId) {
        await this.ensureSchema();
        const cacheKey = String(guildId || '');
        let members = this.memberNamesCache?.guildId === cacheKey
            && this.memberNamesCache.expiresAt > Date.now() ? this.memberNamesCache.rows : null;
        if (!members) {
            const [rows] = await this.db.query(`
                SELECT discord_id, username, global_name, server_nickname, status
                FROM guild_members WHERE guild_id = ? AND status IN ('current', 'former')
            `, [cacheKey]);
            members = rows;
            this.memberNamesCache = { guildId: cacheKey, rows, expiresAt: Date.now() + 60_000 };
        }
        return members;
    }

    async ocrMemberContext(guildId, authorId) {
        const members = await this.memberRowsForGuild(guildId);
        const memberNames = new Set();
        const authorNames = new Set();
        for (const member of members) {
            if (member.status === 'other') continue;
            // Match the warning's identity priority. Account names are fallback
            // evidence only when the member has no server nickname or global name.
            const names = ignAliases(member.server_nickname || member.global_name || member.username);
            for (const name of names) memberNames.add(normalizeIgn(name));
            if (String(member.discord_id) === String(authorId || '')) {
                for (const name of names) authorNames.add(normalizeIgn(name));
            }
        }
        return { memberNames: [...memberNames], authorNames: [...authorNames] };
    }

    async noticeForIgn(guildId, ign, guild = null) {
        const key = normalizeIgn(ign);
        if (!key) return null;
        const identityName = member => member?.nickname || member?.nick || member?.user?.globalName
            || member?.user?.global_name || member?.user?.username;
        const exactIdentity = member => Boolean(identityName(member))
            && String(identityName(member)).trim().toLocaleLowerCase('en-US') === String(ign).trim().toLocaleLowerCase('en-US');
        const liveMembers = [...(guild?.members?.cache?.values?.() || [])];
        const exactMatches = liveMembers.filter(exactIdentity);
        const current = liveMembers.filter(member => (member.roles?.cache?.has(this.guildMemberRoleID)
            || (Array.isArray(member.roles) && member.roles.includes(this.guildMemberRoleID)))
            && ignAliases(identityName(member)).some(name => normalizeIgn(name) === key));
        if (current.length) {
            const member = current[0];
            return { type: 'member', status: 'current', mention: current.length === 1
                && exactMatches.length === 1 && exactIdentity(member) ? `<@${member.id || member.user.id}>` : null };
        }
        await this.ensureSchema();
        // Reuse only the stored friendly row; evaluate live identities for each notice.
        const [members, friend] = await Promise.all([this.memberRowsForGuild(guildId), this.friendlyRowForIgn(guildId, key)]);
        const matchingMembers = members.filter(item => {
            if (item.status === 'other') return false;
            const live = guild?.members?.cache?.get(String(item.discord_id));
            return [identityName(live), item.server_nickname || item.global_name || item.username]
                .some(value => ignAliases(value).some(name => normalizeIgn(name) === key));
        })
            .sort((a, b) => Number(b.status === 'current') - Number(a.status === 'current'))
            .slice(0, 2);
        const member = matchingMembers[0] || null;
        const presentMember = async id => {
            const cached = guild?.members?.cache?.get(String(id));
            if (cached && exactIdentity(cached)) return cached;
            if (!guild?.members?.fetch || !id) return null;
            // Force a targeted refresh when an old stored/cache nickname does
            // not match; Discord displayName can be a global name, not a nick.
            return abortable(Promise.resolve().then(() => guild.members.fetch({ user: String(id), force: true })), {
                timeoutMs: 750, timeoutCode: 'SCOUT_MEMBER_LOOKUP_TIMEOUT'
            }).catch(() => null);
        };
        if (member) {
            const present = await presentMember(member.discord_id);
            const mention = matchingMembers.length === 1 && present && exactMatches.length <= 1 && exactIdentity(present)
                ? `<@${member.discord_id}>` : null;
            return { type: 'member', mention, status: member.status };
        }
        if (friend) {
            const present = friend.discord_id ? await presentMember(friend.discord_id)
                : exactMatches.length === 1 ? exactMatches[0] : null;
            const mention = present && exactMatches.length <= 1 && exactIdentity(present) ? `<@${present.id || present.user.id}>` : null;
            return { type: 'friend', mention };
        }
        return null;
    }
}

module.exports = { ScoutRosterStore };
