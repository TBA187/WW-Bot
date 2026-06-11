
// ----------------------
// /pvp_reverse
// ----------------------
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

class PvpReverse {

    constructor(config) {
        this.name = "pvp_reverse";
        this.db = config.db;
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.logChannelID = config.logChannelID;
        this.historyThreadID = config.historyThreadID;
        this.ownerID = config.ownerID;
        this.client = config.client;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_reverse')
            .setDescription('Reverse the last PvP Crown and restore the previous king with correct data (Officers only)');
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'currentking', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!interaction.member.roles.cache.some(role => allowedRoles.includes(role.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            console.log("------------------------------------------");
            console.log('"/pvp_reverse" command used!');

            const { guild } = interaction;
            const logChannel = guild.channels.cache.get(this.logChannelID);
            if (!logChannel) {
                console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
            }

            // 1) Get the last Crowned PvP King
            const [lastRow] = await this.db.query(`
                SELECT * FROM pvp_king_history
                ORDER BY id DESC
                LIMIT 1
            `);

            if (!lastRow.length) {
                return interaction.editReply('### ⚠️ No PvP crown history found to reverse.');
            }

            const wrongKing = lastRow[0];
            console.log('Wrong King: ', wrongKing);

            // 2) Get the previous King BEFORE wrong crown
            const [prevRows] = await this.db.query(`
                SELECT * FROM pvp_king_history
                ORDER BY id DESC
                LIMIT 1 OFFSET 1
            `);
            let prevKing = prevRows.length ? prevRows[0] : null;
            console.log('Previous King: ', prevKing);

            // 3) Send confirmation message with buttons
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_reverse')
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancel_reverse')
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

            let prevKingTag = prevKing?.king_id ? `(<@${prevKing.king_id}>)` : '';
            let type = 'Crown 👑';
            let typeTxt = 'Crowned:';
            let reverseWarningTxt = 'This will restore the Crown back to the previous PvP King';
            if (prevKing.king_id == wrongKing.king_id) {
                type = 'Defense 🛡️';
                typeTxt = 'Defended Crown:';
                reverseWarningTxt = 'This will undo the PvP stats for the Throne defender';
            }

            const last_crowned_time = wrongKing.created_at
                ? `<t:${Math.floor(new Date(wrongKing.created_at).getTime() / 1000)}:F>`
                : '*Error loading time!*';

            // Live countdown timer
            const now = Math.floor(Date.now() / 1000);
            const countdownSeconds = 60; // 1 min
            const endTime = now + countdownSeconds;

            const message = await interaction.editReply({
                content: `# ⚠️  Warning!\n## Are you sure you want to reverse the last PvP Crown event of <@${wrongKing.king_id}>?\n` +
                    `- **Event Type:** ${type}\n` +
                    `- **${typeTxt}** ${last_crowned_time}\n` +
                    `### ℹ️  ${reverseWarningTxt} ${prevKingTag} and update the database accordingly!\n` +
                    `_ _\n⏳ Bot will auto decline the request in **<t:${endTime}:R>** for security purposes!`,
                components: [row]
            });

            // 4) Create a collector to handle button interaction
            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, time: 60000, max: 1 }); // 1 min

            collector.on('collect', async i => {
                if (i.customId === 'confirm_reverse') {
                    await i.update({ content: `🔄 Reversing PvP Crown of wrong King: **${wrongKing.king_name}...**`, components: [] });

                    // 5) Remove the last history record
                    const [delHistoryRes] = await this.db.query(`
                        DELETE FROM pvp_king_history
                        WHERE id = ?
                    `, [wrongKing.id]);
                    console.log("1) DELETE wrong King FROM pvp_king_history: ", delHistoryRes.affectedRows);

                    // 6) Update Stats for wrong King in pvp_king_stats
                    if (wrongKing.total_wins_after == 0 || wrongKing.total_wins_after == 1) {
                        // If new King has 0 previous wins, then it's a new entry and needs to be deleted
                        const [delStatsRes] = await this.db.query(`
                            DELETE FROM pvp_king_stats
                            WHERE user_id = ?
                        `, [wrongKing.king_id]);
                        console.log("2.1) DELETE wrong King FROM pvp_king_stats: ", delStatsRes.affectedRows);
                    } else {
                        let longestStreakAfter = 0;
                        let consoleMsg = '';
                        if (prevKing) {
                            if (prevKing.king_id == wrongKing.king_id) {
                                consoleMsg = 'prevKing.king_id == wrongKing.king_id';
                                if (prevKing.longest_streak_after != wrongKing.longest_streak_after) {
                                    longestStreakAfter = prevKing.longest_streak_after;
                                    consoleMsg = ` - prevKing.longest_streak_after != wrongKing.longest_streak_after: "${longestStreakAfter}"`;
                                } else {
                                    longestStreakAfter = wrongKing.longest_streak_after;
                                    consoleMsg = ` - prevKing.longest_streak_after == wrongKing.longest_streak_after: "${longestStreakAfter}"`;
                                }
                            } else {
                                longestStreakAfter = wrongKing.longest_streak_after;
                                consoleMsg = `prevKing.king_id != wrongKing.king_id: "${longestStreakAfter}"`;
                            }
                        } else {
                            longestStreakAfter = wrongKing.longest_streak_after;
                            consoleMsg = 'No prevKing!';
                        }

                        const [updateStatsRes] = await this.db.query(`
                            UPDATE pvp_king_stats
                            SET 
                                total_wins = GREATEST(total_wins - 1, 0), 
                                current_streak = 0, 
                                longest_streak = ?, 
                                crowned_at = ?
                            WHERE user_id = ?
                        `, [longestStreakAfter, wrongKing.last_crowned, wrongKing.king_id]);
                        console.log(`2.2) UPDATE wrong King in pvp_king_stats: `, updateStatsRes.affectedRows);
                        console.log(`2.2) Conditions: ${consoleMsg}`);
                    }

                    // 7) Update Discord roles
                    const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
                    if (kingRole) {
                        // Remove king role from the wrong King
                        const wrongMember = await interaction.guild.members.fetch(wrongKing.king_id).catch(() => null);
                        if (wrongMember) await wrongMember.roles.remove(kingRole).catch(() => { });
                        console.log("3) Remove king role from the wrong King: ", wrongKing.king_id);

                        // Give King role back to previous king
                        if (prevKing) {
                            const newMember = await interaction.guild.members.fetch(prevKing.king_id).catch(() => null);
                            if (newMember) await newMember.roles.add(kingRole).catch(() => { });
                            console.log("4) Give King role back to previous King: ", prevKing.king_id);
                        } else {
                            console.log("--) No previous King found to give role!");
                        }
                    } else {
                        console.log("--) King Role not found!");
                    }

                    // 8) Reset cooldowns any challengers have versus the wrong King
                    const [resetCDsql] = await this.db.query(`
                        UPDATE pvp_king_cooldowns
                        SET 
                            last_challenge = NULL
                        WHERE king_id = ?
                        `, [wrongKing.king_id]);
                    console.log("5) UPDATE pvp_king_cooldowns to remove cooldowns against the wrong King: ", resetCDsql.affectedRows);

                    // 9) Delete wrong King Log in Discord History Thread
                    const thread = await this.client.channels.fetch(this.historyThreadID);
                    if (!thread || !thread.isThread()) return console.log('--) History Thread not found! Thread ID: ', this.historyThreadID);

                    // Fetch messages (limit 1, latest)
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMessage = messages.first();

                    if (lastMessage) {
                        await lastMessage.delete();
                        console.log('6) Deleted last message in Discord History Thread!');
                    } else {
                        console.log('6) No messages in Discord History Thread to delete!');
                    }

                    // Error handling: If no Previous King found!
                    if (!prevKing) {
                        console.log("No Previous King found!");

                        // Log to Discord Log Channel
                        if (logChannel) {
                            const executorName = interaction.user.displayName;
                            const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
                            await logChannel.send(
                                `## 🚨  PvP Crown reversed! (${now})\n` +
                                `- **${executorName}** successfully reversed the last PvP Crown of **<@${wrongKing.king_id}>**\n` +
                                `### ❌ No previous King found to assign the PvP King role!\n` +
                                `### <@${this.ownerID}> - No Members currently have the PvP King role. Assign it manually!\n` +
                                `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                                `### ✅  All stats for the wrong King are restored correctly in the database!`
                            );
                        }

                        // User feedback message
                        return interaction.editReply(
                            `## 🚨  PvP Crown reversed! (${now})\n` +
                            `- The last PvP Crown of **<@${wrongKing.king_id}>** has been successfully reversed!\n` +
                            `### ❌ However, no previous King found to assign the PvP King role! Assign it manually to a new King with the */pvp_crown* command!\n` +
                            `### ✅ All stats for the wrong King are restored correctly in the database!`
                        );
                    }

                    // 10) Restore Stats for previous King (to be new current King)
                    const [updatePrevKingRes] = await this.db.query(`
                        UPDATE pvp_king_stats
                        SET 
                            ${prevKing.king_id != wrongKing.king_id ? 'total_crown_losses = GREATEST(total_crown_losses - 1, 0), ' : ''}
                            current_streak = ?
                        WHERE user_id = ?
                    `, [prevKing.streak_after, prevKing.king_id]);
                    console.log("7) UPDATE pvp_king_stats for previous King: ", updatePrevKingRes.affectedRows);

                    const executorName = interaction.user.displayName;
                    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
                    const last_crowned_time = wrongKing.created_at
                        ? `<t:${Math.floor(new Date(wrongKing.created_at).getTime() / 1000)}:F>`
                        : '*Error loading time!*';
                    let type = 'Crown 👑';
                    let typeTxt = 'Crowned:';
                    let reverseTxt = `The PvP King role has been successfully restored back to <@${prevKing.king_id}>`;
                    if (prevKing.king_id == wrongKing.king_id) {
                        type = 'Defense 🛡️';
                        typeTxt = 'Defended Crown:';
                        reverseTxt = `The PvP stats for <@${prevKing.king_id}> has been successfully reverted.`;
                    }

                    // Log to Discord Log Channel
                    if (logChannel) {
                        await logChannel.send(
                            `## 🚨  PvP Crown reversed! (${now})\n` +
                            `- **${executorName} reversed the last PvP Crown event of <@${wrongKing.king_id}>**\n` +
                            `- **Event Type:** ${type}\n` +
                            `- **${typeTxt}** ${last_crowned_time}\n` +
                            `### ✅  ${reverseTxt}\n` +
                            `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                            `### ✅  All stats are updated correctly in the database!`
                        );
                    }

                    console.log("✅ PvP Reversal Success!");
                    console.log("------------------------------------------");

                    // Private executor message
                    await interaction.editReply({
                        content: `### ✅  Reversal complete!\n- Check log for more information: <#${this.logChannelID}>`,
                        components: []
                    });

                    // Send new public message to the channel
                    return interaction.channel.send(
                        `## 🚨  PvP Crown reversed! (${now})\n` +
                        `- **${executorName} reversed the last PvP Crown event of <@${wrongKing.king_id}>**\n` +
                        `- **Event Type:** ${type}\n` +
                        `- **${typeTxt}** ${last_crowned_time}\n` +
                        `### ✅  ${reverseTxt}\n` +
                        `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                        `### ✅  All stats are updated correctly in the database!`
                    );

                } else if (i.customId === 'cancel_reverse') {
                    await i.update({ components: [] });
                    await i.followUp({
                        content: '### ❌  PvP Crown reversal canceled!',
                        ephemeral: true
                    });

                    console.log("User canceled PvP Crown reversal!");
                    console.log("------------------------------------------");
                }
            });

            collector.on('end', collected => {
                if (!collected.size) {
                    interaction.editReply({ content: '### ⌛  PvP Crown reversal timed out *(1 minute)* and has been automatically canceled!\n- You can try again.', components: [] });

                    console.log("PvP Crown reversal timed out!");
                    console.log("------------------------------------------");
                }
            });
        } catch (err) {
            console.error(err);
            return interaction.editReply('### ⚠️ Failed to reverse the last PvP crown! Try again.');
        }

    }
}

module.exports = PvpReverse;
