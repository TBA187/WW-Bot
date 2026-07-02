// ======================================================================
// PvP King System | Send notification when challengers cooldown expires
// ======================================================================

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { refreshGuildMembers } = require('../commands/pvp-king/utils/pvpHelper.js');

const COOLDOWN_CHECK_INTERVAL_MS = 60000;
const PVP_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const MAX_MISSED_NOTIFICATION_AGE_MS = 60 * 60 * 1000;

function getCooldownExpiryMs(row) {
    if (!row?.last_challenge) return null;

    const rawDate = row.last_challenge instanceof Date
        ? row.last_challenge
        : new Date(`${row.last_challenge}Z`);
    const lastChallengeMs = rawDate.getTime();

    if (Number.isNaN(lastChallengeMs)) return null;
    return lastChallengeMs + PVP_COOLDOWN_MS;
}

function shouldNotifyExpiredCooldown(row, nowMs = Date.now()) {
    const expiryMs = getCooldownExpiryMs(row);
    if (!expiryMs) return false;

    return nowMs - expiryMs <= MAX_MISSED_NOTIFICATION_AGE_MS;
}

module.exports = {
    name: 'cooldownTask',
    execute(client, config) {
        const db = config.pvpKingStorage || config.db;
        const { pvpKingChannelID, pvpKingRoleID, guildId } = config;
        let isRunning = false;

        const runCooldownCheck = async () => {
            if (isRunning) return;
            isRunning = true;

            try {
                const expired = await db.findExpiredNotifiableCooldowns();

                if (expired.length === 0) return;

                const guild = client.guilds.cache.get(guildId);
                const pvpChannel = guild?.channels.cache.get(pvpKingChannelID);
                const kingRole = guild?.roles.cache.get(pvpKingRoleID);

                if (guild && kingRole && kingRole.members.size !== 1) {
                    await refreshGuildMembers(guild, 'PvP cooldown task');
                }

                const currentKing = kingRole?.members.first();
                if (!pvpChannel || !currentKing) return;

                const usersToPing = [];
                const idsToReset = [];

                for (const row of expired) {
                    if (row.king_id === currentKing.id && shouldNotifyExpiredCooldown(row)) {
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
                    await db.resetCooldownsByIds(idsToReset);
                }
            } catch (err) {
                console.error('[WW LOG] Cooldown Task Error:', err.code || err.message);
            } finally {
                isRunning = false;
            }
        };

        runCooldownCheck();
        const interval = setInterval(runCooldownCheck, COOLDOWN_CHECK_INTERVAL_MS);
        interval.unref?.();
    }
};

module.exports.shouldNotifyExpiredCooldown = shouldNotifyExpiredCooldown;
