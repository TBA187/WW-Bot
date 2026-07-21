'use strict';

// Keeps only the page and post checkpoints needed to avoid duplicate DMs.
const fs = require('fs');
const { writeJsonIfChanged } = require('../../utils/jsonFile.js');
const { DATA_VERSION, DEFAULT_DATA_FILE } = require('./constants.js');

class TbaForumShopStore {
    constructor(options = {}) {
        this.dataFile = options.dataFile || DEFAULT_DATA_FILE;
        this.tempFile = `${this.dataFile}.tmp`;
    }

    emptyData() {
        return {
            version: DATA_VERSION,
            shops: {}
        };
    }

    ensureFile() {
        if (!fs.existsSync(this.dataFile)) {
            writeJsonIfChanged(this.dataFile, this.tempFile, this.emptyData());
        }
    }

    readData() {
        this.ensureFile();
        const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        return {
            version: DATA_VERSION,
            shops: parsed?.shops && typeof parsed.shops === 'object' ? parsed.shops : {}
        };
    }

    writeData(data) {
        writeJsonIfChanged(this.dataFile, this.tempFile, {
            version: DATA_VERSION,
            shops: data.shops || {}
        });
    }

    initialize(shops) {
        const data = this.readData();
        for (const shop of shops) {
            const existing = data.shops[shop.key];
            if (!existing || existing.topicUrl !== shop.topicUrl) {
                data.shops[shop.key] = {
                    topicUrl: shop.topicUrl,
                    initialized: false,
                    lastSeenPostId: null,
                    lastPage: 1
                };
            }
        }
        this.writeData(data);
        return data;
    }

    getShop(key) {
        return this.readData().shops[key] || null;
    }

    updateShop(key, patch) {
        const data = this.readData();
        if (!data.shops[key]) throw new Error(`Unknown TBA forum shop key: ${key}`);
        data.shops[key] = { ...data.shops[key], ...patch };
        this.writeData(data);
        return data.shops[key];
    }
}

module.exports = {
    TbaForumShopStore
};
