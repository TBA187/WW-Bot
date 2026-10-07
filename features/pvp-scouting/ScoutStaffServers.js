// Keep scout menus bound to the archive they opened, even when preferences change.
'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { SERVERS } = require('./ScoutServerSettings.js');

function interactionServer(interaction, fallback = 'gold') {
    const value = String(interaction.customId || '').split(':').at(-1);
    return value === 'silver' || value === 'gold' || value === 'cross' ? value : fallback;
}

async function staffServer(config, interaction, { cachedOnly = false } = {}) {
    const explicit = interaction.options?.getString?.('server');
    if (explicit === 'gold' || explicit === 'silver') return explicit;
    const settings = config.scoutServerSettings || config.guildMemberStore || config.scoutRosterStore;
    const guildId = interaction.guildId || interaction.guild?.id;
    const cachedGetter = settings?.getCachedServer || settings?.getCachedSelectedServer;
    const cached = cachedGetter?.call(settings, guildId, interaction.user.id);
    if (cached !== undefined) return cached === 'silver' ? 'silver' : 'gold';
    if (cachedOnly && cachedGetter) {
        // A cold preference lookup must not consume Discord's autocomplete deadline.
        void Promise.resolve(settings.hydratePreferences?.(guildId)
            || settings.hydrateSelectedServers?.(guildId)
            || settings.getSelectedServer?.(guildId, interaction.user.id)).catch(() => {});
        return null;
    }
    const selected = await settings?.getSelectedServer?.(guildId, interaction.user.id);
    return selected === 'silver' ? 'silver' : 'gold';
}

function bindServer(payload, server) {
    if (!server) return payload;
    for (const row of payload.components || []) {
        for (const component of row.components || row.data?.components || []) {
            const data = component.data || component;
            if (data.custom_id && /^(?:pvp-scout:|pvp-scout-review|scout-settings:reports-|scout-sources:)/u.test(data.custom_id)
                && !/:(?:gold|silver|cross)$/u.test(data.custom_id)) {
                data.custom_id += `:${server}`;
            }
        }
    }
    return payload;
}

function serverButtons(prefix, owner, selected, token = '', includeCross = false) {
    return new ActionRowBuilder().addComponents(...(includeCross ? ['gold', 'silver', 'cross'] : ['gold', 'silver']).map(server => new ButtonBuilder()
        .setCustomId(`${prefix}${owner}:${token ? `${token}:` : ''}${server}`)
        .setLabel(SERVERS[server].label)
        .setEmoji(SERVERS[server].emoji)
        .setStyle(server === selected ? ButtonStyle.Primary : ButtonStyle.Secondary)));
}

module.exports = { interactionServer, staffServer, bindServer, serverButtons };
