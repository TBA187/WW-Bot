// ========================================
// --------- Detect User Updates ---------
// Server/Global Avatar, Username & Nickname updates
// ========================================

const { AttachmentBuilder, AuditLogEvent, EmbedBuilder } = require('discord.js');
const { syncMemberColorRoleName } = require('./auto_roles.js');

const RECENT_NAME_LOG_TTL_MS = 30 * 1000;
const recentNameLogs = new Map();
const knownUserProfiles = new Map();

function getLogChannel(config, guild = null) {
    const targetGuild = guild || config.client?.guilds.cache.get(config.guildId);
    return targetGuild?.channels.cache.get(config.logChannelID);
}

function normalizeNickname(value) {
    return value || null;
}

function userProfile(user) {
    return {
        id: user.id,
        username: user.username ?? null,
        globalName: user.globalName ?? null
    };
}

function rememberUserProfile(user) {
    if (!user?.id) return;
    knownUserProfiles.set(user.id, userProfile(user));
}

function formatNickname(value) {
    return value || '*No server nickname*';
}

function formatDiscordDisplayName(value, user) {
    return value || '-# *No Discord Display Name!*';
}

function boldValue(value) {
    return `**${value}**`;
}

function getChangeAction(oldValue, newValue) {
    if (!oldValue && newValue) return 'Added';
    if (oldValue && !newValue) return 'Removed';
    return 'Changed';
}

function actionEmoji(action) {
    if (action === 'Added') return '✅';
    if (action === 'Removed') return '❌';
    return '📝';
}

function actionVerb(action) {
    if (action === 'Added') return 'added';
    if (action === 'Removed') return 'removed';
    return 'changed';
}

function changeTitle(label, oldValue, newValue, forcedAction = null) {
    const action = forcedAction || getChangeAction(oldValue, newValue);
    return `${actionEmoji(action)}\u2002${label} ${action}`;
}

function nameChangeDescription(user, label, oldValue, newValue, forcedAction = null) {
    const action = forcedAction || getChangeAction(oldValue, newValue);
    const article = action === 'Added' ? 'a' : 'their';
    return `<@${user.id}> ${actionVerb(action)} ${article} **${label}**`;
}

function serverNicknameDescription(executor, member, isModeratorAction, oldValue, newValue) {
    const action = getChangeAction(oldValue, newValue);
    const article = action === 'Added' ? 'a' : 'their';

    if (isModeratorAction) {
        return `<@${executor.id}> ${actionVerb(action)} ${article} **Server Nickname** for <@${member.id}>`;
    }

    return `<@${member.id}> ${actionVerb(action)} ${article} **Server Nickname**`;
}

function serverNicknameFallbackText(user) {
    return '-# *No server nickname!*';
}

function newServerNicknameFallbackText(user) {
    if (user.globalName) {
        return `-# *No server nickname!*\n-# Using Discord Display Name: **${user.globalName}**`;
    }

    return `-# *No server nickname!*\n-# Using Discord Username: **@${user.username}**`;
}

function auditChangeValue(change, key) {
    return change?.[key] ?? change?.[`${key}_value`] ?? null;
}

function createLogoFile() {
    return new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
}

function authorName(user) {
    const displayName = user.displayName || user.username;
    return displayName === user.username ? user.username : `${displayName} (${user.username})`;
}

function shouldSkipRecentNameLog(userId, label, oldValue, newValue, action) {
    const now = Date.now();
    const key = `${userId}:${label}:${oldValue ?? ''}:${newValue ?? ''}:${action ?? ''}`;
    const lastLoggedAt = recentNameLogs.get(key);

    for (const [entryKey, loggedAt] of recentNameLogs) {
        if (now - loggedAt > RECENT_NAME_LOG_TTL_MS) {
            recentNameLogs.delete(entryKey);
        }
    }

    if (lastLoggedAt && now - lastLoggedAt < RECENT_NAME_LOG_TTL_MS) {
        return true;
    }

    recentNameLogs.set(key, now);
    return false;
}

async function sendAvatarLog(logChannel, user, avatarUrl, title) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const logoFile = createLogoFile();
    const embed = new EmbedBuilder()
        .setAuthor({
            name: authorName(user),
            iconURL: avatarUrl
        })
        .setTitle(title)
        .setColor(0x5865f2)
        .setDescription(`<@${user.id}> changed their avatar!`)
        .setThumbnail(avatarUrl)
        .setFooter({ text: `ID: ${user.id}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [logoFile] });
}

async function sendNameChangeLog(logChannel, options) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const {
        user,
        label,
        description,
        oldLabel,
        newLabel,
        oldValue,
        newValue,
        oldDisplayValue,
        newDisplayValue,
        action,
        color
    } = options;

    if (shouldSkipRecentNameLog(user.id, label, oldValue, newValue, action)) return;

    const logoFile = createLogoFile();
    const embed = new EmbedBuilder()
        .setAuthor({
            name: authorName(user),
            iconURL: user.displayAvatarURL({ dynamic: true })
        })
        .setTitle(changeTitle(label, oldValue, newValue, action))
        .setColor(color)
        .setDescription(description)
        .addFields(
            { name: oldLabel, value: oldDisplayValue, inline: true },
            { name: newLabel, value: newDisplayValue, inline: true }
        )
        .setFooter({ text: `ID: ${user.id}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [logoFile] });
}

