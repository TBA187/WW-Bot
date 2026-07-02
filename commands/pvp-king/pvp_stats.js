// ----------------------
// /pvp_stats
// ----------------------
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');
const { replyMissingMemberOption, stopIfOnCooldown } = require('./utils/pvpHelper.js');

class PvpStats {

    constructor(config) {
        this.name = "pvp_stats";
        this.db = config.pvpKingStorage || config.db;
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
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'stats', 2)) return;

        const user = interaction.options.getUser('user');
        const member = await replyMissingMemberOption(interaction, 'user', '❌ User not found!');
        const name = member ? member.displayName : user.username;
        if (!member) return;

        await interaction.deferReply();

        try {
            const stats = await this.db.getStats(user.id);

            if (!stats) {
                return interaction.editReply(
                    `### 📈  No PvP King data found for ${name}\n`
                );
            }

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
            const message = err.code === 'PVP_DATABASE_UNAVAILABLE'
                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                : '### ⚠️ Failed to retrieve stats.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = PvpStats;
