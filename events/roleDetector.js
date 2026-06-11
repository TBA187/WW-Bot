// ====================
// Detect Role Updates
// ====================

const { AuditLogEvent } = require('discord.js');

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember, config) {
        if (!oldMember.roles || !newMember.roles) return; // Prevents "False Positive" pings
        if (!newMember.guild.roles.cache.has(config.wwRoleID)) return;

        // "White Walker" Role Checks
        const hadRole = oldMember.roles.cache.has(config.wwRoleID);
        const hasRole = newMember.roles.cache.has(config.wwRoleID);
        if (hadRole === hasRole) return;
        let action = 'No action';

        try {
            const logChannel = newMember.guild.channels.cache.get(config.logChannelID);

            await new Promise(resolve => setTimeout(resolve, 1500));

            // Fetch the latest 5 audit log for member role updates
            const fetchedLogs = await newMember.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberRoleUpdate,
            });

            // Filter all entries in the last 10 seconds that specifically modified the WW role
            const relevantLogs = fetchedLogs.entries.filter(e => {
                if (e.target.id !== newMember.id) return false;
                if ((Date.now() - e.createdTimestamp) >= 10000) return false;

                const roleChange = e.changes.find(c => c.key === '$add' || c.key === '$remove');
                if (roleChange && roleChange.new) {
                    return roleChange.new.some(role => role.id === config.wwRoleID);
                }
                return false;
            });

            if (relevantLogs.size === 0) {
                console.log(` - No recent WW role audit log found for ${newMember.user.tag}.`);
                return;
            }

            // Check for human actions
            const humanLog = relevantLogs.find(e => !e.executor.bot);
            let humanAddedRole = false;
            let humanRemovedRole = false;

            if (humanLog) {
                const addChange = humanLog.changes.find(c => c.key === '$add');
                if (addChange && addChange.new && addChange.new.some(r => r.id === config.wwRoleID)) {
                    humanAddedRole = true;
                }

                const removeChange = humanLog.changes.find(c => c.key === '$remove');
                if (removeChange && removeChange.new && removeChange.new.some(r => r.id === config.wwRoleID)) {
                    humanRemovedRole = true;
                }
            }

            // =========================
            // ROLE ADDED
            // =========================
            if (!hadRole && hasRole) {
                action = 'ADD';

                if (humanAddedRole) {
                    // Scenario A: Human tried to ADD the WW role manually
                    const humanExecutor = humanLog.executor;
                    if (logChannel) {
                        await logChannel.send(`### ⚠️ <@${humanExecutor.id}> (${humanExecutor.tag}) tried to give the \`White Walker\` role to <@${newMember.id}>\n - This role will be given to members **automatically when they equip the WW Server Tag!**\n### 🔄  Role has been removed from ${newMember.displayName}  ❌`);
                    }
                    return; // Stop here!
                }

                if (humanRemovedRole) {
                    // Scenario B: If human removed the WW role manually, RaidProtect Bot will automatically ADD it back
                    console.log(`[WW LOG] - RaidProtect restored WW role after human removal. Skipping welcome message!`);
                    return; // Stop here and do NOT send the welcome message!
                }

                // If RaidProtect Bot gave the WW role -> Member Equipped the WW Server Tag!
                const channel = newMember.guild.channels.cache.get(config.welcomeChannelID);
                if (channel) {
                    await channel.send(
                        `## 🎉  New White Walker Representative!  🎉\n` +
                        `### Big shoutout to <@${newMember.id}> for equipping the WW Server Tag! <:man_of_culture:1186287184106496112>\n` +
                        `- You now have a cool new name color and an icon featuring the White Walkers mascot <:kyurem:1472065995089645609>\n` +
                        `-# If you would like to change your name color or icon, you can contact <@${config.ownerID}>`
                    );
                }
            }

            // =========================
            // ROLE REMOVED
            // =========================
            if (hadRole && !hasRole) {
                action = 'REMOVE';

                if (humanRemovedRole) {
                    // Scenario C: Human tried to REMOVE thw WW role manually
                    const humanExecutor = humanLog.executor;
                    if (logChannel) {
                        await logChannel.send(`### ⚠️ <@${humanExecutor.id}> (${humanExecutor.tag}) tried to remove the \`White Walker\` role from <@${newMember.id}>\n - This role will be removed from members **automatically when they unequip the WW Server Tag!**\n### 🔄  Role has been restored back to ${newMember.displayName}  ✅`);
                    }
                    return; // Stop here!
                }

                if (humanAddedRole) {
                    // Scenario D: If human added the WW role manually, RaidProtect Bot will automatically remove it again
                    console.log(`[WW LOG] - RaidProtect reverted WW role after human addition. Skipping removal log message!`);
                    return; // Stop here and do NOT send the removal log message!
                }

                // If RaidProtect Bot removed the WW role -> Member unequipped the WW Server Tag!
                if (logChannel) {
                    await logChannel.send(`### 🔎  <@${newMember.id}> (${newMember.user.tag}) removed the WW Server Tag!`);
                }
            }

        } catch (err) {
            console.error(`[WW LOG] - ERROR sending role-detection (${action} Event) message:`, err);
        }
    }
};
