const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const {
    autoRolePanelAutocomplete,
    findAutoRolePanel,
    handleAutoRoleButton,
    handleAutoRoleModal,
    handleAutoRoleSelect,
    sendAutoRolePanel
} = require('../events/auto_roles');


class AutoRoles {
    constructor(config) {
        this.name = 'auto_roles_send';
        this.adminRoleID = config.adminRoleID;

        this.data = new SlashCommandBuilder()
            .setName('auto_roles_send')
            .setDescription('Send one of the configured auto-role panels.')
            .addStringOption(o =>
                o.setName('panel')
                    .setDescription('Auto-role panel to send.')
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addChannelOption(o =>
                o.setName('channel')
                    .setDescription('Channel to post the selected auto-role panel in. If omitted, the panel default channel is used.')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText)
            );
    }

    isAdminMember(member) {
        if (!member?.roles?.cache) {
            return false;
        }

        return member.roles.cache.some(role => role.id === this.adminRoleID);
    }

    async execute(interaction) {
        if (!this.isAdminMember(interaction.member)) {
            await interaction.reply({
                content: 'Only admins can use this command.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const panel = interaction.options.getString('panel', true);
        const selectedPanel = findAutoRolePanel(panel);
        if (selectedPanel === null) {
            await interaction.reply({
                content: 'Auto-role panel not found! Please pick one from the autocomplete list.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!selectedPanel.active) {
            await interaction.reply({
                content: `**${selectedPanel.name}** is currently inactive and cannot be sent.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        let targetChannel = interaction.options.getChannel('channel');
        if (targetChannel === null && selectedPanel.defaultChannelId !== null) {
            const fetchedChannel = interaction.client.channels.cache.get(selectedPanel.defaultChannelId)
                ?? await interaction.client.channels.fetch(selectedPanel.defaultChannelId).catch(() => null);

            if (fetchedChannel?.type === ChannelType.GuildText) {
                targetChannel = fetchedChannel;
            }
        }

        if (targetChannel === null) {
            await interaction.reply({
                content: 'Please choose a channel, or set `AUTO_ROLES_CHANNEL_ID` inside `events/auto_roles.js` for this panel.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const message = await sendAutoRolePanel(targetChannel, selectedPanel);
            await interaction.editReply(
                `Sent **${selectedPanel.name}** in ${targetChannel}.\n` +
                `Message ID: \`${message.id}\``
            );
        } catch (err) {
            if (err?.code === 'ENOENT') {
                await interaction.editReply(`Could not find \`${selectedPanel.imagePath}\``);
                return;
            }

            if (err?.code === 50013) {
                await interaction.editReply('No permissions to send the auto-role panel in this channel.');
                return;
            }

            console.error('[WW LOG] Auto-role panel send error:', err);
            await interaction.editReply('Discord returned an error while sending the auto-role panel. Please try again.');
        }
    }

    async handleAutocomplete(interaction) {
        if (interaction.commandName !== 'auto_roles_send') return;
        if (!this.isAdminMember(interaction.member)) {
            return interaction.respond([]);
        }

        return autoRolePanelAutocomplete(interaction);
    }

    async handleButton(interaction) {
        return handleAutoRoleButton(interaction);
    }

    async handleSelect(interaction) {
        return handleAutoRoleSelect(interaction);
    }

    async handleModal(interaction) {
        return handleAutoRoleModal(interaction);
    }
}

module.exports = AutoRoles;
