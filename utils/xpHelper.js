// ==========================
// Utility - XP Helper
// ==========================
const xpSettings = require('../config/xpConfig');
const { fetchSpecialTracks } = require('./xpDbHelper');

/**
 * Shared logic to determine which XP tracks a user should be awarded XP for.
 * Calculates master blacklists, whitelists, global checks, and multiple role intersections.
 */
async function getXPTracksForUser(member, channelId, db) {
    // 1) Check Master Blacklists first (Blacklist overrides everything)
    const isBlacklistedUser = xpSettings.global.blackListUsers && xpSettings.global.blackListUsers.includes(member.id);
    const isBlacklistedRole = xpSettings.global.blackListRoles && member.roles.cache.some(r => xpSettings.global.blackListRoles.includes(r.id));
    const isBlacklistedChannel = xpSettings.global.blackListChannels && xpSettings.global.blackListChannels.includes(channelId);

    // If user, their role, or the channel is blacklisted, they get ZERO XP.
    if (isBlacklistedUser || isBlacklistedRole || isBlacklistedChannel) return [];

    // 2) Check Master Whitelists (If array has items, they MUST be in it. If empty, ignore whitelist)
    const requiresUserWhitelist = xpSettings.global.whiteListUsers && xpSettings.global.whiteListUsers.length > 0;
    const requiresRoleWhitelist = xpSettings.global.whiteListRoles && xpSettings.global.whiteListRoles.length > 0;
    const requiresChannelWhitelist = xpSettings.global.whiteListChannels && xpSettings.global.whiteListChannels.length > 0;

    const isWhitelistedUser = !requiresUserWhitelist || xpSettings.global.whiteListUsers.includes(member.id);
    const hasWhitelistedRole = !requiresRoleWhitelist || member.roles.cache.some(r => xpSettings.global.whiteListRoles.includes(r.id));
    const inWhitelistedChannel = !requiresChannelWhitelist || xpSettings.global.whiteListChannels.includes(channelId);

    // If a whitelist is active and they don't meet ALL active whitelist criteria, they get ZERO XP.
    if (!isWhitelistedUser || !hasWhitelistedRole || !inWhitelistedChannel) return [];

    let tracksToAward = [];

    // 3) Check for Special XP Tracks
    if (xpSettings.specialTracksEnabled) {
        // Fetch tracks from database on-demand
        const tracks = await fetchSpecialTracks(db);
        
        // Process tracks to determine type
        const processedTracks = tracks.map(track => {
            let derivedType = 'invalid';

            const hasRoles = track.roleIds && track.roleIds.length > 0;
            const hasChannels = track.channelIds && track.channelIds.length > 0;

            if (hasRoles && hasChannels) {
                derivedType = 'both_role_channel';
            } else if (hasRoles) {
                derivedType = 'role_only';
            } else if (hasChannels) {
                derivedType = 'channel_only';
            }

            return {
                ...track,
                type: derivedType
            };
        }).filter(track => track.type !== 'invalid');

        for (const track of processedTracks) {
            const hasRole = track.roleIds && track.roleIds.length > 0 ? track.roleIds.some(roleId => member.roles.cache.has(roleId)) : false;
            const inChannel = track.channelIds && track.channelIds.length > 0 ? track.channelIds.includes(channelId) : false;
            let matches = false;
            let dbTrackName = '';

            // Using the automatically derived type
            switch (track.type) {
                case 'role_only':
                    matches = hasRole;
                    // Use numeric track ID from database
                    dbTrackName = track.id.toString();
                    break;

                case 'channel_only':
                    matches = inChannel;
                    // Use numeric track ID from database
                    dbTrackName = track.id.toString();
                    break;

                case 'both_role_channel':
                    matches = hasRole && inChannel;
                    // Use numeric track ID from database
                    dbTrackName = track.id.toString();
                    break;
            }

            // If the special track requirements are met, add it to the list
            if (matches) {
                // Create a copy to not mutate the global config, and inject the DB name
                const trackWithId = { ...track, dbTrackName, xpType: dbTrackName };
                tracksToAward.push(trackWithId);
            }
        }
    }

    // 3. Check Global Track
    if (xpSettings.globalEnabled) {
        // Award global XP if: no special XP tracks matched OR allowGlobalXpWhileSpecial is TRUE
        if (tracksToAward.length === 0 || xpSettings.allowGlobalXpWhileSpecial) {
            tracksToAward.push({ type: 'global', xpType: 'global', dbTrackName: 'global', color: xpSettings.global.color });
        }
    }

    return tracksToAward;
}

/**
 * Specifically handles bonuses for Voice Activity (Streaming and Camera usage)
 * @param {object} voiceState - The Discord VoiceState (oldState)
 * @returns {number} Multiplier (e.g., 1.5 for 50%)
 */
function calculateVoiceActivityMultiplier(voiceState) {
    let bonusPercent = 0;

    if (voiceState.streaming) {
        bonusPercent += (xpSettings.voiceXp.bonusMultipliers?.streaming || 0);
    }

    if (voiceState.selfVideo) {
        bonusPercent += (xpSettings.voiceXp.bonusMultipliers?.camera || 0);
    }

    return 1 + (bonusPercent / 100);
}

/**
 * XP BOOSTERS
 * Calculates the total XP multiplier for a user based on active XP Boosters.
 * @param {string} actionType - 'messages', 'reactions', 'commands', or 'voice'
 */
function calculateXpBoostMultiplier(member, channelId, actionType) {
    let multipliers = [];

    // Helper function to verify if the boost applies to the current action
    const xpAppliesTo = (boost) => {
        // If appliesTo doesn't exist, assume it applies to everything to prevent breaking older data
        if (!boost.appliesTo) return true;
        return boost.appliesTo[actionType] === true;
    };

    // 1) Check User Boosters
    const userBoost = xpSettings.boosters.users.find(u => u.id === member.id);
    if (userBoost && xpAppliesTo(userBoost)) multipliers.push(userBoost.percentage);

    // 2) Check Channel Boosters
    const channelBoost = xpSettings.boosters.channels.find(c => c.id === channelId);
    if (channelBoost && xpAppliesTo(channelBoost)) multipliers.push(channelBoost.percentage);

    // 3) Check Role Boosters
    const roleBoosts = xpSettings.boosters.roles
        .filter(r => member.roles.cache.has(r.id) && xpAppliesTo(r))
        .map(r => r.percentage);

    if (roleBoosts.length > 0) {
        // Check if "Stack Boosts" is enabled
        if (xpSettings.boosters.stackBoosters) {
            multipliers.push(...roleBoosts); // Push all role percentages
        } else {
            multipliers.push(Math.max(...roleBoosts)); // Only push the single highest role boost
        }
    }

    if (multipliers.length === 0) return 1; // Base 1.0x multiplier

    // 4) Calculate final multiplier
    if (xpSettings.boosters.stackBoosters) {
        // Example: 50% + 25% = 75% -> 1.75x Total
        const totalBonusPercent = multipliers.reduce((acc, curr) => acc + curr, 0);
        return 1 + (totalBonusPercent / 100);
    } else {
        // Example: Ignore other Boosts: 25%, only take HIGHEST Boost: 50% -> 1.50x Total
        const highestBonusPercent = Math.max(...multipliers);
        return 1 + (highestBonusPercent / 100);
    }
}

module.exports = { getXPTracksForUser, calculateVoiceActivityMultiplier, calculateXpBoostMultiplier };
