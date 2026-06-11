// ===============================
// Level System - Message Handler
// ===============================
const { ChannelType } = require('discord.js');
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');

module.exports = {
    name: 'messageCreate',
    async execute(message, commandConfig) {
        // 1) Ignore bots and DM messages
        if (message.author.bot || !message.guild) return;

        // 2) Check if TEXT message XP is globally disabled
        if (!xpSettings.sources.textMessages) return;

        // 3) Check if TEXT message XP is specifically disabled for Forum Posts or Threads (Public/Private) 
        const channel = message.channel;
        if (channel.isThread()) {
            const isForumPost = channel.parent && channel.parent.type === ChannelType.GuildForum;
            if (isForumPost && !xpSettings.sources.forumThreads) return; // Forum Post
            if (!isForumPost && channel.type === ChannelType.PublicThread && !xpSettings.sources.publicThreads) return;
            if (!isForumPost && channel.type === ChannelType.PrivateThread && !xpSettings.sources.privateThreads) return;
        }

        // 4) Check if XP is specifically disabled for Voice Text Channels
        if (channel.isVoiceBased() && !xpSettings.sources.voiceTextChannels) return;

        // 5) Extract message data for processing
        const { author, guild, channelId, member, content } = message;

        // 6) Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
        const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
        if (tracksToAward.length === 0) return;

        const displayName = member.displayName || member.user.globalName || member.user.username;
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            await recordRawActivity(commandConfig.db, author.id, guild.id, displayName, trackKey, 'message');
        }

        // 7) Calculate XP for TEXT Messages
        let xpGained = Math.floor(Math.random() * (xpSettings.messageXp.max - xpSettings.messageXp.min + 1)) + xpSettings.messageXp.min;

        // 8) Calculate TEXT Message Length BONUS XP
        if (xpSettings.lengthBonusXp.enabled) {
            let userLength = 0;
            let requiredLength = 0;

            // Determine if count by words or characters is selected
            if (xpSettings.lengthBonusXp.calculationMethod === 'words') {
                requiredLength = xpSettings.lengthBonusXp.wordsRequired;
                if (xpSettings.lengthBonusXp.ignoreSpaces) {
                    // Removes all whitespace before counting words
                    userLength = content.trim().split(/\s+/).filter(word => word.length > 0).length;
                } else {
                    // Include all whitespaces
                    userLength = content.split(' ').length;
                }
            } else {
                requiredLength = xpSettings.lengthBonusXp.charsRequired;
                if (xpSettings.lengthBonusXp.ignoreSpaces) {
                    // Removes all whitespace before counting characters
                    userLength = content.replace(/\s+/g, '').length;
                } else {
                    // Include all whitespaces
                    userLength = content.length;
                }
            }

            // Check if they met the minimum threshold to earn length bonuses
            if (userLength >= requiredLength) {
                const intervals = Math.floor(userLength / requiredLength);
                let totalBonusXp = 0;

                // Roll a random bonus for each interval
                for (let i = 0; i < intervals; i++) {
                    // Optimization: If the 'maxBonus' cap is already hit, stop calculating further
                    if (totalBonusXp >= xpSettings.lengthBonusXp.maxBonus) break;

                    const randomBonus = Math.floor(Math.random() * (xpSettings.lengthBonusXp.xpPerIntervalMax - xpSettings.lengthBonusXp.xpPerIntervalMin + 1)) + xpSettings.lengthBonusXp.xpPerIntervalMin;
                    totalBonusXp += randomBonus;
                }

                // Apply the Max Bonus cap to prevent essay-spam farming
                totalBonusXp = Math.min(totalBonusXp, xpSettings.lengthBonusXp.maxBonus);

                // Check if Bonus XP should stack with Global XP, or stand alone
                if (xpSettings.lengthBonusXp.stackWithBaseXp) {
                    xpGained += totalBonusXp; // Stacked: Base + Bonus
                } else {
                    xpGained = totalBonusXp; // Standalone: Overrides base random message XP entirely
                }
            } else {
                // If they did NOT meet the length requirement...
                if (!xpSettings.lengthBonusXp.stackWithBaseXp) {
                    // ...and the server is set to ONLY reward length XP, they get 0 XP for this message.
                    xpGained = 0;
                }
            }
        }

        // If xpGained became 0, check for a fallback minimum bonus.
        // XP became 0 because the message was too short and didin't meet the specified min requirements for Length XP above.
        if (xpGained <= 0) {
            const fallbackXp = xpSettings.lengthBonusXp.minBonus;
            // Apply MIN BONUS XP for short messages IF enabled
            if (fallbackXp && fallbackXp > 0) {
                xpGained = fallbackXp;
            }
        }

        // 9) Calculate Attachments BONUS XP (Images/Videos)
        if (xpSettings.imageBonusXp.enabled && message.attachments.size > 0) {
            const imageCount = Math.min(message.attachments.size, xpSettings.imageBonusXp.maxImagesRewarded);
            for (let i = 0; i < imageCount; i++) {
                const imgXp = Math.floor(Math.random() * (xpSettings.imageBonusXp.max - xpSettings.imageBonusXp.min + 1)) + xpSettings.imageBonusXp.min;
                xpGained += imgXp;
            }
        }

        // 10) Final Safety Check: If after ALL calculations (base, length, fallback, attachments) 
        // the XP is still 0, abort early to save database resources!
        if (xpGained <= 0) return;

        // 11) Apply XP Boosts if any enabled, else use base 1.0x multiplier
        const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'messages');
        xpGained = Math.floor(xpGained * boostMultiplier);

        // 12) Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            // Check if cooldown is set for a Special Track, otherwise use Global cooldown
            const cooldownTimer = trackInfo.cooldownOverrides?.message || xpSettings.messageXp.cooldownTimer;
            if (commandConfig.onCooldown(author.id, `xp_msg_${trackKey}`, cooldownTimer)) continue;
            // Pass 'message' as the actionType
            await processXp(author.id, guild, channelId, member, xpGained, trackInfo, commandConfig, 'message');
        }
    }
};
