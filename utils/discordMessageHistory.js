'use strict';

function messageSearchText(message) {
    const embeds = (message?.embeds || []).map(embed => {
        if (typeof embed?.toJSON === 'function') return embed.toJSON();
        return embed?.data || embed || {};
    });
    const poll = message?.poll?.question?.text || message?.poll?.question || '';
    return `${message?.content || ''}\n${JSON.stringify(embeds)}\n${poll}`;
}

async function findRecentBotMessage(channel, options = {}) {
    if (!channel?.messages?.fetch) return null;
    const needles = (options.needles || []).map(value => String(value || '').trim()).filter(Boolean);
    if (!needles.length) return null;

    const messages = await channel.messages.fetch({ limit: options.limit || 100 });
    if (!messages || typeof messages.values !== 'function') return null;

    const botUserId = String(options.botUserId || '');
    for (const message of messages.values()) {
        if (botUserId && String(message.author?.id || '') !== botUserId) continue;
        const searchable = messageSearchText(message);
        if (needles.every(needle => searchable.includes(needle))) return message;
    }
    return null;
}

module.exports = {
    findRecentBotMessage,
    messageSearchText
};
