// Share paginated guild member loads while keeping caller cancellation independent.
'use strict';

const { Collection } = require('discord.js');
const { abortable, throwIfAborted } = require('./abortable.js');

const pendingRosters = new WeakMap();
const PAGE_SIZE = 1000;

async function listCompleteRoster(guild, signal) {
    const members = new Collection();
    let after;
    while (true) {
        throwIfAborted(signal);
        // REST uses discord.js's HTTP rate-limit queue, avoiding gateway opcode 8.
        const page = await guild.members.list({ limit: PAGE_SIZE, after, cache: true });
        throwIfAborted(signal);
        for (const [id, member] of page) {
            members.set(id, member);
        }
        if (page.size < PAGE_SIZE) return members;
        let next = 0n;
        for (const id of page.keys()) {
            if (!/^\d+$/u.test(id)) throw new Error('The guild member list contains an invalid pagination ID.');
            if (BigInt(id) > next) next = BigInt(id);
        }
        if (next <= BigInt(after ?? '0')) {
            throw new Error('The full guild member list could not be loaded: pagination did not advance.');
        }
        after = next.toString();
    }
}

async function fetchGuildMemberRoster(guild, { signal } = {}) {
    throwIfAborted(signal);
    let request = pendingRosters.get(guild);
    if (!request) {
        request = { controller: new AbortController(), consumers: 0 };
        request.promise = Promise.resolve().then(() => listCompleteRoster(guild, request.controller.signal))
            .finally(() => {
                if (pendingRosters.get(guild) === request) pendingRosters.delete(guild);
            });
        pendingRosters.set(guild, request);
    }
    request.consumers++;
    // One cancelled caller must not interrupt another feature's member load.
    return abortable(request.promise, { signal }).finally(() => {
        if (--request.consumers === 0) {
            request.controller.abort();
            if (pendingRosters.get(guild) === request) pendingRosters.delete(guild);
        }
    });
}

module.exports = { fetchGuildMemberRoster };
