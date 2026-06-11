// =============================
// UTILS: Shared Logging Logic
// ============================
const { ChannelType, EmbedBuilder, AttachmentBuilder } = require('discord.js');

module.exports = {
    // Helper to pause execution (replaces new Promise(res => setTimeout(res, 1500)))
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    // Helper to check if a channel/thread should be ignored for logging
    isBlockedLogChannel: (channelId, ignoredLogChannels) => {
        return ignoredLogChannels && ignoredLogChannels.includes(channelId);
    },

    // Helper to fetch and find the correct audit log entry
    // Updated Helper to be more robust
    fetchTargetAuditLog: async (guild, actionType, targetId, maxAgeMs = 15000) => {
        if (!guild) return null;
        try {
            // Increase limit to 10 to ensure we don't miss the entry if 
            // multiple things happen at once.
            const fetchedLogs = await guild.fetchAuditLogs({ limit: 10 });

            return fetchedLogs.entries.find(e => {
                // 1. Match the action type (if provided)
                // If actionType is null/undefined, we skip this check (useful for permission batches)
                if (actionType && e.action !== actionType) return false;

                // 2. Check the timing (did it happen recently?)
                const isRecent = (Date.now() - e.createdTimestamp) < maxAgeMs;
                if (!isRecent) return false;

                // 3. THE CRITICAL FIX: Check targetId (raw string) OR extra data
                // This covers standard Create/Delete AND the tricky Permission Overwrites
                return (
                    e.targetId === targetId ||
                    e.extra?.channel?.id === targetId ||
                    e.extra?.id === targetId
                );
            });
        } catch (error) {
            console.error("Error fetching audit logs:", error);
            return null;
        }
    },

    // Helper to standardize getting the user who performed the action
    extractExecutor: (entry, fallbackId = null, guild = null) => {
        const user = entry?.executor;
        const member = (user && guild) ? guild.members.cache.get(user.id) : (fallbackId ? guild?.members.cache.get(fallbackId) : null);

        return {
            mention: user ? `<@${user.id}>` : (fallbackId ? `<@${fallbackId}>` : 'Unknown User'),
            id: user?.id || fallbackId || 'Unknown User ID',
            tag: user?.tag || 'Unknown User Tag',
            username: user?.username || 'Unknown Username',
            nickname: member?.nickname || 'No Nickname', // Server specific Nickname
            globalName: user?.displayName || 'No Global Name', // Discord Global Display Name
            avatar: user?.displayAvatarURL() || null
        };
    },

    // Helper to turn ChannelType numbers into readable text
    getChannelTypeInfo: (type) => {
        const types = {
            [ChannelType.GuildText]: { name: 'Text Channel', emoji: '💬' },
            [ChannelType.GuildVoice]: { name: 'Voice Channel', emoji: '🔊' },
            [ChannelType.GuildCategory]: { name: 'Category', emoji: '📂' },
            [ChannelType.GuildAnnouncement]: { name: 'Announcement Channel', emoji: '📢' },
            [ChannelType.AnnouncementThread]: { name: 'Announcement Thread', emoji: '📢 🧵' },
            [ChannelType.PublicThread]: { name: 'Public Thread', emoji: '🧵' },
            [ChannelType.PrivateThread]: { name: 'Private Thread', emoji: '🔐 🧵' },
            [ChannelType.GuildStageVoice]: { name: 'Stage Channel', emoji: '🎤' },
            [ChannelType.GuildForum]: { name: 'Forum Channel', emoji: '🗂️' },
            // [ChannelType.GuildForum]: { name: 'Forum Post', emoji: '🗨️' },
            [ChannelType.GuildMedia]: { name: 'Media Channel', emoji: '🖼️' },
            [ChannelType.GuildDirectory]: { name: 'Directory Channel (Student Hub)', emoji: '📇' },
            // [ChannelType.PublicThread]: { name: 'Thread', emoji: '#️⃣' },
        };

        return types[type] || { name: 'Unknown Channel Type', emoji: '❓' };
    },

    // Emoji Helper
    formatEmoji: (data) => {
        if (!data) return '';
        let eId = null;
        let eName = null;

        if (data.emoji !== undefined) {
            if (!data.emoji) return '';
            eId = data.emoji.id;
            eName = data.emoji.name;
        } else {
            eId = data.id || data.emojiId;
            eName = data.name || data.emojiName;
        }

        if (eId) {
            const safeName = eName ? eName.replace(/[^a-zA-Z0-9_]/g, '') : 'e';
            return `<:${safeName}:${eId}>`;
        }

        if (eName) return eName;
        return '';
    },

    // Channel Role Permissions Formatter
    formatViewChannelPerms: (overwrites, guild, typeName) => {
        if (!overwrites || overwrites.size === 0) return '- **Default Permissions (Public Category)**';

        let permStrings = [];
        overwrites.forEach((perm, id) => {
            const isEveryone = id === guild.id;
            const isRole = guild.roles.cache.has(id);
            let targetLabel = 'Role';
            let targetTag;
            if (isEveryone) {
                targetTag = '@everyone';
            } else if (isRole) {
                const role = guild.roles.cache.get(id);
                targetTag = `<@&${id}> (${role.name})`;
            } else {
                targetLabel = 'Member';
                const member = guild.members.cache.get(id);
                targetTag = `<@${id}> (${member.user.username})`;
            }

            const canView = perm.allow.has('ViewChannel');
            const cannotView = perm.deny.has('ViewChannel');
            if (canView) {
                permStrings.push(`**${targetLabel} override for ${targetTag}**\n- View Channel  ➔  ✅`);
            } else if (cannotView) {
                permStrings.push(`**${targetLabel} override for ${targetTag}**\n- View Channel  ➔  ❌`);
            }
        });
        return permStrings.length > 0 ? permStrings.join('\n') : `- **Default Permissions (Public ${typeName})**`;
    },

    // Build embed message for Discord Logs
    buildLogEmbed: (title, description, id, color, typeName, fields = []) => {
        const attachment = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(color)
            .setDescription(description || ' ')
            .addFields(fields)
            .setFooter({ text: `${typeName} ID: ${id}`, iconURL: 'attachment://ww_logo.png' })
            .setTimestamp();

        return { embeds: [embed], files: [attachment] };
    }
};
