// ----------------------
// /pvp_stats
// ----------------------
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');

class PvpStats {

    constructor(config) {
        this.name = "pvp_stats";
        this.db = config.db;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_stats')
            .setDescription('Show PvP King stats for a user')
            .addUserOption(o =>
                o.setName('user')
                    .setDescription('Select user')
                    .setRequired(true)
            );
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'stats', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser('user');
        const member = interaction.options.getMember('user');
        const name = member ? member.displayName : user.username;
        if (!member) return interaction.reply({ content: '❌ User not found!', flags: MessageFlags.Ephemeral });

        await interaction.deferReply();

        try {
            const [rows] = await this.db.query(`
                SELECT total_wins, total_crown_losses, current_streak, longest_streak, first_crowned, crowned_at
                FROM pvp_king_stats
                WHERE user_id = ?
                `, [user.id]
            );

            if (!rows.length) {
                return interaction.editReply(
                    `### 📈  No PvP King data found for ${name}\n`
                );
            }

            const stats = rows[0];
            const firstCrowned = stats.first_crowned ? `<t:${Math.floor(new Date(stats.first_crowned).getTime() / 1000)}:F>` : '*Never*';
            const lastCrowned = stats.crowned_at ? `<t:${Math.floor(new Date(stats.crowned_at).getTime() / 1000)}:F>` : '*Never*';
            const embed = new EmbedBuilder()
                .setTitle('<:kyurem:1472065995089645609>\u2002White Walker PvP King Stats\u2002<:kyurem:1472065995089645609>')
                .setDescription(`## 📈 PvP Stats for <@${user.id}>`)
                .addFields(
                    { name: `🔥\u2002 Current Win Streak:\u2002${stats.current_streak ?? 0}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002 Longest Streak:\u2002${stats.longest_streak ?? 0}`, value: `\u2002`, inline: false },
                    // { name: `💥\u2002 Total Dethrones: ${stats.total_crown_losses ?? 0}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002 Total Wins:\u2002${stats.total_wins ?? 0}`, value: '\u2002', inline: false },
                    { name: `🥇\u2002 First Victory:\u2002${firstCrowned}`, value: '\u2002', inline: false },
                    { name: `<:pepe_king:1455434151262949535>\u2002 Last Victory:\u2002${lastCrowned}`, value: '\u2002', inline: false },
                    { name: '\u2002', value: '\u2002', inline: false }
                )
                .setColor(0x02f3d7)
                .setThumbnail(user.displayAvatarURL())
                .setFooter(createPvpFooter())
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
                files: [getServerLogo()]
            });
        } catch (err) {
            console.error(err);
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '### ⚠️ Failed to retrieve stats.' });
            }
            return interaction.reply({ content: '### ⚠️ Failed to retrieve stats.', flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = PvpStats;
