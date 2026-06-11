// ==========================
// Utility - XP Engine
// ==========================
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getXpForNextLevel, getTotalXpForLevel, getLevelFromTotalXp } = require('./xpMath');
const { fetchTrackById, fetchRewardsByIds, getXpTypeFromTrackInfo } = require('./xpDbHelper');
const xpSettings = require('../config/xpConfig');

/**
 * Shared logic to process XP, update DB, and handle level-ups.
 * Accepts 'actionType' (message, reaction, command, voice) 
 * and 'statCount' (usually 1, but for voice it represents minutes).
 */
async function processXp(userId, guild, channelId, member, xpGained, trackInfo, commandConfig, actionType, statCount = 1) {
    const track = getXpTypeFromTrackInfo(trackInfo);
    if (!track) {
        console.error(`[XP ENGINE] Refusing to process ${actionType} XP for ${userId} without a valid xp_type.`);
        return;
    }

    const guildId = guild.id;
    // Server Nickname > Discord Global Name > Username
    const displayName = member.displayName || member.user.globalName || member.user.username;

    // 0. Determine which database columns to update based on the actionType
    let xpColumn = '';
    let statColumn = '';

    switch (actionType) {
        case 'message':
            xpColumn = 'message_xp';
            statColumn = 'messages_sent';
            break;
        case 'reaction':
            xpColumn = 'reaction_xp';
            statColumn = 'reactions_added';
            break;
        case 'command':
            xpColumn = 'command_xp';
            statColumn = 'commands_used';
            break;
        case 'voice':
            xpColumn = 'voice_xp';
            statColumn = 'voice_minutes';
            break;
        default:
            // Fallback just in case, though it shouldn't hit this
            console.warn(`[XP ENGINE] Unknown actionType: ${actionType}`);
            return;
    }

    try {
        // 1. Database Logic: Insert or Update TOTAL XP + SPECIFIC XP + STATS
        // column names can be injected safely because they are strictly controlled in the switch statement above.
        const query = `
            INSERT INTO user_levels (user_id, guild_id, xp_type, xp_date, xp_amount, level, username, ${xpColumn}, ${statColumn}) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 0, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
                xp_amount = xp_amount + ?, 
                username = ?,
                xp_date = COALESCE(xp_date, CURRENT_TIMESTAMP),
                ${xpColumn} = ${xpColumn} + ?,
                ${statColumn} = ${statColumn} + ?
        `;

        // The parameter array mapping to the (?, ?, ...) blocks
        const params = [
            userId, guildId, track, xpGained, displayName, xpGained, statCount, // INSERT values
            xpGained, displayName, xpGained, statCount                          // UPDATE values
        ];

        await commandConfig.db.query(query, params);

        // 2. Fetch current state to check for level up
        const [rows] = await commandConfig.db.query(
            `SELECT xp_amount, level FROM user_levels WHERE user_id = ? AND guild_id = ? AND xp_type = ?`,
            [userId, guildId, track]
        );

        if (rows.length === 0) return;
        const currentData = rows[0];

        // 3. Level Up Logic
        // Calculate what level they SHOULD be based on total XP
        const correctLevel = getLevelFromTotalXp(currentData.xp_amount);
        if (correctLevel > currentData.level) {
            // Update the DB to the new level
            await commandConfig.db.query(
                `UPDATE user_levels SET level = ? WHERE user_id = ? AND guild_id = ? AND xp_type = ?`,
                [correctLevel, userId, guildId, track]
            );

            // --- Initialize displayTrackInfo and settings early for reward fetching ---
            let settings = (track === 'global') ? xpSettings.global : trackInfo;
            let displayTrackInfo = trackInfo;

            // If track is numeric ID, fetch full track details from database
            if (/^\d+$/.test(track)) {
                const dbTrack = await fetchTrackById(commandConfig.db, parseInt(track));
                if (dbTrack) {
                    displayTrackInfo = dbTrack;
                    settings = dbTrack;
                }
            }

            // --- AUTO ROLE ASSIGNMENT (Level Rewards) ---
            let rolesEarned = []; // Array to store multiple roles in case of level jumps
            let rewardDescriptions = []; // Array to store reward descriptions
            let trackRewards = [];

            // Fetch rewards from database if track is numeric ID, otherwise use config
            if (/^\d+$/.test(track)) {
                // Get the track's level_rewards IDs from the track info
                const rewardIds = displayTrackInfo.levelRewards || [];
                if (rewardIds.length > 0) {
                    trackRewards = await fetchRewardsByIds(commandConfig.db, rewardIds);
                }
            } else {
                trackRewards = (track === 'global') ? xpSettings.levelRewards : trackInfo.levelRewards;
            }

            if (trackRewards && trackRewards.length > 0) {
                for (const reward of trackRewards) {
                    // Check if the user just reached this level (between old level and new level)
                    if (correctLevel >= reward.level && currentData.level < reward.level) {
                        // Add description if present
                        if (reward.description) {
                            rewardDescriptions.push({ level: reward.level, description: reward.description });
                        }
                        // Assign role if roleId is present and user doesn't have it
                        if (reward.roleId && !member.roles.cache.has(reward.roleId)) {
                            try {
                                await member.roles.add(reward.roleId);
                                // Push object to reference the level and role together in the embed
                                rolesEarned.push({ id: reward.roleId, level: reward.level });
                            } catch (roleErr) {
                                console.error(`[XP ENGINE] 🚨 Failed to assign role ${reward.roleId} to ${userId} :`, roleErr);
                            }
                        }
                    }
                }
            }

            // --- Level Up Notification Logic ---
            // Only proceed if sendLevelUpMsg is TRUE
            if (settings.sendLevelUpMsg) {
                const xpLogChannel = guild.channels.cache.get(commandConfig.botChannelID);
                if (xpLogChannel) {
                    const logoFile = new AttachmentBuilder(xpSettings.logoPath, { name: 'ww_logo.png' });

                    // --- Calculate XP needed for next level ---
                    // Check if the user is at Max Level
                    const isMaxLevel = xpSettings.levelFormula.maxLevel && correctLevel >= xpSettings.levelFormula.maxLevel;
                    let xpProgress = "";
                    let xpForNextLevel = "";
                    if (isMaxLevel) {
                        xpProgress = currentData.xp_amount;
                        xpForNextLevel = "**MAX Level Reached!**";
                    } else {
                        const totalXpRequiredForNext = getTotalXpForLevel(correctLevel + 1);
                        const xpRequiredForNext = totalXpRequiredForNext - currentData.xp_amount;
                        xpProgress = `${currentData.xp_amount} / ${totalXpRequiredForNext} XP`;
                        xpForNextLevel = `${xpRequiredForNext} XP`;
                    }

                    // --- XP TRACK Text ---
                    let xpTrackTxt = '';
                    switch (true) {
                        case track === 'global':
                            xpTrackTxt = `Congratulations <@${userId}>! You reached level **${correctLevel}**\u2002🎉`;
                            break;
                        case /^\d+$/.test(track): {
                            // Handle special XP-Tracks from the Database
                            const hasRoles = displayTrackInfo.roleIds && displayTrackInfo.roleIds.length > 0;
                            const hasChannels = displayTrackInfo.channelIds && displayTrackInfo.channelIds.length > 0;

                            if (hasRoles && hasChannels) {
                                // Both Role(s) & Channel(s) XP-Track
                                const requiredRoles = displayTrackInfo.roleIds.length > 1
                                    ? displayTrackInfo.roleIds.map(roleId => `<@&${roleId}>`).join(', ')
                                    : `<@&${displayTrackInfo.roleIds[0]}>`;
                                const requiredChannels = displayTrackInfo.channelIds.length > 1
                                    ? displayTrackInfo.channelIds.map(channelId => `<#${channelId}>`).join(', ')
                                    : `<#${displayTrackInfo.channelIds[0]}>`;

                                xpTrackTxt =
                                    `### Congratulations <@${userId}>!\u2002🎉\nYou reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                    `-# - **XP role${displayTrackInfo.roleIds.length > 1 ? 's' : ''}:** ${requiredRoles}\n` +
                                    `-# - **XP channel${displayTrackInfo.channelIds.length > 1 ? 's' : ''}:** ${requiredChannels}`;
                            } else if (hasRoles) {
                                // Roles Only XP-Track
                                const requiredRoles = displayTrackInfo.roleIds.length > 1
                                    ? displayTrackInfo.roleIds.map(roleId => `<@&${roleId}>`).join(', ')
                                    : `<@&${displayTrackInfo.roleIds[0]}>`;

                                xpTrackTxt =
                                    `### Congratulations <@${userId}>!\u2002🎉\nYou reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                    `-# - **XP role${displayTrackInfo.roleIds.length > 1 ? 's' : ''}:** ${requiredRoles}`;
                            } else if (hasChannels) {
                                // Channels Only XP-Track
                                const requiredChannels = displayTrackInfo.channelIds.length > 1
                                    ? displayTrackInfo.channelIds.map(channelId => `<#${channelId}>`).join(', ')
                                    : `<#${displayTrackInfo.channelIds[0]}>`;

                                xpTrackTxt =
                                    `### Congratulations <@${userId}>!\u2002🎉You reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                    `-# - **XP channel${displayTrackInfo.channelIds.length > 1 ? 's' : ''}:** ${requiredChannels}`;
                            }
                            break;
                        }
                        default:
                            return; // Not a valid track
                    }

                    // -- Role Rewards Text ---
                    let roleRewardTxt = '';
                    if (rolesEarned.length === 1) { // Singular: One role earned
                        roleRewardTxt = `\n\nFor reaching Level **${rolesEarned[0].level}**, you have been awarded a new role:\n- <@&${rolesEarned[0].id}>`;
                    } else if (rolesEarned.length > 1) { // Plural: Multiple roles earned (e.g. jumping multiple levels)
                        const roleList = rolesEarned.map(r => `Level **${r.level}**: <@&${r.id}>`).join('\n');
                        roleRewardTxt = `\n\nYou have earned multiple role rewards for your progress:\n${roleList}`;
                    }

                    // -- Reward Descriptions Text ---
                    let rewardTxt = '';
                    if (rewardDescriptions.length > 0) {
                        const rewardList = rewardDescriptions.map(r => `**:gift:\u2002You have earned a reward:**\n${r.description}`).join('\n');
                        rewardTxt = `\n\n${rewardList}`;
                    }

                    // -- Level Up Embed ---
                    const levelEmbed = new EmbedBuilder()
                        .setTitle('🏆\u2002Level Up!')
                        .setDescription(`${xpTrackTxt}${roleRewardTxt}${rewardTxt}`)
                        .setColor(displayTrackInfo.color || '#5865F2')
                        .addFields(
                            { name: 'XP Progress', value: xpProgress, inline: true },
                            { name: 'XP for next Level', value: xpForNextLevel, inline: true }
                        )
                        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                        .setFooter({ text: 'White Walkers', iconURL: 'attachment://ww_logo.png' })
                        .setTimestamp();

                    // Prepare the message payload
                    const messagePayload = {
                        embeds: [levelEmbed],
                        files: [logoFile]
                    };

                    // if tagUserLevelUpMsg: true, ping the user
                    if (settings.tagUserLevelUpMsg) {
                        messagePayload.content = `<@${userId}>  🎉`;
                    }

                    await xpLogChannel.send(messagePayload);
                }
            }
        }
    } catch (err) {
        console.error(`[XP ENGINE] 🚨 Error for ${userId} on track ${track}:`, err);
    }
}

module.exports = { processXp };
