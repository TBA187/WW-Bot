// ----------------------
// /pvp_event
// ----------------------
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

class PvpEvent {
    constructor(config) {
        this.name = "pvp_event";
        this.db = config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.data = new SlashCommandBuilder()
            .setName('pvp_event')
            .setDescription("View the time limited PvP King Event Leaderboard");
    }

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const EVENT_START_DATE = '2026-05-06 01:00:00';

            const [historyRows] = await this.db.query(`
                SELECT king_id, king_name, created_at 
                FROM pvp_king_history 
                WHERE created_at > ?
                ORDER BY created_at ASC
            `, [EVENT_START_DATE]);

            const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
            const currentKingId = kingRole?.members.first()?.id || null;

            if (historyRows.length === 0) {
                return interaction.editReply(
                    `### ⏳ The PvP Event has started, but no one has claimed a victory yet!\n` +
                    `Be the first to challenge the current PvP King (<@${currentKingId}>) with the \`/pvp_challenge\` command in <#1469101041189523657>`
                );
            }

            let currentTempKing = null;
            let currentStreak = 0;
            const eventStats = new Map();

            for (const row of historyRows) {
                if (currentTempKing === row.king_id) {
                    currentStreak += 1;
                } else {
                    currentTempKing = row.king_id;
                    currentStreak = 1;
                }

                if (!eventStats.has(row.king_id)) {
                    eventStats.set(row.king_id, {
                        king_id: row.king_id,
                        king_name: row.king_name,
                        total_wins: 0,
                        best_streak: 0, // Highest they ever reached
                        active_streak: 0, // Their current ongoing streak
                        first_crowned: row.created_at,
                        last_win: row.created_at
                    });
                }

                const userStat = eventStats.get(row.king_id);
                userStat.total_wins += 1;
                userStat.last_win = row.created_at;

                // Reset everyone else's active streak to 0 because someone else took the crown
                for (let [id, stats] of eventStats) {
                    if (id !== row.king_id) stats.active_streak = 0;
                }

                // Update the current person's active and best streaks
                userStat.active_streak = currentStreak;
                if (currentStreak > userStat.best_streak) {
                    userStat.best_streak = currentStreak;
                }
            }

            // // Sort by Best Streak primarily
            // let sortedRows = Array.from(eventStats.values()).sort((a, b) =>
            //     (b.best_streak - a.best_streak) ||
            //     (b.total_wins - a.total_wins) ||
            //     (new Date(a.first_crowned) - new Date(b.first_crowned))
            // );

            // Sort logic: 1. Show current King always at top, 2. Total Wins, 3. Best Streak, 4. Date Crowned
            let sortedRows = Array.from(eventStats.values()).sort((a, b) => {
                // 1. Priority: Who has the active unbroken streak?
                if (a.active_streak > 0 && b.active_streak === 0) return -1;
                if (b.active_streak > 0 && a.active_streak === 0) return 1;

                // 2. Secondary: Total Wins
                if (b.total_wins !== a.total_wins) {
                    return b.total_wins - a.total_wins;
                }

                // 3. Tertiary: Best Streak ever achieved
                if (b.best_streak !== a.best_streak) {
                    return b.best_streak - a.best_streak;
                }

                // 4. Final: Who got their first win earliest?
                return new Date(a.first_crowned) - new Date(b.first_crowned);
            });

            const itemsPerPage = 10;
            const totalPages = Math.ceil(sortedRows.length / itemsPerPage);
            let currentPage = 0;

            const generateEmbed = (page) => {
                const start = page * itemsPerPage;
                const end = start + itemsPerPage;
                const currentItems = sortedRows.slice(start, end);

                const embed = new EmbedBuilder()
                    .setColor(0x02f3d7)
                    .setThumbnail(interaction.guild.iconURL())
                    .setTimestamp()
                    .setFooter({
                        text: `Event Page ${page + 1} of ${totalPages}`,
                        iconURL: interaction.guild.iconURL()
                    });

                let descriptionText = `## ⚔️\u2002Vangogsan's PvP King Event\u2002⚔️\n` +
                    `**The race is on! Only victories after May 6th, 2026 count towards this challenge.**\n` +
                    `### 🏆\u2002Goal: First to Win 10 times in a row!\n` +
                    `### 🥇\u2002Reward:\u200223 Coin Capsules\n` +
                    `### 👑\u2002Current PvP King:\u2002<@${currentKingId}>\n` +
                    `-# Challenge the current PvP King with the \`/pvp_challenge\` command in <#1469101041189523657>\n` +
                    `-# Read the PvP King **Rules** by using the \`/pvp_rules\` command.\n\n` +
                    `## <:pepe_king:1455434151262949535>\u2002PvP Event Kings:\n\n`;

                currentItems.forEach((row, index) => {
                    const overallIndex = start + index;
                    const unixLast = Math.floor(new Date(row.last_win + " UTC").getTime() / 1000);
                    const isCurrentKing = row.king_id === currentKingId;
                    const crownLabel = isCurrentKing ? " 👑" : "";

                    // Show [EVENT WINNER] if they hit 10 at any point
                    const eventWinnerMedal = row.best_streak >= 10 ? "\n🌟 **[EVENT WINNER]** 🌟" : "";
                    const rankMedal = overallIndex === 0 ? "🥇" : overallIndex === 1 ? "🥈" : overallIndex === 2 ? "🥉" : `**${overallIndex + 1}.**`;

                    // Only show the streak line if it is ACTIVE or they already finished (10/10)
                    const displayStreak = row.best_streak >= 10 ? row.best_streak : row.active_streak;
                    const showStreakLine = (row.active_streak > 0 || row.best_streak >= 10);
                    const streakText = showStreakLine ? `**└ Unbroken Streak:\u2002\`${displayStreak}/10\`\u2002🔥**\n` : "";

                    descriptionText += `${rankMedal} **${row.king_name}**${crownLabel} ${eventWinnerMedal}\n` +
                        streakText +
                        `└ Total Event Wins:\u2002\`${row.total_wins}\`\u2002⚔️\n` +
                        `└ Last Victory:\u2002<t:${unixLast}:R>\n\n`;
                });

                embed.setDescription(descriptionText);
                return embed;
            };

            const generateComponents = (page, isDisabled = false) => {
                return [new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page_evt')
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isDisabled || page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page_evt')
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isDisabled || page === totalPages - 1)
                )];
            };

            const message = await interaction.editReply({
                embeds: [generateEmbed(currentPage)],
                components: totalPages > 1 ? generateComponents(currentPage) : []
            });

            if (totalPages <= 1) return;

            const collector = message.createMessageComponentCollector({ time: 300000 });

            collector.on('collect', async (i) => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({
                        content: "### ⚠️ Use `/pvp_event` to open your own menu.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (i.customId === 'prev_page_evt') currentPage--;
                if (i.customId === 'next_page_evt') currentPage++;

                await i.update({
                    embeds: [generateEmbed(currentPage)],
                    components: generateComponents(currentPage)
                });
            });

            collector.on('end', () => {
                interaction.editReply({
                    components: generateComponents(currentPage, true)
                }).catch(() => { });
            });

        } catch (err) {
            console.error(err);
            interaction.editReply({ content: '### ⚠️ Failed to load the Event Leaderboard!' }).catch(() => { });
        }
    }
}

module.exports = PvpEvent;