async function sendDiscordUsernameLog(logChannel, oldProfile, newUser) {
    if (oldProfile.username === newUser.username) return;

    await sendNameChangeLog(logChannel, {
        user: newUser,
        label: 'Discord Username',
        description: nameChangeDescription(newUser, 'Discord Username', oldProfile.username, newUser.username, 'Changed'),
        oldLabel: 'Old Discord Username',
        newLabel: 'New Discord Username',
        oldValue: oldProfile.username,
        newValue: newUser.username,
        oldDisplayValue: oldProfile.username,
        newDisplayValue: boldValue(newUser.username),
        action: 'Changed',
        color: 0x3498db
    });
}

async function sendDiscordDisplayNameLog(logChannel, oldProfile, newUser) {
    if (oldProfile.globalName === newUser.globalName) return;

    await sendNameChangeLog(logChannel, {
        user: newUser,
        label: 'Discord Display Name',
        description: nameChangeDescription(newUser, 'Discord Display Name', oldProfile.globalName, newUser.globalName),
        oldLabel: 'Old Discord Display Name',
        newLabel: 'New Discord Display Name',
        oldValue: oldProfile.globalName,
        newValue: newUser.globalName,
        oldDisplayValue: formatDiscordDisplayName(oldProfile.globalName, oldProfile),
        newDisplayValue: newUser.globalName ? boldValue(newUser.globalName) : formatDiscordDisplayName(newUser.globalName, newUser),
        color: 0x9b59b6
    });
}

async function sendDiscordAccountNameLogs(logChannel, oldUser, newUser) {
    const oldProfile = knownUserProfiles.get(newUser.id) ?? userProfile(oldUser);

    await sendDiscordUsernameLog(logChannel, oldProfile, newUser);
    await sendDiscordDisplayNameLog(logChannel, oldProfile, newUser);
    rememberUserProfile(newUser);
}

async function sendNicknameLog(logChannel, oldMember, newMember) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const oldNickname = normalizeNickname(oldMember.nickname);
    const newNickname = normalizeNickname(newMember.nickname);
    if (oldNickname === newNickname) return;

    let executor = newMember.user;
    let isModeratorAction = false;
    let nicknameAuditChange = null;

    try {
        await new Promise(res => setTimeout(res, 1200));

        const fetchedLogs = await newMember.guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.MemberUpdate,
        });

        const auditEntry = fetchedLogs.entries.find(
            entry => entry.target?.id === newMember.id &&
                entry.changes?.some(c => c.key === 'nick') &&
                Date.now() - entry.createdTimestamp < 8000
        );

        nicknameAuditChange = auditEntry?.changes?.find(c => c.key === 'nick') ?? null;
        if (nicknameAuditChange === null) {
            return;
        }

        if (auditEntry && auditEntry.executor?.id !== newMember.id) {
            executor = auditEntry.executor;
            isModeratorAction = true;
        }
    } catch (error) {
        console.error('[WW LOG] Error fetching audit logs for nickname change:', error);
        return;
    }

    const auditedOldNickname = normalizeNickname(auditChangeValue(nicknameAuditChange, 'old'));
    const auditedNewNickname = normalizeNickname(auditChangeValue(nicknameAuditChange, 'new'));
    const displayOldNickname = auditedOldNickname ?? oldNickname;
    const displayNewNickname = auditedNewNickname ?? newNickname;
    const formattedNewNickname = displayNewNickname
        ? formatNickname(displayNewNickname)
        : newServerNicknameFallbackText(newMember.user);

    await sendNameChangeLog(logChannel, {
        user: newMember.user,
        label: 'Server Nickname',
        description: serverNicknameDescription(executor, newMember, isModeratorAction, displayOldNickname, displayNewNickname),
        oldLabel: 'Old Server Nickname',
        newLabel: 'New Server Nickname',
        oldValue: displayOldNickname,
        newValue: displayNewNickname,
        oldDisplayValue: displayOldNickname ? formatNickname(displayOldNickname) : serverNicknameFallbackText(oldMember.user),
        newDisplayValue: displayNewNickname ? boldValue(formattedNewNickname) : formattedNewNickname,
        color: 0xf1c40f
    });

    // Color Role Name Sync: If the user has a custom Color Role, change the Color Role Name to their new server nickname.
    await syncMemberColorRoleName(newMember).catch(error => {
        console.warn(`[WW LOG] Could not sync custom color role name for ${newMember.user.tag ?? newMember.id}:`, error);
    });
}

module.exports = {
    primeUserProfileCache(config) {
        const client = config.client;
        if (!client) return;

        for (const user of client.users.cache.values()) {
            rememberUserProfile(user);
        }

        // This uses only members Discord already cached; no full member fetch here.
        for (const guild of client.guilds.cache.values()) {
            for (const member of guild.members.cache.values()) {
                rememberUserProfile(member.user);
            }
        }
    },

    async handleUserUpdate(oldUser, newUser, config) {
        const logChannel = getLogChannel(config);

        await sendDiscordAccountNameLogs(logChannel, oldUser, newUser);

        if (oldUser.avatar === newUser.avatar) return;

        const avatarUrl = newUser.displayAvatarURL({ dynamic: true, size: 256 });
        await sendAvatarLog(logChannel, newUser, avatarUrl, 'Discord Avatar Update');
    },

    async handleGuildMemberUpdate(oldMember, newMember, config) {
        const logChannel = getLogChannel(config, newMember.guild);

        // Discord account-name changes can arrive here before userUpdate is useful from cache.
        await sendDiscordAccountNameLogs(logChannel, oldMember.user, newMember.user);

        if (oldMember.avatar !== newMember.avatar) {
            const avatarUrl = newMember.displayAvatarURL({ dynamic: true, size: 256 });
            await sendAvatarLog(logChannel, newMember.user, avatarUrl, 'Server Avatar Update');
        }

        await sendNicknameLog(logChannel, oldMember, newMember);
    }
};
