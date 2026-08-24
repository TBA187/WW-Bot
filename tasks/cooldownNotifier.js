// ======================================================================
// PvP King System | Send notification when challengers cooldown expires
// ======================================================================

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { refreshGuildMembers } = require('../commands/pvp-king/utils/pvpHelper.js');
const { messageSearchText } = require('../utils/discordMessageHistory.js');

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

async function recentlyNotifiedCooldownUsers(channel, userIds, botUserId, nowMs = Date.now()) {
    const notified = new Set();
    if (!channel?.messages?.fetch || !userIds?.length) return notified;
    const messages = await channel.messages.fetch({ limit: 100 });
    if (!messages || typeof messages.values !== 'function') return notified;

    for (const message of messages.values()) {
        if (botUserId && String(message.author?.id || '') !== String(botUserId)) continue;
        const createdMs = Number(message.createdTimestamp || message.createdAt?.getTime?.());
        if (!Number.isFinite(createdMs) || nowMs - createdMs > MAX_MISSED_NOTIFICATION_AGE_MS) continue;
        const text = messageSearchText(message);
        if (!text.includes('PvP Cooldown Expired!')) continue;
        for (const userId of userIds) {
            if (text.includes(`<@${userId}>`)) notified.add(String(userId));
        }
    }
    return notified;
}

module.exports = {
    name: 'cooldownTask',
    execute(client, config) {
        const db = config.pvpKingStorage || config.db;
        const { pvpKingChannelID, pvpKingRoleID, guildId } = config;
        let isRunning = false;
        let storageUnavailable = false;

        const runCooldownCheck = async () => {
            if (isRunning) return;
            isRunning = true;

            try {
                const expired = await db.findExpiredNotifiableCooldowns();
                if (storageUnavailable) {
                    storageUnavailable = false;
                    console.log('[WW LOG] PvP cooldown notification storage restored; scheduled checks resumed.');
                }

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
                let alreadyNotified = new Set();
                try {
                    alreadyNotified = await recentlyNotifiedCooldownUsers(
                        pvpChannel,
                        expired.map(row => String(row.challenger_id)),
                        client.user?.id
                    );
                    if (alreadyNotified.size) {
                        console.log(
                            `[WW LOG] Recovered ${alreadyNotified.size} recent PvP cooldown notification(s); duplicate ping skipped.`
                        );
                    }
                } catch (error) {
                    console.warn(
                        '[WW LOG] Could not check recent PvP cooldown messages for duplicates; database state remains the primary guard:',
                        error.code || error.message
                    );
                }

                for (const row of expired) {
                    if (row.king_id === currentKing.id
                        && shouldNotifyExpiredCooldown(row)
                        && !alreadyNotified.has(String(row.challenger_id))) {
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
                if (err.code === 'PVP_DATABASE_UNAVAILABLE' || err.code === 'DATABASE_UNAVAILABLE') {
                    if (!storageUnavailable) {
                        storageUnavailable = true;
                        console.warn(
                            '[WW LOG] PvP cooldown notification check paused because neither MySQL nor a usable JSON snapshot is available. ' +
                            'The task will retry every minute.'
                        );
                    }
                } else {
                    console.error('[WW LOG] Cooldown Task Error:', err);
                }
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
module.exports.recentlyNotifiedCooldownUsers = recentlyNotifiedCooldownUsers;
