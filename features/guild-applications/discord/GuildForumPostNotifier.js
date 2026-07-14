'use strict';

// Sends the owner a compact review alert for new forum posts that are not valid applications.
const { EmbedBuilder } = require('discord.js');
const {
    EMBED_COLOR,
    addLongField,
    cleanForumMetadata,
    formatSubmittedDate,
    logoFile
} = require('./GuildApplicationNotifier.js');
const { TOPIC_URL } = require('../constants.js');

const NOT_AVAILABLE = '*N/A*';

class GuildForumPostNotifier {
    constructor(options = {}) {
        this.client = options.client;
        this.officerChannelId = String(options.officerChannelID || options.officerChannelId || '');
        this.ownerId = String(options.ownerID || options.ownerId || '');
        this.botTimezone = options.botTimezone || 'Etc/UTC';
        this.topicUrl = options.topicUrl || TOPIC_URL;
    }

    async getOfficerChannel() {
        if (!this.officerChannelId) throw new Error('Officer channel ID is not configured.');
        const channel = this.client.channels.cache.get(this.officerChannelId)
            || await this.client.channels.fetch(this.officerChannelId);
        if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
            throw new Error(`Officer channel ${this.officerChannelId} is not text-based or is unavailable.`);
        }
        return channel;
    }

    content(record) {
        return `<@${this.ownerId}>, a new message was detected on the **White Walkers guild application forum page**, but it was not classified as a valid guild application.\n`
            .trim();
    }

    embed(record) {
        const percentage = Math.round(Math.max(0, Math.min(1, Number(record.classificationConfidence || 0))) * 100);
        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setFooter({
                text: `Forum Post Created: ${formatSubmittedDate(record.postedAt, this.botTimezone)}`,
                iconURL: 'attachment://ww_logo.png'
            })
            .addFields(
                { name: 'Application likelihood', value: `**${percentage}%**`, inline: true },
                { name: 'Posted by Vangogsan', value: '**No**', inline: true },
                { name: 'View Forum Application', value: `[**Click Here!**](<${record.postUrl}>)`, inline: true },
                {
                    name: 'Forum Username',
                    value: String(record.forumUsername || '').trim() || NOT_AVAILABLE,
                    inline: false
                }
            );

        addLongField(embed, 'Message Content', cleanForumMetadata(record.rawBodyText) || NOT_AVAILABLE, false);
        return embed;
    }

    async notify(record) {
        if (!this.ownerId) throw new Error('Owner ID is not configured for forum post alerts.');
        const officerChannel = await this.getOfficerChannel();
        const message = await officerChannel.send({
            content: this.content(record),
            embeds: [this.embed(record)],
            files: [logoFile()],
            allowedMentions: { parse: [], users: [this.ownerId] }
        });
        record.notificationStatus = 'non_application_alert_sent';
        record.notifiedAt = new Date().toISOString();
        record.lastError = null;
        return { record, message };
    }
}

module.exports = {
    GuildForumPostNotifier
};
