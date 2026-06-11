// ----------------------
// /pvp_history
// ----------------------
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

class PvpHistory {

    constructor(config) {
        this.name = "pvp_history";
        this.db = config.db;
        this.historyThreadID = config.historyThreadID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_history')
            .setDescription('History of PvP Kings')
            .addIntegerOption(o =>
                o.setName('amount')
                    .setDescription('How many recent entries? (default 10, max 15)')
                    .setMinValue(1)
                    .setMaxValue(15)
            );
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'currentking', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        try {
            const amount = interaction.options.getInteger('amount') ?? 10;

            // Count Total PvP Kings
            const [[{ totalKings }]] = await this.db.query('SELECT COUNT(*) AS totalKings FROM pvp_king_stats');

            // Fetch latest 500 entries from history
            const [rowsDesc] = await this.db.query(`
                SELECT id, king_id, king_name, type, total_wins_after, streak_after, created_at
                FROM pvp_king_history
                ORDER BY id ASC
                LIMIT 500
            `);

            // Count all PvP King entries
            const [[{ totalKingEntries }]] = await this.db.query('SELECT COUNT(*) AS totalKingEntries FROM pvp_king_history');

            if (!rowsDesc.length) {
                return interaction.editReply('### ⚠️ No PvP King history found.');
            }

            // Remove consecutive duplicates and take last streak/wins in block
            const displayRows = [];
            let i = 0;
            while (i < rowsDesc.length) {
                const currentUserId = rowsDesc[i].king_id;
                let firstRow = rowsDesc[i];
                let lastRowIndex = i;

                // Find last consecutive row for this user
                for (let j = i + 1; j < rowsDesc.length; j++) {
                    if (rowsDesc[j].king_id === currentUserId) lastRowIndex = j;
                    else break;
                }

                const lastRow = rowsDesc[lastRowIndex];

                displayRows.push({
                    king_id: lastRow.king_id,
                    king_name: lastRow.king_name,
                    // type: firstRow.type,
                    created_at: firstRow.created_at,
                    total_wins_after: lastRow.total_wins_after,
                    streak_after: lastRow.streak_after,
                });

                i = lastRowIndex + 1;
            }

            // Fetch 'amount' history entries to show
            const historyRows = displayRows.slice(-(amount + 1));
            const currentKing = historyRows.pop(); // remove newest entry (current king)

            // All King entries
            const entries = historyRows.map(r => {
                const time = r.created_at
                    ? `<t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:F>`
                    : '*Error loading time!*';

                return `- 🏆  ${time}  **—  👑  ${r.king_name}  👑  —  Streak during reign:  ${r.streak_after}   |  Total Wins:  ${r.total_wins_after}**`;
            });

            // Always show the last record in DB as current king
            const lastTime = currentKing.created_at
                ? `<t:${Math.floor(new Date(currentKing.created_at).getTime() / 1000)}:F>`
                : '*Error loading time!*';

            entries.push(
                `\n## 👑  ${currentKing.king_name} is the current PvP King  👑  —  Crowned: ${lastTime}\n` +
                `       **→ Current Streak:  ${currentKing.streak_after}  🔥**\n` +
                `       **→ Total Wins:  ${currentKing.total_wins_after}  🏆**`
            );

            await interaction.editReply(
                `# 👑  PvP King History (Last ${historyRows.length} entries)  👑\n` +
                `**<:pepe_king:1455434151262949535>  ${totalKings} individual PvP Kings have ruled White Walkers so far! View all PvP Kings with the \`/pvp_leaderboard\` command.**\n\n` +
                entries.join('\n') +
                `\n\n### View all \`${totalKingEntries}\` PvP King entries in <#${this.historyThreadID}>`
            );

        } catch (err) {
            console.error(err);
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '### ⚠️ Failed to fetch history.' });
            }
            return interaction.reply({ content: '### ⚠️ Failed to fetch history.', flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = PvpHistory;
