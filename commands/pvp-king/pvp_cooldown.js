// ----------------------
// /pvp_cooldown
// ----------------------
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { formatNowMinute, resolveSinglePvpKing, stopIfOnCooldown } = require('./utils/pvpHelper.js');

class PvpCooldown {

    constructor(config) {
        this.name = "pvp_cooldown";
        this.db = config.pvpKingStorage || config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.ownerID = config.ownerID;
        this.logChannelID = config.logChannelID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.onCooldown = config.onCooldown;
        this.data = new SlashCommandBuilder()
            .setName('pvp_cooldown')
            .setDescription('Check your cooldown status against the current PvP King');
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'pvp_cooldown', 2)) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const nowTime = formatNowMinute();
            const kingCheck = await resolveSinglePvpKing(interaction, {
                pvpKingRoleID: this.pvpKingRoleID,
                logChannelID: this.logChannelID,
                ownerID: this.ownerID,
                now: nowTime,
                contextLabel: '/pvp_cooldown',
                missingRoleReply: '### ❌ PvP King role not found! Officers have been notified.',
                noKingReply: '### ⚠️ There is currently no member that has the PvP King role!',
                multipleKingsReply: '### ⚠️ Multiple PvP Kings detected! Officers have been notified.'
            });
            if (!kingCheck.ok) return;

            const currentKing = kingCheck.currentKing;
            if (currentKing.id === interaction.user.id) {
                return interaction.editReply({ content: `### You can't have a cooldown against yourself, King xD` });
            }

            const cooldown = await this.db.getCooldown(interaction.user.id);
            const lastChallengeKing_id = cooldown?.king_id;
            const lastChallenge = cooldown?.last_challenge;
            let isNotifyEnabled = cooldown?.notify_on_expire === 1;

            // --- Logic for Cooldown State ---
            const lastChallengeDate = lastChallenge ? new Date(lastChallenge + 'Z') : null;
            const cooldownMs = 48 * 60 * 60 * 1000;
            const now = new Date();

            const hasActiveCooldown = lastChallengeDate &&
                (now - lastChallengeDate < cooldownMs) &&
                (lastChallengeKing_id === currentKing.id);

            // Helper function to build the message dynamically
            const getMessageContent = (isExpired = false) => {
                let header = '# ⏱️ PvP King Cooldown Status\n';
                let statusSection = `### ✅  You do not have any cooldowns!\n- You can challenge the PvP King (<@${currentKing.id}>) with the \`/pvp_challenge\` command in <#${this.pvpKingChannelID}>`;
                if (!lastChallenge || lastChallengeKing_id !== currentKing.id) {
                    statusSection = `### ✅  No Active Cooldown!\n- You can challenge the PvP King (<@${currentKing.id}>) with the \`/pvp_challenge\` command in <#${this.pvpKingChannelID}>`;
                } else if (!hasActiveCooldown) {
                    statusSection = `### ✅  Cooldown Expired!\n- Your cooldown against **<@${currentKing.id}>** has expired.\n- The PvP Crown awaits — challenge the PvP King again in <#${this.pvpKingChannelID}>`;
                } else {
                    const remainingMs = cooldownMs - (now - lastChallengeDate);
                    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
                    const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                    const unixTime = Math.floor((lastChallengeDate.getTime() + cooldownMs) / 1000);

                    statusSection = `### ⏳ Active Cooldown versus the current PvP King: <@${currentKing.id}>\n` +
                        `- Time remaining: **${hours}h ${minutes}m**\n` +
                        `- You can challenge again: <t:${unixTime}:F> (<t:${unixTime}:R>)`;
                }

                let notifySection = `\n\n## 📢  Notifications: **${isNotifyEnabled ? '*ENABLED 🔔*' : '*DISABLED 🔕*'}**\n` +
                    `-# When you challenge the PvP King using \`/pvp_challenge\`, you'll receive a **48-hour cooldown** once the King accepts your challenge.\n-# Cooldowns are tied to the **PvP King** — not the Throne — meaning your cooldown resets whenever a new King is crowned!\n` +
                    `### Enable notifications to get pinged when:\n` +
                    `- Your cooldown against a PvP King expires\n` +
                    `- A new PvP King is crowned *(you will only be pinged if you have an active cooldown against the fallen King)*`;

                if (isExpired) {
                    const expiredFooter = `\n## ⚠️  Session Expired! (5 minutes)\n- *Run the command again to update notification settings!*`;
                    return `~~${header + statusSection + notifySection}~~` + expiredFooter;
                }

                return header + statusSection + notifySection;
            };

            // --- Button Logic ---
            const getButtons = (disabled = false) => {
                const btn = new ButtonBuilder()
                    .setCustomId('toggle_pvp_notify')
                    .setLabel(isNotifyEnabled ? 'Disable Notifications' : 'Enable Notifications')
                    .setStyle(disabled ? ButtonStyle.Secondary : (isNotifyEnabled ? ButtonStyle.Danger : ButtonStyle.Success))
                    .setEmoji(isNotifyEnabled ? '🔕' : '🔔')
                    .setDisabled(disabled);
                return new ActionRowBuilder().addComponents(btn);
            };

            const replyMsg = await interaction.editReply({
                content: getMessageContent(),
                components: [getButtons()]
            });

            const collector = replyMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 300000 // 5 minutes (300000ms)
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: '❌ Not for you!', flags: MessageFlags.Ephemeral });

                await i.deferUpdate();

                try {
                    // Fetch the MOST RECENT state from the database
                    const latestCooldown = await this.db.getCooldown(i.user.id);
                    const hasChallenged = Boolean(latestCooldown);
                    const currentDbState = hasChallenged ? (latestCooldown.notify_on_expire === 1) : false;
                    isNotifyEnabled = !currentDbState;

                    if (hasChallenged) {
                        await this.db.setCooldownNotification(i.user.id, isNotifyEnabled);
                    } else {
                        await this.db.createNotificationCooldown(i.user.id, i.member.displayName, isNotifyEnabled);
                    }

                    await i.editReply({
                        content: getMessageContent(),
                        components: [getButtons()]
                    });

                    await i.followUp({
                        content: `### ${isNotifyEnabled ? '🔔' : '🔕'} Notifications ${isNotifyEnabled ? 'enabled' : 'disabled'}!`,
                        flags: MessageFlags.Ephemeral
                    });
                } catch (error) {
                    if (error.code === 10062) {
                        console.log("Interaction expired before update could be sent.");
                    } else {
                        console.error(error);
                    }
                }
            });

            collector.on('end', () => {
                interaction.editReply({
                    content: getMessageContent(true),
                    components: [getButtons(true)]
                }).catch(() => { });
            });

        } catch (err) {
            console.error(err);
            interaction.editReply({
                content: err.code === 'PVP_DATABASE_UNAVAILABLE'
                    ? '### ⚠️ Database is currently unavailable. Please try again later.'
                    : '### ⚠️  Database error! Try again.'
            }).catch(() => { });
        }
    }
}

module.exports = PvpCooldown;
