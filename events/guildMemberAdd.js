// -----------------------------------------
// Auto Send Welcome Message to new members
// -----------------------------------------

const { AttachmentBuilder } = require('discord.js');

module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member, config) {
        try {
            const channel = member.guild.channels.cache.get(config.welcomeChannelID);
            if (!channel || !channel.isTextBased()) return;

            const total = member.guild.memberCount;
            const file = new AttachmentBuilder('./images/ww.png');

            await channel.send({
                content: `## Hello <@${member.id}>! Welcome to White Walkers! <:kyurem:1472065995089645609>\n` +
                    `### 📜  Have a look at the Guild Rules: <#1246059221280096357>\n` +
                    `### 📌  Familiarize yourself with our Discord channels and roles here: <#1454633218094530700>\n` +
                    `### Enjoy your stay and feel free to ask any questions in <#1301600985655017566>! 👑\n` +
                    `-# **<:kyurem:1472065995089645609> White Walkers** Discord Server has **${total}** members!\n` +
                    `_ _`,
                files: [file]
            });
        } catch (err) {
            console.error('Welcome message failed:', err);
        }
    }
}
