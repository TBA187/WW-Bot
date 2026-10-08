/**
 * @fileoverview Expose /send_message and Edit Bot Embed (Officer) for Leaders, Admins and Officers.
 * Open private message previews for composing, importing and editing posts before publication.
 */
'use strict';
const { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, MessageFlags } = require('discord.js');
const { EmbedDraft, draftFromMessage, expandLiteralLineBreaks, applyWhiteWalkerBrandingDefaults } = require('../features/message-builder/draft.js');
const { BuilderController } = require('../features/message-builder/editor.js');
class SendMessage {
    constructor(config = {}) {
        this.name = 'send_message';
        this.config = config;
        this.allowedRoles = new Set([config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean));
        this.controller = new BuilderController(config);
        this.sessions = this.controller.sessions;
        this.data = [
            new SlashCommandBuilder()
                .setName('send_message')
                .setDescription('Send a custom bot message or embed. Command opens a builder to customize the message before sending.')
                .setDMPermission(false)
                .addChannelOption(option => option.setName('channel')
                .setDescription('Select a channel to send the message to, or leave empty to use the current channel.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addStringOption(option => option.setName('message_content')
                .setDescription('Message content. Supports markdown, emojis, mentions and \\n for new lines. Add files in the builder.'))
                .addStringOption(option => option.setName('white_walker_branding')
                .setDescription('Adds White Walker footer, thumbnail, blue color, and current timestamp. Leave empty for No.')
                .addChoices({ name: 'Yes', value: 'yes' }, { name: 'No', value: 'no' })),
            new ContextMenuCommandBuilder()
                .setName('Edit Bot Embed (Officer)')
                .setType(ApplicationCommandType.Message)
                .setDMPermission(false)
        ];
    }
    canBuild(member) {
        if (!member)
            return false;
        if (member.roles?.cache?.some)
            return member.roles.cache.some(role => this.allowedRoles.has(role.id));
        return Array.isArray(member.roles) && member.roles.some(id => this.allowedRoles.has(id));
    }
    async execute(interaction) {
        if (interaction.isMessageContextMenuCommand())
            return this.handleContext(interaction);
        return this.handleSlash(interaction);
    }
    async handleSlash(interaction) {
        if (!this.canBuild(interaction.member))
            return interaction.reply({ content: '### No permission!', flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || typeof channel.send !== 'function')
            return interaction.reply({ content: 'The selected channel cannot receive messages.', flags: MessageFlags.Ephemeral });
        const draft = new EmbedDraft({ messageContent: expandLiteralLineBreaks(interaction.options.getString('message_content')) });
        if (interaction.options.getString('white_walker_branding') === 'yes')
            applyWhiteWalkerBrandingDefaults(draft);
        const session = this.controller.createSession({ ownerId: interaction.user.id, target: {
                channel, invocationChannelId: interaction.channel?.id || null, invocationChannel: interaction.channel
            }, draft });
        await session.open(interaction);
    }
    async handleContext(interaction) {
        if (!this.canBuild(interaction.member))
            return interaction.reply({ content: '### No permission!', flags: MessageFlags.Ephemeral });
        const message = interaction.targetMessage;
        if (!interaction.client.user || message.author.id !== interaction.client.user.id)
            return interaction.reply({ content: 'Only White Walker bot messages can be edited.', flags: MessageFlags.Ephemeral });
        if ((this.config.blockedEditBotMsgChannels || []).includes(message.channelId || message.channel?.id))
            return interaction.reply({ content: 'Editing bot messages is not allowed in this channel.', flags: MessageFlags.Ephemeral });
        const session = this.controller.createSession({ ownerId: interaction.user.id, target: {
                channel: message.channel, invocationChannelId: interaction.channel?.id || null,
                invocationChannel: interaction.channel, message
            }, draft: draftFromMessage(message) });
        await session.open(interaction);
    }
    handleButton(interaction) { return this.controller.handleButton(interaction); }
    handleSelect(interaction) { return this.controller.handleSelect(interaction); }
    handleSelectMenu(interaction) { return this.handleSelect(interaction); }
    handleModal(interaction) { return this.controller.handleModal(interaction); }
}
module.exports = SendMessage;
