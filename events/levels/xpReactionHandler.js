// ================================
// Level System - Reaction Handler
// ================================
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');

module.exports = {
    name: 'messageReactionAdd',
    async execute(...args) {
        const reaction = args[0];
        const user = args[1];
        const commandConfig = args[args.length - 1];
        if (!commandConfig?.onCooldown) {
            console.error("Invalid commandConfig:", commandConfig);
            return;
        }
        if (reaction.partial) {
            try { await reaction.fetch(); } catch (error) { return; }
        }

        // 1) Ignore bots and DM messages
        if (user.bot || !reaction.message.guild) return;

        // 2) Check if Message REACTIONS XP is globally disabled
        if (!xpSettings.sources.reactions) return;

        // 3) Extract message data for processing
        const userId = user.id;
        const guild = reaction.message.guild;
        const channelId = reaction.message.channel.id;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        // 4) Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
        const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
        if (tracksToAward.length === 0) return;

        const displayName = member.displayName || member.user.globalName || member.user.username;
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            await recordRawActivity(commandConfig.db, userId, guild.id, displayName, trackKey, 'reaction');
        }

        // 5) Calculate XP for Message REACTIONS (No length bonus XP for Reactions)
        let xpGained = Math.floor(Math.random() * (xpSettings.reactionXp.max - xpSettings.reactionXp.min + 1)) + xpSettings.reactionXp.min;

        // 6) Apply XP Boosts if any enabled, else use base 1.0x multiplier
        const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'reactions');
        xpGained = Math.floor(xpGained * boostMultiplier);

        // 7) Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            // Check if cooldown is set for a Special Track, otherwise use Global cooldown
            const cooldownTimer = trackInfo.cooldownOverrides?.reaction || xpSettings.reactionXp.cooldownTimer;
            if (commandConfig.onCooldown(userId, `xp_react_${trackKey}`, cooldownTimer)) continue;
            // Pass 'reaction' as the actionType
            await processXp(userId, guild, channelId, member, xpGained, trackInfo, commandConfig, 'reaction');
        }
    }
};
