// ==================================================================
// Edit Bot Messages (Slash Commands & Context Menu Commands + Modal
// ==================================================================

// - TO-DO: Show ALSO CONTENT of Embeds when Created/Updated, and when Deleted
// - BUG: When an Embed is removed manually from a message, bot won't add another one!

const {
    SlashCommandBuilder,
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder,
    MessageFlags
} = require('discord.js');
const path = require('path');

class EditBotMsg {
    constructor(config) {
        this.name = "edit_bot_msg";
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.logChannelID = config.logChannelID;
        this.historyThreadID = config.historyThreadID;
        this.ignoredLogChannels = config.ignoredLogChannels;
        this.blockedEditBotMsgChannels = config.blockedEditBotMsgChannels;
        this.onCooldown = config.onCooldown;
        this.data = [
            // Slash Commands
            new SlashCommandBuilder()
                .setName('edit_bot_msg')
                .setDescription('Edit messages sent by White Walker Bot (Admin only)')
                .addStringOption(o =>
                    o.setName('channel_id')
                        .setDescription('Channel ID where the message is located')
                        .setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('message_id')
                        .setDescription('Message ID you want to edit')
                        .setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('content')
                        .setDescription('New message content (use \\n for new line)')
                        .setRequired(true)
                ),

            // Context Menu Commands
            new ContextMenuCommandBuilder()
                .setName('Edit Bot Message (Admin)')
                .setType(ApplicationCommandType.Message)
        ];
    }

    // Main Execution Router
    async execute(interaction) {
        if (interaction.isChatInputCommand()) {
            return this.handleSlash(interaction);
        }

        if (interaction.isMessageContextMenuCommand()) {
            return this.handleContext(interaction);
        }
    }

