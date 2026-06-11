// ===============================
// Level System - Command Handler
// ===============================
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, commandConfig) {
        // 1) Only track actual slash commands
        if (!interaction.isCommand()) return;

        // 2) Ignore bots and DM commands
        if (interaction.user.bot || !interaction.guild) return;

        // 3) Check if COMMAND XP is globally disabled
        if (!xpSettings.sources.commands) return;

        // 4) Extract message data for processing
        const { user, guild, channelId, member } = interaction;

        // 5) Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
        const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
        if (tracksToAward.length === 0) return;

        const displayName = member.displayName || member.user.globalName || member.user.username;
        for (const trackInfo of tracksToAward) {
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            await recordRawActivity(commandConfig.db, user.id, guild.id, displayName, trackKey, 'command');
        }

        // 6) Calculate XP for COMMANDS (No length bonus XP for Commands)
        let xpGained = Math.floor(Math.random() * (xpSettings.commandXp.max - xpSettings.commandXp.min + 1)) + xpSettings.commandXp.min;

        // 7) Apply XP Boosts if any enabled, else use base 1.0x multiplier
        const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'commands');
        xpGained = Math.floor(xpGained * boostMultiplier);

        // 8) Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
        for (const trackInfo of tracksToAward) {
            // Use a separate cooldown string for commands so chatting and commanding don't conflict
            const trackKey = getXpTypeFromTrackInfo(trackInfo);
            if (!trackKey) continue;
            // Check if cooldown is set for a Special Track, otherwise use Global cooldown
            const cooldownTimer = trackInfo.cooldownOverrides?.command || xpSettings.commandXp.cooldownTimer;
            if (commandConfig.onCooldown(user.id, `xp_cmd_${trackKey}`, cooldownTimer)) continue;
            // Pass 'command' as the actionType - Do not 'await' this in order to not slow down the interaction reply
            processXp(user.id, guild, channelId, member, xpGained, trackInfo, commandConfig, 'command').catch(err => {
                console.error('Failed to process command XP:', err);
            });
        }
    }
};
