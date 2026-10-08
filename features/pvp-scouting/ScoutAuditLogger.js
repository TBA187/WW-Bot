// Posts scout publications, officer actions and bot diagnostics to the staff log.
'use strict';

const path = require('node:path');
const { diffLines } = require('diff');
const { reviewSuggestions } = require('./ScoutFeedbackText.js');
const { AttachmentBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');

const ACTIONS = {
    edited: ['Scout Report Edited', 0x5865F2], deleted: ['Scout Report Deleted', 0xED4245],
    confirmed: ['Scout Review Approved', 0x57F287], corrected: ['Scout Review Corrected', 0x5865F2],
    not_scout: ['Scout Review Declined', 0xED4245],
    edit_accepted: ['Scout Message Edit Accepted', 0x57F287], edit_rejected: ['Scout Message Edit Declined', 0xED4245],
    attached: ['Scout Source Attached', 0x5865F2], detached: ['Scout Source Made Independent', 0x5865F2],
    source_deleted: ['Scout Source Deleted', 0xED4245], source_edited: ['Scout Source Edited', 0x5865F2],
    reply_added: ['Scout Information Added', 0x57F287]
};
const LABELS = { ign: 'Opponent IGN', rating: 'PvP rating', teamText: 'Pokémon team', notes: 'Additional notes',
    authorId: 'Reporter Discord ID', authorUsername: 'Reporter username', createdAt: 'Scout posted',
    sourceUrl: 'Discord source link', messageContent: 'Stored message text',
    attachments: 'Screenshots', reviewStatus: 'Review status', classification: 'Classification', rootMessageId: 'Scout Report ID' };

function changesBetween(before = {}, after = {}) {
    return Object.fromEntries(Object.keys(LABELS).filter(key => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
        .map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}

function display(value, max = 390) {
    if (value === null || value === undefined || value === '') return '*None*';
    const text = Array.isArray(value) ? value.map(item => item.url || item.name || item.id || String(item)).join('\n') : String(value);
    return escapeMarkdown(text.slice(0, max)).slice(0, max) + (text.length > max ? '…' : '');
}

function auditPayload(event, logoPath = path.join(__dirname, '../../images/ww_logo.png')) {
    const [title, color] = ACTIONS[event.action] || ['Scout Report Updated', 0x5865F2];
    const first = event.sources?.[0] || {};
    const before = first.before || {}, after = first.after || {};
    const ign = after.ign || before.ign || 'Not detected';
    const sourceUrl = after.sourceUrl || before.sourceUrl;
    const embed = new EmbedBuilder().setColor(color).setTitle(title)
        .setDescription(`**Officer:** <@${event.actorId}> (\`${event.actorId}\`)\n**Opponent:** ${display(ign, 64)}\n`
            + `**Scout Report ID:** \`${event.reportId}\`\n**Scout Message ID:** \`${event.messageId}\``
            + (sourceUrl ? `\n[Jump to scout message ↗️](${sourceUrl})` : ''))
        .setFooter({ text: `White Walkers • Message ID: ${event.messageId}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    const sources = event.sources || [];
    const changes = first.changes || changesBetween(before, after);
    const entries = Object.entries(changes).filter(([key]) => LABELS[key]);
    for (const [key, change] of entries.slice(0, 5)) embed.addFields({ name: LABELS[key],
        value: `**Before:** ${display(change.before)}\n**${event.action === 'edit_rejected' ? 'Proposed' : 'After'}:** ${display(change.after)}`, inline: false });
    if (event.action === 'deleted') embed.addFields({ name: 'Deleted report',
        value: `${sources.length} source(s) removed from \`/scout\`. The original Discord messages remain available.`, inline: false });
    if (sources.length > 1) embed.addFields({ name: 'Affected source IDs',
        value: sources.map(source => `\`${source.messageId}\``).join(', ').slice(0, 1024), inline: false });
    if ((!entries.length || event.action === 'edit_rejected') && event.action !== 'deleted') embed.addFields({ name: 'Decision',
        value: event.action === 'edit_rejected' ? 'The proposed changes were declined; the published report stays unchanged.'
            : 'The officer saved this review decision.', inline: false });
    const files = [new AttachmentBuilder(logoPath, { name: 'ww_logo.png' })];
    // Preserve every before/after value, even when Discord's embed limits require shortened previews.
    if (entries.length || event.action === 'deleted') files.push(new AttachmentBuilder(Buffer.from(JSON.stringify(event, null, 2)),
        { name: `scout-${event.messageId}-changes.json` }));
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
}

function publishedPayload(event, logoPath = path.join(__dirname, '../../images/ww_logo.png')) {
    const contributors = [...new Map((event.sources || []).map(source => [source.author_id,
        source.author_id ? `<@${source.author_id}>` : display(source.author_username || 'Unknown member', 80)])).values()];
    const embed = new EmbedBuilder().setColor(0x57F287).setTitle('✅ Scout Report Published')
        .setDescription(`The Scout Report for **${escapeMarkdown(event.ign)}** has been successfully validated and added to \`/scout\`.\n\n`
            + `**Scouted by:** ${contributors.slice(0, 20).join(', ') || '*Unknown member*'}`
            + (contributors.length > 20 ? ` and ${contributors.length - 20} more` : '') + '\n'
            + `**Scout Report ID:** \`${event.reportId}\`\n**Latest Scout Message ID:** \`${event.messageId}\``
            + (event.sourceUrl ? `\n[**Jump to scout message ↗️**](${event.sourceUrl})` : ''))
        .setFooter({ text: `WW • Scout Report ID: ${event.reportId}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (event.rating != null) embed.addFields({ name: 'PvP Rating', value: String(event.rating), inline: true });
    embed.addFields({ name: 'Source messages', value: String(event.sources?.length || 1), inline: true });
    return { embeds: [embed], files: [new AttachmentBuilder(logoPath, { name: 'ww_logo.png' })],
        allowedMentions: { parse: [] }, nonce: `sp:${event.messageId}`, enforceNonce: true };
}

function scoutTextDiff(before = '', after = '') {
    return diffLines(String(before), String(after)).filter(part => part.added || part.removed)
        .map(part => part.value.replace(/\n$/u, '').split('\n')
            .map(line => `${part.removed ? '-' : '+'} ${line}`).join('\n')).join('\n');
}

function memberEditPayload(event, logoPath = path.join(__dirname, '../../images/ww_logo.png')) {
    const before = event.before || {}, after = event.after || {};
    const ignored = ['ignored', 'not_scout'].includes(after.classification) || after.reviewStatus === 'not_scout';
    const failed = Boolean(event.failed) || after.reviewStatus === 'pending';
    const status = failed ? '❌ Failed validation' : ignored ? 'Not a scout report'
        : event.awaitingApproval ? '⏳ Parsed successfully • awaiting officer approval' : '✅ Successfully validated';
    const color = failed ? 0xED4245 : ignored ? 0x95A5A6 : event.awaitingApproval ? 0xFEE75C : 0x57F287;
    const diff = scoutTextDiff(before.content, after.content);
    const preview = (diff || '(Message text unchanged; see attachment changes below.)').replace(/`/gu, 'ˋ');
    const attachmentNames = value => (value.attachments || []).map(a => `${a.id}: ${a.name || 'image'}`);
    const attachmentsChanged = JSON.stringify(attachmentNames(before)) !== JSON.stringify(attachmentNames(after));
    const confidence = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'Unavailable';
    const embed = new EmbedBuilder().setTitle('Scout Message Edited').setColor(color)
        .setDescription(`**Reporter:** ${display(event.authorUsername || after.authorUsername || 'Unknown', 128)}`
            + (event.authorId ? ` (\`${event.authorId}\`)` : '')
            + `\n**Server:** ${event.server === 'silver' ? 'Silver' : 'Gold'}\n**Status:** ${status}`
            + `\n**Scout Report ID:** \`${event.reportId}\`\n**Scout Message ID:** \`${event.messageId}\``
            + (event.sourceUrl ? `\n[Jump to scout message ↗️](${event.sourceUrl})` : ''))
        .addFields({ name: 'Message changes', value: `\`\`\`diff\n${preview.slice(0, 940)}\n\`\`\``
                + (preview.length > 940 ? '\nFull diff attached.' : ''), inline: false },
            { name: 'Opponent IGN', value: `${display(before.ign, 64)} → ${display(after.ign, 64)}`, inline: true },
            { name: 'IGN confidence', value: `${confidence(before.ignConfidence)} → ${confidence(after.ignConfidence)}`, inline: true },
            { name: 'IGN detection source', value: `${display(before.ignSource, 100)} → ${display(after.ignSource, 100)}`, inline: false })
        .setFooter({ text: `WW • Scout Report ID: ${event.reportId}`, iconURL: 'attachment://ww_logo.png' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    embed.addFields({ name: 'Validation reason', value: display(after.reviewReason || (failed
        ? 'The opponent or team could not be verified confidently.'
        : ignored ? 'This message is not recognized as a scout report.' : 'Validation passed.'), 850), inline: false });
    const suggestions = failed || event.awaitingApproval ? reviewSuggestions({ reason: after.reviewReason,
        edit: event.awaitingApproval ? { after } : null }) : [];
    embed.addFields({ name: 'Bot suggestions', value: suggestions.length
        ? suggestions.map(suggestion => `- ${suggestion}`).join('\n').slice(0, 1024)
        : ignored ? 'Submit an opponent IGN and Pokémon team details or a screenshot.' : 'No corrections needed.', inline: false });
    if (before.rating !== after.rating) embed.addFields({ name: 'PvP rating', value: `${display(before.rating)} → ${display(after.rating)}`, inline: true });
    if (attachmentsChanged) embed.addFields({ name: 'Attachments', value: `Before: ${display(attachmentNames(before), 350)}\nAfter: ${display(attachmentNames(after), 350)}`, inline: false });
    const files = [new AttachmentBuilder(logoPath, { name: 'ww_logo.png' }),
        new AttachmentBuilder(Buffer.from(JSON.stringify(event, null, 2)), { name: `scout-edit-${event.messageId}.json` })];
    if (diff.length > 940) files.push(new AttachmentBuilder(Buffer.from(diff), { name: `scout-edit-${event.messageId}.diff.txt` }));
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
}

function diagnosticPayload(event, ownerId, logoPath = path.join(__dirname, '../../images/ww_logo.png')) {
    const warning = event.level === 'warn';
    const reportId = String(event.reportId || '').trim();
    const footer = reportId && reportId !== 'N/A' ? `WW • Scout Report ID: ${reportId}`
        : `WW • ${event.component || 'Bot runtime'}`;
    const embed = new EmbedBuilder().setColor(warning ? 0xFEE75C : 0xED4245)
        .setTitle(warning ? '⚠️ Bot Warning' : '❌ Bot Error')
        .setDescription(event.message.slice(0, 3500) || 'No error details were available.')
        .setFooter({ text: footer.slice(0, 256), iconURL: 'attachment://ww_logo.png' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (event.component) embed.addFields({ name: 'Component', value: escapeMarkdown(event.component).slice(0, 256), inline: true });
    if (event.code) embed.addFields({ name: 'Error code', value: escapeMarkdown(String(event.code)).slice(0, 128), inline: true });
    if (event.messageId) embed.addFields({ name: 'Scout Message ID', value: `\`${event.messageId}\``, inline: true });
    if (event.repeats) embed.addFields({ name: 'Repeated occurrences', value: `${event.repeats} matching alert(s) were suppressed since the previous notification.`, inline: false });
    return { content: ownerId ? `<@${ownerId}>` : undefined, embeds: [embed],
        files: [new AttachmentBuilder(logoPath, { name: 'ww_logo.png' })],
        allowedMentions: { parse: [], users: ownerId ? [String(ownerId)] : [] } };
}

class ScoutAuditLogger {
    constructor({ client, guildId, channelId, ownerId, logoPath } = {}) {
        this.client = client; this.guildId = String(guildId || ''); this.channelId = String(channelId || '');
        this.logoPath = logoPath; this.pending = Promise.resolve();
        this.ownerId = String(ownerId || '');
    }

    published(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        this.queuePayload(() => publishedPayload(saved, this.logoPath), `scout publication log for ${saved.messageId}`);
    }

    memberEdited(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        this.queuePayload(() => memberEditPayload(saved, this.logoPath), `scout member edit log for ${saved.messageId}`);
    }

    diagnostic(event) {
        if (!this.channelId) return;
        const saved = structuredClone(event);
        this.queuePayload(() => diagnosticPayload(saved, this.ownerId, this.logoPath), 'bot diagnostic log');
    }

    queuePayload(build, label) {
        this.pending = this.pending.then(async () => {
            const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
            if (!channel?.send || channel.guildId !== this.guildId) throw new Error('Scout log channel is unavailable in this server.');
            await channel.send(build());
        }).catch(error => console.warn(`[WW LOG] Could not send ${label}: ${error.message}`));
    }

    enqueue(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        // Only new committed user actions enter this queue. Startup never replays old review history.
        this.pending = this.pending.then(async () => {
            const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
            if (!channel?.send || channel.guildId !== this.guildId) throw new Error('Scout log channel is unavailable in this server.');
            await channel.send(auditPayload(saved, this.logoPath));
        }).catch(error => console.warn(`[WW LOG] Could not send scout action log for ${saved.messageId}: ${error.message}. The saved change history is intact.`));
    }

    flush() { return this.pending; }
}

module.exports = { ScoutAuditLogger, auditPayload, changesBetween, diagnosticPayload, publishedPayload, memberEditPayload, scoutTextDiff };
