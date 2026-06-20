// ----------------------
// /pvp_leaderboard
// ----------------------
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

class PvpLeaderboard {
    constructor(config) {
        this.name = "pvp_leaderboard";
        this.db = config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.historyThreadID = config.historyThreadID;
        this.data = new SlashCommandBuilder()
            .setName('pvp_leaderboard')
            .setDescription('Display all PvP Kings — White Walker Hall of Fame!');
    }

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Fetch ALL records
            const [rows] = await this.db.query(`
                SELECT user_id, king_name, longest_streak, total_wins, first_crowned, crowned_at 
                FROM pvp_king_stats
            `);

            if (rows.length === 0) {
                return interaction.editReply("### 📜 The Hall of Fame is currently empty!");
            }

            // Count Total PvP Kings
            const [[{ total_kings }]] = await this.db.query('SELECT COUNT(*) AS total_kings FROM pvp_king_stats');

            // Count all PvP King entries and keep the latest history row as a display fallback.
            const [[historyInfo]] = await this.db.query(`
                SELECT
                    COUNT(*) AS totalKingEntries,
                    (SELECT king_id FROM pvp_king_history ORDER BY id DESC LIMIT 1) AS latestKingId
                FROM pvp_king_history
            `);
            const totalKingEntries = historyInfo?.totalKingEntries || 0;

            // Do not fetch all guild members here; opcode 8 member chunks are heavily rate limited.
            // The commands that need strict role validation refresh members themselves.
            const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
            const cachedKings = kingRole?.members;
            let currentKingId = cachedKings?.size === 1 ? cachedKings.first().id : null;
            if (!currentKingId && historyInfo?.latestKingId) {
                currentKingId = String(historyInfo.latestKingId);
            }
            const currentKingText = currentKingId ? `<@${currentKingId}>` : '*No current PvP King found*';

            // Pagination & Sorting State
            const itemsPerPage = 10;
            const totalPages = Math.ceil(rows.length / itemsPerPage);
            let currentPage = 0;
            let currentSort = 'total_wins';
            let sortedRows = [...rows];

            const applySort = () => {
                if (currentSort === 'total_wins') {
                    // Highest total wins -> Highest streak -> First crowned (oldest first)
                    sortedRows.sort((a, b) => (b.total_wins - a.total_wins) || (b.longest_streak - a.longest_streak) || (a.first_crowned - b.first_crowned));
                } else if (currentSort === 'longest_streak') {
                    // Highest streak -> Highest total wins -> First crowned (oldest first)
                    sortedRows.sort((a, b) => (b.longest_streak - a.longest_streak) || (b.total_wins - a.total_wins) || (a.first_crowned - b.first_crowned));
                } else if (currentSort === 'first_crowned_asc') {
                    // Oldest victories first (Oldest ➔ Newest)
                    sortedRows.sort((a, b) => a.first_crowned - b.first_crowned);
                } else if (currentSort === 'crowned_at_asc') {
                    // Newest victories first (Newest ➔ Oldest)
                    sortedRows.sort((a, b) => b.crowned_at - a.crowned_at);
                }
            };

            applySort();

