// ==========================
// Level System - Leaderboard
// ==========================

const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    StringSelectMenuBuilder
} = require('discord.js');
const { formatNumber } = require('../../utils/xpFormatter');
const { resolveXpTrack, fetchXpTrackAutocompleteChoices } = require('../../utils/xpDbHelper');
const path = require('path');

const SORT_OPTIONS = {
    level: {
        label: 'Level',
        description: 'Sort by level and total XP',
        orderBy: 'level DESC, xp_amount DESC',
        select: 'xp_amount, level',
        stat: user => `Lvl **${formatNumber(user.level)}** (${formatNumber(user.xp_amount)} XP)`
    },
    messages: {
        label: 'Messages',
        description: 'Sort by total messages sent',
        orderBy: 'total_messages_sent DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_messages_sent',
        stat: user => `**${formatNumber(user.total_messages_sent)}** messages`
    },
    reactions: {
        label: 'Reactions',
        description: 'Sort by total reactions added',
        orderBy: 'total_reactions_added DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_reactions_added',
        stat: user => `**${formatNumber(user.total_reactions_added)}** reactions`
    },
    voice: {
        label: 'Voice Hours',
        description: 'Sort by total voice hours',
        orderBy: 'total_voice_minutes DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_voice_minutes',
        stat: user => `**${formatVoiceTime(user.total_voice_minutes)}** voice time`
    },
    commands: {
        label: 'Commands',
        description: 'Sort by total commands used',
        orderBy: 'total_commands_used DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_commands_used',
        stat: user => `**${formatNumber(user.total_commands_used)}** commands`
    }
};

function getSortOption(sortKey) {
    return SORT_OPTIONS[sortKey] || SORT_OPTIONS.level;
}

function formatVoiceTime(minutes) {
    const totalMinutes = Math.max(0, Math.floor(Number(minutes || 0)));
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    if (hours > 0 && remainingMinutes > 0) return `${formatNumber(hours)}h ${remainingMinutes}m`;
    if (hours > 0) return `${formatNumber(hours)}h`;
    return `${remainingMinutes}m`;
}

function formatTrackingSince(value) {
    if (!value) return 'XP tracking start date is not recorded yet.';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'XP tracking start date is not recorded yet.';

    const dateParts = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: 'short',
        day: '2-digit'
    }).formatToParts(date);
    const partByType = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
    const monthNumber = String(date.getMonth() + 1).padStart(2, '0');
    const formatted = `${partByType.year}-${monthNumber}-${partByType.day}`;

    return `-# XP data has been tracked since ${formatted}`;
}

function getTrackTargetFields(trackInfo) {
    const roleList = trackInfo.roleIds.length > 0
        ? trackInfo.roleIds.map(id => `<@&${id}>`).join('\n')
        : 'None';
    const channelList = trackInfo.channelIds.length > 0
        ? trackInfo.channelIds.map(id => `<#${id}>`).join('\n')
        : 'None';

    return [
        { name: '\u2002', value: `\u2B50\u2002Viewing XP progress for the **${trackInfo.displayName}** XP-Track:`, inline: false },
        { name: trackInfo.channelIds.length === 1 ? 'Channel' : 'Channels', value: channelList, inline: true },
        { name: trackInfo.roleIds.length === 1 ? 'Role' : 'Roles', value: roleList, inline: true },
        { name: '\u2002', value: '\u2002', inline: false }
    ];
}

function buildSortMenu(track, sortKey) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`lb_sort_${track}`)
            .setPlaceholder('Filter leaderboard...')
            .addOptions(Object.entries(SORT_OPTIONS).map(([value, option]) => ({
                label: option.label,
                description: option.description,
                value,
                default: value === sortKey
            })))
    );
}

function buildPageButtons(page, track, sortKey, isLastPage) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`lb_prev_${page}_${sortKey}_${track}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 1),
        new ButtonBuilder()
            .setCustomId(`lb_next_${page}_${sortKey}_${track}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(isLastPage)
    );
}

class Leaderboard {
    constructor(config) {
        this.config = config;
        this.name = 'leaderboard';
        this.data = new SlashCommandBuilder()
            .setName('leaderboard')
            .setDescription('Display the XP Leaderboard of the server')
            .addStringOption(opt => opt
                .setName('track')
                .setDescription('Optional: Select an XP Track (leave empty for Global XP track)')
                .setAutocomplete(true)
            );
    }

