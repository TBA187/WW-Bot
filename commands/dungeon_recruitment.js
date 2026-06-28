// ------------------------------------------
// Dungeon recruitment commands:
// /forlorn | /victini | /meloetta | /hoopa | /xmas_dungeon
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
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const NO_MULTIPLE_ASSIGNMENT_COMMANDS = new Set(['victini', 'xmas_dungeon']);

const DUNGEONS = {
    forlorn: {
        name: 'Forlorn',
        location: 'Forlorn Court',
        titleEmoji: '🏰',
        color: 0x1A43BF,
        roles: [
            { key: 'room1', label: 'Room 1', emoji: '<:slowbro:1520646521396134019>' },
            { key: 'room2', label: 'Room 2', emoji: '<:sceptile:1520646685175316533>' },
            { key: 'room3', label: 'Room 3', emoji: '<:houndoom:1520646615969300510>' },
            { key: 'room4', label: 'Room 4', emoji: '<:salamence:1520646651428077658>' },
            { key: 'mid', label: 'Mid (Rotom)', emoji: '<:rotom:1520647413017346128>' }
        ]
    },
    victini: {
        name: 'Victini',
        location: 'Ruins of the Vale',
        titleEmoji: '<:victini:1514805175519412254>',
        color: 0xF59E0B,
        rolesNote: '-# **Victini Dungeon** needs at least 4 guild members!',
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
        location: 'Crux of Melody',
        titleEmoji: '<:meloetta:1514805507372748830>',
        color: 0xEC4899,
        buttonRows: [
            ['ice', 'sleep', 'trees'],
            ['fire', 'poison']
        ],
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
        location: 'Scattered Realm',
        titleEmoji: '<a:hoopa:1474190060671995924>',
        color: 0x8B5CF6,
        buttonRows: [
            ['hoopa', 'dialga', 'palkia'],
            ['groudon', 'kyogre']
        ],
        roles: [
            { key: 'groudon', label: 'Groudon Boss', emoji: '<:groudon:1520634366546673729>' },
            { key: 'kyogre', label: 'Kyogre Boss', emoji: '<a:kyogre:1520633624477700119>' },
            { key: 'dialga', label: 'Dialga Boss', emoji: '<:dialga:1520650577183510578>' },
            { key: 'palkia', label: 'Palkia Boss', emoji: '<:palkia:1520650534640685077>' },
            { key: 'hoopa', label: 'Hoopa Boss', emoji: '<:hoopa_unbound:1520651206756794398>' }
        ]
    },
    xmas_dungeon: {
        name: 'Xmas',
        location: 'Temple of Truth',
        titleEmoji: '<a:reshiram:1474190687246225450>',
        color: 0x02f3d7,
        buttonRows: [
            ['reshiram', 'tyranitar', 'ninetales'],
            ['camerupt', 'houndoom']
        ],
        roles: [
            { key: 'tyranitar', label: 'Tyranitar Boss', emoji: '🦖' },
            { key: 'ninetales', label: 'Ninetales Boss', emoji: '<:ninetales:1520633565967024198>' },
            { key: 'camerupt', label: 'Camerupt Boss', emoji: '🌋' },
            { key: 'houndoom', label: 'Houndoom Boss', emoji: '<:houndoom:1520646615969300510>' },
            { key: 'reshiram', label: 'Reshiram Boss', emoji: '<a:reshiram:1474190687246225450>' }
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

function normalizeDescription(input) {
    const description = input?.trim().replace(/\\n/g, '\n');
    return description || null;
}

function truncateChoiceName(name) {
    return name.length > 100 ? `${name.slice(0, 97)}...` : name;
}

function getDungeonDisplayName(runOrDungeon) {
    return `${runOrDungeon.name ?? runOrDungeon.dungeonName} Dungeon (${runOrDungeon.location})`;
}

class DungeonRecruitment {
    constructor(config) {
        this.name = 'dungeon_recruitment';
        this.client = config.client;
        this.onCooldown = config.onCooldown;
        this.activeRuns = new Map();
        this.dungeonChannelID = config.dungeonChannelID;
        this.dungeonRoleID = config.dungeonRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;

        this.data = [
            ...Object.keys(DUNGEONS).map(commandName => this.buildCommand(commandName)),
            this.buildReminderCommand()
        ];
    }

    buildCommand(commandName) {
        const dungeon = DUNGEONS[commandName];

        const builder = new SlashCommandBuilder()
            .setName(commandName)
            .setDescription(`Create a ${dungeon.name} Dungeon recruitment. (${dungeon.location})`)
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
                    .setDescription('Dungeon description (optional). Use \\n for line breaks, e.g. Line 1\\nLine 2.')
                    .setRequired(false)
                    .setMaxLength(1000)
            )
            .addStringOption(o =>
                o.setName('ping_dungeon_role')
                    .setDescription('Should the @Dungeon role be pinged for this dungeon run? Leave empty for NO!')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            );

        if (!NO_MULTIPLE_ASSIGNMENT_COMMANDS.has(commandName)) {
            builder.addStringOption(o =>
                o.setName('multiple_assignments')
                    .setDescription('Should a player be able to select multiple Dungeon roles? Leave empty for NO!')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            );
        }

        return builder;
    }

    buildReminderCommand() {
        return new SlashCommandBuilder()
            .setName('dungeon_reminders')
            .setDescription('Enable or disable reminder messages for open Dungeon recruitments')
            .addStringOption(o =>
                o.setName('active_dungeon_runs')
                    .setDescription('Select one open Dungeon recruitment to update its reminders')
                    .setRequired(false)
                    .setAutocomplete(true)
            )
            .addStringOption(o =>
                o.setName('post_reminder')
                    .setDescription('Post reminders for the selected Dungeon run? Leave empty for YES.')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Yes', value: 'yes' },
                        { name: 'No', value: 'no' }
                    )
            )
            .addStringOption(o =>
                o.setName('disable_all_reminders')
                    .setDescription('Select "Yes" to disable ALL open reminders. No enables all. Empty makes no global change.')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
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
        if (interaction.commandName === 'dungeon_reminders') {
            return this.executeReminderCommand(interaction);
        }

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

        // if (interaction.channelId !== this.dungeonChannelID) {
        //     return interaction.reply({
        //         content: `### ❌ The \`/${interaction.commandName}\` command can only be used in <#${this.dungeonChannelID}>.`,
        //         flags: MessageFlags.Ephemeral
        //     });
        // }

        const nowMs = Date.now();
        const startInput = interaction.options.getString('dungeon_start', true);
        const registrationEndInput = interaction.options.getString('registration_end');
        const description = normalizeDescription(interaction.options.getString('description'));
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
                content: '### ❌ Invalid Dungeon Start\n- Enter a time from now, like `5h (hours)`, `100m (mins)`, `1d (day)`, or `5h 17m`.',
                flags: MessageFlags.Ephemeral
            });
        }

        let registrationEndTime = null;
        if (registrationEndInput?.trim()) {
            registrationEndTime = parseDungeonTime(registrationEndInput, nowMs);
            if (!registrationEndTime || registrationEndTime.getTime() <= nowMs) {
                return interaction.reply({
                    content: '### ❌ Invalid Registration End\n- Enter a time from now, like `5h (hours)`, `100m (mins)`, `1d (day)`, or `5h 17m`.',
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
            partyLeaderName: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
            dungeonKey: interaction.commandName,
            dungeonName: dungeon.name,
            location: dungeon.location,
            titleEmoji: dungeon.titleEmoji,
            color: dungeon.color,
            roles: dungeon.roles,
            rolesNote: dungeon.rolesNote ?? null,
            buttonRows: dungeon.buttonRows ?? null,
            startTime,
            registrationEndTime,
            description,
            multipleAssignments,
            assignments: {},
            closed: false,
            createdAt: nowMs,
            reminderCounter: 0,
            remindersEnabled: true,
            remindersStopAt: nowMs + REMINDER_WINDOW_MS,
            deadlineTimeout: null
        };

        this.activeRuns.set(runId, run);

        try {
            await interaction.deferReply();

            const startMessage = pingDungeonRole
                ? `### ${run.titleEmoji} <@&${this.dungeonRoleID}>, a **${run.dungeonName} Dungeon** run has been started by <@${run.partyLeaderId}>!\n- Join by pressing the **buttons** below!`
                : `### ${run.titleEmoji} A **${run.dungeonName} Dungeon** run has been started by <@${run.partyLeaderId}>!\n- Join by pressing the **buttons** below!`;

            const message = await interaction.editReply({
                content: startMessage,
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run),
                files: [createFooterLogoAttachment()],
                allowedMentions: { roles: pingDungeonRole ? [this.dungeonRoleID] : [] }
            });

            run.messageId = message.id;
            run.messageUrl = message.url ?? `https://discord.com/channels/${run.guildId}/${run.channelId}/${run.messageId}`;
            this.scheduleDeadline(run);
        } catch (err) {
            this.activeRuns.delete(runId);
            if (run.deadlineTimeout) clearTimeout(run.deadlineTimeout);
            throw err;
        }
    }

    hasReminderPermission(interaction) {
        const allowedRoles = [this.adminRoleID, this.officerRoleID].filter(Boolean);
        return interaction.member?.roles?.cache?.some(role => allowedRoles.includes(role.id)) ?? false;
    }

    getOpenRuns() {
        return [...this.activeRuns.values()]
            .filter(run => !run.closed)
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    }

    isReminderWindowOpen(run, nowMs = Date.now()) {
        return !run.remindersStopAt || nowMs < run.remindersStopAt;
    }

    setRunReminders(run, enabled, nowMs = Date.now()) {
        if (enabled && !this.isReminderWindowOpen(run, nowMs)) {
            run.remindersEnabled = false;
            return { updated: false, expired: true };
        }

        const wasEnabled = run.remindersEnabled !== false;
        run.remindersEnabled = enabled;
        if (enabled && !wasEnabled) {
            run.reminderCounter = 0;
        }

        return { updated: true, expired: false };
    }

    async executeReminderCommand(interaction) {
        if (this.onCooldown?.(interaction.user.id, 'dungeon_reminders', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (!this.hasReminderPermission(interaction)) {
            return interaction.reply({ content: '### ❌ No permission!', flags: MessageFlags.Ephemeral });
        }

        const runId = interaction.options.getString('active_dungeon_runs');
        const postReminder = interaction.options.getString('post_reminder');
        const disableAllReminders = interaction.options.getString('disable_all_reminders');

        if (runId && disableAllReminders) {
            return interaction.reply({
                content: '### ❌ Choose either one active Dungeon run or a global reminder action, not both.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!runId && !disableAllReminders) {
            return interaction.reply({
                content: '### ❌ Select an active Dungeon run, or use `disable_all_reminders` to manage all open reminders.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (disableAllReminders) {
            const enableAll = disableAllReminders === 'no';
            const openRuns = this.getOpenRuns();
            if (openRuns.length === 0) {
                return interaction.reply({
                    content: '### ❌ There are no open Dungeon recruitments in the local cache.',
                    flags: MessageFlags.Ephemeral
                });
            }

            let updatedCount = 0;
            let expiredCount = 0;
            for (const run of openRuns) {
                const result = this.setRunReminders(run, enableAll);
                if (result.expired) expiredCount += 1;
                if (result.updated) updatedCount += 1;
            }

            const actionText = enableAll ? 'enabled' : 'disabled';
            const expiredText = expiredCount > 0
                ? `\n- ${expiredCount} Dungeon run(s) are older than 24 hours, so reminders stayed disabled.`
                : '';

            return interaction.reply({
                content: `### ✅ Dungeon reminders updated\n- Reminders ${actionText} for **${updatedCount}** open Dungeon run(s).${expiredText}`,
                flags: MessageFlags.Ephemeral
            });
        }

        const run = this.activeRuns.get(runId);
        if (!run || run.closed) {
            return interaction.reply({
                content: '### ❌ That Dungeon recruitment is no longer open.',
                flags: MessageFlags.Ephemeral
            });
        }

        const enableReminder = postReminder !== 'no';
        const result = this.setRunReminders(run, enableReminder);
        if (result.expired) {
            return interaction.reply({
                content: `### ⏳ Reminders cannot be re-enabled for **${run.dungeonName} Dungeon** because it is older than 24 hours.`,
                flags: MessageFlags.Ephemeral
            });
        }

        return interaction.reply({
            content:
                `### ✅ Dungeon reminders updated\n` +
                `- Dungeon: **${run.dungeonName} Dungeon** by <@${run.partyLeaderId}>\n` +
                `- Reminders: **${enableReminder ? 'Enabled' : 'Disabled'}**`,
            flags: MessageFlags.Ephemeral
        });
    }

    async handleAutocomplete(interaction) {
        if (interaction.commandName !== 'dungeon_reminders') return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'active_dungeon_runs') return interaction.respond([]);

        const query = focused.value.toLowerCase();
        const choices = this.getOpenRuns()
            .map(run => ({
                name: truncateChoiceName(`${run.dungeonName} (${run.partyLeaderName ?? 'Unknown'})`),
                value: run.id
            }))
            .filter(choice => choice.name.toLowerCase().includes(query))
            .slice(0, MAX_AUTOCOMPLETE_CHOICES);

        return interaction.respond(choices);
    }

    buildEmbed(run) {
        const descriptionLines = [
            `## ${run.titleEmoji}\u2002${getDungeonDisplayName(run)}\n` +
            `- Dungeon Start: ${formatDiscordTime(run.startTime)}`
        ];

        if (run.registrationEndTime) {
            descriptionLines.push(`- Registration End: ${formatDungeonTime(run.registrationEndTime, run.closed)}`);
        }

        descriptionLines.push(`- Multiple **Dungeon Roles** assignments: **${run.multipleAssignments ? 'Yes!' : 'No!'}**`);
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
            value: run.closed
                ? ''
                : ['-# Select an available Dungeon role by pressing the buttons below', run.rolesNote].filter(Boolean).join('\n'),
            inline: false
        });

        embed.addFields(this.getRolesInButtonOrder(run).map(role => ({
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
            : this.getRolesInButtonOrder(run)
                .map(role => `- ${role.emoji}\u2002**${role.label}:** ${run.assignments[role.key] ? `<@${run.assignments[role.key]}>` : '*No assignment*'}`)
                .join('\n');

        return new EmbedBuilder()
            .setDescription(`### ${run.titleEmoji}\u2002${getDungeonDisplayName(run)}\n` +
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

    getRolesInButtonOrder(run) {
        if (!Array.isArray(run.buttonRows) || run.buttonRows.length === 0) {
            return run.roles;
        }

        const roleByKey = new Map(run.roles.map(role => [role.key, role]));
        const orderedRoles = run.buttonRows.flatMap(row =>
            row.map(roleKey => roleByKey.get(roleKey)).filter(Boolean)
        );
        const orderedKeys = new Set(orderedRoles.map(role => role.key));
        const missingRoles = run.roles.filter(role => !orderedKeys.has(role.key));

        return [...orderedRoles, ...missingRoles];
    }

    buildComponents(run) {
        const roleByKey = new Map(run.roles.map(role => [role.key, role]));
        const buttonRows = Array.isArray(run.buttonRows) && run.buttonRows.length > 0
            ? run.buttonRows
                .map(row => row.map(roleKey => roleByKey.get(roleKey)).filter(Boolean))
                .filter(row => row.length > 0)
            : [run.roles];

        return buttonRows.map(roles => {
            const row = new ActionRowBuilder();

            for (const role of roles) {
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

            return row;
        });
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
                content: `### ❌ You have been successfully removed from ${run.dungeonName} Dungeon with the role: **${role.label}**.`
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
        run.remindersEnabled = false;
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
        const nowMs = Date.now();
        for (const run of this.activeRuns.values()) {
            if (run.closed || run.channelId !== message.channelId) continue;
            if (!this.isReminderWindowOpen(run, nowMs)) {
                run.remindersEnabled = false;
                continue;
            }
            if (run.remindersEnabled === false) continue;

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
