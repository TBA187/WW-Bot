// =======================================================================
// LOG Channel Events (Text, Voice, Forum, Announcement & Stage Channels)
// =======================================================================

// BUG: When moving a Channel to another Category, it says "Unknow User", otherwise the rest works!
// BUG: When Creating/Deleting many Role/Member Permission Overwrites fast in a Channel, the bot sometimes ...
// ... logs duplicates of some of the Role/Memebr events for both Create/Delete! Bulk updating many Channel overwrites at the same time works perfect!
// TO-DO: Handle when Deleting Category and it contain channels! Channels gets moved to top as UNCATEGORIZED!
// When Category DELETED, bot logs this for Channel: "Category changed: *None* ➔ *None*" and UNKWON EXECUTOR!

const { AuditLogEvent, ChannelType, PermissionsBitField } = require('discord.js');
const {
    sleep,
    isBlockedLogChannel,
    fetchTargetAuditLog,
    extractExecutor,
    getChannelTypeInfo,
    formatEmoji,
    formatViewChannelPerms,
    buildLogEmbed
} = require('../utils/logHelpers.js');

const channelUpdateCache = new Map();

module.exports = {
    // ---------------------------
    // Handle Channel Creation ✅
    // ---------------------------
    async handleChannelCreate(channel, config) {
        if (!channel.guild) return;

        const logChannel = channel.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await sleep(1500);

        const entry = await fetchTargetAuditLog(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
        const executor = extractExecutor(entry, null, channel.guild);

        // IGNORE logging for newly created Private Channels (Optional Filter for Server Owner only)
        // TO-DO: Store channelID in DB to prevent future logging for update/delete events
        if (config.ignoreLogPrivateChannelCreate === 1 && executor.id === config.ownerID) {
            // Check if view permission for ONLY @everyone were set to false
            const everyoneOverwrites = channel.permissionOverwrites.cache;
            const isPrivateAtCreation = everyoneOverwrites.size === 1 &&
                everyoneOverwrites.has(channel.guild.id) &&
                everyoneOverwrites.get(channel.guild.id).deny.has(PermissionsBitField.Flags.ViewChannel);

            // Skip logging if channel was marked as Private by user and NO other role overwrites were made!
            if (isPrivateAtCreation) return;
        }

        const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(channel.type);
        const channelLabel = channel.type === ChannelType.GuildText ? 'Channel' : typeName;
        const parent = channel.parent ? `${channel.parent.name}` : '*Uncategorized!*';
        const parentID = channel.parent ? `${channel.parent.id}` : '*No Category ID!*';
        const isCategory = channel.type === ChannelType.GuildCategory;

        // ----- Collect details for Forum Channels -----
        let details = [];
        details.push(`- **Name:** <#${channel.id}>`);
        details.push(`- **Type:** ${typeName}\u2002${typeEmoji}`);
        details.push(`- **Category:** ${parent} (\`${parentID}\`)`);

        if (channel.topic) details.push(`- **Topic:** \`\`\`${channel.topic}\`\`\``);
        if (channel.rateLimitPerUser) details.push(`- **Slowmode:** \`${channel.rateLimitPerUser}s\``);
        if (channel.nsfw) details.push(`- **Age-Restricted:** \`Yes\``);
        if (channel.bitrate) details.push(`- **Bitrate:** \`${channel.bitrate / 1000}kbps\``);
        if (channel.userLimit) details.push(`- **User Limit:** \`${channel.userLimit}\``);

        if (channel.type === ChannelType.GuildForum) {
            if (channel.availableTags && channel.availableTags.length > 0) {
                details.push(`- **Tags Configured:** ${channel.availableTags.length}`);
            }
            details.push(`- **Require Tags:** \`${channel.flags?.has('RequireTag') ? 'Yes' : 'No'}\``);
        }

        // ----- Default Channels -----
        const viewPerms = formatViewChannelPerms(channel.permissionOverwrites.cache, channel.guild, typeName);

        const fields = isCategory ? [
            { name: 'Category Name', value: `${channel.name}`, inline: true },
            { name: 'Created By', value: `${executor.mention} (${executor.username})`, inline: true },
            { name: '', value: viewPerms, inline: false }
        ] : [
            { name: 'Name', value: `${channel.name}`, inline: true },
            { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
            { name: 'Category', value: parent, inline: true },
            { name: 'Created By', value: `${executor.mention} (${executor.username})`, inline: false },
            { name: '', value: viewPerms, inline: false }
        ];

        const logPayload = buildLogEmbed(
            isCategory ? `✅\u2002Category Created!\u2002${typeEmoji}` : `✅\u2002${channelLabel} Created: <#${channel.id}>`,
            channel.topic ? `**Topic:** ${channel.topic}` : null,
            channel.id,
            isCategory ? 0x228B22 : 0x00FF00,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    },

    // ---------------------------
    // Handle Channel Deletion ❌
    // ---------------------------
    async handleChannelDelete(channel, config) {
        if (!channel.guild) return;

        if (isBlockedLogChannel(channel.id, config.ignoredLogChannels)) return;

        const logChannel = channel.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await sleep(1500);
        const entry = await fetchTargetAuditLog(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
        const executor = extractExecutor(entry, null, channel.guild);
        const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(channel.type);
        const channelLabel = channel.type === ChannelType.GuildText ? 'Channel' : typeName;
        const parent = channel.parent ? `${channel.parent.name}` : '*Uncategorized!*';
        const isCategory = channel.type === ChannelType.GuildCategory;

        const fields = isCategory ? [
            { name: 'Category Name', value: `${channel.name}`, inline: true },
            { name: 'Deleted By', value: `${executor.mention} (${executor.username})`, inline: true },
        ] : [
            { name: 'Name', value: `${channel.name}`, inline: true },
            { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
            { name: 'Category', value: parent, inline: true },
            { name: 'Deleted By', value: `${executor.mention} (${executor.username})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            isCategory ? `❌\u2002Category Deleted!\u2002${typeEmoji}` : `❌\u2002${channelLabel} Deleted!`,
            null,
            channel.id,
            isCategory ? 0x8B0000 : 0xFF0000,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    },

    // ---------------------------
    // Handle Channel Updates 🔄
    // ---------------------------
    async handleChannelUpdate(oldChannel, newChannel, config) {
        if (!newChannel.guild || !newChannel.guild.channels.cache.has(newChannel.id)) return;
        if (isBlockedLogChannel(newChannel.id, config.ignoredLogChannels)) return;

        const channelId = newChannel.id;

        // Handle Channel Batch Updates
        if (channelUpdateCache.has(channelId)) {
            const cached = channelUpdateCache.get(channelId);
            clearTimeout(cached.timeout); // If this channel is already in the queue, reset the timer!

            cached.timeout = setTimeout(() => {
                processBatchedUpdate(cached.oldChannel, channelId, config);
            }, 2500); // Wait 2.5 seconds for changes to settle

            return;
        }

        // If it's the first change, create a new entry in the queue
        const timeout = setTimeout(() => {
            processBatchedUpdate(oldChannel, channelId, config);
        }, 2500);

        channelUpdateCache.set(channelId, { oldChannel, timeout });
    }
};

async function processBatchedUpdate(oldChannel, channelId, config) {
    channelUpdateCache.delete(channelId);

    const newChannel = oldChannel.guild.channels.cache.get(channelId);
    if (!newChannel) return;

    const logChannel = newChannel.guild.channels.cache.get(config.logChannelID);
    if (!logChannel) return;

    await sleep(1500);
    let logEntry = null;
    try {
        const fetchedLogs = await newChannel.guild.fetchAuditLogs({ limit: 15 });
        logEntry = fetchedLogs.entries.find(e => {
            const isCorrectAction = [
                AuditLogEvent.ChannelUpdate,
                AuditLogEvent.ChannelOverwriteCreate,
                AuditLogEvent.ChannelOverwriteUpdate,
                AuditLogEvent.ChannelOverwriteDelete
            ].includes(e.action);

            return isCorrectAction &&
                (e.targetId === newChannel.id || e.extra?.channel?.id === newChannel.id || e.extra?.id === newChannel.id) &&
                (Date.now() - e.createdTimestamp) < 45000;
        });
    } catch (err) { console.error(err); }

    const executor = logEntry ? {
        mention: `<@${logEntry.executor.id}>`,
        username: logEntry.executor.tag,
        id: logEntry.executor.id
    } : { mention: 'Unknown User', username: 'Unknown', id: null };

    const parent = newChannel.parent ? `${newChannel.parent.name}` : '*Uncategorized!*';
    const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(newChannel.type);
    const { name: oldTypeName, moji: oldTypeEmoji } = getChannelTypeInfo(oldChannel.type);
    const channelLabel = newChannel.type === ChannelType.GuildText ? 'Channel' : typeName;
    const isCategory = newChannel.type === ChannelType.GuildCategory;

    // ---------------------------
    // Detect Channel Changes
    // ---------------------------
    let changes = [];

    // 1) Name Change
    if (oldChannel.name !== newChannel.name) {
        changes.push(`- **Name Updated:**\u2002\`${oldChannel.name}\`  ➔  \`${newChannel.name}\``);
    }

    // 2) Topic/Description
    if ((oldChannel.topic || '') !== (newChannel.topic || '')) {
        const oldT = oldChannel.topic || '*No topic*';
        const newT = newChannel.topic || '*No topic*';
        changes.push(`- **Topic Changed:**\n**From:** \`\`\`${oldT}\`\`\`\n**To:** \`\`\`${newT}\`\`\``);
    }

    // 3) Slowmode (Rate Limit)
    if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        const formatSlow = (s) => (s === undefined || s === null) ? 'Off' : (s === 0 ? 'Off' : `${s}s`);
        const oldS = formatSlow(oldChannel.rateLimitPerUser);
        const newS = formatSlow(newChannel.rateLimitPerUser);
        if (oldS !== newS) changes.push(`- **Slowmode:** \`${oldS}\` ➔ \`${newS}\``);
    }

    // 4) Age-Restricted Channel (NSFW Status)
    if (oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`- **Age-Restricted (NSFW):** \`${oldChannel.nsfw ? 'Enabled' : 'Disabled'}\` ➔ \`${newChannel.nsfw ? 'Enabled' : 'Disabled'}\``);
    }

    // 5) Type Change
    if (oldChannel.type !== newChannel.type) {
        changes.push(`- **Channel Type:** \`${oldTypeName}\` ➔ \`${typeName}\``);
    }

    // 6) Hide After Inactivity
    const archiveChange = logEntry?.changes?.find(c => c.key === 'default_auto_archive_duration');
    const oldArchive = archiveChange ? archiveChange.old : oldChannel.defaultAutoArchiveDuration;
    const newArchive = archiveChange ? archiveChange.new : newChannel.defaultAutoArchiveDuration;
    if (archiveChange || (oldArchive !== newArchive)) {
        const formatDuration = (minutes) => {
            if (!minutes) return 'Default (3 Days)';
            if (minutes === 60) return '1 Hour';
            if (minutes === 1440) return '24 Hours';
            if (minutes === 4320) return '3 Days';
            if (minutes === 10080) return '1 Week';
            return `${minutes} Minutes`;
        };
        const oldD = formatDuration(oldArchive);
        const newD = formatDuration(newArchive);
        if (oldD !== newD) changes.push(`- **Hide Threads after inactivity:** \`${oldD}\` ➔ \`${newD}\``);
    }

    // 7.1) Voice Channel: Bitrate
    if (oldChannel.bitrate !== newChannel.bitrate) {
        changes.push(`- **Bitrate:** \`${oldChannel.bitrate / 1000}kbps\` ➔ \`${newChannel.bitrate / 1000}kbps\``);
    }

    // 7.2) Voice Channel: User Limit
    if (oldChannel.userLimit !== newChannel.userLimit) {
        changes.push(`- **User Limit:** \`${oldChannel.userLimit || '∞'}\` ➔ \`${newChannel.userLimit || '∞'}\``);
    }

    // 7.3) Voice Channel: Region Override
    if (oldChannel.rtcRegion !== newChannel.rtcRegion) {
        changes.push(`- **Region Override:** \`${oldChannel.rtcRegion || 'Automatic'}\` ➔ \`${newChannel.rtcRegion || 'Automatic'}\``);
    }

    // 7.4) Voice Channel: Video Quality Mode
    if (oldChannel.videoQualityMode !== newChannel.videoQualityMode) {
        const getVQM = (mode) => mode === 1 ? 'Auto' : (mode === 2 ? '720p/1080p' : 'Unknown');
        changes.push(`- **Video Quality:** \`${getVQM(oldChannel.videoQualityMode)}\` ➔ \`${getVQM(newChannel.videoQualityMode)}\``);
    }

    // 8) Forum Channels Specifics
    if (newChannel.type === ChannelType.GuildForum) {
        if (oldChannel.defaultForumLayout !== newChannel.defaultForumLayout) {
            const getLayout = (l) => l === 1 ? 'List' : (l === 2 ? 'Gallery' : 'Not Set');
            changes.push(`- **Default Layout:** \`${getLayout(oldChannel.defaultForumLayout)}\` ➔ \`${getLayout(newChannel.defaultForumLayout)}\``);
        }
        if (oldChannel.defaultSortOrder !== newChannel.defaultSortOrder) {
            const getSort = (s) => s === 0 ? 'Latest Activity' : (s === 1 ? 'Creation Time' : 'Default');
            changes.push(`- **Default Sort Order:** \`${getSort(oldChannel.defaultSortOrder)}\` ➔ \`${getSort(newChannel.defaultSortOrder)}\``);
        }
        if (JSON.stringify(oldChannel.defaultReactionEmoji) !== JSON.stringify(newChannel.defaultReactionEmoji)) {
            const oldEmoji = oldChannel.defaultReactionEmoji ? `${formatEmoji(oldChannel.defaultReactionEmoji)}` : '*No Emoji*';
            const newEmoji = newChannel.defaultReactionEmoji ? `${formatEmoji(newChannel.defaultReactionEmoji)}` : '*No Emoji*';
            changes.push(`- **Default Reaction:** ${oldEmoji} ➔ ${newEmoji}`);
        }
        if (oldChannel.defaultThreadRateLimitPerUser !== newChannel.defaultThreadRateLimitPerUser) {
            const oldTR = oldChannel.defaultThreadRateLimitPerUser || 'Off';
            const newTR = newChannel.defaultThreadRateLimitPerUser || 'Off';
            changes.push(`- **Post Slowmode:** \`${oldTR}${typeof oldTR === 'number' ? 's' : ''}\` ➔ \`${newTR}${typeof newTR === 'number' ? 's' : ''}\``);
        }
        if ((oldChannel.flags?.has('RequireTag') || false) !== (newChannel.flags?.has('RequireTag') || false)) {
            changes.push(`- **Require tags to post:** \`${oldChannel.flags?.has('RequireTag') ? 'Enabled' : 'Disabled'}\` ➔ \`${newChannel.flags?.has('RequireTag') ? 'Enabled' : 'Disabled'}\``);
        }

        // Tags Logic
        const oldTags = oldChannel.availableTags || [];
        const newTags = newChannel.availableTags || [];
        oldTags.forEach(oldT => {
            const tagEmoji = oldT.emoji ? `${formatEmoji(oldT)}` : '*No Emoji*';
            if (!newTags.find(t => t.id === oldT.id)) changes.push(`- **Tag Deleted!**\u2002❌\n   - **Tag Name:** \`${oldT.name}\`\n   - **Tag Emoji:** ${tagEmoji}`);
        });
        newTags.forEach(newT => {
            const oldT = oldTags.find(t => t.id === newT.id);
            const tagEmoji = newT.emoji ? `${formatEmoji(newT)}` : '*No Emoji*';
            if (!oldT) {
                changes.push(`- **New Tag Created!**\u2002✅\n   - **Tag Name:** \`${newT.name}\`\n   - **Tag Emoji:** ${tagEmoji}\n   - **Moderators Only:** \`${newT.moderated ? 'Yes' : 'No'}\``);
            } else {
                if (oldT.name !== newT.name) changes.push(`- **Tag Name changed:**\u2002\`${oldT.name}\`  ➔  \`${newT.name}\``);
                const emojiChanged = (oldT.emoji ? `${oldT.emoji.id}-${oldT.emoji.name}` : 'none') !== (newT.emoji ? `${newT.emoji.id}-${newT.emoji.name}` : 'none');
                if (emojiChanged) changes.push(`- **Tag Emoji for** '\`${newT.name}\`' **updated:**\u2002${oldT.emoji ? formatEmoji(oldT) : '*No Emoji*'}  ➔  ${tagEmoji}`);
                if (oldT.moderated !== newT.moderated) changes.push(`- **Tag Permissions for** "\`${newT.name}\`" **updated:**\u2002\`${oldT.moderated ? 'Mods Only' : 'Everyone'}\`  ➔  \`${newT.moderated ? 'Mods Only' : 'Everyone'}\``);
            }
        });
    }

    // 9) Category (Parent)
    if (oldChannel.parentId !== newChannel.parentId) {
        changes.push(`- **Category changed:** \`${oldChannel.parent?.name || '*None*'}\` ➔ \`${newChannel.parent?.name || '*None*'}\``);
    }

    // 10) Category Permissions Sync Status
    if (oldChannel.permissionsLocked !== newChannel.permissionsLocked) {
        changes.push(`- **Category Sync:** \`${newChannel.permissionsLocked ? 'Synced with Category' : 'Custom Permissions'}\``);
    }

    // 11) Channel Permission Overwrites
    const oldOverwrites = oldChannel.permissionOverwrites.cache;
    const newOverwrites = newChannel.permissionOverwrites.cache;
    if (!oldOverwrites.equals(newOverwrites)) {
        // Handle Deleted Overwrites
        oldOverwrites.forEach((oldPerm, id) => {
            if (!newOverwrites.has(id)) {
                const targetTag = id === newChannel.guild.id ? '@everyone' : (newChannel.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`);
                changes.push(`**Overwrites for ${targetTag} removed!**`);
            }
        });

        // Handle Created or Updated Overwrites
        newOverwrites.forEach((newPerm, id) => {
            const oldPerm = oldOverwrites.get(id);
            const hasChanged = !oldPerm ||
                oldPerm.allow.bitfield !== newPerm.allow.bitfield ||
                oldPerm.deny.bitfield !== newPerm.deny.bitfield;

            if (hasChanged) {
                const targetTag = id === newChannel.guild.id ? '@everyone' : (newChannel.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`);
                let permChanges = [];

                for (const [permName, permBit] of Object.entries(PermissionsBitField.Flags)) {
                    const oldAllow = oldPerm ? oldPerm.allow.has(permBit) : false;
                    const oldDeny = oldPerm ? oldPerm.deny.has(permBit) : false;
                    const newAllow = newPerm.allow.has(permBit);
                    const newDeny = newPerm.deny.has(permBit);

                    if (oldAllow !== newAllow || oldDeny !== newDeny) {
                        const spacedName = permName.replace(/([A-Z])/g, ' $1').trim();
                        const getState = (allow, deny) => allow ? '✅' : (deny ? '❌' : '⬜');
                        permChanges.push(`- **${spacedName}: ${getState(oldAllow, oldDeny)} ➔ ${getState(newAllow, newDeny)}**`);
                    }
                }

                if (!oldPerm) {
                    // Logic for a brand new permission overwrite
                    if (permChanges.length === 0) {
                        changes.push(`**Overwrites for ${targetTag} created:**\n- **⚠️\u2002No permissions were selected!**`);
                    } else {
                        // Logic for a brand new permission overwrite that is quickly updated right after creation
                        changes.push(`**Overwrites for ${targetTag} created & configured:**\n${permChanges.join('\n')}`);
                    }
                } else if (permChanges.length > 0) {
                    changes.push(`**Overwrites for ${targetTag} updated:**\n${permChanges.join('\n')}`);
                }
            }
        });
    }

    if (changes.length === 0) return;

    const fields = isCategory ? [
        { name: 'Category Name', value: `${newChannel.name}`, inline: true },
        { name: 'Updated By', value: `${executor.mention} (${executor.username})`, inline: true },
        { name: '\u2002', value: '\u2002', inline: false },
        { name: '⚙️\u2002Changes:', value: changes.join('\n'), inline: false }
    ] : [
        { name: 'Name', value: `${newChannel.name}`, inline: true },
        { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
        { name: 'Category', value: parent, inline: true },
        { name: `Updated By`, value: `${executor.mention} (${executor.username})`, inline: false },
        { name: '\u2002', value: '\u2002', inline: false },
        { name: '⚙️\u2002Changes:', value: changes.join('\n'), inline: false }
    ];

    const logPayload = buildLogEmbed(
        isCategory ? `🔄\u2002Category Updated!\u2002${typeEmoji}` : `🔄\u2002${channelLabel} Updated: <#${newChannel.id}>`,
        null,
        newChannel.id,
        isCategory ? 0x9B59B6 : 0xFFA500, // Purple for category, Orange for channel
        typeName,
        fields
    );

    await logChannel.send(logPayload);
}
