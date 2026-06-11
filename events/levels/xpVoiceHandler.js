// =============================
// Level System - Voice Handler
// =============================
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateVoiceActivityMultiplier, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');

// Store active voice sessions in memory: userId -> timestamp (Date.now())
const voiceSessions = new Map();

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, commandConfig) {
        // Ignore bots
        if (newState.member?.user.bot) return;

        // Check if VOICE XP is globally disabled
        if (!xpSettings.sources.voice) return;

        const userId = newState.id;
        const guild = newState.guild;
        const member = newState.member;

        // --- Join/Leave checks with logic for Deaf/Mute ---
        // If someone is muted or mutes themselves, the bot treats it as if they "left" the channel and awards them XP up to that point.
        // When unmuted, it treats it like a "join" and restarts the timer to prevent afk-farming.

        // Granular Voice XP config checks
        const wasEligible = oldState.channelId !== null &&
            !(xpSettings.voiceXp.ignoreServerDeafened && oldState.serverDeaf) &&
            !(xpSettings.voiceXp.ignoreSelfDeafened && oldState.selfDeaf) &&
            !(xpSettings.voiceXp.ignoreServerMuted && oldState.serverMute) &&
            !(xpSettings.voiceXp.ignoreSelfMuted && oldState.selfMute);

        const isEligible = newState.channelId !== null &&
            !(xpSettings.voiceXp.ignoreServerDeafened && newState.serverDeaf) &&
            !(xpSettings.voiceXp.ignoreSelfDeafened && newState.selfDeaf) &&
            !(xpSettings.voiceXp.ignoreServerMuted && newState.serverMute) &&
            !(xpSettings.voiceXp.ignoreSelfMuted && newState.selfMute);

        // State Changes based on Eligibility instead of just channel ID
        const joinedChannel = !wasEligible && isEligible;
        const leftChannel = wasEligible && !isEligible;
        const switchedChannel = wasEligible && isEligible && oldState.channelId !== newState.channelId;

        // Detect Voice Activity Change: If they stayed in the channel but toggled Stream or Camera,
        // treat it as a "switch" to award the old XP rate and start the new one.
        const activityToggled = wasEligible && isEligible && (
            oldState.streaming !== newState.streaming ||
            oldState.selfVideo !== newState.selfVideo
        );

        // User Joins a VC (or becomes eligible)
        if (joinedChannel) {
            voiceSessions.set(userId, Date.now());
            return;
        }

        // If a user switches channels, calculate their time in the old channel, award it, and restart the timer
        // If a user leaves entirely, calculate and award.
        if (leftChannel || switchedChannel || activityToggled) {
            if (!voiceSessions.has(userId)) {
                // If they switch, start a new timer
                if (switchedChannel || activityToggled) voiceSessions.set(userId, Date.now());
                return;
            }

            const joinTime = voiceSessions.get(userId);
            const leaveTime = Date.now();

            // If they are leaving, clear the session. If switching, reset to current time.
            if (leftChannel) voiceSessions.delete(userId);
            if (switchedChannel || activityToggled) voiceSessions.set(userId, Date.now());

            // Calculate total minutes spent
            const durationMs = leaveTime - joinTime;

            // Use the channel they just LEFT to determine XP
            const channelId = oldState.channelId;

            // Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
            const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
            if (tracksToAward.length === 0) return;

            const minutesSpent = Math.floor(durationMs / 60000);
            const displayName = member.displayName || member.user.globalName || member.user.username;

            for (const trackInfo of tracksToAward) {
                const trackKey = getXpTypeFromTrackInfo(trackInfo);
                if (!trackKey) continue;
                await recordRawActivity(commandConfig.db, userId, guild.id, displayName, trackKey, 'voice', minutesSpent);

                // XP Cooldown: Check if this specific Track has a custom minTimeForXp
                // If 'minTimeForXp' is set to 60 seconds, and a user is in a voice channel for 59 seconds,
                // they get 0 XP. If they stay for 60 seconds, they get 1 minute's worth of XP.
                const minTimeSecs = trackInfo.cooldownOverrides?.voiceMinTime || xpSettings.voiceXp.minTimeForXp || 60;
                const minMsRequired = minTimeSecs * 1000;

                // If they didn't meet the required time for THIS track, skip it
                if (durationMs < minMsRequired) continue;

                // Calculate minutes spent based on the track's requirement rules
                if (minutesSpent < 1) continue;

                // Calculate XP (Random XP between Min/Max MULTIPLIED by minutes spent)
                const minXp = xpSettings.voiceXp.xpPerMinuteMin;
                const maxXp = xpSettings.voiceXp.xpPerMinuteMax;
                let totalXpGained = 0;
                for (let i = 0; i < minutesSpent; i++) {
                    totalXpGained += Math.floor(Math.random() * (maxXp - minXp + 1)) + minXp;
                }

                // --- Apply XP BONUSES ---
                // Apply Voice Activity Bonuses (Streaming/Camera On)
                const activityMultiplier = calculateVoiceActivityMultiplier(oldState);
                // Apply XP Boosts if any enabled, else use base 1.0x multiplier
                const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'voice');

                // Calculate final multiplier based on boost stacking strageties
                let finalMultiplier;
                if (xpSettings.boostStackStrategy === 'additive') {
                    // Convert multipliers (e.g. 1.5) back to decimal bonuses (0.5)
                    const activityBonus = activityMultiplier - 1;
                    const boostBonus = boostMultiplier - 1;
                    // Add them together: 1 + 0.5 + 1.0 = 2.5x
                    finalMultiplier = 1 + activityBonus + boostBonus;
                } else if (xpSettings.boostStackStrategy === 'compound') {
                    // Compound them: 1.5 * 2.0 = 3.0x
                    finalMultiplier = activityMultiplier * boostMultiplier;
                }

                // Apply final multiplier to total XP ONCE to maintain precision
                totalXpGained = Math.floor(totalXpGained * finalMultiplier);

                // Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
                // Pass 'voice' as action type, and 'minutesSpent' as the stat count
                await processXp(userId, guild, channelId, member, totalXpGained, trackInfo, commandConfig, 'voice', minutesSpent);
            }
        }
    }
};
