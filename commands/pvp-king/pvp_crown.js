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
        this.name = "pvp_crown";
        this.db = config.pvpKingStorage || config.db;
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
                    `**🚨 <@${this.ownerID}> — Multiple PvP Kings Detected!**\n` +
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
                            .setColor(0x02f3d7)
                            .setTitle('🔔 PvP Cooldowns Cleared!')
                            .setThumbnail(newKing.displayAvatarURL({ size: 256 }))
                            .setDescription(
                                `### The PvP Throne has been claimed by <@${newKing.id}>!\n` +
                                `The reign of **${oldKing.displayName}** has ended. **All cooldowns have been reset**, and you may now challenge the new PvP King! ⚔️`
                            )
                            .addFields(
                                { name: '👑 New PvP King', value: `<@${newKing.id}>`, inline: true },
                                { name: 'Old PvP King', value: `<@${oldKing.id}>`, inline: true }
                            )
                            .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
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

            // DELETE AFTER EVENT!
            // ==========================================
            // NEW ADDITION: PVP EVENT ANNOUNCEMENT LOGIC
            // ==========================================
            const EVENT_START = '2026-05-06 01:00:00';

            if (new Date() > new Date(EVENT_START)) {
                // 1. Fetch history since event start (DESC to count backwards from this win)
                const fullEventHistory = await this.db.eventHistorySinceDesc(EVENT_START);

                let eventStreakCounter = 0;
                let eventVictoryDates = [];

                // 2. Calculate the UNBROKEN streak for this specific user
                for (const row of fullEventHistory) {
                    if (row.king_id === newKing.id) {
                        eventStreakCounter++;
                        eventVictoryDates.push(row.created_at);
                    } else {
                        // THE STREAK IS BROKEN: This win was preceded by someone else
                        break;
                    }
                }

                // 3. Trigger announcement only at exactly 10 wins
                if (eventStreakCounter === 10) {
                    const announceChannel = guild.channels.cache.get('1180559473501290688');
                    if (announceChannel) {
                        const recentMessages = await announceChannel.messages.fetch({ limit: 50 });

                        const historyList = eventVictoryDates
                            .reverse() // Sort 1 -> 10
                            .map((date, i) => `**${i + 1}.** <t:${Math.floor(new Date(date).getTime() / 1000)}:f>`)
                            .join('\n');

                        const winEmbed = new EmbedBuilder()
                            .setTitle('🏆\u2002PvP King Event Challenge has concluded!\u2002🏆')
                            .setColor('#FFD700')
                            .setThumbnail(newKing.displayAvatarURL())
                            .setDescription(
                                `### 🎉\u2002We have our PvP Grand Champion!\n` +
                                `**<@${newKing.id}>** has achieved a flawless **10 Win Streak**!\n` +
                                `### 🎁\u2002Reward:\u20023 Coin Capsules\n` +
                                `**📜\u2002Event Victory Logs:**\n${historyList}\n\n`
                            )
                            .setFooter({ text: 'WW PvP Event Dominion', iconURL: interaction.guild.iconURL() })
                            .setTimestamp();

                        await announceChannel.send({
                            content: `## <:pepe_king:1455434151262949535>\u2002PvP King Event Winner Announcement!\u2002<:pepe_king:1455434151262949535>\n` +
                                `### 👑\u2002Grand Champion:\u2002<@${newKing.id}>\u2002👑\n` +
                                `||@everyone||`,
                            embeds: [winEmbed]
                        });

                    }
                }
            }
            // DELETE AFTER EVENT!
            // ==========================================
            // END OF PVP EVENT ANNOUNCEMENT LOGIC
            // ==========================================

            // Public Feedback Message
            const oldKingTag = oldKing ? `<@${oldKing.id}> ` : '*No previous PvP King!*';
            const attachment = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
            const crownEmbed = new EmbedBuilder()
                .setDescription(`### 👑\u2002 <@${newKing.id}> ${isDefense ? 'defended the PvP Throne!\u2002🛡️' : 'conquered the PvP Throne!\u2002⚔️'}`)
                .addFields(
                    { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002Longest Streak: ${longest}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002Total Wins: ${totalWins}`, value: '\u2002', inline: false },
                )
                .setColor(isDefense ? 0x9b59b6 : 0xf1c40f)
                .setThumbnail(newKing.displayAvatarURL())
                .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
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

            // Log Event to Log Channel
            if (logChannel) {
                const crownEmbedLog = new EmbedBuilder()
                    .setDescription(
                        `### 🏆\u2002 <@${interaction.user.id}> used the \`/pvp_crown\` command!\u2002🤖\n` +
                        `- Event Type: **${isDefense ? 'Defense 🛡️' : 'Crown 👑'}**\n` +
                        `- Target Member: <@${newKing.id}>\n` +
                        `### [🔗 Jump to ${isDefense ? 'Defense Message 🛡️' : 'Crown Message 👑'}](${crownMessage.url})`
                    )
                    .setColor(isDefense ? 0x9b59b6 : 0xf1c40f)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
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
                    .setDescription(`### 👑\u2002<@${newKing.id}> ${isDefense ? 'defended the PvP Throne!\u2002🛡️' : 'conquered the PvP Throne!\u2002⚔️'}`)
                    .addFields(
                        { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: true },
                        { name: `🏆\u2002Total Wins: ${totalWins}`, value: `\u2002`, inline: true },
                    )
                    .setColor(isDefense ? 0x9b59b6 : 0xf1c40f)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
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

module.exports = PvpCrownKing;
