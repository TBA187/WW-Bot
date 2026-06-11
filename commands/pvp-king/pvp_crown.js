// ----------------------
// /pvp_crown
// ----------------------
const { SlashCommandBuilder, MessageFlags, ThreadChannel, EmbedBuilder, AttachmentBuilder } = require('discord.js');

class PvpCrownKing {

    constructor(config) {
        this.name = "pvp_crown";
        this.db = config.db;
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
        if (this.onCooldown(interaction.user.id, 'currentking', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (interaction.channelId !== this.pvpKingChannelID) {
            return interaction.reply({ content: `### ❌  The \`/pvp_crown\` command can only be used in <#${this.pvpKingChannelID}>`, flags: MessageFlags.Ephemeral });
        }

        const { guild } = interaction;
        const logChannel = guild.channels.cache.get(this.logChannelID);
        if (!logChannel) {
            console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
        }

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID, this.pvpWarriorRoleID];
        if (!interaction.member.roles.cache.some(role => allowedRoles.includes(role.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        // SAFETY CHECKS
        const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
        if (!kingRole) {
            return interaction.reply({ content: '### ❌  PvP King role not found! Needs to be fixed manually!', flags: MessageFlags.Ephemeral });
        }

        const kings = kingRole.members;

        // If more than 1 PvP King exist
        if (kings.size > 1) {
            // Log the issue to the Discord Log Channel
            if (logChannel) {
                const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
                await logChannel.send(
                    `**🚨 <@${this.ownerID}> — Multiple PvP Kings Detected!**\n` +
                    `**${kingRole.members.size} members** currently have the PvP King role.\n` +
                    `This needs to be fixed manually before crowning a new king! (${now})`
                );
            }

            // User feedback message
            return interaction.reply({
                content:
                    `❌ **Error:** There are currently **${kingRole.members.size} members** with the PvP King role.\n` +
                    `Please fix this manually before crowning a new king!`,
                flags: MessageFlags.Ephemeral
            });
        }

        // If 0 OR 1 PvP Kings exist:
        const newKing = interaction.options.getMember('user');
        if (!newKing) {
            return interaction.reply({ content: '### ❌  User not found.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        try {
            // IF New King Crowned, OR Current King defends their crown
            const oldKing = kings.first();
            const isDefense = oldKing && oldKing.id === newKing.id;

            // Get new King's last crowned date if any
            const [newKingRow] = await this.db.query(
                'SELECT crowned_at FROM pvp_king_stats WHERE user_id = ?',
                [newKing.id]
            );
            const newKing_last_crowned = newKingRow[0]?.crowned_at || 0;
            let usersToNotify = [];

            // =============================
            // DEFENSE CASE
            // =============================
            if (isDefense) {
                await this.db.query(`
                INSERT INTO pvp_king_stats (user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)
                VALUES (?, ?, 1, 1, 1, UTC_TIMESTAMP())
                ON DUPLICATE KEY UPDATE
                    total_wins = total_wins + 1,
                    current_streak = current_streak + 1,
                    longest_streak = GREATEST(longest_streak, current_streak),
                    crowned_at = UTC_TIMESTAMP()
                `, [newKing.id, newKing.displayName]);
            }
            // =============================
            // NEW KING CASE
            // =============================
            else {
                if (oldKing) {
                    // ----- Cooldown Notification Logic -----
                    const [notifyRows] = await this.db.query(`
                        SELECT challenger_id, last_challenge FROM pvp_king_cooldowns 
                        WHERE king_id = ? AND notify_on_expire = 1 AND last_challenge IS NOT NULL
                    `, [oldKing.id]);

                    const now = new Date();
                    const cooldownMs = 48 * 60 * 60 * 1000;
                    for (const row of notifyRows) {
                        const lastChallengeDate = new Date(row.last_challenge + 'Z');
                        // Only notify if the 48h hasn't passed yet
                        if (now - lastChallengeDate < cooldownMs) {
                            usersToNotify.push(`<@${row.challenger_id}>`);
                        }
                    }

                    // Remove old king role if exists
                    await oldKing.roles.remove(this.pvpKingRoleID).catch(console.error);

                    // Reset old king streak
                    await this.db.query(`
                    UPDATE pvp_king_stats
                    SET 
                        total_crown_losses = total_crown_losses + 1,
                        current_streak = 0
                    WHERE user_id = ?
                    `, [oldKing.id]);

                    // Reset cooldowns any challengers have versus the old King
                    await this.db.query(`
                    UPDATE pvp_king_cooldowns
                    SET last_challenge = NULL
                    WHERE king_id = ?
                    `, [oldKing.id]);

                    // Apply a fresh cooldown to the old King against the new King to prevent instant rematches
                    await this.db.query(`
                    INSERT INTO pvp_king_cooldowns (challenger_id, challenger_name, king_id, king_name, last_challenge)
                    VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
                    ON DUPLICATE KEY UPDATE
                        challenger_name = VALUES(challenger_name),
                        king_id = VALUES(king_id),
                        king_name = VALUES(king_name),
                        last_challenge = VALUES(last_challenge)
                    `, [oldKing.id, oldKing.displayName, newKing.id, newKing.displayName]);

                    // If any challengers have an active cooldown against the fallen King AND enabled notifications, then send notifications to waiting challengers!
                    if (usersToNotify.length > 0 && this.pvpKingChannelID) {
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
                                content: usersToNotify.length > 0 ? usersToNotify.join(' ') : null,
                                embeds: [pvpKingCdEmbed],
                                files: [logoFile]
                            });
                        }
                    }
                }

                // Update new king stats
                await this.db.query(`
                INSERT INTO pvp_king_stats 
                    (user_id, king_name, total_wins, current_streak, longest_streak, first_crowned, crowned_at)
                VALUES (?, ?, 1, 1, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
                ON DUPLICATE KEY UPDATE
                    total_wins = total_wins + 1,
                    current_streak = 1,
                    longest_streak = GREATEST(longest_streak, 1),
                    crowned_at = UTC_TIMESTAMP()
                `, [newKing.id, newKing.displayName]);

                // Add role to new king
                await newKing.roles.add(this.pvpKingRoleID).catch(console.error);

                // Add secondary role ONCE to all first-time PvP Kings
                if (!newKing.roles.cache.has(this.pvpWarriorRoleID)) {
                    await newKing.roles.add(this.pvpWarriorRoleID).catch(console.error);
                }
            }

            //currentKingId = newKing.id;

            // Get current King's Win Streak
            const [rows] = await this.db.query(
                'SELECT total_wins, current_streak, longest_streak, crowned_at FROM pvp_king_stats WHERE user_id = ?',
                [newKing.id]
            );
            const totalWins = rows[0]?.total_wins || 0;
            const streak = rows[0]?.current_streak || 0;
            const longest = rows[0]?.longest_streak || 0;
            const crowned_at = rows[0]?.crowned_at || 0;
            let lastCrowned = (newKing_last_crowned === 0) ? crowned_at : newKing_last_crowned;

            // Log to DB History
            await this.db.query(`
            INSERT INTO pvp_king_history
                (king_id, king_name, type, total_wins_after, streak_after, longest_streak_after, last_crowned, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
            `, [
                newKing.id,
                newKing.displayName,
                isDefense ? 'defense' : 'crown',
                totalWins,
                streak,
                longest,
                lastCrowned
            ]);

            // DELETE AFTER EVENT!
            // ==========================================
            // NEW ADDITION: PVP EVENT ANNOUNCEMENT LOGIC
            // ==========================================
            const EVENT_START = '2026-05-06 01:00:00';

            if (new Date() > new Date(EVENT_START)) {
                // 1. Fetch history since event start (DESC to count backwards from this win)
                const [fullEventHistory] = await this.db.query(`
                    SELECT king_id, created_at FROM pvp_king_history 
                    WHERE created_at > ? 
                    ORDER BY created_at DESC
                `, [EVENT_START]);

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
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '### ⚠️ Database error during Crowning.' });
            }
            return interaction.reply({ content: '### ⚠️ Database error during Crowning.', flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = PvpCrownKing;
