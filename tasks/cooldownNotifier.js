// ======================================================================
// PvP King System | Send notification when challengers cooldown expires
// ======================================================================

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

const COOLDOWN_CHECK_INTERVAL_MS = 60000;

module.exports = {
    name: 'cooldownTask',
    execute(client, config) {
        const { db, pvpKingChannelID, pvpKingRoleID, guildId } = config;
        let isRunning = false;

        setInterval(async () => {
            if (isRunning) return;
            isRunning = true;

            try {
                const [expired] = await db.query(`
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

                if (guild && kingRole && kingRole.members.size !== 1) {
                    await guild.members.fetch().catch(err => {
                        console.error('[WW LOG] Failed to refresh members for PvP cooldown task:', err.code || err.message);
                    });
                }

                const currentKing = kingRole?.members.first();
                if (!pvpChannel || !currentKing) return;

                const usersToPing = [];
                const idsToReset = [];

                for (const row of expired) {
                    if (row.king_id === currentKing.id) {
                        usersToPing.push(`<@${row.challenger_id}>`);
                    }

                    idsToReset.push(row.id);
                }

                if (usersToPing.length > 0) {
                    const logoFile = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
                    const pvpKingCdEmbed = new EmbedBuilder()
                        .setColor(0x02f3d7)
                        .setTitle('🔔 PvP Cooldown Expired!')
                        .setThumbnail(currentKing.displayAvatarURL({ size: 256 }))
                        .setDescription(
                            `### The wait is over!\n` +
                            `- Your cooldown against <@${currentKing.id}> has expired.\n` +
                            '- You may now challenge the **PvP King** once again! ⚔️'
                        )
                        .setFooter({ text: 'WW PvP King System', iconURL: 'attachment://ww_logo.png' })
                        .setTimestamp();

                    await pvpChannel.send({
                        content: usersToPing.join(' '),
                        embeds: [pvpKingCdEmbed],
                        files: [logoFile]
                    });
                }

                if (idsToReset.length > 0) {
                    const placeholders = idsToReset.map(() => '?').join(',');
                    await db.query(
                        `UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE id IN (${placeholders})`,
                        idsToReset
                    );
                }
            } catch (err) {
                console.error('[WW LOG] Cooldown Task Error:', err.code || err.message);
            } finally {
                isRunning = false;
            }
        }, COOLDOWN_CHECK_INTERVAL_MS);
    }
};
