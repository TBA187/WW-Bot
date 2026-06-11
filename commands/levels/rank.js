// ============================
// Level System - Rank Command
// ============================

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { formatNumber } = require('../../utils/xpFormatter');
const xpMath = require('../../utils/xpMath');
const xpSettings = require('../../config/xpConfig');
const { resolveXpTrack, fetchXpTrackAutocompleteChoices } = require('../../utils/xpDbHelper');
const path = require('path');

function formatTrackingSince(value) {
    if (!value) return '-# XP data does not have a recorded start date yet.';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-# XP data does not have a recorded start date yet.';

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

function formatVoiceTime(minutes) {
    const totalMinutes = Math.max(0, Math.floor(Number(minutes || 0)));
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    if (hours > 0 && remainingMinutes > 0) return `${formatNumber(hours)}h ${remainingMinutes}m`;
    if (hours > 0) return `${formatNumber(hours)}h`;
    return `${remainingMinutes} min`;
}

function getDisplayName(member, user) {
    return member?.displayName || user.globalName || user.username;
}

function capitalizeDisplayName(name) {
    if (!name) return name;
    return name.charAt(0).toUpperCase() + name.slice(1);
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

class Rank {
    constructor(config) {
        this.config = config;
        this.name = 'rank';
        this.data = new SlashCommandBuilder()
            .setName('rank')
            .setDescription('Check level and detailed XP stats for a user')
            .addUserOption(opt => opt.setName('user').setDescription('User to check (leave empty for yourself)'))
            .addStringOption(opt => opt
                .setName('track')
                .setDescription('Optional: Select an XP Track (leave empty for Global XP track)')
                .setAutocomplete(true)
            );
    }

    async execute(interaction) {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetMember = interaction.options.getMember('user') || interaction.member;
        const trackInput = interaction.options.getString('track');
        const guildId = interaction.guild.id;

        const trackInfo = await resolveXpTrack(this.config.db, trackInput);
        if (!trackInfo) {
            return interaction.reply({
                content: "### Track Not Found\nThis XP track doesn't exist.",
                flags: MessageFlags.Ephemeral
            });
        }

        const track = trackInfo.xpType;

        await interaction.deferReply();

        try {
            const [rows] = await this.config.db.query(`
                SELECT
                    xp_date, xp_amount, level,
                    message_xp, reaction_xp, command_xp, voice_xp,
                    messages_sent, reactions_added, commands_used, voice_minutes,
                    total_messages_sent, total_reactions_added, total_commands_used, total_voice_minutes
                FROM user_levels
                WHERE user_id = ? AND guild_id = ? AND xp_type = ?
            `, [target.id, guildId, track]);

            if (!rows[0] && !trackInfo.isGlobal) {
                const roleList = trackInfo.roleIds.length > 0
                    ? trackInfo.roleIds.map(id => `<@&${id}>`).join('\n')
                    : 'None';
                const channelList = trackInfo.channelIds.length > 0
                    ? trackInfo.channelIds.map(id => `<#${id}>`).join('\n')
                    : 'None';

                return interaction.editReply({
                    content: `### No Data Found\n${target} has no data for the **${trackInfo.displayName}** XP track.\n**XP-Track Roles:** ${roleList}\n**XP-Track Channels:** ${channelList}`
                });
            }

            const data = rows[0] || {
                xp_date: null,
                xp_amount: 0,
                level: 0,
                message_xp: 0,
                reaction_xp: 0,
                command_xp: 0,
                voice_xp: 0,
                messages_sent: 0,
                reactions_added: 0,
                commands_used: 0,
                voice_minutes: 0,
                total_messages_sent: 0,
                total_reactions_added: 0,
                total_commands_used: 0,
                total_voice_minutes: 0
            };

            const isMaxLevel = xpSettings.levelFormula.maxLevel && data.level >= xpSettings.levelFormula.maxLevel;
            let xpProgress = '';
            let xpForNextLevel = '';

            if (isMaxLevel) {
                xpProgress = `**${formatNumber(data.xp_amount)}**`;
                xpForNextLevel = '**MAX Level Reached!**';
            } else {
                const totalXpRequiredForNext = xpMath.getTotalXpForLevel(data.level + 1);
                const xpRemainder = totalXpRequiredForNext - data.xp_amount;
                xpProgress = `**${formatNumber(data.xp_amount)} / ${formatNumber(totalXpRequiredForNext)} XP**`;
                xpForNextLevel = `**${formatNumber(xpRemainder)} XP**`;
            }

            const logoPath = path.join(__dirname, '../../images/ww_logo.png');
            const logoFile = new AttachmentBuilder(logoPath, { name: 'ww_logo.png' });
            const displayName = capitalizeDisplayName(getDisplayName(targetMember, target));
            const trackingSince = formatTrackingSince(data.xp_date);
            const rankTitle = trackInfo.isGlobal
                ? `${displayName}'s Rank Overview`
                : `${displayName}'s Rank Overview for ${trackInfo.displayName}`;

            const rankEmbed = new EmbedBuilder()
                .setTitle(rankTitle)
                .setDescription(trackingSince)
                .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                .setColor(trackInfo.color || '#3f4bff')
                .addFields(
                    ...(!trackInfo.isGlobal ? getTrackTargetFields(trackInfo) : []),
                    { name: 'Level', value: `**${formatNumber(data.level)}**`, inline: true },
                    { name: 'XP Progress', value: xpProgress, inline: true },
                    { name: 'XP for next Level', value: xpForNextLevel, inline: true },
                    { name: '\u200b', value: '**📊\u2002Detailed Stat Breakdown**', inline: false },
                    { name: '💬\u2002Messages sent       \u200b', value: `- Total: **${formatNumber(data.total_messages_sent)}**\n- XP: **${formatNumber(data.message_xp)}**`, inline: true },
                    { name: '🔥\u2002Reactions added', value: `- Total: **${formatNumber(data.total_reactions_added)}**\n- XP: **${formatNumber(data.reaction_xp)}**`, inline: true },
                    { name: '\u2002', value: '\u2002', inline: false },
                    { name: '🎙️\u2002Voice Chat Hours       \u200b', value: `- Total: **${formatVoiceTime(data.total_voice_minutes)}**\n- XP: **${formatNumber(data.voice_xp)}**`, inline: true },
                    { name: '⌨️\u2002Commands used', value: `- Total: **${formatNumber(data.total_commands_used)}**\n- XP: **${formatNumber(data.command_xp)}**`, inline: true }
                )
                .setFooter({ text: 'White Walker Level System', iconURL: 'attachment://ww_logo.png' })
                .setTimestamp();

            return interaction.editReply({ embeds: [rankEmbed], files: [logoFile] });
        } catch (err) {
            console.error('[WW LOG] Rank Command Error:', err);
            return interaction.editReply({ content: 'Error fetching rank data.' });
        }
    }

    async handleAutocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const choices = await fetchXpTrackAutocompleteChoices(this.config.db, focusedValue);
        await interaction.respond(choices).catch(() => { });
    }
}

module.exports = Rank;
