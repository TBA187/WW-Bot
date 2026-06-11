// ----------------------
// /pvp_current_king
// ----------------------
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');

class PvpCurrentKing {

    constructor(config) {
        this.name = "pvp_current_king";
        this.db = config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.ownerID = config.ownerID;
        this.logChannelID = config.logChannelID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_current_king')
            .setDescription('Show the current PvP King');
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'currentking', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        try {
            const { guild } = interaction;
            const logChannel = guild.channels.cache.get(this.logChannelID);
            if (!logChannel) {
                console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
            }

            const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
            const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

            if (!kingRole) {
                if (logChannel) {
                    await logChannel.send(`### 🚨 <@${this.ownerID}> — PvP King role missing! (${now})`);
                }

                return interaction.reply({
                    content: '### ❌ PvP King role not found! Officers have been notified and will resolve the issue as soon as possible.',
                    flags: MessageFlags.Ephemeral
                });
            }

            if (kingRole.members.size === 0) {
                if (logChannel) {
                    await logChannel.send(`### 🚨 <@${this.ownerID}> — No PvP King found! (${now})`);
                }

                return interaction.reply({
                    content: '### ⚠️ No PvP King found! Officers have been notified and will resolve the issue as soon as possible.',
                    flags: MessageFlags.Ephemeral
                });
            }

            if (kingRole.members.size > 1) {
                if (logChannel) {
                    await logChannel.send(`### 🚨 <@${this.ownerID}> — Multiple PvP Kings detected: ${kingRole.members.size} — (${now})`);
                }

                return interaction.reply({
                    content: '### ⚠️ Multiple PvP Kings detected! Officers have been notified and will resolve the issue as soon as possible.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply();

            const currentKing = kingRole.members.first();

            // Get PvP King stats from DB
            const [rows] = await this.db.query(
                'SELECT total_wins, current_streak, longest_streak, first_crowned, crowned_at FROM pvp_king_stats WHERE user_id = ?',
                [currentKing.id]
            );

            const totalWins = rows[0]?.total_wins || 0;
            const currentStreak = rows[0]?.current_streak || 0;
            const longestStreak = rows[0]?.longest_streak || 0;
            const firstCrowned = rows[0]?.first_crowned ? `<t:${Math.floor(new Date(rows[0]?.first_crowned).getTime() / 1000)}:F>` : '*Never*';
            const lastCrowned = rows[0]?.crowned_at ? `<t:${Math.floor(new Date(rows[0]?.crowned_at).getTime() / 1000)}:F>` : '*Never*';
            const embed = new EmbedBuilder()
                .setTitle('<:kyurem:1472065995089645609>\u2002White Walker PvP King\u2002<:kyurem:1472065995089645609>')
                .setDescription(`## 👑\u2002<@${currentKing.id}>\u2002👑`)
                .addFields(
                    { name: `🔥\u2002 Current Win Streak:\u2002${currentStreak}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002 Longest Streak:\u2002${longestStreak}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002 Total Wins:\u2002${totalWins}`, value: '\u2002', inline: false },
                    { name: `🥇\u2002 First Victory:\u2002${firstCrowned}`, value: '\u2002', inline: false },
                    { name: `<:pepe_king:1455434151262949535>\u2002 Last Victory:\u2002${lastCrowned}`, value: '\u2002', inline: false },
                    { name: '\u2002', value: '\u2002', inline: false },
                    { name: '\u2002', value: `- Challenge <@${currentKing.id}> with the \`/pvp_challenge\` command!`, inline: false },
                    { name: '\u2002', value: '\u2002', inline: false }
                )
                .setColor(0xf1c40f)
                .setThumbnail(currentKing.displayAvatarURL())
                .setFooter(createPvpFooter())
                .setTimestamp();

            return interaction.editReply({
                embeds: [embed],
                files: [getServerLogo()]
            });
        } catch (err) {
            console.error(err);
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '### ⚠️ Database error.' });
            }
            return interaction.reply({ content: '### ⚠️ Database error.', flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = PvpCurrentKing;
