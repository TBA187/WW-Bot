// Owns the separate Gold and Silver archives and routes messages to their channel.
'use strict';

const path = require('node:path');
const { PvpScoutStore } = require('./PvpScoutStore.js');
const { PvpScoutIngestor } = require('./PvpScoutIngestor.js');

class ScoutServerRegistry {
    constructor(options = {}) {
        const config = options.config || {};
        const channels = { gold: config.pvpScoutingGoldChannelID, silver: config.pvpScoutingSilverChannelID };
        const learningChannelIds = Object.values(channels).filter(Boolean).map(String);
        this.byServer = new Map();
        this.byChannel = new Map();
        const Store = options.Store || PvpScoutStore;
        const Ingestor = options.Ingestor || PvpScoutIngestor;
        for (const server of ['gold', 'silver']) {
            const channelId = String(channels[server] || '');
            const store = new Store({ db: options.db, channelId, server,
                rosterStore: options.rosterStore, auditLogger: options.auditLogger, learningChannelIds,
                onLearningChanged: () => this.invalidateLearning(),
                autocompleteCachePath: path.join(options.dataPath || path.join(__dirname, '../../data'),
                    server === 'gold' ? 'scout-autocomplete-cache.json' : 'scout-autocomplete-silver-cache.json') });
            const ingestor = new Ingestor({ client: options.client, store, server, channelId,
                rosterStore: options.rosterStore, guildId: config.guildId,
                diagnostics: options.diagnostics, officerChannelId: config.officerChannelID });
            const context = Object.freeze({ server, label: server === 'gold' ? 'Gold' : 'Silver', channelId, store, ingestor });
            this.byServer.set(server, context);
            if (channelId) {
                if (this.byChannel.has(channelId)) throw new Error('Gold and Silver scouting must use different channels.');
                this.byChannel.set(channelId, context);
            }
        }
    }

    get(server = 'gold') { return this.byServer.get(String(server).toLowerCase()) || null; }
    forChannel(channelId) { return this.byChannel.get(String(channelId || '')) || null; }
    contexts() { return [...this.byServer.values()].filter(context => context.channelId); }

    invalidateLearning() {
        for (const context of this.byServer.values()) {
            context.store.reviewLearningAt = 0;
            context.store.reviewLearningRevision = Number(context.store.reviewLearningRevision || 0) + 1;
        }
    }

    async warmAutocomplete() {
        // Finish shared DDL once before both archives begin their own queries.
        for (const context of this.contexts()) await context.store.ensureSchema();
        return Promise.all(this.contexts().map(context => context.store.autocomplete('', context.channelId)));
    }

    async start() {
        for (const context of this.byServer.values()) {
            if (!context.channelId) await context.ingestor.start();
        }
        // Each ingestor has its own retry loop, checkpoint, and OCR queue.
        return Promise.all(this.contexts().map(context => context.ingestor.start()));
    }

    async stop() {
        return Promise.allSettled([...this.byServer.values()].map(context => context.ingestor.stop()));
    }
}

module.exports = { ScoutServerRegistry };
