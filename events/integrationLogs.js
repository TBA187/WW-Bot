// ================================
// LOG Webhook & Integration Events
// ================================

const { AuditLogEvent, ChannelType } = require('discord.js');

module.exports = {
    async handleWebhookUpdate(channel, config) {
        if (!channel.guild) return;

        // Ignore log events for specified channels
        if (config.ignoredLogChannels && config.ignoredLogChannels.includes(channel.id)) return;

        const logChannel = channel.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await new Promise(res => setTimeout(res, 2000));

        const fetchedLogs = await channel.guild.fetchAuditLogs({
            limit: 10
        });

        const entry = fetchedLogs.entries.find(e =>
            [
                AuditLogEvent.WebhookCreate,
                AuditLogEvent.WebhookUpdate,
                AuditLogEvent.WebhookDelete,
                AuditLogEvent.IntegrationCreate,
                AuditLogEvent.IntegrationUpdate,
                AuditLogEvent.IntegrationDelete
            ].includes(e.action) &&
            // Check if it belongs to this channel, or fallback to catching the most recent one
            (e.target?.channelId === channel.id || !e.target?.channelId) &&
            Date.now() - e.createdTimestamp < 15000
        );

        if (!entry) return;

        // Action labels and emoji
        let actionLabel = "Updated";
        let emoji = "🔄";
        if ([AuditLogEvent.WebhookCreate, AuditLogEvent.IntegrationCreate].includes(entry.action)) {
            actionLabel = "Created";
            emoji = "✅";
        } else if ([AuditLogEvent.WebhookDelete, AuditLogEvent.IntegrationDelete].includes(entry.action)) {
            actionLabel = "Deleted";
            emoji = "❌";
        }

        // Identify if it's a Webhook or a standard Integration
        const isWebhook = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete].includes(entry.action);
        const typeLabel = isWebhook ? "Webhook" : "Integration";
        let isMovedTxT = null;

        // Extract updates
        let detailChanges = [];
        const isUpdate = entry.action === AuditLogEvent.WebhookUpdate || entry.action === AuditLogEvent.IntegrationUpdate;
        if (isUpdate && entry.changes) {
            entry.changes.forEach(change => {
                const key = change.key;
                const oldVal = change.old ?? '*None*';
                const newVal = change.new ?? '*None*';

                if (key === 'name') {
                    detailChanges.push(`- **Name Changed:** \`${oldVal}\` ➔ \`${newVal}\``);
                } else if (key === 'channel_id') {
                    isMovedTxT = `:  <#${oldVal}>  ➔  <#${newVal}>`;
                    detailChanges.push(`- **Switched Channel:**\n  - **Old Channel:** <#${oldVal}>\n  - **New Channel:** <#${newVal}>`);
                } else if (key === 'avatar_hash') {
                    detailChanges.push(`- **Avatar Updated**  🖼️\n  - **Old Avatar:** \`${oldVal}\`\n  - **New Avatar:** \`${newVal}\``);
                } else {
                    // Fallback for other potential properties
                    detailChanges.push(`- **Property \`${key}\` changed:** \`${oldVal}\` ➔ \`${newVal}\``);
                }
            });
        }

        const changeText = detailChanges.length > 0 ? `### ⚙️  Changes:\n${detailChanges.join('\n')}\n` : '';
        const executor = entry.executor ? `<@${entry.executor.id}>` : 'Unknown User';
        const executorName = entry.executor ? `${entry.executor.username}` : 'Unknown Username';
        const parent = channel.parent ? `${channel.parent.name}` : '*Uncategorized!*';
        const parentID = channel.parent ? `${channel.parent.id}` : '*No Category ID!*';
        let channelTypeLabel = "Channel";
        if (channel.type === ChannelType.GuildVoice) channelTypeLabel = "Voice Channel";
        else if (channel.type === ChannelType.GuildForum) channelTypeLabel = "Forum Channel";
        else if (channel.type === ChannelType.GuildAnnouncement) channelTypeLabel = "Announcement Channel";
        else if (channel.type === ChannelType.GuildStageVoice) channelTypeLabel = "Stage Channel";
        const isMovedLabel = isMovedTxT ? isMovedTxT : ` in <#${channel.id}>`;

        await logChannel.send(
            `## ${emoji}  ${typeLabel} ${actionLabel}${isMovedLabel}\n` +
            `- **${typeLabel}:** \`${entry.target?.name || 'Unknown'}\`  🔗\n` +
            `- **${channelTypeLabel} Name:** \`#${channel.name}\`  —  **ID:** \`${channel.id}\`\n` +
            `- **${channelTypeLabel} Category:** \`${parent}\`  —  **ID:** \`${parentID}\`\n` +
            `${changeText}\n` +
            `**${actionLabel} By:** ${executor} (${executorName})  —  <t:${Math.floor(Date.now() / 1000)}:F>`
        );
    }
};
