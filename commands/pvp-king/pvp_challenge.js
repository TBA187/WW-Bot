// ----------------------
// /pvp_challenge
// ----------------------
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getServerLogo, getServerBanner, pvpThumnbnail, pvpBannerImage, createPvpFooter, createPvpLogFooter } = require('./utils/pvpAssets.js');

class PvpChallengeKing {
    constructor(config) {
        this.name = "pvp_challenge";
        this.db = config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.logChannelID = config.logChannelID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.ownerID = config.ownerID;
        //this.activeChallenge = null;
        this.challengeTimeouts = config.challengeTimeouts;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_challenge')
            .setDescription('Challenge the current PvP King');
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'currentking', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (interaction.channelId !== this.pvpKingChannelID) {
            return interaction.reply({ content: `### ❌  The \`/pvp_challenge\` command can only be used in <#${this.pvpKingChannelID}>`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Auto-clear stale lock (15 minutes - Discord Limitation)
        //if (activeChallenge && Date.now() - activeChallenge.startedAt > 900000) {
        //   activeChallenge = null;
        //}

        //if (activeChallenge) {
        //    return interaction.editReply({ content: '⚔️ A PvP challenge is already active. Please wait until it finishes.' });
        //}

        try {
            const { guild } = interaction;
            const logChannel = guild.channels.cache.get(this.logChannelID);
            if (!logChannel) {
                console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
            }

            const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

            // Validate PvP King role:
            const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
            if (!kingRole) {
                if (logChannel) {
                    await logChannel.send(
                        `**🚨 <@${this.ownerID}> — No PvP King Role found!**\n` +
                        `- This needs to be fixed asap! (${now})`
                    );
                }

                return interaction.editReply({
                    content: '### ❌ PvP King Role not found! Officers have been notified and will resolve the issue as soon as possible.'
                });
            }

            // Check for multiple kings
            const kings = kingRole.members;
            if (kings.size > 1) {
                if (logChannel) {
                    await logChannel.send(
                        `### 🚨 <@${this.ownerID}> — A user tried to challenge the PvP King but failed.\n- **Error:** Multiple PvP Kings detected **(${kings.size})** — (${now})`
                    );
                }

                return interaction.editReply({
                    content: `### ⚠️ There are currently: "${kings.size}" PvP Kings. This must be fixed before challenges can proceed.\n- **Officers have been notified and will resolve the issue as soon as possible.**`
                });
            }

            // If no PvP Kings
            if (kings.size === 0) {
                if (logChannel) {
                    await logChannel.send(
                        `### 🚨 <@${this.ownerID}> — No PvP King found! (${now})`
                    );
                }

                return interaction.editReply({
                    content: '### ⚠️ No PvP King found. Officers have been notified and will resolve the issue as soon as possible.'
                });
            }

            // At this point exactly 1 PvP King exists
            const currentKing = kings.first();
            // currentKingId = currentKing.id; // re-sync automatically

            if (interaction.user.id === currentKing.id) {
                return interaction.editReply({
                    content: '### ❌ You cannot challenge yourself!'
                });
            }

            try {
                // Check if challenger has a cooldown (48 hours)
                const [cdRows] = await this.db.query(
                    'SELECT king_id, last_challenge FROM pvp_king_cooldowns WHERE challenger_id = ?',
                    [interaction.user.id]
                );
                const lastChallengeKing_id = cdRows[0]?.king_id;
                const lastChallenge = cdRows[0]?.last_challenge;
                if (lastChallenge && lastChallengeKing_id === currentKing.id) {
                    const lastChallengeDate = new Date(lastChallenge + 'Z'); // Z = UTC
                    const now = new Date();
                    const diffMs = now - lastChallengeDate;
                    const cooldownMs = 48 * 60 * 60 * 1000; // (48 hours)
                    const nextChallenge = lastChallengeDate.getTime() + cooldownMs;

                    if (diffMs < cooldownMs) {
                        // Still on cooldown
                        const remainingMs = cooldownMs - diffMs;
                        const hours = Math.floor(remainingMs / (1000 * 60 * 60));
                        const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                        const unixTime = Math.floor(nextChallenge / 1000);
                        const cooldownEmbed = new EmbedBuilder()
                            .setColor(0xffcc00)
                            .setTitle('⏳ PvP King Challenge Cooldown Active!')
                            .setThumbnail(currentKing.displayAvatarURL({ size: 256 }))
                            .setDescription(
                                `### You are still on cooldown against <@${currentKing.id}>\n` +
                                `- Please wait **${hours}h ${minutes}m (<t:${unixTime}:F>)**\n` +
                                `- You can challenge again <t:${unixTime}:R>\n` +
                                `### 🔔 Notification Tip\n` +
                                `- Enable notifications with the \`/pvp_cooldown\` command to get pinged when your cooldown expires!`
                            )
                            .setFooter(createPvpFooter())
                            .setTimestamp();

                        return interaction.editReply({
                            embeds: [cooldownEmbed],
                            files: [getServerLogo()]
                        });
                    }
                }
            } catch (err) {
                console.error(err);
                await interaction.editReply({ content: '### ⚠️  Something went wrong. Please try again.' });
            }

            //activeChallenge = {
            //    challengerId: interaction.user.id,
            //    kingId: currentKing.id,
            //    startedAt: Date.now()
            //};

            // Confirmation buttons (only visible to challenger)
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pvp_confirm_yes_${currentKing.id}_${interaction.user.id}`)
                    .setLabel('Yes!')
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId(`pvp_confirm_no_${currentKing.id}_${interaction.user.id}`)
                    .setLabel('No!')
                    .setStyle(ButtonStyle.Danger)
            );

            await interaction.editReply({
                content: `## ⚔️  Do you want to challenge the PvP King for the throne?  ⚔️\n- Curent PvP King: **👑 ${currentKing.displayName} 👑**\n` +
                    `-# When the PvP King accepts your challenge, you will receive a **48-hour cooldown** before you can challenge **${currentKing.displayName}** again.\n` +
                    `-# If a new PvP King is crowned, the cooldown will reset and you may challenge the new King immediately.`,
                components: [confirmRow]
            });

            // Auto-expire the confirmation buttons after 60 seconds
            if (this.challengeTimeouts.has(interaction.user.id)) {
                clearTimeout(this.challengeTimeouts.get(interaction.user.id));
            }

            const timeout = setTimeout(async () => {
                try {
                    console.log(`Challenge timeout for: ${interaction.user.displayName}`);

                    await interaction.editReply({
                        content: "### ⌛ Challenge request auto expired after 1 minute!\n- You can use the **/pvp_challenge** command again to challenge the PvP King.",
                        components: []
                    });

                } catch { }

                this.challengeTimeouts.delete(interaction.user.id);

            }, 60000);

            this.challengeTimeouts.set(interaction.user.id, timeout);

            // Next code is executed from handleButton()

        } catch (err) {
            console.error(err);
            return interaction.editReply({ content: '### ⚠️ Error executing command.' });
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith("pvp_")) return false;

        const { guild } = interaction;
        const logChannel = guild.channels.cache.get(this.logChannelID);
        if (!logChannel) {
            console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
        }

        // Challenger confirmation buttons: pvp_confirm_yes / pvp_confirm_no
        if (interaction.customId.startsWith('pvp_confirm_')) {
            const parts = interaction.customId.split('_');
            if (parts.length !== 5) return false;

            const [, , action, kingId, challengerId] = parts;

            // Only the challenger can press
            if (interaction.user.id !== challengerId) {
                return interaction.reply({ content: "### ❌  This confirmation isn't for you!", flags: MessageFlags.Ephemeral });
            }

            // Swap out the buttons for a disabled "Loading..." button before doing anything else (Prevents button spam)
            const challengerLoadingRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('pvp_challenger_loading')
                    .setLabel('Summoning the King...')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );

            await interaction.update({ components: [challengerLoadingRow] }); // deferReply

            const timeout = this.challengeTimeouts.get(challengerId);
            if (timeout) {
                // Cancel the PvP challenge timeout!
                clearTimeout(timeout);
                this.challengeTimeouts.delete(challengerId);
            }

            if (action === 'no') {
                console.log(`Challenger cancelled PvP King challenge: ${interaction.user.displayName} against ${kingId}`);
                return interaction.editReply({
                    content: "### ❌  Challenge cancelled.",
                    components: []
                });
            }

            if (action === 'yes') {
                const currentKing = await interaction.guild.members.fetch(kingId).catch(() => null);
                if (!currentKing) {
                    return interaction.editReply({
                        content: "### ❌  PvP King not found!",
                        components: []
                    });
                }

                // Create Accept/Decline Buttons for the PvP King
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`pvp_accept_${kingId}_${challengerId}`)
                        .setLabel('Accept')
                        .setStyle(ButtonStyle.Success),

                    new ButtonBuilder()
                        .setCustomId(`pvp_decline_${kingId}_${challengerId}`)
                        .setLabel('Decline')
                        .setStyle(ButtonStyle.Danger)
                );

                // Send public challenge message
                await interaction.channel.send({
                    content:
                        `## <@&${this.pvpKingRoleID}> has been challenged!\n\n` +
                        `**🏆 <@${kingId}>**, do you accept the challenge from <@${challengerId}>?\n` +
                        `-# When the PvP King accepts the challenge, a **48 hours cooldown** will be applied to the challenger.\n-# When a new King is Crowned, all active cooldowns will reset and the New King may be challenged immediately!`,
                    //`-# The **Accept / Decline** buttons can become unresponsive (Discord limitation). If that's the case, the challenger **(${interaction.user.displayName})** must be pinged manually.`,
                    components: [row]
                });

                return interaction.editReply({
                    content: "### ⚔️  Challenge sent!  ⚔️",
                    components: []
                });
            }

