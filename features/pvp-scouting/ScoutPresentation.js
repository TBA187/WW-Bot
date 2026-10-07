// Shares modal inputs, branded embeds, and loading feedback across scout commands.
'use strict';

const path = require('node:path');
const { AttachmentBuilder, EmbedBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { withButtonLoading } = require('../../utils/interactionLoading.js');

const LOGO_NAME = 'ww_logo.png';
const LOGO_PATH = path.join(__dirname, '../../images', LOGO_NAME);

function scoutTextInput(id, label, value = '', paragraph = false, required = false, maxLength = 4000, placeholder = '') {
    const input = new TextInputBuilder().setCustomId(id).setRequired(required).setMaxLength(maxLength)
        .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short);
    if (value != null && String(value)) input.setValue(String(value).slice(0, maxLength));
    if (placeholder) input.setPlaceholder(placeholder);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

function scoutPayload(payload, message = null) {
    // Screenshot messages remain plain text with up to ten image attachments.
    if (!payload?.embeds?.length) return payload;
    const existing = message?.attachments?.find?.(attachment => attachment.name === LOGO_NAME);
    const iconURL = existing?.url || `attachment://${LOGO_NAME}`;
    const embeds = payload.embeds.map((value, index) => {
        const json = value.toJSON?.() || value;
        // Team pages put their footer below the last description. Leave earlier
        // embeds footerless so the logo and page count appear only once.
        if (!json.footer && index < payload.embeds.length - 1) return new EmbedBuilder(json);
        return new EmbedBuilder(json).setFooter({ text: json.footer?.text || 'White Walkers', iconURL });
    });
    const result = { ...payload, embeds };
    if (existing) {
        const files = payload.files?.filter(file => file.name !== LOGO_NAME);
        if (files?.length) result.files = files;
        else delete result.files;
    } else if (!(payload.files || []).some(file => file.name === LOGO_NAME)) {
        result.files = [...(payload.files || []), new AttachmentBuilder(LOGO_PATH, { name: LOGO_NAME })];
    }
    return result;
}

function withScoutLoading(interaction, work, options = {}) {
    return withButtonLoading(interaction, async () => scoutPayload(await work(),
        options.newMessage ? null : interaction.message), options);
}

module.exports = { scoutPayload, scoutTextInput, withScoutLoading };
