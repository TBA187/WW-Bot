// ======================================
// /test to retrieve member Discord Info
// ======================================
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, AttachmentBuilder } = require('discord.js');

class Test {

    constructor(config) {
        this.name = "test";
        this.db = config.db;
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('test')
            .setDescription('Test')
            .addUserOption(o =>
                o.setName('user')
                    .setDescription('Select user')
                    .setRequired(true)
            );
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'stats', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!interaction.member.roles.cache.some(role => allowedRoles.includes(role.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser('user');
        const member = interaction.options.getMember('user');
        if (!member) return interaction.reply({ content: '❌ User not found!', flags: MessageFlags.Ephemeral });

        const username = user?.username;
        const userTag = member.user?.tag ?? '*Unknown User!*'; // Discord @handle
        const globalName = member.user?.globalName ?? '*No Global Name!*'; // Discord Global Display Name
        const displayName = member.displayName ?? '*Nickname not found!*'; // WW Server Nickname

        const attachment = new AttachmentBuilder('./images/ww_logo.png', { name: 'ww_logo.png' });
        const embed = new EmbedBuilder()
            // .setTitle('<:kyurem:1472065995089645609>')
            .setDescription(`### User Information for <@${user.id}>\n` +
                `- Discord Username (@handle): **${username}**\n` +
                `- Legacy Discord User Tag: **${userTag}**\n` +
                `-# **Deprecated:** Discord has phased out the legacy **username#1234** discriminator system. <@${user.id}> has transitioned to the new unique username format, and the legacy tag is no longer in use!\n` +
                `- Discord Global Display Name: **${globalName}**\n` +
                `- WW Server Nickname: **${displayName}**\n` +
                `- Discord User ID: **${member.id}**\n`
            )
            .setColor(0x00e4ff)
            .setThumbnail(user.displayAvatarURL())
            .setFooter({ text: 'White Walker Test', iconURL: 'attachment://ww_logo.png' })
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            files: [attachment]
        });
    }
}

module.exports = Test;