            return;
        }

        const parts = interaction.customId.split('_');
        if (parts.length !== 4) return;

        const [type, action, kingId, challengerId] = parts;
        const actionType = `${type}_${action}`;
        if (!['pvp_accept', 'pvp_decline'].includes(actionType)) return;

        // Only the King can press buttons
        if (interaction.user.id !== kingId) {
            return interaction.reply({
                content: "### ❌ Not for you! Only the PvP King can press the buttons.",
                flags: MessageFlags.Ephemeral
            });
        }

        // Swap out the buttons for a disabled "Loading..." button before doing anything else (Prevents button spam)
        const kingLoadingRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('pvp_king_loading')
                .setLabel('Processing response...')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );

        await interaction.update({ components: [kingLoadingRow] }); // deferUpdate

        const currentKing = await interaction.guild.members.fetch(kingId).catch(() => null);
        const challenger = await interaction.guild.members.fetch(challengerId).catch(() => null);
        const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const unixNow = Math.floor(Date.now() / 1000);

        if (!currentKing || !challenger) {
            const errorMsg = !currentKing && !challenger
                ? 'Both PvP King and Challenger not found!'
                : !currentKing
                    ? 'PvP King not found!'
                    : !challenger
                        ? 'Challenger not found!'
                        : '';

            // Log to Discord Log Channel
            if (logChannel) {
                await logChannel.send(`** ❌ Error:** ${errorMsg}\n- Current King ID: ${kingId}\n- Challenger ID: ${challengerId}`);
            }

            return interaction.editReply({ content: `** ❌ Error:** ${errorMsg}`, flags: MessageFlags.Ephemeral });
        }

        if (actionType === 'pvp_accept') {
            //activeChallenge = null;
            const acceptEmbed = new EmbedBuilder()
                .setTitle('<:kyurem:1472065995089645609>\u2002White Walkers Awaken!\u2002<:kyurem:1472065995089645609>')
                .setDescription(`Winter is coming… the Frozen Throne awaits no mortal. The White Walkers spare none; only the strongest shall endure the frost!\u2002🧊\n\u200B`)
                .setColor(0x5DADE2)
                .addFields(
                    { name: '👑 The Night King', value: `<@${kingId}>`, inline: true },
                    { name: '🗡️ Frostborn Challenger', value: `<@${challengerId}>`, inline: true }
                    // { name: '📅 🌑 Time of Reckoning', value: `<t:${unixNow}:F>` }
                )
                .setThumbnail(currentKing.displayAvatarURL())
                .setImage(pvpBannerImage)
                .setFooter(createPvpFooter())
                .setTimestamp();

            // Send the NEW message first and capture it in a variable
            const newMessage = await interaction.channel.send({
                content: `## 🏆  The PvP King (${currentKing.displayName}) accepted a challenge from <@${challengerId}>  ⚔️\n**❄️  Winter decides their fate… all who fall will freeze in its wake!  ❄️**\n\u200B`,
                embeds: [acceptEmbed],
                files: [getServerBanner(), getServerLogo()]
            });

            // Edit the OLD message and include the link to the NEW one
            await interaction.editReply({
                content: `~~${interaction.message.content}~~\n### ✅ Challenge Accepted: <t:${unixNow}:F>\n🔗 **[Jump to Challenge Message](${newMessage.url})**`,
                components: []
            });

            // When King accepts challenge: Log timestamp for challenger cooldown in the DB
            await this.db.query(`
                        INSERT INTO pvp_king_cooldowns (challenger_id, challenger_name, king_id, king_name, last_challenge)
                        VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
                        ON DUPLICATE KEY UPDATE
                            challenger_name = VALUES(challenger_name),
                            king_id = VALUES(king_id),
                            king_name = VALUES(king_name),
                            last_challenge = UTC_TIMESTAMP()
                        `, [challengerId, challenger.displayName, kingId, currentKing.displayName]);

            // Log to Discord Log Channel
            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    // .setTitle('🏆\u2002PvP King Challenge Accepted!\u2002🏆')
                    .setDescription(
                        `### 🏆\u2002The PvP King accepted a challenge!\u2002🏆\n` +
                        `**Post-Battle Instructions:**\n` +
                        `-# Once the PvP King battle ends, make sure to check the posted screenshot, or ask the PvP King / Challenger to post a screenshot in <#${this.pvpKingChannelID}>\n` +
                        `### ⚠️\u2002There can be 2 scenarios:\n` +
                        `- **👑\u2002If the challenger wins:**\n   - Use \`/pvp_crown\` targeting <@${challengerId}>\n` +
                        `- **🛡️\u2002If the King defends:**\n   - Use \`/pvp_crown\` targeting <@${kingId}> to log the winning streak 🔥\n` +
                        `### 🔗\u2002Message Link:\u2002[Jump to Acceptance Message](${newMessage.url})\n`
                    )
                    .setColor(0x02f3d7)
                    .addFields(
                        { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                        { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                        // { name: '📅 Time of Acceptance', value: `<t:${unixNow}:F>`, inline: true },
                    )
                    .setThumbnail(pvpThumnbnail)
                    .setFooter(createPvpFooter())
                    .setTimestamp();

                await logChannel.send({
                    embeds: [logEmbed],
                    files: [getServerLogo()]
                });
            }
        } else if (actionType === 'pvp_decline') {
            //activeChallenge = null;
            const declineEmbed = new EmbedBuilder()
                .setTitle('❌\u2002PvP King Challenge Declined!')
                .setDescription(`### <@${kingId}>, please state your reason for declining`)
                .setColor(0xE74C3C)
                .addFields(
                    { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                    { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                )
                .setThumbnail(currentKing.displayAvatarURL())
                .setFooter(createPvpFooter())
                .setTimestamp();

            const newMessage = await interaction.channel.send({
                content: `### The PvP King declined the challenge from <@${challengerId}>`,
                embeds: [declineEmbed],
                files: [getServerLogo()]
            });

            await interaction.editReply({
                content: `~~${interaction.message.content}~~\n### ❌ Challenge Declined: <t:${unixNow}:F>\n**🔗 [Jump to Decline Message](${newMessage.url})**`,
                components: []
            });

            if (logChannel) {
                const declineLogEmbed = new EmbedBuilder()
                    .setTitle('❌\u2002PvP King Challenge Declined!')
                    .setDescription(`### The PvP King declined a challenge!\n**🔗 [Jump to Decline Message](${newMessage.url})**`)
                    .setColor(0xE74C3C)
                    .addFields(
                        { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                        { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                    )
                    .setThumbnail(pvpThumnbnail)
                    .setFooter(createPvpLogFooter())
                    .setTimestamp();

                await logChannel.send({
                    embeds: [declineLogEmbed],
                    files: [getServerLogo()]
                });
            }
        }
        return true;
    }
}

module.exports = PvpChallengeKing;
