
// ----------------------
// /pvp_reverse
// ----------------------
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLogChannel, requireAnyRole, stopIfOnCooldown } = require('./utils/pvpHelper.js');

class PvpReverse {

    constructor(config) {
        this.name = "pvp_reverse";
        this.db = config.pvpKingStorage || config.db;
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
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!await requireAnyRole(interaction, allowedRoles)) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            console.log("------------------------------------------");
            console.log('"/pvp_reverse" command used!');

            const { guild } = interaction;
            const logChannel = getLogChannel(guild, this.logChannelID);

            // 1) Get the last Crowned PvP King
            let wrongKing = await this.db.latestHistory();

            if (!wrongKing) {
                return interaction.editReply('### ⚠️ No PvP crown history found to reverse.');
            }

            console.log('Wrong King: ', wrongKing);

            // 2) Get the previous King BEFORE wrong crown
            let prevKing = await this.db.latestHistory(1);
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
            if (prevKing?.king_id == wrongKing.king_id) {
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

                    let reverseResult;
                    try {
                        reverseResult = await this.db.reverseLatestCrownEvent({ expectedHistoryId: wrongKing.id });
                    } catch (err) {
                        if (err.code === 'PVP_STALE_REVERSE') {
                            return interaction.editReply({
                                content: '### ⚠️ The latest PvP crown changed before this reverse could finish.\n- Nothing was changed. Run `/pvp_reverse` again to review the newest crown event.',
                                components: []
                            });
                        }

                        console.error(err);
                        return interaction.editReply({
                            content: err.code === 'PVP_DATABASE_UNAVAILABLE'
                                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                                : '### ⚠️ Failed to reverse the last PvP crown. No PvP King changes were applied.',
                            components: []
                        });
                    }

                    wrongKing = reverseResult.wrongKing;
                    prevKing = reverseResult.prevKing;
                    console.log("1) DELETE wrong King FROM pvp_king_history: ", reverseResult.delHistoryRes?.affectedRows ?? 0);
                    console.log("2) UPDATE wrong King in pvp_king_stats: ", reverseResult.statsResult?.affectedRows ?? 0);
                    if (reverseResult.statsConsoleMsg) console.log(`2) Conditions: ${reverseResult.statsConsoleMsg}`);

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

                    console.log("5) UPDATE pvp_king_cooldowns to remove cooldowns against the wrong King: ", reverseResult.resetCooldownResult?.affectedRows ?? 0);

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

                    const executorName = interaction.user.displayName;
                    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

                    // Error handling: If no Previous King found!
                    if (!prevKing) {
                        console.log("No Previous King found!");

                        // Log to Discord Log Channel
                        if (logChannel) {
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

                    console.log("7) UPDATE pvp_king_stats for previous King: ", reverseResult.prevKingResult?.affectedRows ?? 0);

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
