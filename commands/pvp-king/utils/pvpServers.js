// Routes PvP King commands to their server's storage, roles and channels.
const { SERVERS } = require('../../../features/pvp-scouting/ScoutServerSettings.js');
const { requirePvpChannel } = require('./pvpHelper.js');

function getPvpServerConfigs(config) {
    const gold = {
        ...config,
        pvpServer: 'gold',
        pvpKingStorage: config.pvpKingStores?.gold || config.pvpKingStorage,
        challengeTimeouts: config.pvpChallengeTimeouts?.gold || config.challengeTimeouts || new Map()
    };
    const servers = [gold];

    if (config.pvpKingSilverChannelID) {
        const silverStorage = config.pvpKingStores?.silver;
        if (!silverStorage) throw new Error('Silver PvP King storage is not configured.');
        if (silverStorage === gold.pvpKingStorage) throw new Error('Gold and Silver PvP King stores must be separate.');
        if (!config.pvpKingSilverRoleID || !config.historySilverThreadID) {
            throw new Error('Silver PvP King role and history thread must be configured.');
        }
        if (config.pvpKingSilverChannelID === config.pvpKingChannelID
            || config.pvpKingSilverRoleID === config.pvpKingRoleID
            || config.historySilverThreadID === config.historyThreadID) {
            throw new Error('Gold and Silver PvP King channels, roles, and history threads must be separate.');
        }
        servers.push({
            ...config,
            pvpServer: 'silver',
            pvpKingStorage: silverStorage,
            pvpKingChannelID: config.pvpKingSilverChannelID,
            pvpKingRoleID: config.pvpKingSilverRoleID,
            historyThreadID: config.historySilverThreadID,
            challengeTimeouts: config.pvpChallengeTimeouts?.silver || new Map()
        });
    }

    return servers.map(server => ({
        ...server,
        pvpServerName: SERVERS[server.pvpServer].label,
        pvpServerEmoji: SERVERS[server.pvpServer].markup,
        pvpServerColor: server.pvpServer === 'silver' ? 0xc0c0c0 : 0xffd700,
        onCooldown: config.onCooldown
            ? (userId, command, seconds) => config.onCooldown(userId, `${server.pvpServer}:${command}`, seconds)
            : undefined
    }));
}

// Separate command instances keep collectors, database access, roles, and
// confirmation timers bound to their originating server for the entire session.
function wrapPvpServerCommand(Command) {
    return class PvpServerCommand {
        constructor(config) {
            const configs = getPvpServerConfigs(config);
            this.commands = new Map(configs.map(server => [server.pvpKingChannelID, new Command(server)]));
            this.channelIds = configs.map(server => server.pvpKingChannelID).filter(Boolean);
            const gold = this.commands.get(config.pvpKingChannelID);
            this.name = gold.name;
            this.data = gold.data;

            if (typeof Command.prototype.handleButton === 'function') {
                this.handleButton = async interaction => {
                    if (!/^pvp_(?:confirm_(?:yes|no)_|accept_|decline_)/u.test(interaction.customId || '')) return false;
                    const command = await this.commandFor(interaction);
                    if (command) await command.handleButton(interaction);
                    return true;
                };
            }
        }

        async commandFor(interaction) {
            if (!await requirePvpChannel(interaction, this.channelIds, this.name)) return null;
            return this.commands.get(interaction.channelId);
        }

        async execute(interaction) {
            // Route valid commands synchronously so they can acknowledge in the same turn.
            const command = this.commands.get(interaction.channelId);
            if (command && this.channelIds.includes(interaction.channelId)) return command.execute(interaction);
            await requirePvpChannel(interaction, this.channelIds, this.name);
        }
    };
}

module.exports = { getPvpServerConfigs, wrapPvpServerCommand };
