// Track eligible voice sessions and award XP at the previous channel activity rate.
const xpSettings = require('../../config/xpConfig');
const { getXPTracksForUser, calculateVoiceActivityMultiplier, calculateXpBoostMultiplier } = require('../../utils/xpHelper');
const { processXp } = require('../../utils/xpEngine');
const { recordRawActivity, getXpTypeFromTrackInfo } = require('../../utils/xpDbHelper');
// Keep voice timers separate for each client; each timer is keyed by guild and member.
const sessionsByClient = new WeakMap();

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, commandConfig) {
        // Ignore bots
        if (newState.member?.user?.bot) return;

        // Check if VOICE XP is globally disabled
        if (!xpSettings.sources.voice) return;

        const userId = newState.id;
        const guild = newState.guild;
        const member = newState.member;
        const sessionOwner = commandConfig.client || commandConfig;
        let voiceSessions = sessionsByClient.get(sessionOwner);
        if (!voiceSessions) {
            voiceSessions = new Map();
            sessionsByClient.set(sessionOwner, voiceSessions);
        }
        const sessionKey = `${guild.id}:${userId}`;
        // Missing members cannot be checked for track eligibility; discard their old timer.
        if (!member) {
            voiceSessions.delete(sessionKey);
            return;
        }

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
        // Treat eligibility changes as joins or departures, even within the same channel.
        const joinedChannel = !wasEligible && isEligible;
        const leftChannel = wasEligible && !isEligible;
        const switchedChannel = wasEligible && isEligible && oldState.channelId !== newState.channelId;
        // A stream or camera change ends the old activity rate and starts the new one.
        const activityToggled = wasEligible && isEligible && (
            oldState.streaming !== newState.streaming ||
            oldState.selfVideo !== newState.selfVideo
        );
        // Start timing when the member joins a channel or becomes eligible again.
        if (joinedChannel) {
            voiceSessions.set(sessionKey, Date.now());
            return;
        }

        // If a user switches channels, calculate their time in the old channel, award it, and restart the timer
        // If a user leaves entirely, calculate and award.
        if (leftChannel || switchedChannel || activityToggled) {
            if (!voiceSessions.has(sessionKey)) {
                // After a restart, start from this event rather than guessing earlier activity.
                if (switchedChannel || activityToggled) voiceSessions.set(sessionKey, Date.now());
                return;
            }

            const joinTime = voiceSessions.get(sessionKey);
            const leaveTime = Date.now();
            // Advance the session before awaiting storage; another state event may arrive meanwhile.
            if (leftChannel) voiceSessions.delete(sessionKey);
            if (switchedChannel || activityToggled) voiceSessions.set(sessionKey, leaveTime);
            // Measure elapsed time using the previous session's start.
            const durationMs = leaveTime - joinTime;
            // Eligibility and boosts belong to the channel where this time was spent.
            const channelId = oldState.channelId;

            // Hand over to xpHelper.js - Shared logic to check for Master Blacklist, Special XP Tracks, and Global XP Check
            const tracksToAward = await getXPTracksForUser(member, channelId, commandConfig.db);
            if (tracksToAward.length === 0) return;

            // Only complete minutes count toward voice activity and XP.
            const minutesSpent = Math.floor(durationMs / 60000);
            const displayName = member.displayName || member.user.globalName || member.user.username;

            for (const trackInfo of tracksToAward) {
                const trackKey = getXpTypeFromTrackInfo(trackInfo);
                if (!trackKey) continue;
                // Record activity even if the track's minimum XP duration has not been met.
                await recordRawActivity(commandConfig.db, userId, guild.id, displayName, trackKey, 'voice', minutesSpent);

                // XP Cooldown: Check if this specific Track has a custom minTimeForXp
                // If 'minTimeForXp' is set to 60 seconds, and a user is in a voice channel for 59 seconds,
                // they get 0 XP. If they stay for 60 seconds, they get 1 minute's worth of XP.
                const minTimeSecs = trackInfo.cooldownOverrides?.voiceMinTime || xpSettings.voiceXp.minTimeForXp || 60;
                const minMsRequired = minTimeSecs * 1000;
                // Both the track's threshold and one full minute must be reached.
                if (durationMs < minMsRequired) continue;
                if (minutesSpent < 1) continue;
                // Roll the configured random XP amount separately for each complete minute.
                const minXp = xpSettings.voiceXp.xpPerMinuteMin;
                const maxXp = xpSettings.voiceXp.xpPerMinuteMax;
                let totalXpGained = 0;
                for (let i = 0; i < minutesSpent; i++) {
                    totalXpGained += Math.floor(Math.random() * (maxXp - minXp + 1)) + minXp;
                }

                // --- Apply XP BONUSES ---
                // Apply Voice Activity Bonuses (Streaming/Camera On)
                const activityMultiplier = calculateVoiceActivityMultiplier(oldState);
                // Add configured member and channel boosts, or use 1 when none apply.
                const boostMultiplier = calculateXpBoostMultiplier(member, channelId, 'voice');
                // Combine activity and XP boosts using the configured stacking strategy.
                let finalMultiplier;
                if (xpSettings.boostStackStrategy === 'additive') {
                    // Add only the bonuses above 1x: 1.5x and 2x become 2.5x.
                    const activityBonus = activityMultiplier - 1;
                    const boostBonus = boostMultiplier - 1;
                    finalMultiplier = 1 + activityBonus + boostBonus;
                } else if (xpSettings.boostStackStrategy === 'compound') {
                    // Multiply the full rates: 1.5x and 2x become 3x.
                    finalMultiplier = activityMultiplier * boostMultiplier;
                }
                // Round once after all boosts to avoid losing fractional XP at each step.
                totalXpGained = Math.floor(totalXpGained * finalMultiplier);

                // Hand over to xpEngine.js - Shared logic to process XP, update DB, and handle level-ups.
                // Pass 'voice' as action type, and 'minutesSpent' as the stat count
                await processXp(userId, guild, channelId, member, totalXpGained, trackInfo, commandConfig, 'voice', minutesSpent);
            }
        }
    }
};
