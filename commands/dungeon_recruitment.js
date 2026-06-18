// ------------------------------------------
// Dungeon recruitment commands:
// /forlorn | /victini | /meloetta | /hoopa
// -------------------------------------------
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags
} = require('discord.js');
const path = require('path');

const MAX_TIMEOUT_MS = 2147483647;

const DUNGEONS = {
    forlorn: {
        name: 'Forlorn',
        titleEmoji: '🏰',
        color: 0x1A43BF,
        roles: [
            { key: 'room1', label: 'Room 1', emoji: '🔥' },
            { key: 'room2', label: 'Room 2', emoji: '💧' },
            { key: 'room3', label: 'Room 3', emoji: '🌿' },
            { key: 'room4', label: 'Room 4', emoji: '🧚' },
            { key: 'mid', label: 'Mid (Rotom)', emoji: '⚡' }
        ]
    },
    victini: {
        name: 'Victini',
        titleEmoji: '<:victini:1514805175519412254>',
        color: 0xF59E0B,
        roles: [
            { key: 'player1', label: 'Player 1', emoji: '🥇' },
            { key: 'player2', label: 'Player 2', emoji: '🥈' },
            { key: 'player3', label: 'Player 3', emoji: '🥉' },
            { key: 'player4', label: 'Player 4', emoji: '🏅' },
            { key: 'player5', label: 'Player 5', emoji: '🏆' }
        ]
    },
    meloetta: {
        name: 'Meloetta',
        titleEmoji: '<:meloetta:1514805507372748830>',
        color: 0xEC4899,
        roles: [
            { key: 'ice', label: 'Ice Room', emoji: '❄️' },
            { key: 'sleep', label: 'Sleep Room', emoji: '😴' },
            { key: 'fire', label: 'Fire Room', emoji: '🔥' },
            { key: 'poison', label: 'Poison Room', emoji: '☠️' },
            { key: 'trees', label: 'Trees (Water Room)', emoji: '🌊' }
        ]
    },
    hoopa: {
        name: 'Hoopa',
        titleEmoji: '<a:hoopa:1474190060671995924>',
        color: 0x8B5CF6,
        roles: [
            { key: 'player1', label: 'Player 1', emoji: '🌀' },
            { key: 'player2', label: 'Player 2', emoji: '🔮' },
            { key: 'player3', label: 'Player 3', emoji: '✨' },
            { key: 'player4', label: 'Player 4', emoji: '🗝️' },
            { key: 'player5', label: 'Player 5', emoji: '💫' }
        ]
    }
};

function getUnix(date) {
    return Math.floor(date.getTime() / 1000);
}

