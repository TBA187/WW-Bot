'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { GuildForumStaffFilter, nameContainsIgn, selectedMemberName } = require('../features/guild-applications/discord/GuildForumStaffFilter.js');

function member(id, nickname, role, globalName = null, username = 'OtherName') {
    return { id, nickname, user: { username, globalName }, roles: { cache: new Collection(role ? [[role, {}]] : []) } };
}
function fixture(members) {
    const calls = [];
    const guild = { members: { async list(options) {
        calls.push(options);
        const start = options.after ? members.findIndex(m => m.id === options.after) + 1 : 0;
        return new Collection(members.slice(start, start + options.limit).map(m => [m.id, m]));
    } } };
    const filter = new GuildForumStaffFilter({ client: { guilds: { cache: new Collection([['guild', guild]]) } },
        config: { guildId: 'guild', leaderRoleID: 'leader', adminRoleID: 'admin', officerRoleID: 'officer' } });
    return { filter, calls };
}

test('staff matching accepts IGN aliases, case, decorations, and literal punctuation without matching another IGN', () => {
    for (const [name, ign] of [['Vangogsan / Am1damaru', 'vANGOgsan'], ['Vangogsan / Am1damaru', 'Am1damaru'],
        ['★ Player42 ★', 'Player42'], ['Name (A.b)', 'A.b'], ['Name / A[1]', 'A[1]']]) {
        assert.equal(nameContainsIgn(name, ign), true, name);
    }
    for (const [name, ign] of [['VangogsanFan', 'Vangogsan'], ['NotVangogsan', 'Vangogsan'], ['Axby', 'A.b'],
        ['Vangogsan_alt', 'Vangogsan'], ['Player', ''], ['Other', 'Player']]) {
        assert.equal(nameContainsIgn(name, ign), false, name);
    }
});

test('each member uses nickname, then global display name, then username only when higher names are absent', async () => {
    const members = [member('1', 'DifferentNickname', 'officer', 'ForumIgn', 'ForumIgn'),
        member('2', null, 'admin', 'GlobalIgn / Alt', 'UsernameIgn'), member('3', '', 'leader', null, 'UsernameIgn')];
    const { filter } = fixture(members);
    assert.equal(selectedMemberName(members[0]), 'DifferentNickname');
    assert.equal(await filter.matchAuthor('ForumIgn'), null);
    assert.equal((await filter.matchAuthor('GlobalIgn')).id, '2');
    assert.equal((await filter.matchAuthor('UsernameIgn')).id, '3');
    assert.equal((await filter.matchAuthor('DifferentNickname')).id, '1');
});

test('only members with one of the configured three roles suppress a forum author', async () => {
    const { filter } = fixture([member('1', 'LeaderIgn / Alt', 'leader'), member('2', 'AdminIgn', 'admin'),
        member('3', 'OfficerIgn', 'officer'), member('4', 'MemberIgn', 'member'), member('5', 'OwnerIgn', 'owner')]);
    for (const name of ['LeaderIgn', 'AdminIgn', 'OfficerIgn']) assert.ok(await filter.matchAuthor(name));
    for (const name of ['MemberIgn', 'OwnerIgn', 'UnmatchedIgn']) assert.equal(await filter.matchAuthor(name), null);
});

test('one lazy REST snapshot serves the entire scan and refreshes role/name changes on the next scan', async () => {
    const members = [member('1', 'Vangogsan / Am1damaru', 'leader')];
    const { filter, calls } = fixture(members);
    assert.equal(calls.length, 0);
    await Promise.all([filter.matchAuthor('Vangogsan'), filter.matchAuthor('Am1damaru'), filter.matchAuthor('Other')]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cache, false);
    members[0].roles.cache.clear();
    filter.beginScan();
    assert.equal(await filter.matchAuthor('Vangogsan'), null);
    assert.equal(calls.length, 2);
});

test('REST pagination includes staff beyond the first thousand members', async () => {
    const members = Array.from({ length: 1000 }, (_, n) => member(String(n + 1), `Player${n}`, 'member'));
    members.push(member('1001', 'LateOfficer', 'officer'));
    const { filter, calls } = fixture(members);
    assert.equal((await filter.matchAuthor('LateOfficer')).id, '1001');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].after, '1000');
});

test('a failed staff lookup can retry on the next scan', async () => {
    const { filter } = fixture([member('1', 'StaffIgn', 'officer')]);
    const list = filter.client.guilds.cache.get('guild').members.list;
    filter.client.guilds.cache.get('guild').members.list = async () => { throw new Error('Discord unavailable'); };
    await assert.rejects(filter.matchAuthor('StaffIgn'), /Discord unavailable/);
    filter.client.guilds.cache.get('guild').members.list = list;
    filter.beginScan();
    assert.ok(await filter.matchAuthor('StaffIgn'));
});
