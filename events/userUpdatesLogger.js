// ========================================
// --------- Detect User Updates ---------
// Server/Global Avatar & Nickname updates
// ========================================

const { AttachmentBuilder, AuditLogEvent, EmbedBuilder } = require('discord.js');

function getLogChannel(config, guild = null) {
    const targetGuild = guild || config.client?.guilds.cache.get(config.guildId);
    return targetGuild?.channels.cache.get(config.logChannelID);
}

function normalizeNickname(value) {
    return value || null;
}

function formatNickname(value) {
    return value || '*No server nickname*';
}

function auditChangeValue(change, key) {
    return change?.[key] ?? change?.[`${key}_value`] ?? null;
}

function createLogoFile() {
    return new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
}

async function sendAvatarLog(logChannel, user, avatarUrl, title) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const logoFile = createLogoFile();
    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${user.displayName || user.username} (${user.username})`,
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
            console.warn(`[WW LOG] Skipped nickname log for ${newMember.user.tag ?? newMember.id}: no recent nickname audit log found.`);
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

    const logoFile = createLogoFile();
    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${newMember.user.displayName || newMember.user.username} (${newMember.user.username})`,
            iconURL: newMember.user.displayAvatarURL({ dynamic: true })
        })
        .setTitle('Nickname Update')
        .setColor(0xf1c40f)
        .setDescription(
            isModeratorAction
                ? `📝 <@${executor.id}> changed the nickname of <@${newMember.id}>.`
                : `📝 <@${newMember.id}> changed their own nickname.`
        )
        .addFields(
            { name: 'Old nickname', value: formatNickname(auditedOldNickname ?? oldNickname), inline: true },
            { name: 'New nickname', value: formatNickname(auditedNewNickname ?? newNickname), inline: true }
        )
        .setFooter({ text: `ID: ${newMember.id}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [logoFile] });
}

module.exports = {
    async handleUserUpdate(oldUser, newUser, config) {
        if (oldUser.avatar === newUser.avatar) return;

        const logChannel = getLogChannel(config);
        const avatarUrl = newUser.displayAvatarURL({ dynamic: true, size: 256 });
        await sendAvatarLog(logChannel, newUser, avatarUrl, 'Global Avatar Update');
    },

    async handleGuildMemberUpdate(oldMember, newMember, config) {
        const logChannel = getLogChannel(config, newMember.guild);

        if (oldMember.avatar !== newMember.avatar) {
            const avatarUrl = newMember.displayAvatarURL({ dynamic: true, size: 256 });
            await sendAvatarLog(logChannel, newMember.user, avatarUrl, 'Server Avatar Update');
        }

        await sendNicknameLog(logChannel, oldMember, newMember);
    }
};
