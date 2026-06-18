// ==================================================
// LOG Thread Events (Channel Threads & Forum Posts)
// ==================================================

const { AuditLogEvent, ChannelType } = require('discord.js');
const {
    sleep,
    isBlockedLogChannel,
    fetchTargetAuditLog,
    extractExecutor,
    formatEmoji,
    buildLogEmbed
} = require('../utils/logHelpers.js');

function isForumPost(thread) {
    return thread.parent?.type === ChannelType.GuildForum;
}

function getThreadTypeName(thread) {
    return isForumPost(thread) ? 'Forum Post' : 'Thread';
}

function getThreadTypeEmoji(thread) {
    return isForumPost(thread) ? '💬' : '🧵';
}

function getParentLabel(thread) {
    return thread.parentId ? `<#${thread.parentId}>` : '*Unknown Parent*';
}

function getCategoryLabel(thread) {
    const category = thread.parent?.parent;
    if (!category) return '*Uncategorized!*';
    return `${category.name} (\`${category.id}\`)`;
}

function formatArchiveDuration(minutes) {
    if (!minutes) return 'Default';
    if (minutes === 60) return '1 Hour';
    if (minutes === 1440) return '24 Hours';
    if (minutes === 4320) return '3 Days';
    if (minutes === 10080) return '1 Week';
    return minutes >= 60 ? `${minutes / 60} Hours` : `${minutes} Minutes`;
}

function formatForumTag(thread, tagId) {
    const tag = thread.parent?.availableTags?.find(t => t.id === tagId);
    if (!tag) return '`Unknown Tag`';

    const emoji = formatEmoji(tag);
    return emoji ? `\`${tag.name}\` ${emoji}` : `\`${tag.name}\``;
}

function getAppliedTags(thread) {
    return Array.isArray(thread.appliedTags) ? thread.appliedTags : [];
}

function getPinnedState(thread) {
    return thread.flags?.has?.('Pinned') ?? false;
}

