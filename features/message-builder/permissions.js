'use strict';

function hasAllowedRole(member, allowedRoles) {
    const includes = id => allowedRoles instanceof Set ? allowedRoles.has(id) : allowedRoles.includes(id);
    const roles = member?.roles;
    if (roles?.cache?.some) return roles.cache.some(role => includes(role.id));
    if (Array.isArray(roles)) return roles.some(role => includes(typeof role === 'string' ? role : role.id));
    return false;
}

function currentMember(interaction) {
    return interaction.guild?.members?.cache?.get(interaction.user.id) || interaction.member;
}

module.exports = { hasAllowedRole, currentMember };
