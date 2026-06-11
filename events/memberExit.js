// =====================================================
// LOG "Leave, Kick, Ban/Unban, Mute/Unmute" EVENTS
// =====================================================
const { AuditLogEvent } = require('discord.js');

// activeTimeouts tracks countdowns so the bot knows when Timeouts naturally expire
const activeTimeouts = new Map(); // !NOTE! - Add timestamps to DB instead, to avoid losing track of timeout timestamps if bot restarsts!

// Short-term memory: (Key: UserID, Value: Nickname)
const nicknameCache = new Map();

module.exports = {
    // --------------------------
    // Handle leaves, kick, bans
    // --------------------------
    async handleMemberRemove(member, logChannelID) {
        try {
            const channel = member.guild.channels.cache.get(logChannelID);
            if (!channel || !channel.isTextBased()) return;

            const userId = member.id;
            const userNickame = member.displayName ?? '*Nickname not found!*';

            // Store Nickname immediately to pass to handleGuildBanAdd()
            nicknameCache.set(userId, userNickame);
            setTimeout(() => nicknameCache.delete(userId), 10000); // Delete after 10 seconds to not leak memory.

            // Add 1.2 second buffer to let Discord's Audit Log catch up
            await new Promise(res => setTimeout(res, 1200));

            // ------- Silent Ban Check -------
            const banLogs = await member.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberBanAdd });
            const isBanned = banLogs.entries.find(e => e.target.id === userId && Date.now() - e.createdTimestamp < 5000);

            if (isBanned) return;
            // ------- If it's a ban, STOP HERE! handleGuildBanAdd() handles the rest! -------
            // -------------------------------------------------------------------------------

            const username = member.user?.tag ?? '*Unknown User!*'; // Discord @handle
            const globalName = member.user?.globalName ?? '*No Global Name!*'; // Discord Global Display Name
            const displayName = member.displayName ?? '*Nickname not found!*'; // WW Server Nickname
            const total = member.guild.memberCount;

            // ------- Check Kick -------
            const kickLogs = await member.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberKick,
            });

            const kickEntry = kickLogs.entries.find(
                entry => entry.target.id === member.id &&
                    Date.now() - entry.createdTimestamp < 5000
            );

            if (kickEntry) {
                const { executor, reason } = kickEntry;
                return channel.send(
                    `### ⚠️  <@${member.id}> was kicked by <@${executor.id}>!\n` +
                    `- **Reason:** ${reason ?? '*No reason provided!*'}\n` +
                    `- **User Information:**\n` +
                    `  - Discord Username (@handle): **${username}**\n` +
                    `  - Discord Global Display Name: **${globalName}**\n` +
                    `  - WW Server Nickname: **${displayName}**\n` +
                    `  - Discord User ID: **${member.id}**\n` +
                    `- Discord Members: **${total}**`
                );
            }

            // ------- Voluntary Leave -------
            await channel.send(
                `### ❌  <@${member.id}> voluntarily left the server! 👋\n` +
                `- **User Information:**\n` +
                `  - Discord Username (@handle): **${username}**\n` +
                `  - Discord Global Display Name: **${globalName}**\n` +
                `  - WW Server Nickname: **${displayName}**\n` +
                `  - Discord User ID: **${member.id}**\n` +
                `- Discord Members: **${total}**`
            );
        } catch (err) {
            console.error('Leave/kick/ban message failed:', err);
        }
    },

    // --------------------------------
    // Handle Bans (Manual & Bot bans)
    // --------------------------------
    async handleGuildBanAdd(ban, logChannelID) {
        try {
            const channel = ban.guild.channels.cache.get(logChannelID);
            if (!channel || !channel.isTextBased()) return;

            // Add 1.5 second buffer to let Discord's Audit Log catch up
            await new Promise(res => setTimeout(res, 1500));

            // Pick up the Nickname from handleMemberRemove()
            const savedNickname = nicknameCache.get(ban.user.id) ?? '*Nickname not found!*';
            nicknameCache.delete(ban.user.id); // Clean up the map

            const total = ban.guild.memberCount;

            const fetchedLogs = await ban.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberBanAdd,
            });

            const banLog = fetchedLogs.entries.find(
                entry => entry.target.id === ban.user.id &&
                    Date.now() - entry.createdTimestamp < 5000
            );

            const executor = banLog?.executor;
            const reason = banLog?.reason ?? '*No reason provided!*';
            const username = ban.user?.tag ?? '*Unknown User!*';
            const globalName = ban.user?.globalName ?? username;
            const executorMention = executor ? `<@${executor.id}>` : '*Unknown Moderator*';
            const errorNote = !executor ? `***⚠️ Discord Error:*** *Executor not found due to Audit Log delay! Manually check Discord's Audit Log for more info!*\n` : '';

            await channel.send(
                `### ⛔  <@${ban.user.id}> was banned by ${executorMention}!\n` +
                `- **Reason:** ${reason}\n` +
                `${errorNote}` +
                `- **User Information:**\n` +
                `  - Discord Username (@handle): **${username}**\n` +
                `  - Discord Global Display Name: **${globalName}**\n` +
                `  - WW Server Nickname: **${savedNickname}**\n` +
                `  - Discord User ID: **${ban.user.id}**\n` +
                `- Discord Members: **${total}**`
            );
        } catch (err) {
            console.error('Ban message failed:', err);
        }
    },

    // ---------------
    // Handle Unbans
    // ---------------
    async handleGuildBanRemove(ban, logChannelID) {
        try {
            const channel = ban.guild.channels.cache.get(logChannelID);
            if (!channel || !channel.isTextBased()) return;

            await new Promise(res => setTimeout(res, 1000));

            const fetchedLogs = await ban.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberBanRemove,
            });

            const unbanLog = fetchedLogs.entries.find(
                entry => entry.target.id === ban.user.id &&
                    Date.now() - entry.createdTimestamp < 5000
            );

            const executor = unbanLog?.executor;
            const total = ban.guild.memberCount;
            const username = ban.user?.tag ?? '*Unknown User!*';
            const globalName = ban.user?.globalName ?? username;
            const executorMention = executor ? `<@${executor.id}>` : '*Unknown Moderator*';
            const errorNote = !executor ? `***⚠️ Discord Error:*** *Executor not found due to Audit Log delay! Manually check Discord's Audit Log for more info!*\n` : '';

            await channel.send(
                `### ✅  <@${ban.user.id}> was unbanned by ${executorMention}!\n` +
                `${errorNote}` +
                `- **User Information:**\n` +
                `  - Discord Username (@handle): **${username}**\n` +
                `  - Discord Global Display Name: **${globalName}**\n` +
                `  - Discord User ID: **${ban.user.id}**\n` +
                `- Discord Members: **${total}**`
            );
        } catch (err) {
            console.error('Unban message failed:', err);
        }
    },

    // ----------------------------------
    // Handle Timeouts / Mutes & Unmutes
    // ----------------------------------
    async handleGuildMemberUpdate(oldMember, newMember, logChannelID) {
        try {
            const channel = newMember.guild.channels.cache.get(logChannelID);
            if (!channel || !channel.isTextBased()) return;

            const wasTimedOut = oldMember.isCommunicationDisabled();
            const isTimedOut = newMember.isCommunicationDisabled();
            // If timeout status didn't change, ignore this event
            if (wasTimedOut === isTimedOut) return;

            await new Promise(res => setTimeout(res, 2500));

            const fetchedLogs = await newMember.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberUpdate,
            });

            const timeoutLog = fetchedLogs.entries.find(
                entry => entry.target.id === newMember.id &&
                    entry.changes.some(c => c.key === 'communication_disabled_until') &&
                    Date.now() - entry.createdTimestamp < 8000
            );

            const executor = timeoutLog?.executor;
            const reason = timeoutLog?.reason ?? '*No reason provided!*';
            const username = newMember.user?.tag ?? '*Unknown User!*';
            const globalName = newMember.user?.globalName ?? username;
            const displayName = newMember.displayName ?? '*Nickname not found!*';
            const executorMention = executor ? `<@${executor.id}>` : '*Unknown Moderator*';

            if (!wasTimedOut && isTimedOut) {
                // ==========================================
                // User got TIMED OUT by Moderator
                // ==========================================
                const expiresAt = `<t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:R>`;
                const errorNote = !executor ? `***⚠️ Discord Error:*** *Executor not found due to Audit Log delay! Manually check Discord's Audit Log for more info!*\n` : '';

                await channel.send(
                    `### ⏱️  <@${newMember.id}> was timed out by ${executorMention}!\n` +
                    `- **Reason for Timeout:** ${reason}\n` +
                    `- **Timeout expires:** ${expiresAt}\n` +
                    `${errorNote}` +
                    `- **User Information:**\n` +
                    `  - Discord Username (@handle): **${username}**\n` +
                    `  - Discord Global Display Name: **${globalName}**\n` +
                    `  - WW Server Nickname: **${displayName}**\n` +
                    `  - Discord User ID: **${newMember.id}**`
                );

                // Start the internal bot timer for NATURAL expiry
                const msUntilExpiry = newMember.communicationDisabledUntilTimestamp - Date.now();

                // Clear any weird overlapping timers just in case
                if (activeTimeouts.has(newMember.id)) {
                    clearTimeout(activeTimeouts.get(newMember.id));
                }

                // ==========================================
                // User's TIMEOUT auto expired
                // ==========================================
                if (msUntilExpiry > 0 && msUntilExpiry <= 2147483647) { // JS setTimeout max limit is ~24 days (2147483647 ms)
                    const timerId = setTimeout(async () => {
                        // This code runs when the timeout naturally hits 0
                        activeTimeouts.delete(newMember.id);

                        // Re-fetch member to ensure they are still in the server before logging
                        const currentMember = await newMember.guild.members.fetch(newMember.id).catch(() => null);
                        if (currentMember) {
                            await channel.send(
                                `### 🍃  <@${newMember.id}>'s timeout has expired!\n` +
                                `- **User Information:**\n` +
                                `  - Discord Username (@handle): **${username}**\n` +
                                `  - Discord Global Display Name: **${globalName}**\n` +
                                `  - WW Server Nickname: **${displayName}**\n` +
                                `  - Discord User ID: **${newMember.id}**`
                            );
                        }
                    }, msUntilExpiry);

                    activeTimeouts.set(newMember.id, timerId);
                }

            } else if (wasTimedOut && !isTimedOut) {
                // ==========================================
                // TIMEOUT MANUALLY REMOVED by Moderator
                // - Natural expiry doesn't trigger Discord API events, so this will always be a manual Timeout removal
                // ==========================================

                // Cancel the natural expiry timer since an officer intervened
                if (activeTimeouts.has(newMember.id)) {
                    clearTimeout(activeTimeouts.get(newMember.id));
                    activeTimeouts.delete(newMember.id);
                }

                await channel.send(
                    `### 🔊  <@${newMember.id}>'s timeout was removed by ${executorMention}!\n` +
                    `- **Reason for removal:** ${reason}\n` +
                    `- **User Information:**\n` +
                    `  - Discord Username (@handle): **${username}**\n` +
                    `  - Discord Global Display Name: **${globalName}**\n` +
                    `  - WW Server Nickname: **${displayName}**\n` +
                    `  - Discord User ID: **${newMember.id}**`
                );
            }
        } catch (err) {
            console.error('Timeout message failed:', err);
        }
    }
};
