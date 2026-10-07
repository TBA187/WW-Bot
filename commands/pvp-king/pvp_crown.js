const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { announceEventWinner } = require('./utils/pvpEvent.js');
// ----------------------
// /pvp_crown
// ----------------------
const { SlashCommandBuilder, MessageFlags, ThreadChannel, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const {
    formatNowMinute,
    getLogChannel,
    refreshGuildMembers,
    replyMissingMemberOption,
    requireAnyRole,
    requirePvpChannel,
    stopIfOnCooldown
} = require('./utils/pvpHelper.js');

class PvpCrownKing {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_crown";
        this.db = config.pvpKingStorage || config.db;
        this.eventConfig = config;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.pvpWarriorRoleID = config.pvpWarriorRoleID;
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.ownerID = config.ownerID;
        this.logChannelID = config.logChannelID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.historyThreadID = config.historyThreadID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_crown')
            .setDescription('Crown a new PvP King (Officers only)')
            .addUserOption(o =>
                o.setName('user').setDescription('Select the new PvP King').setRequired(true)
            );
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        // Check if user has Officer Role
        if (!await requirePvpChannel(interaction, this.pvpKingChannelID, 'pvp_crown')) return;

        const { guild } = interaction;
        const logChannel = getLogChannel(guild, this.logChannelID);
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID, this.pvpWarriorRoleID];
        if (!await requireAnyRole(interaction, allowedRoles)) return;

        // Crown has slightly different rules than the normal "find one king" helper:
        // no current king is allowed, but multiple current kings must be fixed manually.
        const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
        if (!kingRole) {
            return interaction.reply({ content: '### ❌  PvP King role not found! Needs to be fixed manually!', flags: MessageFlags.Ephemeral });
        }

        const newKing = await replyMissingMemberOption(interaction);
        if (!newKing) return;

        await interaction.deferReply();
        await refreshGuildMembers(interaction.guild, '/pvp_crown');

        const kings = kingRole.members;
        if (kings.size > 1) {
            if (logChannel) {
                const now = formatNowMinute();
                await logChannel.send(
                    `**🚨 <@${this.ownerID}> — Multiple PvP Kings Detected in ${this.pvpServerName}!**\n` +
                    `**${kingRole.members.size} members** currently have the PvP King role.\n` +
                    `This needs to be fixed manually before crowning a new king! (${now})`
                );
            }

            return interaction.editReply({
                content:
                    `❌ **Error:** There are currently **${kingRole.members.size} members** with the PvP King role.\n` +
                    `Please fix this manually before crowning a new king!`
            });
        }

        try {
            // IF New King Crowned, OR Current King defends their crown
            const oldKing = kings.first();
            const isDefense = oldKing && oldKing.id === newKing.id;

            const crownResult = await this.db.recordCrownEvent({
                newKingId: newKing.id,
                newKingName: newKing.displayName,
                oldKingId: oldKing?.id,
                oldKingName: oldKing?.displayName,
                isDefense
            });

            // Discord changes happen only after storage succeeds.
            if (!isDefense) {
                if (oldKing) {
                    // Remove old king, if role exists
                    await oldKing.roles.remove(this.pvpKingRoleID).catch(console.error);

                }

                // Add role to new king
                await newKing.roles.add(this.pvpKingRoleID).catch(console.error);

                // Add secondary role ONCE to all first-time PvP Kings
                if (!newKing.roles.cache.has(this.pvpWarriorRoleID)) {
                    await newKing.roles.add(this.pvpWarriorRoleID).catch(console.error);
                }

                const usersToNotify = (crownResult.usersToNotify ?? []).map(row => `<@${row.challenger_id}>`);
                // If any challengers have an active cooldown against the fallen King AND enabled notifications, then send notifications to waiting challengers!
                if (oldKing && usersToNotify.length > 0 && this.pvpKingChannelID) {
                    const pvpKingChannel = guild.channels.cache.get(this.pvpKingChannelID);
                    if (pvpKingChannel) {
                        const logoFile = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
                        const pvpKingCdEmbed = new EmbedBuilder()
                            .setColor(this.pvpServerColor)
                            .setTitle(`🔔 PvP Cooldowns Cleared! — ${this.pvpServerName} ${this.pvpServerEmoji}`)
                            .setThumbnail(newKing.displayAvatarURL({ size: 256 }))
                            .setDescription(
                                `### ${this.pvpServerEmoji} The PvP Throne in ${this.pvpServerName} has been claimed by <@${newKing.id}>!\n` +
                                `The reign of **${oldKing.displayName}** has ended. **All cooldowns have been reset**, and you may now challenge the new PvP King! ⚔️`
                            )
                            .addFields(
                                { name: '👑 New PvP King', value: `<@${newKing.id}>`, inline: true },
                                { name: 'Old PvP King', value: `<@${oldKing.id}>`, inline: true }
                            )
                            .setFooter({ text: `WW PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://ww_logo.png' })
                            .setTimestamp();

                        await pvpKingChannel.send({
                            content: usersToNotify.join(' '),
                            embeds: [pvpKingCdEmbed],
                            files: [logoFile]
                        });
                    }
                }
            }

            //currentKingId = newKing.id;

            // Get current King's Win Streak
            const stats = crownResult.stats;
            const totalWins = stats?.total_wins || 0;
            const streak = stats?.current_streak || 0;
            const longest = stats?.longest_streak || 0;

            // Public Feedback Message
            const oldKingTag = oldKing ? `<@${oldKing.id}> ` : '*No previous PvP King!*';
            const attachment = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
            const crownEmbed = new EmbedBuilder()
                .setDescription(`### 👑\u2002 <@${newKing.id}> ${isDefense ? 'defended' : 'conquered'} the PvP Throne in ${this.pvpServerName}\u2002${isDefense ? '🛡️' : '⚔️'}`)
                .addFields(
                    { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002Longest Streak: ${longest}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002Total Wins: ${totalWins}`, value: '\u2002', inline: false },
                )
                .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                .setThumbnail(newKing.displayAvatarURL())
                .setFooter({ text: `WW PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://ww_logo.png' })
                .setTimestamp();

            if (!isDefense) {
                crownEmbed.addFields(
                    { name: 'Former King', value: oldKingTag, inline: true },
                    { name: 'New King', value: `👑\u2002 <@${newKing.id}>\u2002👑`, inline: true });
            }

            const crownMessage = await interaction.followUp({
                embeds: [crownEmbed],
                files: [attachment]
            });

            // Event announcements cannot roll back an already saved crown.
            try {
                await announceEventWinner(this.eventConfig, interaction, newKing);
            } catch (err) {
                console.warn('[WW LOG] PvP event announcement failed; the crown is saved:', err);
            }

            // Log Event to Log Channel
            if (logChannel) {
                const crownEmbedLog = new EmbedBuilder()
                    .setDescription(
                        `### 🏆\u2002 <@${interaction.user.id}> used the \`/pvp_crown\` command!\u2002🤖\n` +
                        `- Server: **${this.pvpServerName}** ${this.pvpServerEmoji}\n` +
                        `- Event Type: **${isDefense ? 'Defense 🛡️' : 'Crown 👑'}**\n` +
                        `- Target Member: <@${newKing.id}>\n` +
                        `### [🔗 Jump to ${isDefense ? 'Defense Message 🛡️' : 'Crown Message 👑'}](${crownMessage.url})`
                    )
                    .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: `WW PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://ww_logo.png' })
                    .setTimestamp();

                if (!isDefense) {
                    crownEmbedLog.addFields(
                        { name: 'Former King', value: oldKingTag, inline: true },
                        { name: 'New King', value: `👑\u2002<@${newKing.id}>\u2002👑`, inline: true }
                    );
                }

                await logChannel.send({
                    embeds: [crownEmbedLog],
                    files: [attachment]
                });
            }

            // Log to History Thread
            try {
                const historyThread = await interaction.guild.channels.fetch(this.historyThreadID);
                if (!(historyThread instanceof ThreadChannel)) return;

                const crownEmbedEntry = new EmbedBuilder()
                    .setDescription(`### 👑\u2002<@${newKing.id}> ${isDefense ? 'defended' : 'conquered'} the PvP Throne in ${this.pvpServerName}!\u2002${isDefense ? '🛡️' : '⚔️'}`)
                    .addFields(
                        { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: true },
                        { name: `🏆\u2002Total Wins: ${totalWins}`, value: `\u2002`, inline: true },
                    )
                    .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: `WW PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://ww_logo.png' })
                    .setTimestamp();

                await historyThread.send({
                    embeds: [crownEmbedEntry],
                    files: [attachment]
                });
            } catch (e) {
                console.error(e);
            }
        } catch (err) {
            console.error(err);
            const message = err.code === 'PVP_DATABASE_UNAVAILABLE'
                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                : '### ⚠️ Database error during Crowning. No PvP King changes were applied.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpCrownKing);
