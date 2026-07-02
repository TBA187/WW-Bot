const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const {
    GIVEAWAY_ACTIVE,
    GIVEAWAY_DELETED,
    GIVEAWAY_ENDED,
    buildGiveawayListEmbeds,
    canManageGiveaways,
    deleteGiveawayMessage,
    drawSummary,
    endGiveaway,
    giveawayAutocomplete,
    giveawayChannelOnlyError,
    giveawayDisplayLabel,
    handleGiveawayButton,
    makeGiveawayId,
    normalizeGiveawayDescription,
    parseColor,
    parseGiveawayEndTime,
    refreshGiveawayMessage,
    resolveRoleIds,
    sendEmbedFollowUp,
    sendGiveawayMessage,
    sendParticipantEmbeds,
    shouldRestrictGiveawayChannel,
    utcNowIso,
    validateWinnerCount
} = require('../events/giveaways');

class Giveaways {
    constructor(config) {
        this.name = 'giveaway';
        this.config = config;
        this.giveawayStore = config.giveawayStore;

        this.data = new SlashCommandBuilder()
            .setName('giveaway')
            .setDescription('Create and manage White Walkers giveaways.')
            .addSubcommand(sub =>
                sub.setName('create')
                    .setDescription('Create a giveaway.')
                    .addStringOption(o =>
                        o.setName('duration')
                            .setDescription("End time. Use '1d 5h 30m' or UTC datetime like '2026-07-01 18:30'.")
                            .setRequired(true)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription('Number of winners to draw.')
                            .setRequired(true)
                            .setMinValue(1)
                            .setMaxValue(100)
                    )
                    .addStringOption(o =>
                        o.setName('prize')
                            .setDescription('Prize for the giveaway.')
                            .setRequired(true)
                            .setMaxLength(512)
                    )
                    .addStringOption(o =>
                        o.setName('name')
                            .setDescription('Optional giveaway title. Leave empty to use White Walkers Giveaway  🎉.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('description')
                            .setDescription('Giveaway description (optional). Use \\n for line breaks, e.g. Line1\\nLine2')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('host')
                            .setDescription('Giveaway host. Leave empty to use the Giveaway hosts @username.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('color')
                            .setDescription('Embed color. Hex or names like neon green, dark red, navy blue. Default #39FF14.')
                            .setRequired(false)
                            .setMaxLength(64)
                    )
                    .addAttachmentOption(o =>
                        o.setName('thumbnail')
                            .setDescription('Image for Giveaway (appears at the top right of the embed). Leave empty for White Walkers logo.')
                            .setRequired(false)
                    )
                    .addStringOption(o =>
                        o.setName('ping_roles')
                            .setDescription('Roles to ping for the giveaway. Mention roles or enter role names. Empty = no pings.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('required_role')
                            .setDescription('Officer-only: required role(s) to enter. Only one matching role is needed.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('edit')
                    .setDescription('Edit an active giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to edit.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(o =>
                        o.setName('duration')
                            .setDescription("New end time. Use '1d 5h 30m' or UTC datetime like '2026-07-01 18:30'.")
                            .setRequired(false)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription('New number of winners.')
                            .setRequired(false)
                            .setMinValue(1)
                            .setMaxValue(100)
                    )
                    .addStringOption(o =>
                        o.setName('prize')
                            .setDescription('New prize.')
                            .setRequired(false)
                            .setMaxLength(512)
                    )
                    .addStringOption(o =>
                        o.setName('name')
                            .setDescription('New giveaway title.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('host')
                            .setDescription('New host text.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('color')
                            .setDescription('New embed color. Accepts hex code or names like dark red, light green, navy blue.')
                            .setRequired(false)
                            .setMaxLength(64)
                    )
                    .addAttachmentOption(o =>
                        o.setName('thumbnail')
                            .setDescription('New image for the embed thumbnail.')
                            .setRequired(false)
                    )
                    .addStringOption(o =>
                        o.setName('ping_roles')
                            .setDescription('Role(s) to ping in the giveaway message. Leave empty to keep current pings.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('required_role')
                            .setDescription('Require entrants to have one or more roles.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addBooleanOption(o =>
                        o.setName('remove_ping_roles')
                            .setDescription('Remove the current ping roles.')
                            .setRequired(false)
                    )
                    .addBooleanOption(o =>
                        o.setName('remove_required_role')
                            .setDescription('Remove the current required role.')
                            .setRequired(false)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('end')
                    .setDescription('End an active giveaway immediately.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to end.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('delete')
                    .setDescription('Delete a giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to delete.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('reroll')
                    .setDescription('Reroll winners for an ended giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Select an ended giveaway to reroll. Giveaways older than 48 hours cannot be rerolled.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription("Number of new winners. Defaults to the giveaway's winner count.")
                            .setRequired(false)
                            .setMinValue(1)
                            .setMaxValue(100)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('participants')
                    .setDescription('Show giveaway participants.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to inspect.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('list')
                    .setDescription('List giveaways.')
                    .addStringOption(o =>
                        o.setName('status')
                            .setDescription('Which giveaways to list. Leave empty to show currently active giveaways.')
                            .setRequired(false)
                            .addChoices(
                                { name: 'Active', value: GIVEAWAY_ACTIVE },
                                { name: 'Ended', value: GIVEAWAY_ENDED },
                                { name: 'Deleted', value: GIVEAWAY_DELETED },
                                { name: 'All', value: 'all' }
                            )
                    )
            );
    }

    async execute(interaction) {
        if (!this.giveawayStore) {
            return interaction.reply({ content: 'Giveaway storage is not ready.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'create') return this.create(interaction);
        if (subcommand === 'edit') return this.edit(interaction);
        if (subcommand === 'end') return this.end(interaction);
        if (subcommand === 'delete') return this.delete(interaction);
        if (subcommand === 'reroll') return this.reroll(interaction);
        if (subcommand === 'participants') return this.participants(interaction);
        if (subcommand === 'list') return this.list(interaction);
        return interaction.reply({ content: 'Unknown giveaway command.', flags: MessageFlags.Ephemeral });
    }

    async create(interaction) {
        if (shouldRestrictGiveawayChannel(this.config) && interaction.channelId !== this.config.giveawayChannelID) {
            return interaction.reply({ content: giveawayChannelOnlyError(this.config), flags: MessageFlags.Ephemeral });
        }

        const requiredRoleText = interaction.options.getString('required_role');
        if (requiredRoleText?.trim() && !canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: '`required_role` can only be used by Admin/Staff.', flags: MessageFlags.Ephemeral });
        }

        let winners;
        let endsAt;
        let colorHex;
        let pingRoleIds;
        let requiredRoleIds;
        try {
            winners = validateWinnerCount(interaction.options.getInteger('winners', true));
            endsAt = parseGiveawayEndTime(interaction.options.getString('duration', true));
            colorHex = parseColor(interaction.options.getString('color'));
            pingRoleIds = resolveRoleIds(interaction.guild, interaction.options.getString('ping_roles'));
            requiredRoleIds = resolveRoleIds(interaction.guild, requiredRoleText);
        } catch (err) {
            return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
        }

        if (!interaction.channel?.send || interaction.channel?.type !== ChannelType.GuildText) {
            return interaction.reply({ content: 'This command must be used in a message channel.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const giveawayId = makeGiveawayId();
        const name = interaction.options.getString('name');
        const host = interaction.options.getString('host');
        const thumbnail = interaction.options.getAttachment('thumbnail');
        const now = utcNowIso();
        let giveaway = {
            giveaway_id: giveawayId,
            guild_id: interaction.guildId,
            channel_id: interaction.channelId,
            message_id: null,
            name: name?.trim() || null,
            description: normalizeGiveawayDescription(interaction.options.getString('description')),
            prize: interaction.options.getString('prize', true).trim(),
            host_text: host?.trim() || interaction.user.toString(),
            host_display_name: host?.trim() ? null : this.userDisplayName(interaction.member || interaction.user),
            host_user_id: host?.trim() ? null : interaction.user.id,
            created_by_id: interaction.user.id,
            created_by_name: this.userDisplayName(interaction.member || interaction.user),
            winners_total: winners,
            ping_role_ids: pingRoleIds,
            required_role_ids: requiredRoleIds,
            required_role_id: requiredRoleIds[0] || null,
            status: GIVEAWAY_ACTIVE,
            starts_at: now,
            ends_at: endsAt.toISOString(),
            ended_at: null,
            deleted_at: null,
            color_hex: colorHex,
            thumbnail_url: thumbnail?.url || null,
            winner_user_ids: []
        };

        giveaway = await this.giveawayStore.createGiveaway(giveaway);

        let message;
        try {
            message = await sendGiveawayMessage(interaction.channel, giveaway, this.config);
        } catch (err) {
            console.error('[WW LOG] Giveaway create message failed:', err);
            await interaction.editReply('Discord returned an error while creating the giveaway.');
            return;
        }

        giveaway = await this.giveawayStore.updateGiveaway(giveawayId, { message_id: message.id });
        await interaction.editReply(`Giveaway created: ${message.url}`);
    }

    async edit(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record || record.status !== GIVEAWAY_ACTIVE) {
            return interaction.editReply('That active giveaway could not be found.');
        }

        const updates = {};
        try {
            const duration = interaction.options.getString('duration');
            const winners = interaction.options.getInteger('winners');
            const color = interaction.options.getString('color');
            const pingRoles = interaction.options.getString('ping_roles');
            const requiredRole = interaction.options.getString('required_role');
            if (duration) updates.ends_at = parseGiveawayEndTime(duration).toISOString();
            if (winners !== null) updates.winners_total = validateWinnerCount(winners);
            if (color) updates.color_hex = parseColor(color);
            if (pingRoles) updates.ping_role_ids = resolveRoleIds(interaction.guild, pingRoles);
            if (requiredRole) {
                const requiredRoleIds = resolveRoleIds(interaction.guild, requiredRole);
                updates.required_role_ids = requiredRoleIds;
                updates.required_role_id = requiredRoleIds[0] || null;
            }
        } catch (err) {
            return interaction.editReply(err.message);
        }

        const prize = interaction.options.getString('prize');
        const name = interaction.options.getString('name');
        const host = interaction.options.getString('host');
        const thumbnail = interaction.options.getAttachment('thumbnail');
        if (prize) updates.prize = prize.trim();
        if (name) updates.name = name.trim();
        if (host) {
            updates.host_text = host.trim();
            updates.host_display_name = null;
            updates.host_user_id = null;
        }
        if (thumbnail) updates.thumbnail_url = thumbnail.url;
        if (interaction.options.getBoolean('remove_ping_roles') === true) updates.ping_role_ids = [];
        if (interaction.options.getBoolean('remove_required_role') === true) {
            updates.required_role_ids = [];
            updates.required_role_id = null;
        }

        if (!Object.keys(updates).length) {
            return interaction.editReply('No giveaway changes were provided.');
        }

        const updated = await this.giveawayStore.updateGiveaway(giveawayId, updates);
        await refreshGiveawayMessage(interaction.client, this.config, updated);
        await interaction.editReply(`Updated **${giveawayDisplayLabel(updated, { guild: interaction.guild })}**.`);
    }

    async end(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record || record.status !== GIVEAWAY_ACTIVE) {
            return interaction.editReply('That active giveaway could not be found.');
        }

        const [ended, winnerIds] = await endGiveaway(interaction.client, this.config, record, { actor: interaction.user, drawType: 'end' });
        await interaction.editReply(drawSummary('Ended', ended, winnerIds, interaction.guild));
    }

    async delete(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record) {
            return interaction.editReply('That giveaway could not be found.');
        }

        const updated = await this.giveawayStore.updateGiveaway(giveawayId, {
            status: GIVEAWAY_DELETED,
            deleted_at: utcNowIso()
        });
        await deleteGiveawayMessage(interaction.client, this.config, updated);
        await interaction.editReply(`Deleted **${giveawayDisplayLabel(updated, { guild: interaction.guild })}**.`);
    }

    async reroll(interaction) {
        if (shouldRestrictGiveawayChannel(this.config) && interaction.channelId !== this.config.giveawayChannelID) {
            return interaction.reply({ content: giveawayChannelOnlyError(this.config, 'reroll'), flags: MessageFlags.Ephemeral });
        }

        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record || record.status !== GIVEAWAY_ENDED) {
            return interaction.editReply('That ended giveaway could not be found.');
        }

        let winnerCount;
        try {
            winnerCount = validateWinnerCount(interaction.options.getInteger('winners') || Number(record.winners_total || 1));
        } catch (err) {
            return interaction.editReply(err.message);
        }

        const [rerolled, winnerIds] = await endGiveaway(interaction.client, this.config, record, {
            actor: interaction.user,
            drawType: 'reroll',
            winnerCount
        });
        await interaction.editReply(drawSummary('Rerolled', rerolled, winnerIds, interaction.guild));
    }

    async participants(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record) {
            return interaction.editReply('That giveaway could not be found.');
        }

        await sendParticipantEmbeds(interaction, this.config, record);
    }

    async list(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = interaction.options.getString('status') || GIVEAWAY_ACTIVE;
        const giveaways = await this.giveawayStore.listGiveaways(status);
        for (const giveaway of giveaways) {
            const entries = await this.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
            giveaway.participant_count = entries.length;
        }

        const embeds = buildGiveawayListEmbeds(giveaways, status, interaction.guild);
        return this.sendEmbeds(interaction, embeds);
    }

    async sendEmbeds(interaction, embeds) {
        await sendEmbedFollowUp(interaction, embeds);
    }

    async handleAutocomplete(interaction) {
        if (interaction.commandName !== 'giveaway') return;
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'edit' || subcommand === 'end') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: GIVEAWAY_ACTIVE }));
        }
        if (subcommand === 'reroll') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: GIVEAWAY_ENDED, recentEndedOnly: true }));
        }
        if (subcommand === 'delete' || subcommand === 'participants') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: 'all' }));
        }
        return interaction.respond([]);
    }

    async handleButton(interaction) {
        return handleGiveawayButton(interaction, this.config);
    }

    userDisplayName(user) {
        return String(user?.nickname || user?.displayName || user?.globalName || user?.username || user?.user?.username || user?.id || 'Unknown');
    }
}

module.exports = Giveaways;
