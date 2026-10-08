/**
 * @fileoverview Build startup command counts and lists from registered Discord definitions and prefix metadata.
 * Exclude internal routing aliases while listing executable slash, context-menu and prefix commands.
 */
'use strict';

const { ApplicationCommandType, ApplicationCommandOptionType } = require('discord.js');

function validName(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function subcommandPaths(options, parent) {
    return (options || []).flatMap(option => {
        const name = validName(option.name);
        if (!name) return [];
        const path = parent + ' ' + name;
        if (option.type === ApplicationCommandOptionType.Subcommand) return [path];
        if (option.type === ApplicationCommandOptionType.SubcommandGroup) return subcommandPaths(option.options, path);
        return [];
    });
}

function countLabel(count, singular) {
    return count + ' ' + singular + (count === 1 ? '' : 's');
}

function buildCommandSummary(applicationCommands, prefixDefinitions = []) {
    const standalone = [], groups = [], messageMenus = [], userMenus = [], other = [];
    const seen = new Set();
    for (const command of applicationCommands) {
        const name = validName(command.name);
        if (!name) continue;
        const type = command.type ?? ApplicationCommandType.ChatInput;
        const key = type + ':' + name;
        if (seen.has(key)) continue;
        seen.add(key);
        if (type === ApplicationCommandType.ChatInput) {
            const grouped = (command.options || []).some(option =>
                option.type === ApplicationCommandOptionType.Subcommand
                || option.type === ApplicationCommandOptionType.SubcommandGroup);
            if (grouped) groups.push({ name, commands: subcommandPaths(command.options, name) });
            else standalone.push(name);
        } else if (type === ApplicationCommandType.Message) messageMenus.push(name);
        else if (type === ApplicationCommandType.User) userMenus.push(name);
        else other.push(name);
    }

    // Multiple prefixes are invocation forms of one command and count only once.
    const prefixByName = new Map();
    for (const definition of prefixDefinitions) {
        const name = validName(definition.name);
        if (!name) continue;
        const entry = prefixByName.get(name) || { name, invocations: new Set() };
        for (const prefix of definition.prefixes || []) {
            if (typeof prefix === 'string' && prefix) entry.invocations.add(prefix + name);
        }
        if (entry.invocations.size) prefixByName.set(name, entry);
    }
    const prefixes = [...prefixByName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const sortNames = names => names.sort((a, b) => a.localeCompare(b, 'en'));
    sortNames(standalone); sortNames(messageMenus); sortNames(userMenus); sortNames(other);
    groups.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const group of groups) sortNames(group.commands);

    const counts = {
        standaloneSlash: standalone.length,
        subcommands: groups.reduce((total, group) => total + group.commands.length, 0),
        contextMenus: messageMenus.length + userMenus.length,
        prefixCommands: prefixes.length,
        otherApplicationCommands: other.length
    };
    counts.total = counts.standaloneSlash + counts.subcommands + counts.contextMenus
        + counts.prefixCommands + counts.otherApplicationCommands;
    const lines = ['Loaded ' + countLabel(counts.total, 'command') + ':'];
    const section = (label, names) => {
        if (names.length) lines.push(' - ' + label + ' (' + names.length + '): ' + names.join(', '));
    };
    section('Standalone slash commands', standalone);
    if (groups.length) {
        lines.push(' - Slash-command groups (' + countLabel(groups.length, 'group') + ', '
            + countLabel(counts.subcommands, 'subcommand') + '): '
            + groups.map(group => group.name + ': '
                + group.commands.map(command => command.slice(group.name.length + 1)).join(', ')).join(' — '));
    }
    section('Message context-menu commands', messageMenus);
    section('User context-menu commands', userMenus);
    section('Prefix commands', prefixes.map(command => command.name + ' ('
        + [...command.invocations].join(' / ') + ')'));
    section('Other application commands', other);
    return { counts, lines };
}

module.exports = { buildCommandSummary };