module.exports = {
    name: 'threadLogs',

    async handleThreadCreate(thread, config) {
        if (!thread.guild) return;
        if (isBlockedLogChannel(thread.parentId, config.ignoredLogChannels)) return;

        const logChannel = thread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        const typeName = getThreadTypeName(thread);
        const typeEmoji = getThreadTypeEmoji(thread);
        const isPrivate = thread.type === ChannelType.PrivateThread;

        await sleep(1500);
        const entry = await fetchTargetAuditLog(thread.guild, AuditLogEvent.ThreadCreate, thread.id, 15000);
        const executor = extractExecutor(entry, thread.ownerId, thread.guild);

        const details = [
            `- **Title:** <#${thread.id}>`,
            `- **Type:** ${typeName} ${typeEmoji}`,
            `- **Visibility:** ${isPrivate ? 'Private 🔒' : 'Public 🌐'}`,
            `- **Parent Channel:** ${getParentLabel(thread)}`,
            `- **Category:** ${getCategoryLabel(thread)}`
        ];

        const appliedTags = getAppliedTags(thread);
        if (isForumPost(thread) && appliedTags.length > 0) {
            details.push(`- **Selected Tag(s):** ${appliedTags.map(tagId => formatForumTag(thread, tagId)).join(', ')}`);
        }

        if (thread.rateLimitPerUser) {
            details.push(`- **Slowmode:** \`${thread.rateLimitPerUser}s\``);
        }

        const fields = [
            { name: 'Name', value: thread.name || `<#${thread.id}>`, inline: true },
            { name: 'Thread Type', value: `${typeName} ${typeEmoji}`, inline: true },
            { name: 'Parent Channel', value: getParentLabel(thread), inline: true },
            { name: 'Created By', value: `${executor.mention} (${executor.username})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            `✅ ${typeName} Created: <#${thread.id}>`,
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
        if (isBlockedLogChannel(thread.parentId, config.ignoredLogChannels)) return;

        const logChannel = thread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        const typeName = getThreadTypeName(thread);

        await sleep(1500);
        const entry = await fetchTargetAuditLog(thread.guild, AuditLogEvent.ThreadDelete, thread.id, 15000);
        const executor = extractExecutor(entry, null, thread.guild);

        const description = [
            `- **Title:** ${thread.name || `\`${thread.id}\``}`,
            `- **Parent Channel:** ${getParentLabel(thread)}`
        ].join('\n');

        const fields = [
            { name: typeName, value: thread.name || `\`${thread.id}\``, inline: true },
            { name: 'Parent Channel', value: getParentLabel(thread), inline: true },
            { name: 'Deleted By', value: `${executor.mention} (${executor.username})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            `❌ ${typeName} Deleted`,
            description,
            thread.id,
            0xFF0000,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    },

    async handleThreadUpdate(oldThread, newThread, config) {
        if (!newThread.guild) return;
        if (isBlockedLogChannel(newThread.parentId, config.ignoredLogChannels)) return;

        const logChannel = newThread.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        const typeName = getThreadTypeName(newThread);
        const typeEmoji = getThreadTypeEmoji(newThread);

        await sleep(2000);
        const entry = await fetchTargetAuditLog(newThread.guild, AuditLogEvent.ThreadUpdate, newThread.id, 20000);
        const executor = extractExecutor(entry, null, newThread.guild);

        const changes = [];

        if (oldThread.name !== newThread.name) {
            changes.push(`- **Title:** \`${oldThread.name}\` ➜ \`${newThread.name}\``);
        }

        if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
            const oldSlowmode = oldThread.rateLimitPerUser ? `${oldThread.rateLimitPerUser}s` : 'Off';
            const newSlowmode = newThread.rateLimitPerUser ? `${newThread.rateLimitPerUser}s` : 'Off';
            changes.push(`- **Slowmode:** \`${oldSlowmode}\` ➜ \`${newSlowmode}\``);
        }

        if (oldThread.autoArchiveDuration !== newThread.autoArchiveDuration) {
            changes.push(`- **Hide After Inactivity:** \`${formatArchiveDuration(oldThread.autoArchiveDuration)}\` ➜ \`${formatArchiveDuration(newThread.autoArchiveDuration)}\``);
        }

        const oldAppliedTags = getAppliedTags(oldThread);
        const newAppliedTags = getAppliedTags(newThread);
        if (isForumPost(newThread) && JSON.stringify(oldAppliedTags) !== JSON.stringify(newAppliedTags)) {
            const added = newAppliedTags.filter(tagId => !oldAppliedTags.includes(tagId));
            const removed = oldAppliedTags.filter(tagId => !newAppliedTags.includes(tagId));

            if (added.length > 0) {
                changes.push(`- **Tag Added:** ${added.map(tagId => formatForumTag(newThread, tagId)).join(', ')}`);
            }

            if (removed.length > 0) {
                changes.push(`- **Tag Removed:** ${removed.map(tagId => formatForumTag(newThread, tagId)).join(', ')}`);
            }
        }

        if (getPinnedState(oldThread) !== getPinnedState(newThread)) {
            changes.push(`- **Pinned:** \`${getPinnedState(newThread) ? 'Yes' : 'No'}\``);
        }

        if (oldThread.locked !== newThread.locked) {
            changes.push(`- **Locked:** \`${oldThread.locked ? 'Locked' : 'Unlocked'}\` ➜ \`${newThread.locked ? 'Locked' : 'Unlocked'}\``);
        }

        if (oldThread.archived !== newThread.archived) {
            changes.push(`- **Archive Status:** \`${oldThread.archived ? 'Archived' : 'Active'}\` ➜ \`${newThread.archived ? 'Archived' : 'Active'}\``);
        }

        if (changes.length === 0) return;

        const fields = [
            { name: 'Name', value: newThread.name || `<#${newThread.id}>`, inline: true },
            { name: 'Thread Type', value: `${typeName} ${typeEmoji}`, inline: true },
            { name: 'Parent Channel', value: getParentLabel(newThread), inline: true },
            { name: 'Updated By', value: `${executor.mention} (${executor.username})`, inline: false },
            { name: 'Changes:', value: changes.join('\n'), inline: false }
        ];

        const logPayload = buildLogEmbed(
            `🔄 ${typeName} Updated: <#${newThread.id}>`,
            null,
            newThread.id,
            0xFFA500,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    }
};