    async execute(interaction) {
        const trackInput = interaction.options.getString('track');
        const trackInfo = await resolveXpTrack(this.config.db, trackInput);

        if (!trackInfo) {
            return interaction.reply({
                content: "### Track Not Found\nThis XP track doesn't exist.",
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply();
        return this.renderLeaderboard(interaction, 1, trackInfo.xpType, 'level');
    }

    async renderLeaderboard(interaction, page, trackInput = null, sortKey = 'level') {
        const trackInfo = await resolveXpTrack(this.config.db, trackInput);
        if (!trackInfo) {
            const payload = { content: 'This XP track no longer exists.', components: [] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        }

        const track = trackInfo.xpType;
        const sort = getSortOption(sortKey);
        const activeSortKey = SORT_OPTIONS[sortKey] ? sortKey : 'level';
        const guildId = interaction.guild.id;
        const guildName = interaction.guild.name;
        const limit = 20;
        const offset = (page - 1) * limit;

        try {
            const [settingsRows] = await this.config.db.query(
                'SELECT xp_date_enabled FROM guild_settings WHERE guild_id = ?',
                [guildId]
            );
            const trackingSince = formatTrackingSince(settingsRows[0]?.xp_date_enabled);

            const [users] = await this.config.db.query(
                `SELECT user_id, ${sort.select}
                 FROM user_levels
                 WHERE guild_id = ? AND xp_type = ?
                 ORDER BY ${sort.orderBy}
                 LIMIT ? OFFSET ?`,
                [guildId, track, limit, offset]
            );

            const logoPath = path.join(__dirname, '../../images/ww_logo.png');
            const logoFile = new AttachmentBuilder(logoPath, { name: 'ww_logo.png' });
            const leaderboardTitle = trackInfo.isGlobal
                ? `Leaderboard for ${guildName}`
                : `Leaderboard for ${trackInfo.displayName}`;
            const descriptionLines = [];
            if (trackInfo.isGlobal) {
                descriptionLines.push(trackingSince);
            }
            const descriptionText = descriptionLines.join('\n');

            const lbEmbed = new EmbedBuilder()
                .setTitle(leaderboardTitle)
                .setThumbnail('attachment://ww_logo.png')
                .setColor('#F1C40F')
                .setFooter({ text: `White Walker XP System | Page ${page}`, iconURL: 'attachment://ww_logo.png' })
                .setTimestamp();

            if (descriptionText) {
                lbEmbed.setDescription(descriptionText);
            }

            if (!trackInfo.isGlobal) {
                lbEmbed.addFields(...getTrackTargetFields(trackInfo));
            }

            if (users.length === 0) {
                lbEmbed.setDescription(descriptionText ? `${descriptionText}\n\nNo data found for this track yet.` : 'No data found for this track yet.');
            } else {
                const memberColumn = users.map((user, index) => {
                    const rank = offset + index + 1;
                    return `**#${rank}** <@${user.user_id}>`;
                }).join('\n');
                const statColumn = users.map(user => {
                    return sort.stat(user);
                }).join('\n');
                if (descriptionText) {
                    lbEmbed.setDescription(descriptionText);
                }
                lbEmbed.addFields(
                    { name: `Leaderboard sorted by \`${sort.label}\``, value: '\u2002', inline: false },
                    { name: 'Member', value: memberColumn, inline: true },
                    { name: sort.label, value: statColumn, inline: true }
                );
            }

            const components = [
                buildSortMenu(track, activeSortKey),
                buildPageButtons(page, track, activeSortKey, users.length < limit)
            ];

            const payload = { embeds: [lbEmbed], components, files: [logoFile] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        } catch (err) {
            console.error('[WW LOG] Level Leaderboard Error:', err);
            const payload = { content: 'Error fetching leaderboard data.', components: [] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('lb_')) return false;

        const parts = interaction.customId.split('_');
        const action = parts[1];
        const currentPage = parseInt(parts[2], 10);
        const sortKey = parts[3] || 'level';
        const track = parts.slice(4).join('_');
        let newPage = currentPage;

        if (action === 'next') newPage++;
        if (action === 'prev') newPage--;

        await this.renderLeaderboard(interaction, newPage, track, sortKey);
        return true;
    }

    async handleSelect(interaction) {
        if (!interaction.customId.startsWith('lb_sort_')) return false;

        const track = interaction.customId.replace('lb_sort_', '');
        const sortKey = interaction.values[0] || 'level';
        await this.renderLeaderboard(interaction, 1, track, sortKey);
        return true;
    }

    async handleAutocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const choices = await fetchXpTrackAutocompleteChoices(this.config.db, focusedValue);
        await interaction.respond(choices).catch(() => { });
    }
}

module.exports = Leaderboard;