function formatDiscordTime(date) {
    const unix = getUnix(date);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatDungeonTime(date, isClosed) {
    const formattedTime = formatDiscordTime(date);
    return isClosed ? `~~${formattedTime}~~` : formattedTime;
}

function createFooterLogoAttachment() {
    return new AttachmentBuilder(path.join(__dirname, '../images/ww_logo.png'), { name: 'ww_logo.png' });
}

function parseRelativeTime(input, nowMs) {
    const multipliers = {
        s: 1000,
        sec: 1000,
        secs: 1000,
        second: 1000,
        seconds: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        mins: 60 * 1000,
        minute: 60 * 1000,
        minutes: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        hrs: 60 * 60 * 1000,
        hour: 60 * 60 * 1000,
        hours: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000
    };

    const cleaned = input
        .trim()
        .toLowerCase()
        .replace(/^in\s+/, '')
        .replace(/,/g, ' ')
        .replace(/\band\b/g, ' ');

    const partRegex = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
    let totalMs = 0;
    let matched = false;
    let cursor = 0;
    let match;

    while ((match = partRegex.exec(cleaned)) !== null) {
        const betweenParts = cleaned.slice(cursor, match.index).trim();
        if (betweenParts) return null;

        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const multiplier = multipliers[unit];

        if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;

        totalMs += amount * multiplier;
        matched = true;
        cursor = partRegex.lastIndex;
    }

    if (!matched || cleaned.slice(cursor).trim()) return null;

    return new Date(nowMs + totalMs);
}

function parseDungeonTime(input, nowMs = Date.now()) {
    if (!input || !input.trim()) return null;

    const cleaned = input.trim();
    return parseRelativeTime(cleaned, nowMs);
}

class DungeonRecruitment {
    constructor(config) {
        this.name = 'dungeon_recruitment';
        this.client = config.client;
        this.onCooldown = config.onCooldown;
        this.activeRuns = new Map();
        this.dungeonChannelID = config.dungeonChannelID;
        this.dungeonRoleID = config.dungeonRoleID;

        this.data = Object.keys(DUNGEONS).map(commandName => this.buildCommand(commandName));
    }

    buildCommand(commandName) {
        const dungeon = DUNGEONS[commandName];

        return new SlashCommandBuilder()
            .setName(commandName)
            .setDescription(`Create a ${dungeon.name} Dungeon recruitment`)
            .addStringOption(o =>
                o.setName('dungeon_start')
                    .setDescription('Time until the Dungeon starts (e.g. 5 hours or 7 hours 17 mins)')
                    .setRequired(true)
                    .setMaxLength(100)
            )
            .addStringOption(o =>
                o.setName('registration_end')
                    .setDescription('Leave empty to close when 5 members join. Or enter time to close recruiment, e.g. 7 h 30 m')
                    .setRequired(false)
                    .setMaxLength(100)
            )
            .addStringOption(o =>
                o.setName('description')
                    .setDescription('Dungeon description (optional)')
                    .setRequired(false)
                    .setMaxLength(1000)
            )
            .addStringOption(o =>
                o.setName('ping_dungeon_role')
                    .setDescription('Should the @Dungeon role be tagged for this for this dungeon run?')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            )
            .addStringOption(o =>
                o.setName('multiple_assignments')
                    .setDescription('Leave empty if: one player can only select one Dungeon role. "Yes" allows multiple role assignments.')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Yes', value: 'yes' }
                    )
            );
    }

    createRunId() {
        let runId;
        do {
            runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        } while (this.activeRuns.has(runId));

        return runId;
    }

    async execute(interaction) {
        const dungeon = DUNGEONS[interaction.commandName];
        if (!dungeon) return;

        if (this.onCooldown?.(interaction.user.id, `dungeon_${interaction.commandName}`, 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (!this.dungeonChannelID) {
            return interaction.reply({
                content: '### ❌ Dungeon channel is not configured.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.channelId !== this.dungeonChannelID) {
            return interaction.reply({
                content: `### ❌ The \`/${interaction.commandName}\` command can only be used in <#${this.dungeonChannelID}>.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const nowMs = Date.now();
        const startInput = interaction.options.getString('dungeon_start', true);
        const registrationEndInput = interaction.options.getString('registration_end');
        const description = interaction.options.getString('description')?.trim() || null;
        const pingDungeonRole = interaction.options.getString('ping_dungeon_role') === 'yes';
        const multipleAssignments = interaction.options.getString('multiple_assignments') === 'yes';

        if (pingDungeonRole && !this.dungeonRoleID) {
            return interaction.reply({
                content: '### ❌ Dungeon role is not configured.',
                flags: MessageFlags.Ephemeral
            });
        }

        const startTime = parseDungeonTime(startInput, nowMs);
        if (!startTime || startTime.getTime() <= nowMs) {
            return interaction.reply({
                content: '### ❌ Invalid Dungeon Start\n- Enter a time from now, like `5 hours`, `100 mins`, `1 day`, or `5 hours 17 mins`.',
                flags: MessageFlags.Ephemeral
            });
        }

        let registrationEndTime = null;
        if (registrationEndInput?.trim()) {
            registrationEndTime = parseDungeonTime(registrationEndInput, nowMs);
            if (!registrationEndTime || registrationEndTime.getTime() <= nowMs) {
                return interaction.reply({
                    content: '### ❌ Invalid Registration End\n- Enter a time from now, like `4 hours`, `100 mins`, `1 day`, or `4 hours 30 mins`.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const runId = this.createRunId();
        const run = {
            id: runId,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            messageId: null,
            messageUrl: null,
            partyLeaderId: interaction.user.id,
            dungeonKey: interaction.commandName,
            dungeonName: dungeon.name,
            titleEmoji: dungeon.titleEmoji,
            color: dungeon.color,
            roles: dungeon.roles,
            startTime,
            registrationEndTime,
            description,
            multipleAssignments,
            assignments: {},
            closed: false,
            reminderCounter: 0,
            deadlineTimeout: null
        };

        this.activeRuns.set(runId, run);

        try {
            const startMessage = pingDungeonRole
                ? `### ${run.titleEmoji}  <@&${this.dungeonRoleID}> A ${run.dungeonName} Dungeon run has been started!\n- Join by pressing the **buttons** below!`
                : `### ${run.titleEmoji}  A ${run.dungeonName} Dungeon run has been started!\n- Join by pressing the **buttons** below!`;

            await interaction.reply({
                content: startMessage,
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run),
                files: [createFooterLogoAttachment()],
                allowedMentions: { roles: pingDungeonRole ? [this.dungeonRoleID] : [] }
            });

            const message = await interaction.fetchReply();
            run.messageId = message.id;
            run.messageUrl = message.url ?? `https://discord.com/channels/${run.guildId}/${run.channelId}/${run.messageId}`;
            this.scheduleDeadline(run);
        } catch (err) {
            this.activeRuns.delete(runId);
            if (run.deadlineTimeout) clearTimeout(run.deadlineTimeout);
            throw err;
        }
    }

    buildEmbed(run) {
        const descriptionLines = [
            `## ${run.titleEmoji}\u2002${run.dungeonName} Dungeon\n` +
            `- Dungeon Start: ${formatDiscordTime(run.startTime)}`
        ];

        if (run.registrationEndTime) {
            descriptionLines.push(`- Registration Ends: ${formatDungeonTime(run.registrationEndTime, run.closed)}`);
        }

        descriptionLines.push(`- Dungeon Registration: **${run.closed ? 'Closed!\u2002:x:' : 'Open!\u2002:white_check_mark:'}**`);

        const embed = new EmbedBuilder()
            // .setTitle(`${run.titleEmoji}  ${run.dungeonName} Dungeon`)
            .setColor(run.color)
            .setDescription(descriptionLines.join('\n'))
            .setFooter({
                text: 'White Walker Dungeon Organizer',
                iconURL: 'attachment://ww_logo.png'
            })
            .setTimestamp();

        if (run.description) {
            embed.addFields({
                name: 'Description:',
                value: run.description,
                inline: false
            });
        }

        embed.addFields({
            name: 'Dungeon Roles:',
            value: run.closed ? '' : '-# Select an available Dungeon role by pressing the buttons below',
            inline: false
        });

        embed.addFields(run.roles.map(role => ({
            name: `${role.emoji} ${role.label}`,
            value: run.assignments[role.key]
                ? `<@${run.assignments[role.key]}>`
                : (run.closed ? '- *No assignment*' : '- *Available!*'),
            inline: true
        })));

        return embed;
    }

    buildCloseOverviewEmbed(run) {
        const signedUpCount = this.getAssignedUserIds(run).length;
        const rolesOverview = signedUpCount === 0
            ? `No members signed up for the ${run.dungeonName} dungeon.`
            : run.roles
                .map(role => `- ${role.emoji}\u2002**${role.label}:** ${run.assignments[role.key] ? `<@${run.assignments[role.key]}>` : '*No assignment*'}`)
                .join('\n');

        return new EmbedBuilder()
            .setDescription(`### ${run.titleEmoji}\u2002${run.dungeonName} Dungeon\n` +
                `**Party Leader:** <@${run.partyLeaderId}>`
            )
            .setColor(run.color)
            .setFooter({
                text: 'White Walker Dungeon Organizer',
                iconURL: 'attachment://ww_logo.png'
            })
            .setTimestamp()
            .addFields(
                {
                    name: 'Dungeon Start:',
                    value: formatDiscordTime(run.startTime),
                    inline: false
                }
            )
            .addFields(run.description ? [{
                name: 'Description:',
                value: run.description,
                inline: false
            }] : [])
            .addFields({
                name: 'Dungeon Roles:',
                value: rolesOverview,
                inline: false
            });
    }

    buildComponents(run) {
        const row = new ActionRowBuilder();

        for (const role of run.roles) {
            const isClaimed = Boolean(run.assignments[role.key]);

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`dgn:${run.id}:${role.key}`)
                    .setLabel(role.label)
                    .setEmoji(role.emoji)
                    .setStyle(isClaimed ? ButtonStyle.Danger : ButtonStyle.Success)
                    .setDisabled(run.closed)
            );
        }

        return [row];
    }

    getRole(run, roleKey) {
        return run.roles.find(role => role.key === roleKey);
    }

    getAssignedRoleForUser(run, userId) {
        return run.roles.find(role => run.assignments[role.key] === userId) ?? null;
    }

    getAssignedUserIds(run) {
        return Object.values(run.assignments);
    }

    isFull(run) {
        return run.roles.every(role => Boolean(run.assignments[role.key]));
    }

    scheduleDeadline(run) {
        if (!run.registrationEndTime || run.closed) return;

        const delay = run.registrationEndTime.getTime() - Date.now();
        if (delay <= 0) {
            this.closeRun(run.id, 'deadline', this.client).catch(err => console.error('[WW LOG] Dungeon deadline close failed:', err));
            return;
        }

        const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
        run.deadlineTimeout = setTimeout(() => {
            run.deadlineTimeout = null;
            if (Date.now() >= run.registrationEndTime.getTime()) {
                this.closeRun(run.id, 'deadline', this.client).catch(err => console.error('[WW LOG] Dungeon deadline close failed:', err));
            } else {
                this.scheduleDeadline(run);
            }
        }, timeoutDelay);
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('dgn:')) return false;

        const [, runId, roleKey] = interaction.customId.split(':');
        const run = this.activeRuns.get(runId);

        if (!run) {
            await interaction.reply({
                content: '### ❌ This dungeon recruitment is no longer active.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        const role = this.getRole(run, roleKey);
        if (!role) {
            await interaction.reply({
                content: '### ❌ This Dungeon role no longer exists.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        if (run.closed) {
            await interaction.reply({
                content: '### ⏳ This dungeon recruitment has already closed.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const claimedBy = run.assignments[role.key];
        if (claimedBy === interaction.user.id) {
            delete run.assignments[role.key];

            await interaction.message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            });

            await interaction.editReply({
                content: `### ✅ You have been successfully removed from ${run.dungeonName} Dungeon with the role: **${role.label}**.`
            });
            return true;
        }

        if (claimedBy) {
            await interaction.editReply({
                content: `### ❌ **${role.label}** has already been claimed by <@${claimedBy}>.`
            });
            return true;
        }

        const existingRole = this.getAssignedRoleForUser(run, interaction.user.id);
        if (!run.multipleAssignments && existingRole) {
            await interaction.editReply({
                content: `### ❌ You are already assigned to **${existingRole.label}** in this ${run.dungeonName} Dungeon run.\n-# Press your current role button to leave before selecting another role.`
            });
            return true;
        }

        run.assignments[role.key] = interaction.user.id;

        const isNowFull = this.isFull(run);
        if (isNowFull) {
            await this.closeRun(run.id, 'full', interaction.client, interaction.message);
        } else {
            await interaction.message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            });
        }

        await interaction.editReply({
            content:
                `### ✅ You have been successfully assigned to ${run.dungeonName} Dungeon with the role: **${role.label}**.\n` +
                (isNowFull
                    ? '-# This filled the final Dungeon role, so recruitment is now closed.'
                    : '-# Press the button corresponding to your role to be removed from this Dungeon run.')
        });

        return true;
    }

    async closeRun(runId, reason, client, sourceMessage = null) {
        const run = this.activeRuns.get(runId);
        if (!run || run.closed) return;

        run.closed = true;
        if (run.deadlineTimeout) {
            clearTimeout(run.deadlineTimeout);
            run.deadlineTimeout = null;
        }

        const message = sourceMessage ?? await this.fetchRunMessage(run, client);
        if (message) {
            await message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            }).catch(err => console.error('[WW LOG] Failed to edit closed dungeon recruitment:', err));
        }

        const channel = message?.channel ?? await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const uniqueUserIds = [...new Set(this.getAssignedUserIds(run))];
        const mentions = uniqueUserIds.map(id => `<@${id}>`).join(', ');

        let content;
        if (reason === 'full') {
            content =
                `${mentions}\n` +
                `Recruitment for the ${run.dungeonName} Dungeon has been closed, as all 5 roles have been filled.\n` +
                '- Good luck, and have fun!\u2002<:man_of_culture:1186287184106496112>';
        } else {
            const signedUpCount = this.getAssignedUserIds(run).length;
            content =
                `${mentions ? `${mentions}\n` : ''}` +
                `The recruitment deadline for the ${run.dungeonName} Dungeon has passed, and recruitment is now closed.\n` +
                `${signedUpCount > 0 ? `- Good luck, and have fun!\u2002<:man_of_culture:1186287184106496112>` : ''}`;
        }

        await channel.send({
            content,
            embeds: [this.buildCloseOverviewEmbed(run)],
            files: [createFooterLogoAttachment()],
            allowedMentions: { users: uniqueUserIds }
        });
    }

    async fetchRunMessage(run, client) {
        if (!run.messageId) return null;

        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return null;

        return channel.messages.fetch(run.messageId).catch(() => null);
    }

    async handleMessageCreate(message) {
        if (message.author.bot) return false;

        let handled = false;
        for (const run of this.activeRuns.values()) {
            if (run.closed || run.channelId !== message.channelId) continue;

            handled = true;
            run.reminderCounter += 1;

            if (run.reminderCounter % 10 === 0 && run.messageUrl) {
                await message.channel.send({
                    content:
                        `## ${run.titleEmoji}\u2002Recruitment for ${run.dungeonName} Dungeon is still open!\n` +
                        `- [Jump to Dungeon Recruitment](${run.messageUrl})`
                });
            }
        }

        return handled;
    }
}

module.exports = DungeonRecruitment;
