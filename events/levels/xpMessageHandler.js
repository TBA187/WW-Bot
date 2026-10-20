// Award message XP and record eligible activity before cooldowns.
const { ChannelType } = require('discord.js');
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');

module.exports = {
    name: 'messageCreate',
    async execute(message, commandConfig) {
        // Ignore bots and DM messages
        if (message.author.bot || !message.guild) return;

        // Check if TEXT message XP is globally disabled
        if (!xpSettings.sources.textMessages) return;

        // Check if TEXT message XP is specifically disabled for Forum Posts or Threads (Public/Private) 
        const channel = message.channel;
        if (channel.isThread()) {
            const isForumPost = channel.parent && channel.parent.type === ChannelType.GuildForum;
            if (isForumPost && !xpSettings.sources.forumThreads) return; // Forum Post
            if (!isForumPost && channel.type === ChannelType.PublicThread && !xpSettings.sources.publicThreads) return;
            if (!isForumPost && channel.type === ChannelType.PrivateThread && !xpSettings.sources.privateThreads) return;
        }

        // Check if XP is specifically disabled for Voice Text Channels
        if (channel.isVoiceBased() && !xpSettings.sources.voiceTextChannels) return;

        // Extract message data for processing used by activity tracking and XP awards
        const { author, guild, channelId, member, content } = message;

        // Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
        const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
        if (tracksToAward.length === 0) return;

        // Count eligible activity even when an XP cooldown prevents an award.
        const displayName = member.displayName || member.user.globalName || member.user.username;
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            await recordRawActivity(commandConfig.db, author.id, guild.id, displayName, trackKey, 'message');
        }

        // Calculate base XP for TEXT Messages
        let xpGained = Math.floor(Math.random() * (xpSettings.messageXp.max - xpSettings.messageXp.min + 1)) + xpSettings.messageXp.min;

        // Calculate TEXT Message Length BONUS XP
        if (xpSettings.lengthBonusXp.enabled) {
            let userLength = 0;
            let requiredLength = 0;
            // Count words or characters according to the configured length rule.
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
                    // Exclude whitespace from the character count.
                    userLength = content.replace(/\s+/g, '').length;
                } else {
                    // Include whitespace in the character count.
                    userLength = content.length;
                }
            }

            // Check if they met the minimum threshold to earn length bonuses
            if (userLength >= requiredLength) {
                const intervals = Math.floor(userLength / requiredLength);
                let totalBonusXp = 0;

                // Roll a random bonus for each interval
                for (let i = 0; i < intervals; i++) {
                    // If the 'maxBonus' cap is already hit, stop calculating further
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
                // In length-only mode, short messages receive no base XP.
                if (!xpSettings.lengthBonusXp.stackWithBaseXp) {
                    xpGained = 0;
                }
            }
        }
        // Apply the configured minimum bonus when the earlier calculation gave no XP.
        if (xpGained <= 0) {
            const fallbackXp = xpSettings.lengthBonusXp.minBonus;
            if (fallbackXp && fallbackXp > 0) {
                xpGained = fallbackXp;
            }
        }
        // Attachment bonus, limited to the configured number of rewarded attachments.
        if (xpSettings.imageBonusXp.enabled && message.attachments.size > 0) {
            const imageCount = Math.min(message.attachments.size, xpSettings.imageBonusXp.maxImagesRewarded);
            for (let i = 0; i < imageCount; i++) {
                const imgXp = Math.floor(Math.random() * (xpSettings.imageBonusXp.max - xpSettings.imageBonusXp.min + 1)) + xpSettings.imageBonusXp.min;
                xpGained += imgXp;
            }
        }
        // Skip XP processing if the base, length, fallback and attachment awards total zero.
        if (xpGained <= 0) return;

        // Apply XP Boosts if any enabled, else use base 1.0x multiplier
        const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'messages');
        xpGained = Math.floor(xpGained * boostMultiplier);

        // Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            // Use the track's cooldown override when present, otherwise the global setting.
            const cooldownTimer = trackInfo.cooldownOverrides?.message || xpSettings.messageXp.cooldownTimer;
            if (commandConfig.onCooldown(author.id, `xp_msg_${trackKey}`, cooldownTimer)) continue;
            // Pass 'message' as the actionType
            await processXp(author.id, guild, channelId, member, xpGained, trackInfo, commandConfig, 'message');
        }
    }
};
