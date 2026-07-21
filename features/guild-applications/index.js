'use strict';

// Keeps the guild-application feature wiring in one place for the bot startup code.
const { GuildApplicationMonitor } = require('./GuildApplicationMonitor.js');
const { ProForumClient } = require('./forum/ProForumClient.js');
const { GuildApplicationParser } = require('./parsing/GuildApplicationParser.js');
const { GuildApplicationOcr } = require('./parsing/GuildApplicationOcr.js');
const { GuildApplicationStore } = require('./storage/GuildApplicationStore.js');
const { GuildApplicationNotifier } = require('./discord/GuildApplicationNotifier.js');
const {
    GuildForumPostNotifier,
    handleGuildForumFeedbackButton
} = require('./discord/GuildForumPostNotifier.js');
const { GuildApplicationVoteReminder } = require('./discord/GuildApplicationVoteReminder.js');

function createGuildApplicationMonitor(options = {}) {
    const config = options.config || {};
    const topicUrl = config.forumGuildApplicationPage;
    const ignoredUsers = config.forumGuildApplicationIgnoredUsers;
    const forumClient = options.forumClient || new ProForumClient({
        fetch: options.fetch,
        topicUrl,
        ignoredUsers
    });
    const parser = options.parser || new GuildApplicationParser({ ignoredUsers });
    const ocr = options.ocr || new GuildApplicationOcr(options.ocrOptions);
    const store = options.store || new GuildApplicationStore({
        db: options.db,
        storageMode: options.storageMode,
        dataFile: options.dataFile
    });
    const notifier = options.notifier || new GuildApplicationNotifier({
        client: options.client,
        guildId: config.guildId,
        officerChannelID: config.officerChannelID,
        courtHouseChannelID: config.courtHouseChannelID,
        officerRoleID: config.officerRoleID,
        botTimezone: config.botTimezone,
        topicUrl,
        clock: options.clock
    });
    const voteReminder = options.voteReminder || new GuildApplicationVoteReminder({
        client: options.client,
        store,
        guildId: config.guildId,
        courtHouseChannelID: config.courtHouseChannelID,
        officerRoleID: config.officerRoleID,
        clock: options.clock,
        intervalMs: options.voteReminderIntervalMs
    });
    const nonApplicationNotifier = options.nonApplicationNotifier || new GuildForumPostNotifier({
        client: options.client,
        officerChannelID: config.officerChannelID,
        ownerID: config.ownerID,
        botTimezone: config.botTimezone,
        topicUrl
    });
    return new GuildApplicationMonitor({
        client: options.client,
        forumClient,
        parser,
        ocr,
        store,
        notifier,
        nonApplicationNotifier,
        voteReminder,
        topicUrl,
        reapplicationCooldownHours: config.forumGuildApplicationCooldownHours,
        clock: options.clock,
        intervalMs: options.intervalMs
    });
}

module.exports = {
    GuildApplicationMonitor,
    GuildApplicationNotifier,
    GuildForumPostNotifier,
    GuildApplicationOcr,
    GuildApplicationParser,
    GuildApplicationStore,
    GuildApplicationVoteReminder,
    handleGuildForumFeedbackButton,
    ProForumClient,
    createGuildApplicationMonitor
};
