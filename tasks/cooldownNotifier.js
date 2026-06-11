// ======================================================================
// PvP King System | Send notification when challengers cooldown expires 
// ======================================================================

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

// Helper function for retry logic
const queryWithRetry = async (db, sql, params = [], retries = 3, delayMs = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await db.query(sql, params);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.error(`[WW LOG] ⚠️ Query attempt ${i + 1} failed, retrying in ${delayMs / 1000}s... Error:`, err.code);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
};

module.exports = {
    name: 'cooldownTask',
    execute(client, config) {
        const { db, pvpKingChannelID, pvpKingRoleID, guildId } = config;

        setInterval(async () => {
            try {
                // Fetch expired cooldowns for members with retry logic
                const [expired] = await queryWithRetry(db, `
                    SELECT id, challenger_id, king_id 
                    FROM pvp_king_cooldowns 
                    WHERE notify_on_expire = 1 
                      AND last_challenge IS NOT NULL 
                      AND last_challenge <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
                `);

                if (expired.length === 0) return;

                const guild = client.guilds.cache.get(guildId);
                const pvpChannel = guild?.channels.cache.get(pvpKingChannelID);
                const kingRole = guild?.roles.cache.get(pvpKingRoleID);
                const currentKing = kingRole?.members.first();

                if (!pvpChannel || !currentKing) return;

                const usersToPing = [];
                const idsToReset = [];
                for (const row of expired) {
                    // Safety Check: Only ping if the cooldown was specifically against the current PvP King
                    if (row.king_id === currentKing.id) {
                        usersToPing.push(`<@${row.challenger_id}>`);
                    }

                    idsToReset.push(row.id);
                }

                // Notify members if cooldowns expired for the current PvP King
                if (usersToPing.length > 0) {
                    const logoFile = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
                    const pvpKingCdEmbed = new EmbedBuilder()
                        .setColor(0x02f3d7)
                        .setTitle('🔔 PvP Cooldown Expired!')
                        .setThumbnail(currentKing.displayAvatarURL({ size: 256 }))
                        .setDescription(`### The wait is over!\n- Your cooldown against <@${currentKing.id}> has expired.\n- You may now challenge the **PvP King** once again! ⚔️`)
                        .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
                        .setTimestamp();

                    await pvpChannel.send({
                        content: usersToPing.join(' '),
                        embeds: [pvpKingCdEmbed],
                        files: [logoFile]
                    });
                }

                // Cleanup: Set all processed IDs to NULL with retry logic
                if (idsToReset.length > 0) {
                    const placeholders = idsToReset.map(() => '?').join(',');
                    await queryWithRetry(
                        db,
                        `UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE id IN (${placeholders})`,
                        idsToReset
                    );
                }

            } catch (err) {
                console.error('[WW LOG] ❌ Cooldown Task Error after retries:', err);
            }
        }, 60000);
    }
};