            const generateEmbed = (page) => {
                const start = page * itemsPerPage;
                const end = start + itemsPerPage;
                const currentItems = sortedRows.slice(start, end);
                const embed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setThumbnail(interaction.guild.iconURL())
                    .setTimestamp()
                    .setFooter({
                        text: `WW PvP King System • Page ${page + 1} of ${totalPages}`,
                        iconURL: interaction.guild.iconURL()
                    });

                const sortTitles = {
                    'longest_streak': { emoji: '🔥', title: 'Longest Streak' },
                    'total_wins': { emoji: '⚔️', title: 'Total Wins' },
                    'first_crowned_asc': { emoji: '📜', title: 'First Victories (Oldest ➔ Newest)' },
                    'crowned_at_asc': { emoji: '✨', title: 'Last Victories (Newest ➔ Oldest)' }
                };
                const activeSort = sortTitles[currentSort] || sortTitles.total_wins;

                let descriptionText = `## 🏆\u2002White Walkers — PvP Hall of Fame\u2002🏆\n` +
                    `**In the grip of endless winter, \`${total_kings}\` PvP Kings stand frozen in time, their legacy etched in ice forever!\u2002🧊**\n` +
                    `-# - **Current PvP King:\u2002👑\u2002${currentKingText}\u2002👑**\n` +
                    `-# - Challenge the current PvP King with: **\`/pvp_challenge\`**\n` +
                    `### PvP Kings sorted by\u2002${activeSort.emoji}\u2002${activeSort.title}:\n`;

                currentItems.forEach((row, index) => {
                    const overallIndex = start + index;
                    const unixFirst = Math.floor(row.first_crowned / 1000);
                    const unixLast = Math.floor(row.crowned_at / 1000);

                    // Check if this row is the current king
                    const isCurrentKing = String(row.user_id) === currentKingId;
                    const crownLabel = isCurrentKing ? " 👑" : "";

                    const rankMedal = overallIndex === 0 ? "🥇" : overallIndex === 1 ? "🥈" : overallIndex === 2 ? "🥉" : `**${overallIndex + 1}.**`;

                    descriptionText += `${rankMedal} **${row.king_name}**${crownLabel}\n` +
                        `└ First Victory:\u2002<t:${unixFirst}:d>\u2002—\u2002Last Victory:\u2002<t:${unixLast}:d>\n` +
                        `└ Longest Streak:\u2002\`${row.longest_streak}\`\u2002🔥 \u2002—\u2002  Total Wins:\u2002\`${row.total_wins}\`\u2002⚔️\n\n`;
                });

                if (this.historyThreadID) {
                    descriptionText += `-# View all \`${totalKingEntries}\` PvP King entries in <#${this.historyThreadID}>\n`;
                }

                embed.setDescription(descriptionText);
                return embed;
            };

            const generateComponents = (page, isDisabled = false) => {
                const sortRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('sort_menu')
                        .setPlaceholder(isDisabled ? `🚫 Session Expired! — Run '/pvp_leaderboard' again` : 'Sort the Leaderboard...')
                        .setDisabled(isDisabled)
                        .addOptions([
                            { label: 'Total Wins', description: 'Sort by Total Wins', value: 'total_wins', emoji: '⚔️' },
                            { label: 'Longest Streak', description: 'Sort by Highest Streaks', value: 'longest_streak', emoji: '🔥' },
                            { label: 'Oldest Kings', description: 'Sort by First Victories (Oldest ➔ Newest)', value: 'first_crowned_asc', emoji: '📜' },
                            { label: 'Newest Kings', description: 'Sort by Recent Victories (Newest ➔ Oldest)', value: 'crowned_at_asc', emoji: '✨' }
                        ])
                );

                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(isDisabled || page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(isDisabled || page === totalPages - 1)
                );

                return totalPages > 1 ? [sortRow, buttonRow] : [sortRow];
            };

            const message = await interaction.editReply({
                embeds: [generateEmbed(currentPage)],
                components: generateComponents(currentPage)
            });

            // Set collector for 24 hours (86,400,000 ms)
            const collector = message.createMessageComponentCollector({
                time: 86400000
            });

            collector.on('collect', async (i) => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({
                        content: "### ⚠️  Use the `/pvp_leaderboard` command to open your own menu.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (i.isStringSelectMenu()) {
                    currentSort = i.values[0];
                    currentPage = 0;
                    applySort();
                } else if (i.isButton()) {
                    if (i.customId === 'prev_page') currentPage--;
                    if (i.customId === 'next_page') currentPage++;
                }

                await i.update({
                    embeds: [generateEmbed(currentPage)],
                    components: generateComponents(currentPage)
                });

                collector.resetTimer();
            });

            collector.on('end', () => {
                interaction.editReply({
                    components: generateComponents(currentPage, true)
                }).catch(() => { });
            });

        } catch (err) {
            console.error(err);
            interaction.editReply({ content: '### ⚠️ Failed to load the PvP King Hall of Fame!' }).catch(() => { });
        }
    }
}

module.exports = PvpLeaderboard;
