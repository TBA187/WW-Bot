// Derive conservative, reusable evidence from officer review decisions.
'use strict';

function normalizeIgn(value) {
    const ign = String(value || '').trim()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_.-]+$/gu, '').replace(/-+$/u, '');
    return ign ? ign.toLocaleLowerCase('en-US') : null;
}

function reviewedTextKey(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US')
        .replace(/\s+/gu, ' ');
}

function reviewPatternKey(source, hasImage, layout) {
    return `${String(source || 'none')}|${hasImage ? 'image' : 'text'}|${String(layout || 'none')}`;
}

function buildReviewLearning(events, { channelId = null } = {}) {
    const aliases = new Map();
    const exactOutcomes = new Map();
    const sourceStats = new Map();
    const histories = new Map();
    // The store returns newest events first. Event IDs also allow callers to
    // supply another order without reviving a superseded officer decision.
    const ordered = [...events].sort((left, right) => {
        if (!left.event_id || !right.event_id) return 0;
        const a = BigInt(left.event_id), b = BigInt(right.event_id);
        return a === b ? 0 : a > b ? -1 : 1;
    });
    for (const event of ordered) {
        let before, after;
        try {
            before = typeof event.before_json === 'string' ? JSON.parse(event.before_json) : event.before_json;
            after = typeof event.after_json === 'string' ? JSON.parse(event.after_json) : event.after_json;
        } catch { continue; }
        if (!before || !after) continue;
        const id = String(event.message_id || before.messageId || '');
        if (!histories.has(id)) histories.set(id, []);
        histories.get(id).push({ event, before, after });
    }
    const sourceVersion = value => JSON.stringify([
        reviewedTextKey(value.messageContent),
        (value.attachments || []).map(item => String(item.id || item.name || ''))
    ]);
    for (const history of histories.values()) {
        // Administrative deletion is never a parser rejection, even if a
        // later maintenance event forgot to carry the hidden marker forward.
        if (history.some(item => item.after.staffOverrides?.hidden)) continue;
        const decisions = history.filter(item => !item.after.managementAction);
        if (!decisions.length) continue;
        const latest = decisions[0];
        const { event, after } = latest;
        const action = String(event.action || '');
        // Reopening is saved as a corrected event in the existing schema.
        // Pending decisions must cancel earlier approvals as reusable evidence.
        if (after.staffOverrides?.hidden || after.reviewStatus === 'pending'
            || !['confirmed', 'corrected', 'not_scout'].includes(action)) continue;
        const relevant = decisions.filter(item => sourceVersion(item.before) === sourceVersion(latest.before));
        const before = relevant.at(-1).before;
        const hasImage = (before.attachments || []).some(item =>
            String(item.contentType || '').startsWith('image/')
            || /\.(?:png|jpe?g|webp|gif)$/iu.test(String(item.name || '')));
        const source = reviewPatternKey(before.ignSource, hasImage, before.teamLayoutStatus);
        if (!sourceStats.has(source)) sourceStats.set(source, { confirmed: 0, changedIgn: 0, rejected: 0 });
        const stats = sourceStats.get(source);
        if (action === 'not_scout') stats.rejected++;
        else if (normalizeIgn(before.ign) === normalizeIgn(after.ign)) {
            stats.confirmed++;
        } else stats.changedIgn++;

        const textKey = reviewedTextKey(before.messageContent);
        // Formats and spelling evidence are shared, while exact text outcomes
        // stay with their archive so another server cannot inherit a team edit.
        if (textKey.length >= 4 && !(before.attachments || []).length
            && (!channelId || String(event.channel_id || '') === String(channelId))) {
            if (!exactOutcomes.has(textKey)) exactOutcomes.set(textKey, []);
            exactOutcomes.get(textKey).push({ action: action !== 'not_scout'
                && relevant.some(item => item.event.action === 'corrected') ? 'corrected' : action, after });
        }
        if (action === 'not_scout' || !normalizeIgn(after.ign)
            || !relevant.some(item => item.event.action === 'corrected')) continue;
        // All earlier readings can point toward the final confirmed name;
        // the inverse alias from a mistaken correction must never survive.
        const wrongReads = new Set(relevant.flatMap(item => [item.before.ign,
            ...(item.before.ocrResults || []).filter(read => Number(read.focusedConfidence || 0) >= 0.75)
                .map(read => read.focusedIgn)]).map(normalizeIgn).filter(Boolean));
        for (const wrong of wrongReads) {
            if (wrong === normalizeIgn(after.ign)) continue;
            if (!aliases.has(wrong)) aliases.set(wrong, new Map());
            const targets = aliases.get(wrong);
            const target = normalizeIgn(after.ign);
            if (!targets.has(target)) targets.set(target,
                { to: after.ign, messageIds: new Set(), reviewerIds: new Set() });
            targets.get(target).messageIds.add(String(event.message_id));
            targets.get(target).reviewerIds.add(String(event.reviewer_id));
        }
    }
    const exactCorrections = new Map();
    const rejectedText = new Set();
    for (const [key, outcomes] of exactOutcomes) {
        if (outcomes.some(item => item.action === 'not_scout')
            && outcomes.every(item => item.action === 'not_scout')) rejectedText.add(key);
        const fields = value => JSON.stringify([
            normalizeIgn(value.ign), value.rating, value.teamText, value.notes
        ]);
        const name = normalizeIgn(outcomes[0].after.ign);
        const firstWord = normalizeIgn(key.split(/\s/u)[0].replace(/[:;]+$/u, ''));
        const explicitlyNamed = name && (firstWord === name
            || new RegExp(`^(?:ign|opponent)\\s*[:=]\\s*${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s|$)`, 'iu').test(key));
        if (explicitlyNamed && outcomes.every(item => item.action === 'corrected'
            && fields(item.after) === fields(outcomes[0].after))) {
            exactCorrections.set(key, outcomes[0].after);
        }
    }
    return {
        aliases: new Map([...aliases].map(([key, targets]) => [key, [...targets.values()].map(item => ({
            to: item.to, reports: item.messageIds.size, reviewers: item.reviewerIds.size
        }))])),
        exactCorrections, rejectedText, sourceStats
    };
}

module.exports = { buildReviewLearning, reviewedTextKey, reviewPatternKey };
