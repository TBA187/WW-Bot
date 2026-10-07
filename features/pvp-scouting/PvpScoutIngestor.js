// Archives scouting messages and OCR, then groups replies and short follow-up runs together.
'use strict';

const { PvpScoutOcr, SCAN_VERSION } = require('./PvpScoutOcr.js');
const { extractScoutData, candidateFromText, cleanIgn, isClearlySpamTeam, normalizeIgn, hasImageEvidence, isClearlyOffTopicText } = require('./PvpScoutParser.js');
const { hasKnownTeamDetail, isPokemonDetailNote, matchKnownTermHeading, matchSpeciesHeading,
    reportContextSpecies, resolveNoteShorthand, splitScoutText } = require('./PokemonTeamParser.js');
const { setImmediate: yieldToEvents } = require('node:timers/promises');
const { ScoutMessageFeedback } = require('./ScoutMessageFeedback.js');

const BACKFILL_PAGE_SIZE = 100;
const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000;
const IMMEDIATE_FOLLOW_UP_WINDOW_MS = 2 * 60 * 1000;
const EDIT_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function submittedScoutEmbed(message, botId) {
    if (!botId || String(message.author?.id) !== String(botId)) return null;
    return message.embeds?.find(embed => String(embed.title || '').startsWith('PvP Scout Report — ')
        && /^https:\/\/discord\.com\/users\/\d+$/u.test(embed.author?.url || '')) || null;
}

function canArchiveMessage(message, botId) {
    return !(message?.author?.bot || message?.webhookId || botId && String(message?.author?.id) === String(botId))
        || Boolean(submittedScoutEmbed(message, botId));
}

function teamSpecies(row, contextual = false, contextSpecies = []) {
    const team = row?.team_text || row?.teamText
        || contextual && splitScoutText(row?.message_content, null, { allowContextualDetails: true, contextSpecies }).teamText;
    return new Set(String(team || '').split(/\n/u)
        .map(line => matchSpeciesHeading(line.replace(/^\s*[-•]\s*/u, ''))?.species)
        .filter(Boolean));
}

function attachmentIsImage(attachment = {}) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const name = String(attachment.name || attachment.url || '').toLowerCase();
    return contentType.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(name);
}

function attachmentRecord(attachment) {
    return {
        id: String(attachment.id || ''),
        name: String(attachment.name || ''),
        url: String(attachment.url || ''),
        proxyURL: String(attachment.proxyURL || ''),
        contentType: attachment.contentType || null,
        size: Number(attachment.size || 0),
        width: attachment.width || null,
        height: attachment.height || null
    };
}

function discordSourceUrl(message) {
    if (message.url) return String(message.url);
    const guildId = message.guildId || message.guild?.id || '@me';
    return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
}

function messageTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function rowHasScoutEvidence(row, contextual = false, contextSpecies = []) {
    if (!row || row.is_deleted || row.review_status === 'not_scout'
        || row.ign_source === 'multiple_opponents'
        || row.ign_source === 'member_submission' && row.review_status === 'pending') return false;
    if (hasImageEvidence(row.attachments)) return true;
    const text = String(row.message_content || '');
    if (isClearlyOffTopicText(text)) return false;
    if (['scout', 'review'].includes(row.classification)) return true;
    const heading = (contextual ? resolveNoteShorthand(text, contextSpecies) : text).trim().replace(/^[-*•]\s*/u, '');
    const pokemon = matchSpeciesHeading(heading, {
        allowBroadAlias: true, allowTypo: contextual && hasKnownTeamDetail(heading, { allowTypo: true })
    });
    const observation = contextual && /^(?:he|it|the\s+opponent)\s+(?:has|had|got|holds|used|uses|runs)\b/iu.test(heading)
        && hasKnownTeamDetail(heading, { allowTypo: true });
    if (!pokemon?.species && !observation
        && !matchKnownTermHeading(heading) && !/^z[- ]?moves?\b/iu.test(heading)) return false;
    // A nameless move/item fragment can belong to an established scout.
    // Merely mentioning a Pokémon in conversation is insufficient.
    const team = teamSpecies(row, contextual, contextSpecies);
    const parsedDetails = String(row.team_text || row.teamText || '');
    // "Kommo-o z" is an item/move note, including in older archived rows.
    const zMove = pokemon?.species && /^[\s:(=-]*z[\s).!?]*$/iu.test(heading.slice(pokemon.end));
    return team.size > 0 && (zMove || contextual && isPokemonDetailNote(heading)
        || hasKnownTeamDetail(heading, { allowTypo: true }) || /[:=()]/u.test(text)
        || /\((?:Item|Ability|Nature|Other):|:\s*\S/iu.test(parsedDetails));
}

function mayJoinReport(row, root, previous, explicitReply, windowMs = FOLLOW_UP_WINDOW_MS) {
    if (row?.channel_id && root?.channel_id && String(row.channel_id) !== String(root.channel_id)) return false;
    if (row?.server && root?.server && row.server !== root.server) return false;
    const sameAuthor = Boolean(row?.author_id && root?.author_id
        && String(row.author_id) === String(root.author_id));
    const continuingReply = !explicitReply && previous?.message_id !== root?.message_id
        && row?.author_id && String(row.author_id) === String(previous?.author_id || '');
    const contextual = (sameAuthor || continuingReply || explicitReply) && ['scout', 'review'].includes(root?.classification);
    const contextSpecies = contextual ? reportContextSpecies(root) : [];
    if (!rowHasScoutEvidence(row, contextual, contextSpecies) || !rowHasScoutEvidence(root)) return false;
    const name = String(row.ign_normalized || '').toLowerCase();
    const rootName = String(root.ign_normalized || '').toLowerCase();
    if (name && rootName && name !== rootName) return false;
    if (!sameAuthor && explicitReply) return true;
    if (!sameAuthor && !continuingReply) return false;
    const elapsed = messageTimestamp(row.created_at) - messageTimestamp(previous?.created_at || root.created_at);
    if (elapsed < 0 || elapsed > windowMs) return false;
    const species = teamSpecies(row, contextual, contextSpecies);
    const rootSpecies = root.species || teamSpecies(root);
    const shared = [...species].filter(value => rootSpecies.has(value)).length;
    // An explicitly different/full team is a separate report, even for the same IGN.
    if (species.size >= 4 && rootSpecies.size >= 4 && shared < 3) return false;
    const bothImages = hasImageEvidence(row.attachments) && hasImageEvidence(root.attachments);
    if (bothImages) return Boolean(name && rootName && name === rootName || shared >= 4);
    if (explicitReply || name && rootName) return true;
    return elapsed <= IMMEDIATE_FOLLOW_UP_WINDOW_MS || shared >= 3
        || !hasImageEvidence(row.attachments) && !name && species.size > 0;
}

function groupLink(row, rootId, root) {
    const link = { messageId: String(row.message_id), rootMessageId: String(rootId) };
    if (row.classification !== 'ignored' || row.review_status !== 'not_required'
        || row.reviewed_by_id || row.staffOverrides?.locked) return link;
    const details = splitScoutText(row.message_content, null, {
        allowContextualDetails: true, contextSpecies: reportContextSpecies(root)
    });
    if (details.teamText && (details.teamText !== row.team_text || details.notes !== row.notes)) {
        link.teamDetails = { teamText: details.teamText, notes: details.notes, contentHash: row.content_hash };
    }
    return link;
}

// One state machine is shared by the pure helper and paged archive rebuilding.
function groupRows(rows, state, followUpWindowMs = FOLLOW_UP_WINDOW_MS) {
    const links = [];
    const promotions = [];
    const { roots, messageRoots } = state;
    for (const row of rows) {
        const id = String(row.message_id);
        if (row.is_deleted) {
            messageRoots.set(id, null);
            state.previous = null;
            continue;
        }
        let rootId = id;
        const manualRootId = row.staffOverrides?.rootMessageId;
        const parentRootId = row.reply_to_id && messageRoots.get(String(row.reply_to_id));
        const parentRoot = roots.get(parentRootId);
        if (manualRootId) rootId = String(manualRootId);
        else if (parentRoot && mayJoinReport(row, parentRoot, parentRoot, true, followUpWindowMs)) rootId = parentRootId;
        if (!manualRootId && rootId === id && state.previous
            && row.author_id && String(state.previous.author_id || '') === String(row.author_id)) {
            const priorRootId = messageRoots.get(String(state.previous.message_id));
            const priorRoot = roots.get(priorRootId);
            if (priorRoot && mayJoinReport(row, priorRoot, state.previous, false, followUpWindowMs)) rootId = priorRootId;
        }
        messageRoots.set(id, rootId);
        if (rootId === id) roots.set(id, { ...row, species: teamSpecies(row) });
        else {
            const root = roots.get(rootId);
            links.push(groupLink(row, rootId, root));
            if (root && !root.ign_normalized && row.ign_normalized) {
                root.ign_normalized = row.ign_normalized;
                promotions.push({ rootMessageId: rootId, sourceMessageId: id });
            }
            if (root) for (const species of teamSpecies(row, true, reportContextSpecies(root))) root.species.add(species);
        }
        state.previous = row;
    }
    return { links, promotions, messageRoots, roots };
}

function buildGroupLinks(rows, followUpWindowMs = FOLLOW_UP_WINDOW_MS) {
    return groupRows(rows, { roots: new Map(), messageRoots: new Map(), previous: null }, followUpWindowMs);
}

class PvpScoutIngestor {
    constructor(options = {}) {
        this.client = options.client;
        this.store = options.store;
        this.rosterStore = options.rosterStore || null;
        this.guildId = String(options.guildId || '');
        this.channelId = String(options.channelId || '');
        this.server = options.server === 'silver' ? 'silver' : 'gold';
        this.officerChannelId = String(options.officerChannelId || '');
        this.ocr = options.ocr || new PvpScoutOcr(options.ocrOptions);
        this.stopped = false;
        this.started = false;
        this.backfilling = false;
        this.queue = Promise.resolve();
        this.backfillPromise = null;
        this.reinspectionPromise = null;
        this.catchupPromise = null;
        this.catchupReady = false;
        this.catchupFailureRevision = 0;
        this.failureCount = 0;
        this.diagnostics = options.diagnostics || null;
        this.feedback = options.feedback || new ScoutMessageFeedback({ client: this.client, store: this.store,
            channelId: this.channelId, stopped: () => this.stopped,
            diagnostics: this.diagnostics,
            onReview: async messageId => this.notifyNewReview({ message_id: messageId }),
            onPublished: async event => { this.store.auditLogger?.published(event); } });
    }

    enqueue(task) {
        const pending = this.queue.then(task, task);
        this.queue = pending.catch(error => {
            console.error('[WW LOG] PvP scouting ingestion task failed:', error);
        });
        return pending;
    }

    enqueueMessage(message, task) {
        this.feedback.beginMessage?.(message);
        const queue = () => this.enqueue(task);
        return (this.diagnostics ? this.diagnostics.run({ component: 'Scout ingestion', messageId: message?.id }, queue) : queue())
            .finally(() => this.feedback.endMessage?.(message));
    }

    async start() {
        if (this.started) return;
        if (!this.channelId) {
            console.warn(`[WW LOG] ${this.server === 'silver' ? 'Silver' : 'Gold'} PvP scouting is disabled because ${this.server === 'silver' ? 'pvpScoutingSilverChannelID' : 'pvpScoutingGoldChannelID'} is not configured.`);
            return;
        }
        this.started = true;
        while (!this.stopped) {
            try {
                await this.store.ensureSchema();
                this.store.autocomplete('', this.channelId).catch(error => {
                    console.warn(`[WW LOG] Could not preload PvP scout autocomplete: ${error.message}`);
                });
                const state = await this.store.getBackfillState();
                this.backfilling = Number(state.backfill_complete) !== 1;
                const updatedRecords = await this.enqueue(async () => {
                    const updated = await this.store.refreshAutomaticRecords();
                    await this.rebuildGroups();
                    return updated;
                });
                await this.store.autocomplete('', this.channelId).catch(error => {
                    console.warn(`[WW LOG] Could not refresh PvP scout autocomplete: ${error.message}`);
                });
                if (updatedRecords) {
                    const pending = await this.store.pendingReviewCount();
                    console.log(`[WW LOG] PvP scout archive refreshed from saved messages: ${updatedRecords} record(s) updated; ${pending} still need review.`);
                }
                this.failureCount = 0;
                if (this.backfilling) {
                    this.backfillPromise = this.runBackfill().catch(error => {
                        console.error('[WW LOG] PvP scouting backfill stopped unexpectedly:', error);
                    });
                } else {
                    this.startCatchup();
                    // Reread screenshots saved with an older OCR version in the background.
                    this.reinspectionPromise = this.reinspectLegacyResultCards().catch(error => {
                        console.error('[WW LOG] PvP scouting result-card refresh failed:', error);
                    });
                }
                return;
            } catch (error) {
                this.failureCount++;
                const delayMs = Math.min(5000, 1000 * (2 ** Math.min(this.failureCount - 1, 3)));
                console.warn(`[WW LOG] PvP scouting storage is unavailable (${error.message}); retrying startup in ${Math.ceil(delayMs / 1000)}s.`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    async stop() {
        this.stopped = true;
        await this.backfillPromise?.catch(() => {});
        await this.reinspectionPromise?.catch(() => {});
        await this.catchupPromise?.catch(() => {});
        await this.queue.catch(() => {});
        if (this.feedback.stop) await this.feedback.stop();
        else await this.feedback.drain();
        await this.ocr.close?.();
        this.started = false;
    }

    async getChannel() {
        const channel = this.client.channels.cache.get(this.channelId)
            || await this.client.channels.fetch(this.channelId);
        if (!channel?.messages?.fetch) throw new Error(`Channel ${this.channelId} does not expose message history.`);
        return channel;
    }

    async reinspectLegacyResultCards() {
        const cards = await this.store.savedResultCardsToReinspect();
        if (!cards.length || this.stopped) {
            if (!this.stopped) console.log(`[WW LOG] ${this.server === 'silver' ? 'Silver' : 'Gold'} PvP saved-result-card reinspection COMPLETE: no archived screenshots need rereading.`);
            return;
        }

        console.log(`[WW LOG] Rechecking ${cards.length} saved PvP scouting screenshot(s) with updated OCR.`);
        const channel = await this.getChannel();
        let refreshed = 0;
        let failed = 0;
        for (const [index, row] of cards.entries()) {
            if (this.stopped) break;
            try {
                const message = await channel.messages.fetch(row.message_id);
                const saved = await this.enqueue(() => this.saveMessage(message, { regroup: true }));
                if (saved) refreshed++;
            } catch (error) {
                failed++;
                console.warn(`[WW LOG] Could not reread PvP scout message ${row.message_id}: ${error.message}`);
            }
            if ((index + 1) % 25 === 0) {
                console.log(`[WW LOG] PvP result-card refresh processed ${index + 1} of ${cards.length} saved message(s).`);
            }
        }
        if (refreshed) {
            // Finish grouping even if shutdown was requested halfway through this pass.
            await this.enqueue(() => this.rebuildGroups());
        }
        if (this.stopped) {
            console.log(`[WW LOG] PvP result-card refresh INTERRUPTED: ${refreshed} of ${cards.length} saved message(s) reread. Remaining messages may be retried on restart.`);
            return;
        }
        const remaining = await this.store.pendingReviewCount();
        console.log(`[WW LOG] PvP result-card refresh COMPLETE for this startup: ${refreshed} of ${cards.length} saved message(s) reread, ${failed} failed; ${remaining} still need human review.`);
    }

    async buildRecord(message) {
        // Keep Discord's attachment URLs as the image source; only the OCR text is saved locally.
        const attachments = [...(message.attachments?.values?.() || [])].map(attachmentRecord);
        // Reports submitted through /scout are posted by the bot with the member credited in the embed.
        const report = submittedScoutEmbed(message, this.client.user?.id);
        if (report) {
            const ign = cleanIgn(report.title.slice('PvP Scout Report — '.length));
            const field = name => report.fields?.find(item => item.name === name)?.value || '';
            const teamText = report.description || '';
            const ratingText = field('PvP Rating');
            if (ign && teamText && (!ratingText || /^\d{1,5}$/.test(ratingText))) {
                const needsOfficerReview = isClearlySpamTeam(teamText);
                return {
                    messageId: String(message.id), channelId: String(message.channelId || this.channelId),
                    server: this.server,
                    guildId: message.guildId || message.guild?.id || null,
                    authorId: report.author.url.split('/').at(-1), authorUsername: report.author.name || 'Unknown member',
                    createdAt: message.createdAt || message.createdTimestamp || new Date(), editedAt: message.editedAt || null,
                    content: [report.title, teamText, ratingText, field('Additional Notes')].filter(Boolean).join('\n'),
                    sourceUrl: discordSourceUrl(message), replyToId: null,
                    attachments, ocrResults: [], classification: needsOfficerReview ? 'review' : 'scout',
                    ign, ignNormalized: normalizeIgn(ign),
                    ignConfidence: 1, ignSource: 'member_submission', rating: ratingText ? Number(ratingText) : null,
                    teamText, notes: field('Additional Notes'),
                    reviewStatus: needsOfficerReview ? 'pending' : 'confirmed',
                    reviewReason: needsOfficerReview ? 'Manual report team text looks like off-topic spam.' : null,
                    teamLayoutStatus: attachments.some(attachmentIsImage) ? 'uncertain' : 'none'
                };
            }
        }
        const imageAttachments = [...(message.attachments?.values?.() || [])]
            .filter(attachmentIsImage);
        const firstTextCandidate = candidateFromText(message.content || '');
        const reviewEvidencePromise = Promise.all([
            this.store.knownIgnEvidence(), this.store.staffReviewLearning()
        ]);
        const memberContextPromise = this.rosterStore?.ocrMemberContext(
            String(message.guildId || message.guild?.id || this.guildId), message.author?.id
        ).catch(error => {
            console.warn(`[WW LOG] Could not load scout member-name context: ${error.message}`);
            return { memberNames: [], authorNames: [] };
        }) || Promise.resolve({ memberNames: [], authorNames: [] });
        const memberContext = await memberContextPromise;
        const ocrResults = [];
        for (const attachment of imageAttachments) {
            const result = await this.ocr.analyzeAttachment(
                attachment,
                message.id,
                firstTextCandidate?.ign || null,
                memberContext
            );
            ocrResults.push({
                attachmentId: result.attachmentId,
                name: result.name,
                url: result.url,
                text: result.text || null,
                lines: result.lines || [],
                width: result.width || null,
                height: result.height || null,
                ocrWidth: result.ocrWidth || null,
                ocrHeight: result.ocrHeight || null,
                cardRect: result.cardRect || null,
                focusedIgn: result.focusedIgn || null,
                focusedConfidence: result.focusedConfidence || 0,
                focusedSource: result.focusedSource || null,
                focusedScanAttempted: result.focusedScanAttempted === true || Boolean(result.error),
                battlePairAmbiguous: result.battlePairAmbiguous === true,
                scanVersion: result.scanVersion || SCAN_VERSION,
                cardScanAttempted: result.cardScanAttempted === true,
                positionScanAttempted: !result.error,
                teamLayoutStatus: result.teamLayoutStatus || 'uncertain',
                teamLayoutReason: result.teamLayoutReason || null,
                error: result.error || null
            });
        }

        const [knownIgnEvidence, reviewLearning] = await reviewEvidencePromise;
        const parsed = extractScoutData({ content: message.content, attachments }, {
            ocrResults, knownIgnEvidence, reviewLearning, authorId: message.author?.id || null,
            memberContext
        });
        const teamLayoutStatuses = ocrResults.map(result => result.teamLayoutStatus);
        const teamLayoutStatus = !teamLayoutStatuses.length
            ? 'none'
            : teamLayoutStatuses.includes('uncertain')
                ? 'uncertain'
                : 'recognized';
        return {
            messageId: String(message.id),
            channelId: String(message.channelId || this.channelId),
            server: this.server,
            guildId: message.guildId || message.guild?.id || null,
            authorId: message.author?.id || null,
            authorUsername: message.author?.username || message.author?.globalName || message.member?.displayName || 'Unknown member',
            createdAt: message.createdAt || message.createdTimestamp || new Date(),
            editedAt: message.editedAt || null,
            content: String(message.content || ''),
            sourceUrl: discordSourceUrl(message),
            replyToId: message.reference?.messageId || null,
            attachments,
            ocrResults,
            ...parsed,
            teamLayoutStatus
        };
    }

    async saveMessage(message, { regroup = false } = {}) {
        if (this.stopped || !message?.id || String(message.channelId || message.channel?.id || '') !== this.channelId) return null;
        if (!canArchiveMessage(message, this.client.user?.id)) return null;
        const record = await this.buildRecord(message);
        if (this.stopped) return null;
        const saved = await this.store.saveMessage(record);
        if (!this.backfilling && !regroup) await this.assignLiveGroup(saved);
        return saved;
    }

    async rootForMessage(messageId) {
        if (!messageId) return null;
        const source = await this.store.getMessage(messageId);
        if (!source || source.is_deleted) return null;
        if (source.channel_id && String(source.channel_id) !== this.channelId) return null;
        const rootId = source.root_message_id || source.message_id;
        const root = await this.store.getMessage(rootId);
        if (root?.ign_source === 'member_submission' && root.review_status === 'pending') return null;
        return root && root.classification !== 'ignored' ? root : null;
    }

    async assignLiveGroup(saved) {
        if (saved?.staffOverrides?.rootMessageId) return;
        if (!saved || saved.is_deleted || saved.review_status === 'not_scout') return;
        let root = await this.rootForMessage(saved.reply_to_id);
        if (root && !mayJoinReport(saved, root, root, true)) root = null;
        if (!root) {
            const previous = await this.store.getPreviousMessage(saved.message_id, this.channelId);
            if (previous && String(previous.author_id || '') === String(saved.author_id || '')) {
                const priorRoot = await this.rootForMessage(previous.root_message_id || previous.message_id);
                if (priorRoot && mayJoinReport(saved, priorRoot, previous, false)) root = priorRoot;
            }
        }
        if (root && String(root.message_id) !== String(saved.message_id)) {
            if (!root.ign_normalized && saved.ign_normalized) await this.store.promoteRootIgn(root.message_id, saved.message_id);
            await this.store.setRootLinks([groupLink(saved, root.message_id, root)], this.channelId);
        }
    }

    async handleCreate(message) {
        const saved = await this.enqueueMessage(message, async () => {
            let row;
            try {
                row = await this.saveMessage(message);
            } catch (error) {
                // Later events cannot certify a gap left by this failed message.
                this.catchupReady = false;
                this.catchupFailureRevision++;
                throw error;
            }
            if (row && this.catchupReady && !this.stopped) {
                try {
                    await this.store.saveCatchupCursor(message.id, this.channelId);
                } catch (error) {
                    this.catchupReady = false;
                    this.catchupFailureRevision++;
                    console.warn(`[WW LOG] Could not save PvP scout catch-up checkpoint: ${error.message}. Startup will retry from the previous checkpoint.`);
                }
            }
            return row;
        });
        // Modal submissions are already complete and are posted by the bot;
        // keep their officer notification without treating them as public feedback.
        if (saved?.ign_source === 'member_submission' && saved.review_status === 'pending') {
            await this.notifyNewReview(saved).catch(error => {
                console.warn(`[WW LOG] Could not notify officers about scout ${saved.message_id}: ${error.message}`);
            });
        }
        if (saved) await this.feedback.observeMessage(message);
        return saved;
    }

    async notifyNewReview(saved) {
        if (!this.officerChannelId || this.backfilling || this.stopped) return;
        const row = await this.store.getMessage(saved.message_id);
        if (!row || row.review_status !== 'pending' || row.is_deleted) return;
        const age = Date.now() - messageTimestamp(row.created_at);
        if (age < -5 * 60 * 1000 || age > EDIT_REVIEW_WINDOW_MS) return;
        const groupedWithoutName = String(row.root_message_id || row.message_id) !== String(row.message_id)
            && !row.opponent_ign && !hasImageEvidence(row.attachments) && [
                'Could not identify the opponent IGN in the message or screenshot.',
                'Message looks like scouting information but the opponent IGN is unclear.'
            ].includes(row.review_reason);
        if (groupedWithoutName) return;
        if (!await this.store.claimReviewAlert(row.message_id)) return;
        let posted = false;
        try {
            const channel = this.client.channels.cache.get(this.officerChannelId)
                || await this.client.channels.fetch(this.officerChannelId);
            if (!channel?.send) throw new Error('Officer channel is unavailable or cannot receive messages.');
            const username = String(row.author_username || 'Unknown member').slice(0, 128)
                .replace(/([\\*_~`|>])/gu, '\\$1').replace(/@/gu, '＠');
            const reportId = String(row.root_message_id || row.message_id);
            const message = await channel.send({
                content: `A new **Scout Report** submitted by **${username}** is awaiting review.\n`
                    + 'Use the `/scout-review` command to review the Scout Report.\n'
                    + `-# - Scout Message ID: ${row.message_id}\n`
                    + `-# - Scout Report ID: ${reportId}\n`
                    + `- [**Jump to Scout Message**](${row.source_url})`,
                allowedMentions: { parse: [] }
            });
            posted = true;
            await this.store.markReviewAlertSent(row.message_id, message.id);
        } catch (error) {
            if (!posted) await this.store.releaseReviewAlert(row.message_id).catch(() => {});
            throw error;
        }
    }

    async notifyEditReview(edit) {
        if (!this.officerChannelId || this.backfilling || this.stopped || !edit) return;
        const row = await this.store.getMessage(edit.message_id);
        const latest = await this.store.getEditReview(edit.message_id);
        if (!row || row.is_deleted || latest?.status !== 'pending'
            || Number(latest.revision) !== Number(edit.revision)) return;
        const age = Date.now() - messageTimestamp(row.created_at);
        if (age < -5 * 60 * 1000 || age > EDIT_REVIEW_WINDOW_MS) return;
        if (!await this.store.claimEditReviewAlert(edit.message_id, edit.revision)) return;
        let posted = false;
        try {
            const channel = this.client.channels.cache.get(this.officerChannelId)
                || await this.client.channels.fetch(this.officerChannelId);
            if (!channel?.send) throw new Error('Officer channel is unavailable or cannot receive messages.');
            const username = String(row.author_username || 'Unknown member').slice(0, 128)
                .replace(/([\\*_~`|>])/gu, '\\$1').replace(/@/gu, '＠');
            const reportId = String(row.root_message_id || row.message_id);
            const message = await channel.send({
                content: `A recent **Scout Report** was edited by **${username}** and is awaiting review.\n`
                    + 'Use the `/scout-review` command to review the updated Scout Report.\n'
                    + `-# - Scout Message ID: ${row.message_id}\n`
                    + `-# - Scout Report ID: ${reportId}\n`
                    + `- [**Jump to Scout Message**](${row.source_url})`,
                allowedMentions: { parse: [] }
            });
            posted = true;
            await this.store.markEditReviewAlertSent?.(edit.message_id, edit.revision, message.id);
        } catch (error) {
            if (!posted) await this.store.releaseEditReviewAlert(edit.message_id, edit.revision).catch(() => {});
            throw error;
        }
    }

    async handleUpdate(message) {
        const result = await this.enqueueMessage(message, async () => {
            let current = message;
            if (current?.partial) current = await current.fetch().catch(() => null);
            if (!current || !canArchiveMessage(current, this.client.user?.id)) return null;
            const previous = await this.store.getMessage(current.id);
            const messageAge = previous ? Date.now() - messageTimestamp(previous.created_at) : Infinity;
            const isRecentScout = previous && !previous.is_deleted
                && ['scout', 'review'].includes(previous.classification)
                && previous.review_status !== 'not_scout'
                && messageAge >= -5 * 60 * 1000 && messageAge <= EDIT_REVIEW_WINDOW_MS;
            if (isRecentScout) {
                const proposal = await this.buildRecord(current);
                if (this.stopped) return null;
                // An unresolved parser failure can be fixed by its author. Published
                // reports and officer decisions still require approval of any edits.
                const latest = await this.store.getMessage(current.id);
                const existingEdit = await this.store.getEditReview(current.id);
                const root = latest?.root_message_id && String(latest.root_message_id) !== String(current.id)
                    ? await this.store.getMessage(latest.root_message_id) : null;
                const rootEdit = root?.review_status === 'pending' ? await this.store.getEditReview(root.message_id) : null;
                const protectedGroup = root && (root.is_deleted || root.reviewed_by_id || root.staffOverrides?.locked
                    || root.staffOverrides?.hidden || rootEdit?.status === 'pending'
                    || root.opponent_ign && root.review_status !== 'pending');
                const retry = latest?.review_status === 'pending' && !latest.reviewed_by_id
                    && !latest.staffOverrides?.locked && !latest.staffOverrides?.hidden
                    && existingEdit?.status !== 'pending' && !protectedGroup;
                if (retry) {
                    const saved = await this.store.saveMessage(proposal);
                    await this.rebuildGroups();
                    return { saved, message: current, stagedEdit: false };
                }
                const edit = await this.store.stageEditReview(latest || previous, proposal);
                return { saved: latest || previous, message: current, edit, stagedEdit: true };
            }
            if (previous) await this.store.expirePendingEditReview?.(previous.message_id);
            const saved = await this.saveMessage(current, { regroup: true });
            if (saved) await this.rebuildGroups();
            return { saved, message: current, stagedEdit: false };
        });
        if (!result) return null;
        if (result.stagedEdit) {
            if (result.edit) {
                await this.notifyEditReview(result.edit).catch(error => {
                    console.warn(`[WW LOG] Could not notify officers about edited scout ${result.saved.message_id}: ${error.message}`);
                });
            }
        }
        if (result.saved) await this.feedback.observeMessage(result.message);
        return result.saved;
    }

    refreshMessageFeedback(messageId) {
        return this.feedback.refreshReport(messageId);
    }

    async handleDelete(message) {
        if (!message?.id || String(message.channelId || message.channel?.id || '') !== this.channelId) return;
        if (!canArchiveMessage(message, this.client.user?.id)) return;
        await this.enqueue(async () => {
            await this.store.markDeleted(message.id, this.channelId);
            if (!this.backfilling) await this.rebuildGroups();
        });
        await this.feedback.remove(message.id);
    }

    async rebuildGroups() {
        await this.store.resetRootLinks(this.channelId);
        let cursor = null;
        const state = { roots: new Map(), messageRoots: new Map(), previous: null };
        const promotions = [];
        // Retain the state across pages and finish after resetting links.
        while (true) {
            const rows = await this.store.listMessagesAfter(cursor, 500, this.channelId);
            if (!rows.length) break;
            const links = [];
            for (let index = 0; index < rows.length; index += 20) {
                await yieldToEvents();
                const result = groupRows(rows.slice(index, index + 20), state);
                links.push(...result.links);
                promotions.push(...result.promotions);
            }
            await this.store.setRootLinks(links, this.channelId);
            cursor = rows.at(-1).message_id;
            if (rows.length < 500) break;
        }
        for (const promotion of promotions) await this.store.promoteRootIgn(promotion.rootMessageId, promotion.sourceMessageId);
    }

    startCatchup() {
        if (this.stopped) return;
        this.catchupReady = false;
        this.catchupPromise = this.catchUpMessages().then(async () => {
            // Resume saved timers after missed follow-ups have been archived and grouped.
            if (this.stopped) return;
            try { await this.feedback.restorePending?.(); }
            catch (error) { console.warn(`[WW LOG] Could not resume pending scout feedback: ${error.message}`); }
        }).catch(error => {
            this.catchupReady = false;
            if (!this.stopped) console.warn(`[WW LOG] PvP scout catch-up paused: ${error.message}. It will retry from the saved checkpoint on the next startup.`);
        });
        return this.catchupPromise;
    }

    async catchUpMessages() {
        if (this.stopped) return;
        this.catchupReady = false;
        const failureRevision = this.catchupFailureRevision;
        const cursor = await this.store.getCatchupCursor(this.channelId);
        if (this.stopped) return;
        const channel = await this.getChannel();
        if (!cursor) console.log('[WW LOG] Initializing PvP scout catch-up checkpoint; checking history for missing messages.');
        let before, newestId, count = 0;
        // Walk backward to the checkpoint instead of trusting the highest archived
        // ID: newer live events may already be saved beyond an unprocessed gap.
        try {
            while (!this.stopped) {
                const messages = await channel.messages.fetch({ limit: BACKFILL_PAGE_SIZE, cache: false,
                    ...(before ? { before } : {}) });
                if (this.stopped) return;
                const ordered = [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
                if (!ordered.length) break;
                newestId ||= ordered.at(-1).id;
                for (const message of ordered) {
                    if (this.stopped) return;
                    if (cursor && BigInt(message.id) <= BigInt(cursor)) continue;
                    const saved = await this.enqueue(async () => {
                        if (this.stopped || await this.store.getMessage(message.id)) return null;
                        if (this.stopped) return null;
                        return this.saveMessage(message, { regroup: true });
                    });
                    if (saved) count++;
                }
                const oldestId = ordered[0].id;
                if (cursor && BigInt(oldestId) <= BigInt(cursor) || ordered.length < BACKFILL_PAGE_SIZE) break;
                if (before && BigInt(oldestId) >= BigInt(before)) throw new Error('Discord message history did not advance.');
                before = oldestId;
            }
        } finally {
            // Keep already saved portions grouped even if a later page fails.
            if (count) await this.enqueue(() => this.rebuildGroups());
        }
        if (this.stopped) return;
        await this.enqueue(async () => {
            if (this.stopped) return;
            if (newestId) await this.store.saveCatchupCursor(newestId, this.channelId);
            this.catchupReady = failureRevision === this.catchupFailureRevision;
        });
        if (count && !this.stopped) console.log(`[WW LOG] PvP scout catch-up archived ${count} missed message(s).`);
    }

    async runBackfill() {
        let backfillState = await this.store.getBackfillState(this.channelId);
        let cursor = backfillState.before_message_id || null;
        let processedCount = Number(backfillState.processed_count || 0);
        const channel = await this.getChannel();
        console.log(`[WW LOG] PvP scouting history backfill started at ${cursor || 'latest messages'}.`);

        while (!this.stopped) {
            try {
                const page = await channel.messages.fetch({
                    limit: BACKFILL_PAGE_SIZE,
                    ...(cursor ? { before: cursor } : {})
                });
                const messages = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
                if (!messages.length) {
                    await this.store.saveBackfillState({
                        beforeMessageId: cursor,
                        complete: true,
                        processedCount,
                        lastError: null
                    }, this.channelId);
                    await this.enqueue(() => this.rebuildGroups());
                    await this.store.autocomplete('', this.channelId).catch(error => {
                        console.warn(`[WW LOG] Could not refresh PvP scout autocomplete: ${error.message}`);
                    });
                    this.backfilling = false;
                    console.log(`[WW LOG] PvP scouting backfill complete: ${processedCount} historical message(s) archived.`);
                    this.startCatchup();
                    this.reinspectionPromise = this.reinspectLegacyResultCards().catch(error => {
                        console.error('[WW LOG] PvP scouting screenshot refresh failed:', error);
                    });
                    return;
                }

                await this.enqueue(async () => {
                    for (const message of messages) {
                        if (this.stopped) break;
                        await this.saveMessage(message, { regroup: true });
                        processedCount++;
                    }
                });
                if (this.stopped) return;
                cursor = messages[0].id;
                await this.store.saveBackfillState({
                    beforeMessageId: cursor,
                    complete: false,
                    processedCount,
                    lastError: null
                }, this.channelId);
                if (processedCount % 1000 < messages.length) {
                    console.log(`[WW LOG] PvP scouting backfill archived ${processedCount} message(s); continuing before ${cursor}.`);
                }
            } catch (error) {
                if (this.stopped) return;
                await this.store.setBackfillError(error, this.channelId).catch(() => {});
                this.failureCount++;
                const delayMs = Math.min(60000, 1000 * (2 ** Math.min(this.failureCount - 1, 6)));
                console.warn(`[WW LOG] PvP scouting backfill paused (${error.message}); retrying in ${Math.ceil(delayMs / 1000)}s.`);
                await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 5000)));
            }
        }
    }
}

module.exports = {
    BACKFILL_PAGE_SIZE,
    FOLLOW_UP_WINDOW_MS,
    PvpScoutIngestor,
    attachmentIsImage,
    buildGroupLinks,
    canArchiveMessage,
    discordSourceUrl
};
