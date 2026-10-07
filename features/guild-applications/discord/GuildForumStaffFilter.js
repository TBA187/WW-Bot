'use strict';

// Match only current Leaders, Admins, and Officers, using one name per member.
function normalizedName(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function selectedMemberName(member) {
    return String(member.nickname || '').trim()
        || String(member.user?.globalName || '').trim()
        || String(member.user?.username || '').trim();
}

function nameContainsIgn(displayName, forumIgn) {
    const ign = normalizedName(forumIgn);
    if (!ign) return false;
    const name = normalizedName(displayName);
    const ignCharacter = /[\p{L}\p{N}_]/u;
    let index = -1;
    // Delimited aliases match; a different IGN such as VangogsanFan does not.
    while ((index = name.indexOf(ign, index + 1)) !== -1) {
        const before = [...name.slice(0, index)].at(-1);
        const after = [...name.slice(index + ign.length)][0];
        if ((!before || !ignCharacter.test(before)) && (!after || !ignCharacter.test(after))) return true;
    }
    return false;
}

class GuildForumStaffFilter {
    constructor({ client, config = {} } = {}) {
        this.client = client;
        this.guildId = config.guildId;
        this.roleIds = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean);
        this.lookup = null;
    }

    beginScan() {
        this.lookup = null;
    }

    async loadStaff() {
        if (!this.guildId || this.roleIds.length !== 3) throw new Error('Guild Application staff roles are not configured.');
        const guild = this.client.guilds.cache.get(this.guildId) || await this.client.guilds.fetch(this.guildId);
        if (!guild?.members?.list) throw new Error('Guild Application staff members are unavailable.');
        const staff = [];
        let after;
        // REST pagination includes uncached members without gateway member-search requests.
        while (true) {
            const members = await guild.members.list({ limit: 1000, after, cache: false });
            for (const member of members.values()) {
                if (!member.user?.bot && this.roleIds.some(role => member.roles?.cache?.has(role))) {
                    staff.push({ id: member.id, name: selectedMemberName(member) });
                }
            }
            if (members.size < 1000) return staff;
            const next = members.lastKey();
            if (!next || next === after) throw new Error('Guild Application staff pagination did not advance.');
            after = next;
        }
    }

    async matchAuthor(forumIgn) {
        if (!normalizedName(forumIgn)) return null;
        // Fetch lazily once per scan, only when a new or pending post needs matching.
        if (!this.lookup) this.lookup = this.loadStaff();
        return (await this.lookup).find(member => nameContainsIgn(member.name, forumIgn)) || null;
    }
}

module.exports = { GuildForumStaffFilter, nameContainsIgn, selectedMemberName };
