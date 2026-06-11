// ========================================
// Detect Nickname change event and log it
// ========================================

const { AuditLogEvent } = require('discord.js');

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember, config) {
        if (oldMember.nickname === newMember.nickname) return;

        const logChannel = newMember.guild.channels.cache.get(config.logChannelID);
        if (!logChannel || !logChannel.isTextBased()) return;

        const oldNick = oldMember.displayName;
        const newNick = newMember.displayName;
        const userHandle = newMember.user.tag;

        let executor = newMember.user; // Default to the user changing it themselves
        let isModeratorAction = false;

        try {
            await new Promise(res => setTimeout(res, 1200));

            const fetchedLogs = await newMember.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberUpdate,
            });

            // Find the specific entry that targets this user AND changed the nickname
            const auditEntry = fetchedLogs.entries.find(
                entry => entry.target.id === newMember.id &&
                    entry.changes.some(c => c.key === 'nick') &&
                    Date.now() - entry.createdTimestamp < 8000
            );

            if (auditEntry) {
                if (auditEntry.executor.id !== newMember.id) {
                    // Moderator Action
                    executor = auditEntry.executor;
                    isModeratorAction = true;
                }
            }
        } catch (error) {
            console.error('[WW LOG] Error fetching audit logs for nickname change:', error);
        }

        const timestamp = `<t:${Math.floor(Date.now() / 1000)}:F>`;
        let executorTxt = isModeratorAction
            ? `### 📝 <@${executor.id}> changed the nickname of <@${newMember.id}> (${userHandle})\n`
            : `### 📝 <@${newMember.id}> (${userHandle}) changed their own nickname!\n`;

        await logChannel.send(
            `${executorTxt}` +
            `- Old nickname: **${oldNick}**\n` +
            `- New nickname: **${newNick}**\n` +
            `### Nickname changed: ${timestamp}`
        );
    }
};
