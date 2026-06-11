// ==================================================
// LOG Thread Events (Channel Threads & Forum Posts)
// ==================================================

// 🟡 EDIT START 🟡 - Use utility file and setup embed
const { AuditLogEvent, ChannelType } = require('discord.js');
const { formatEmoji, buildLogEmbed } = require('../utils/logHelpers.js');
// 🟡 EDIT END 🟡

module.exports = {
    name: 'forumLogs', // Just an identifier

    async handleThreadCreate(thread, config) {
        if (!thread.guild) return;
        if (config.ignoredLogChannels && config.ignoredLogChannels.includes(thread.parentId)) return;

        const isForum = thread.parent?.type === ChannelType.GuildForum;
        const typeName = isForum ? 'Forum Post' : 'Thread';
        const parentName = isForum ? 'Forum' : 'Parent';
        const typeEmoji = isForum ? '💬' : '🧵';
        const parentChannel = thread.parent;
        const categoryName = parentChannel?.parent?.name || '*Uncategorized!*';
        const categoryId = parentChannel?.parent?.id || '*No ID!*';
        const isThreadPrivate = thread.type === ChannelType.PrivateThread;

        const logChannel = thread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 1500));
        const fetchedLogs = await thread.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.ThreadCreate });
        const entry = fetchedLogs.entries.find(e => e.target.id === thread.id && Date.now() - e.createdTimestamp < 10000);

        const ownerId = thread.ownerId || entry?.executor?.id;
        const executor = ownerId ? `<@${ownerId}>` : 'Unknown User';
        const executorName = entry?.executor ? entry.executor.username : (thread.guild.members.cache.get(ownerId)?.user.username || 'Unknown Username');

        let details = [];
        details.push(`- **${typeName} Title:** <#${thread.id}>`);
        details.push(`- **Visibility:** ${isThreadPrivate ? 'Private 🔒' : 'Public 🌐'}`);
        details.push(`- **${parentName} Channel:** <#${thread.parentId}> (\`${thread.parentId}\`)`);
        details.push(`- **Category:** ${categoryName} (\`${categoryId}\`)`);

        if (isForum && thread.appliedTags.length > 0) {
            const forumTags = parentChannel.availableTags || [];
            const tagString = thread.appliedTags.map(id => {
                const tag = forumTags.find(t => t.id === id);
                if (!tag) return '`Unknown Tag`';
                const emojiStr = formatEmoji(tag);
                return emojiStr ? `\`${tag.name}\` ${emojiStr}` : `\`${tag.name}\``;
            }).join(', ');
            details.push(`- **Selected Tag(s):** ${tagString}`);
        }

        if (thread.rateLimitPerUser) details.push(`- **Slowmode:** \`${thread.rateLimitPerUser}s\``);


        const fields = [
            { name: 'Category', value: categoryName, inline: true },
            { name: 'Parent Channel', value: `<#${thread.parentId}>`, inline: true },
            { name: 'Created By', value: `${executor} (${executorName})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            `${typeEmoji} New ${typeName} Created`,
            details.join('\n'),
            thread.id,
            0x00FF00,
            typeName,
            fields
        );
        await logChannel.send(logPayload);
    },

    async handleThreadDelete(thread, config) {
        if (!thread.guild) return;
        if (config.ignoredLogChannels && config.ignoredLogChannels.includes(thread.parentId)) return;

        const isForum = thread.parent?.type === ChannelType.GuildForum;
        const typeName = isForum ? 'Forum Post' : 'Thread';

        const logChannel = thread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 1500));
        const fetchedLogs = await thread.guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.ThreadDelete });
        const entry = fetchedLogs.entries.find(e => e.target.id === thread.id && Date.now() - e.createdTimestamp < 10000);

        const executor = entry?.executor ? `<@${entry.executor.id}>` : 'Unknown User';
        const executorName = entry?.executor ? entry.executor.username : 'Unknown Username';

        const description = `- **Title:** ${thread.name}\n- **Parent Channel:** <#${thread.parentId}>`;
        const executorString = `${executor} (${executorName})`;

        const logPayload = buildLogEmbed('delete', `❌ ${typeName} Deleted`, description, thread.id, executorString, 0xFF0000);
        await logChannel.send(logPayload);
    },

    async handleThreadUpdate(oldThread, newThread, config) {
        if (!newThread.guild) return;
        if (config.ignoredLogChannels && config.ignoredLogChannels.includes(newThread.parentId)) return;

        const isForum = newThread.parent?.type === ChannelType.GuildForum;
        const typeName = isForum ? 'Forum Post' : 'Thread';

        const logChannel = newThread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 2000));
        const fetchedLogs = await newThread.guild.fetchAuditLogs({ limit: 10, type: AuditLogEvent.ThreadUpdate });
        const logEntry = fetchedLogs.entries.find(e => e.target.id === newThread.id && Date.now() - e.createdTimestamp < 15000);

        const executor = logEntry?.executor ? `<@${logEntry.executor.id}>` : 'Unknown User';
        const executorName = logEntry?.executor ? logEntry.executor.username : 'Unknown Username';

        let changes = [];

        if (oldThread.name !== newThread.name) {
            changes.push(`- **Title Changed:** \`${oldThread.name}\` ➔ \`${newThread.name}\``);
        }

        if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
            const oldS = oldThread.rateLimitPerUser ? `${oldThread.rateLimitPerUser}s` : 'Off';
            const newS = newThread.rateLimitPerUser ? `${newThread.rateLimitPerUser}s` : 'Off';
            changes.push(`- **Slowmode:** \`${oldS}\` ➔ \`${newS}\``);
        }

        if (oldThread.autoArchiveDuration !== newThread.autoArchiveDuration) {
            const formatDur = (m) => m >= 60 ? `${m / 60}h` : `${m}m`;
            changes.push(`- **Hide After Inactivity:** \`${formatDur(oldThread.autoArchiveDuration)}\` ➔ \`${formatDur(newThread.autoArchiveDuration)}\``);
        }

        if (isForum && JSON.stringify(oldThread.appliedTags) !== JSON.stringify(newThread.appliedTags)) {
            const forumTags = newThread.parent?.availableTags || [];
            const getTagInfo = (id) => {
                const tag = forumTags.find(t => t.id === id);
                if (!tag) return `\`Unknown Tag\``;
                const emoji = formatEmoji(tag);
                return emoji ? `\`${tag.name}\`  ${emoji}` : `\`${tag.name}\``;
            };

            const added = newThread.appliedTags.filter(id => !oldThread.appliedTags.includes(id));
            const removed = oldThread.appliedTags.filter(id => !newThread.appliedTags.includes(id));

            if (added.length > 0) changes.push(`- **✅ Tag Added:** ${added.map(id => getTagInfo(id)).join(', ')}`);
            if (removed.length > 0) changes.push(`- **❌ Tag Removed:** ${removed.map(id => getTagInfo(id)).join(', ')}`);
        }

        if (oldThread.flags.has('Pinned') !== newThread.flags.has('Pinned')) {
            changes.push(`- **Pinned:** \`${newThread.flags.has('Pinned') ? 'Yes' : 'No'}\``);
        }

        if (oldThread.locked !== newThread.locked) {
            changes.push(`- **Locked Status:** \`${oldThread.locked ? 'Locked' : 'Unlocked'}\` ➔ \`${newThread.locked ? 'Locked' : 'Unlocked'}\``);
        }

        if (oldThread.archived !== newThread.archived) {
            changes.push(`- **Archive Status:** \`${oldThread.archived ? 'Archived' : 'Active'}\` ➔ \`${newThread.archived ? 'Archived' : 'Active'}\``);
        }

        if (changes.length === 0) return;

        // Replace the bottom of handleThreadUpdate with this:
        const fields = [
            { name: 'Parent Channel', value: `<#${newThread.parentId}>`, inline: true },
            { name: 'Thread', value: `<#${newThread.id}>`, inline: true },
            { name: 'Updated By', value: `${executor} (${executorName})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            `🔄 ${typeName} Updated: <#${newThread.id}>`,
            changes.join('\n'),
            newThread.id,
            null,
            0xFFA500,
            typeName,
            fields
        );
        await logChannel.send(logPayload);
    }
};
