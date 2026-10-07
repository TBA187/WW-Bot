const path = require('path');
const { AttachmentBuilder } = require('discord.js');

const getServerLogo = () => {
    return new AttachmentBuilder(
        path.resolve('images/ww_logo.png'),
        { name: 'serverLogo.png' }
    );
};

const getServerBanner = () => {
    return new AttachmentBuilder(
        path.resolve('images/ww.png'),
        { name: 'serverBanner.png' }
    );
};

const pvpThumnbnail = 'attachment://serverLogo.png';

const pvpBannerImage = 'attachment://serverBanner.png';

const createPvpFooter = serverName => ({
    text: `WW PvP King Dominion${serverName ? ` • ${serverName}` : ''}`,
    iconURL: 'attachment://serverLogo.png'
    // text: `WW PvP King System • WW`,
    // iconURL: interaction.guild.iconURL()
});

const createPvpLogFooter = serverName => ({
    text: `WW PvP King Logs${serverName ? ` • ${serverName}` : ''}`,
    iconURL: 'attachment://serverLogo.png'
});

module.exports = {
    getServerLogo,
    getServerBanner,
    pvpThumnbnail,
    pvpBannerImage,
    createPvpFooter,
    createPvpLogFooter
};
