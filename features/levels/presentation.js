// Shared track labels and tracking dates for the rank and leaderboard views.

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

    return `XP tracked since ${formatted}`;
}

function getTrackRequirementDisplay(trackInfo) {
    const roleLabel = trackInfo.roleIds.length === 1 ? 'XP-Role' : 'XP-Roles';
    const channelLabel = trackInfo.channelIds.length === 1 ? 'XP-Channel' : 'XP-Channels';
    const commaRoles = trackInfo.roleIds.map(id => `<@&${id}>`).join(', ');
    const commaChannels = trackInfo.channelIds.map(id => `<#${id}>`).join(', ');
    const hasRoles = trackInfo.roleIds.length > 0;
    const hasChannels = trackInfo.channelIds.length > 0;

    if (hasRoles && hasChannels) {
        return {
            description: '',
            fields: [
                { name: roleLabel, value: trackInfo.roleIds.map(id => `-# <@&${id}>`).join('\n'), inline: true },
                { name: channelLabel, value: trackInfo.channelIds.map(id => `-# <#${id}>`).join('\n'), inline: true },
                { name: '\u2002', value: '\u2002', inline: false }
            ]
        };
    }

    if (hasRoles) {
        return {
            description: `**${roleLabel}:** ${commaRoles}`,
            fields: []
        };
    }

    if (hasChannels) {
        return {
            description: `**${channelLabel}:** ${commaChannels}`,
            fields: []
        };
    }

    return { description: '', fields: [] };
}

module.exports = { formatTrackingSince, getTrackRequirementDisplay };
