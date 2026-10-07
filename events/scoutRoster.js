// Reconciles scout identity lists at startup and tracks member role/profile changes.
'use strict';

const { Events } = require('discord.js');
const { abortable } = require('../utils/abortable.js');

module.exports = {
    register(client, config) {
        const store = config.scoutRosterStore;
        const guildId = String(config.guildId || '');
        const roleId = String(config.guildMemberRoleID || '');
        if (!store || !guildId || !roleId) return;
        const signal = config.shutdownSignal;
        let retry;
        const stopped = () => signal?.aborted;
        signal?.addEventListener('abort', () => clearTimeout(retry), { once: true });

        const initializeRoster = async () => {
            if (stopped()) return;
            try {
                const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
                if (stopped()) return;
                const result = await abortable(store.seedCurrentGuildMembers(guild, roleId), { signal });
                const changes = [
                    result.added && `${result.added} added`,
                    result.restored && `${result.restored} restored`,
                    result.former && `${result.former} marked former`,
                    result.updated && `${result.updated} profile(s) updated`
                ].filter(Boolean);
                if (changes.length) {
                    console.log(`[WW LOG] Scout member list ${result.alreadySeeded ? 'reconciled' : 'initialized'}; ${changes.join(', ')}.`);
                }
            } catch (error) {
                if (stopped()) return;
                console.error('[WW LOG] Could not initialize scout member list:', error);
                retry = setTimeout(initializeRoster, 60_000);
                retry.unref?.();
            }
        };
        client.once(Events.ClientReady, initializeRoster);

        client.on('guildMemberUpdate', async (oldMember, newMember) => {
            if (stopped()) return;
            if (String(newMember?.guild?.id || '') !== guildId) return;
            try {
                await store.handleMemberUpdate(oldMember, newMember, guildId, roleId);
            } catch (error) {
                if (stopped()) return;
                console.error(`[WW LOG] Could not update scout member ${newMember.id}:`, error);
            }
        });

        client.on('guildMemberAdd', async member => {
            if (stopped()) return;
            if (String(member?.guild?.id || '') !== guildId) return;
            try {
                await store.handleMemberAdd(member, guildId, roleId);
            } catch (error) {
                if (stopped()) return;
                console.error(`[WW LOG] Could not update scout member ${member.id}:`, error);
            }
        });

        client.on('guildMemberRemove', async member => {
            if (stopped()) return;
            if (String(member?.guild?.id || '') !== guildId) return;
            try {
                await store.handleMemberRemove(member, guildId);
            } catch (error) {
                if (stopped()) return;
                console.error(`[WW LOG] Could not mark scout member ${member.id} as former:`, error);
            }
        });
    }
};
