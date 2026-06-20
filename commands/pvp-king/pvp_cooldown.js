// ----------------------
// /pvp_cooldown
// ----------------------
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

class PvpCooldown {

    constructor(config) {
        this.name = "pvp_cooldown";
        this.db = config.db;
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
        if (this.onCooldown(interaction.user.id, 'pvp_cooldown', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const { guild } = interaction;
            const logChannel = guild.channels.cache.get(this.logChannelID);
            const nowTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
            const kingRole = guild.roles.cache.get(this.pvpKingRoleID);

            if (!kingRole) {
                if (logChannel) await logChannel.send(`### 🚨 <@${this.ownerID}> — PvP King role missing! (${nowTime})`);
                return interaction.editReply({
                    content: '### ❌ PvP King role not found! Officers have been notified.',
                });
            }

            await guild.members.fetch().catch(err => {
                console.error('[WW LOG] Failed to refresh members for /pvp_cooldown:', err.code || err.message);
            });

            if (kingRole.members.size === 0) {
                if (logChannel) { await logChannel.send(`### 🚨 <@${this.ownerID}> — No PvP King found! (${nowTime})`); }
                return interaction.editReply({
                    content: '### ⚠️ There is currently no member that has the PvP King role!',
                });
            }

            if (kingRole.members.size > 1) {
                if (logChannel) await logChannel.send(`### 🚨 <@${this.ownerID}> — Multiple PvP Kings detected: ${kingRole.members.size} — (${nowTime})`);
                return interaction.editReply({
                    content: '### ⚠️ Multiple PvP Kings detected! Officers have been notified.',
                });
            }

            const currentKing = kingRole.members.first();
            if (currentKing.id === interaction.user.id) {
                return interaction.editReply({ content: `### You can't have a cooldown against yourself, King xD` });
            }

            const [cdRows] = await this.db.query(
                'SELECT king_id, last_challenge, notify_on_expire FROM pvp_king_cooldowns WHERE challenger_id = ?',
                [interaction.user.id]
            );

            const lastChallengeKing_id = cdRows[0]?.king_id;
            const lastChallenge = cdRows[0]?.last_challenge;
            let isNotifyEnabled = cdRows[0]?.notify_on_expire === 1;

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
                    const [checkRows] = await this.db.query(
                        'SELECT notify_on_expire FROM pvp_king_cooldowns WHERE challenger_id = ?',
                        [i.user.id]
                    );

                    const hasChallenged = checkRows.length > 0;
                    const currentDbState = hasChallenged ? (checkRows[0].notify_on_expire === 1) : false;
                    isNotifyEnabled = !currentDbState;

                    if (hasChallenged) {
                        await this.db.query(
                            'UPDATE pvp_king_cooldowns SET notify_on_expire = ? WHERE challenger_id = ?',
                            [isNotifyEnabled ? 1 : 0, i.user.id]
                        );
                    } else {
                        await this.db.query(
                            `INSERT INTO pvp_king_cooldowns 
                            (challenger_id, challenger_name, king_id, king_name, last_challenge, notify_on_expire) 
                            VALUES (?, ?, 'None', 'None', NULL, ?)`,
                            [i.user.id, i.member.displayName, isNotifyEnabled ? 1 : 0]
                        );
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
            interaction.editReply({ content: '### ⚠️  Database error! Try again.' }).catch(() => { });
        }
    }
}

module.exports = PvpCooldown;