    // ---------------------------
    // SLASH COMMAND (manual edit)
    // ---------------------------
    async handleSlash(interaction) {
        if (this.onCooldown(interaction.user.id, 'edit_msg', 2)) {
            return interaction.reply('⏳ Slow down!');
        }

        // Check for role permissions
        const allowedRoles = [this.adminRoleID];
        if (!interaction.member.roles.cache.some(r => allowedRoles.includes(r.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        const channelId = interaction.options.getString('channel_id');
        const messageId = interaction.options.getString('message_id');
        const newContent = interaction.options.getString('content').replace(/\\n/g, '\n');

        // Check for blocked channels for editing Bot Messages
        if (this.blockedEditBotMsgChannels && this.blockedEditBotMsgChannels.includes(channelId)) {
            return interaction.reply({ content: '### ❌  Editing bot messages is not allowed in this channel!', flags: MessageFlags.Ephemeral });
        }

        try {
            const channel = await interaction.client.channels.fetch(channelId);
            const message = await channel.messages.fetch(messageId);

            // Check if message is a bot message
            if (message.author.id !== interaction.client.user.id) {
                return interaction.reply({ content: '### ❌  Only bot messages can be edited!', flags: MessageFlags.Ephemeral });
            }

            await message.edit(newContent);

            return interaction.reply({ content: '### ✅  Message edited!', flags: MessageFlags.Ephemeral });

        } catch (err) {
            console.error(err);
            return interaction.reply({ content: '### ❌  Failed to edit message.', flags: MessageFlags.Ephemeral });
        }
    }

    // ------------ Context Menu Commands ---------------
    // Right Click Bot message → Apps → New Modal Window
    // --------------------------------------------------
    async handleContext(interaction) {
        // Check for role permissions
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!interaction.member.roles.cache.some(r => allowedRoles.includes(r.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        // Check if message is a bot message
        const message = interaction.targetMessage;
        if (message.author.id !== interaction.client.user.id) {
            return interaction.reply({ content: '### ❌  Only bot messages can be edited!', flags: MessageFlags.Ephemeral });
        }

        // Check for blocked channels for editing Bot Messages
        if (this.blockedEditBotMsgChannels && this.blockedEditBotMsgChannels.includes(message.channelId)) {
            return interaction.reply({ content: '### ❌  Editing bot messages is not allowed in this channel!', flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder()
            .setCustomId(`editMsg_${message.id}_${message.channelId}`)
            .setTitle('Edit Bot Message (Admin)');

        // Content field
        const contentInput = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('Message content')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(message.content || '\u200B') // zero-width space for empty content
            .setRequired(false);

        // Append toggle
        const appendInput = new TextInputBuilder()
            .setCustomId('append')
            .setLabel('Append instead of replace? (Y/N) - (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('N')
            .setRequired(false);

        // Embed JSON
        const embedInput = new TextInputBuilder()
            .setCustomId('embed')
            .setLabel('Embed JSON (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('{"title":"Example","description":"Hello"}')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(contentInput),
            new ActionRowBuilder().addComponents(appendInput),
            new ActionRowBuilder().addComponents(embedInput)
        );

        await interaction.showModal(modal);
    }

    // ----------------------------
    // MODAL SUBMIT → CONFIRM STEP
    // ----------------------------
    async handleModal(interaction) {
        if (!interaction.customId.startsWith('editMsg_')) return false;

        const [, messageId, channelId] = interaction.customId.split('_');

        // --- VALIDATION for Append  ---
        let appendRaw = interaction.fields.getTextInputValue('append')?.toLowerCase().trim();
        if (!appendRaw) appendRaw = 'n'; // Default to 'n' if empty

        if (appendRaw !== 'y' && appendRaw !== 'n') {
            return interaction.reply({
                content: '### ❌  Invalid Append Input!\n- Please enter **Y** for Yes or **N** for No.',
                flags: MessageFlags.Ephemeral
            });
        }

        const isAppend = appendRaw === 'y';
        const content = interaction.fields.getTextInputValue('content') || '\u200B';
        const embedRaw = interaction.fields.getTextInputValue('embed');
        const confirmId = `confirmEdit_${messageId}_${channelId}_${isAppend}`;

        // Save edit temporarily
        interaction.client.editCache ??= new Map();
        interaction.client.editCache.set(confirmId, {
            content,
            embedRaw
        });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(confirmId)
                .setLabel('✅ Confirm Edit')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('cancelEdit')
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Danger)
        );

        let previewLabel = isAppend ? 'APPEND to existing message:' : 'your edit below!\n## 👁️‍🗨️ New Message:\n';

        await interaction.reply({
            content: `### ⚠️  <@${interaction.user.id}>, please confirm ${previewLabel}\n\n${content}\n\n${embedRaw ? '- 📦 *Contains Embed JSON*' : ''}`,
            components: [buttons],
            flags: MessageFlags.Ephemeral
        });

        return true;
    }

    // =====================================================
    // BUTTON HANDLER (CONFIRM / CANCEL)
    // =====================================================
    async handleButton(interaction) {
        if (interaction.customId === 'cancelEdit') {
            await interaction.update({ content: '### ❌  Edit cancelled.', components: [] });
            return true;
        }

        if (!interaction.customId.startsWith('confirmEdit_')) return false;

        const cache = interaction.client.editCache.get(interaction.customId);
        if (!cache) return true;
        interaction.client.editCache.delete(interaction.customId); // Delete the cache immediately so rapid consecutive clicks are ignored

        await interaction.deferUpdate();

        const [, messageId, channelId, isAppendStr] = interaction.customId.split('_');
        const isAppend = isAppendStr === 'true';

        try {
            const channel = await interaction.client.channels.fetch(channelId);
            const message = await channel.messages.fetch(messageId);
            const oldContent = message.content || '';
            const oldEmbedsCount = message.embeds.length;
            let finalContent = cache.content;

            if (isAppend) {
                // If appending, combine them. If content is just the default placeholder, append nothing.
                const addition = (finalContent === '\u200B') ? '' : finalContent;
                finalContent = oldContent.trimEnd() + '\n' + addition;
            } else {
                // Safety: If overwriting with an empty/default field, keep the old content
                if (!finalContent || finalContent === '\u200B') finalContent = oldContent;
            }

            // Prepare embeds
            let finalEmbeds = message.embeds;
            let embedStatus = 'no changes';
            const trimmedEmbed = cache.embedRaw ? cache.embedRaw.trim() : '';
            if (trimmedEmbed.length > 0) {
                try {
                    const parsed = JSON.parse(trimmedEmbed);
                    finalEmbeds = [parsed];
                    if (oldEmbedsCount === 0) embedStatus = '✅ **Added**';
                    else embedStatus = '✏️ **Modified**';
                } catch {
                    return interaction.editReply({ content: '❌ Invalid embed JSON.', components: [] });
                }
            }

            await message.edit({
                content: finalContent || message.content,
                embeds: finalEmbeds
            });

            // Ignore log events for specified channels (this.ignoredLogChannels)
            if (this.logChannelID && !this.ignoredLogChannels.includes(channel.id)) {
                const logChannel = await interaction.client.channels.fetch(this.logChannelID);
                const Diff = require('diff');

                // --- NORMALIZATION ---
                const cleanOld = oldContent.split('\n').map(l => l.trimEnd()).join('\n').trimEnd() + '\n';
                const cleanNew = finalContent.split('\n').map(l => l.trimEnd()).join('\n').trimEnd() + '\n';
                const diffParts = Diff.diffLines(cleanOld, cleanNew);
                let diffLinesArray = [];

                // Helper to format lines based on whether they changed
                const formatLine = (line, part) => {
                    if (line !== '') return `${part.added ? '+ ' : part.removed ? '- ' : '  '}${line}`;
                    if (part.added) return `+ *[ADDED EMPTY LINE]*`;
                    if (part.removed) return `- *[REMOVED EMPTY LINE]*`;
                    return `  `; // Unchanged empty line
                };

                // First pass: Try to show everything
                diffParts.forEach((part, i) => {
                    const lines = part.value.split('\n');
                    if (lines[lines.length - 1] === '') lines.pop();

                    // If this is a removed empty line AND the next part is an addition, skip the removed label
                    const isRemovedEmpty = part.removed && lines.length === 1 && lines[0] === '';
                    const nextIsAddition = diffParts[i + 1] && diffParts[i + 1].added;

                    if (isRemovedEmpty && nextIsAddition) return;

                    lines.forEach(line => {
                        diffLinesArray.push(formatLine(line, part));
                    });
                });

                let diffResult = diffLinesArray.join('\n');

                // Second pass: Truncate only if it exceeds Discord's limits (1024)
                if (diffResult.length > 1000) {
                    let tempArray = [];
                    diffParts.forEach((part, i) => {
                        const lines = part.value.split('\n');
                        if (lines[lines.length - 1] === '') lines.pop();

                        const isRemovedEmpty = part.removed && lines.length === 1 && lines[0] === '';
                        const nextIsAddition = diffParts[i + 1] && diffParts[i + 1].added;
                        if (isRemovedEmpty && nextIsAddition) return;

                        if (part.added || part.removed) {
                            lines.forEach(line => tempArray.push(formatLine(line, part)));
                        } else {
                            if (lines.length > 2) {
                                tempArray.push(`  ... (${lines.length} unchanged lines) ...`);
                            } else {
                                lines.forEach(line => tempArray.push(formatLine(line, part)));
                            }
                        }
                    });
                    diffResult = tempArray.join('\n').slice(0, 980) + '\n... [Truncated due to length]';
                }

                let diffStr = `\`\`\`diff\n${diffResult || '  No text changes'}\n\`\`\``;

                const logFields = [
                    { name: 'Channel:', value: `<#${channelId}>`, inline: true },
                    { name: 'Message ID:', value: `\`${messageId}\``, inline: true }
                ];

                if (embedStatus !== 'no changes') {
                    logFields.push({ name: 'Embed Status:', value: embedStatus, inline: true });
                }

                logFields.push(
                    { name: 'Message Link:', value: `[Jump to Message](${message.url})`, inline: false },
                    { name: 'Difference:', value: diffStr }
                );

                const imagePath = path.join(__dirname, '../images/ww.png');
                const footerLogo = new AttachmentBuilder(imagePath, { name: 'footer_logo.png' });

                const embed = new EmbedBuilder()
                    .setColor(0x00FFFF)
                    .setTitle('🤖  Bot Message Edited  ✏️')
                    .setDescription(`Edited by <@${interaction.user.id}> (${interaction.user.username})`)
                    .addFields(logFields)
                    .setFooter({ text: 'White Walker Logs', iconURL: 'attachment://footer_logo.png' })
                    .setTimestamp();

                await logChannel.send({ embeds: [embed], files: [footerLogo] });
            }

            await interaction.editReply({
                content: '### ✅  Bot message successfully updated!',
                components: []
            });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: '### ❌  Failed to edit bot message!', components: [] });
        }

        return true;
    }
}

module.exports = EditBotMsg;
