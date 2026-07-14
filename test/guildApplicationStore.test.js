'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuildApplicationStore } = require('../features/guild-applications/storage/GuildApplicationStore.js');

function tempFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-guild-applications-'));
    return path.join(directory, 'guild_applications.json');
}

function record(postId = '100') {
    return {
        postId,
        topicId: '228820',
        topicUrl: 'https://example.com/topic',
        postUrl: `https://example.com/post/${postId}`,
        pageNumber: 1,
        forumUserId: '9001',
        forumUsername: 'Applicant',
        postedAt: '2026-07-13T12:00:00.000Z',
        observedAt: '2026-07-13T12:01:00.000Z',
        contentHash: 'a'.repeat(64),
        rawBodyText: 'IGN: Applicant',
        imageUrls: [],
        classification: 'application',
        classificationConfidence: 0.95,
        parserReasons: ['labelled_ign'],
        ocrOutput: null,
        ign: 'Applicant',
        ignSource: 'labelled_text',
        ignConfidence: 0.98,
        age: '20',
        country: 'Denmark',
        interests: 'PvP',
        extraInformation: null,
        isBaseline: false,
        notificationStatus: 'pending'
    };
}

class FakeDb {
    constructor() {
        this.fail = false;
        this.upserts = [];
        this.hasRequiredConfig = true;
    }

    async getConnection() {
        if (this.fail) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        return {
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: () => {},
            query: async (sql, params) => {
                this.upserts.push({ sql, params });
                return [{ affectedRows: 1 }];
            }
        };
    }

    async query(sql) {
        if (this.fail) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        if (/count\(\*\)/i.test(sql)) return [[{ total: this.upserts.length }], []];
        if (/max\(page_number\)/i.test(sql)) return [[{ last_page: 1, last_post_id: '100' }], []];
        return [[], []];
    }
}

test('STORAGE_MODE=json never calls MySQL and keeps local records', async () => {
    const db = new FakeDb();
    const file = tempFile();
    const store = new GuildApplicationStore({ db, storageMode: 'json', dataFile: file, hasMysqlCredentials: true });

    await store.initialize();
    await store.saveRecord(record());
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(db.upserts.length, 0);
    assert.equal(data.source, 'json_only');
    assert.equal(data.pendingSync, false);
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].storageOrigin, 'json_only');
});

test('json-only test records are never synchronized when returning to auto mode', async () => {
    const db = new FakeDb();
    const file = tempFile();
    const jsonStore = new GuildApplicationStore({ db, storageMode: 'json', dataFile: file, hasMysqlCredentials: true });
    await jsonStore.initialize();
    await jsonStore.saveRecord(record('150'));

    const autoStore = new GuildApplicationStore({ db, storageMode: 'auto', dataFile: file, hasMysqlCredentials: true });
    await autoStore.initialize();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(db.upserts.length, 0);
    assert.equal(data.source, 'mysql_fallback');
    assert.equal(data.records.length, 0);
    assert.equal(data.initialized, false);
});

test('json mode refuses to relabel unsynced production fallback records', async () => {
    const db = new FakeDb();
    db.fail = true;
    const file = tempFile();
    const autoStore = new GuildApplicationStore({ db, storageMode: 'auto', dataFile: file, hasMysqlCredentials: true });
    await autoStore.saveRecord(record('175'));

    const jsonStore = new GuildApplicationStore({ db, storageMode: 'json', dataFile: file, hasMysqlCredentials: true });
    await assert.rejects(() => jsonStore.initialize(), /unsynced MySQL fallback records/i);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.source, 'mysql_fallback');
    assert.equal(data.records.length, 1);
});

test('MySQL failure writes one idempotent fallback record', async () => {
    const db = new FakeDb();
    db.fail = true;
    const file = tempFile();
    const store = new GuildApplicationStore({ db, storageMode: 'auto', dataFile: file, hasMysqlCredentials: true });

    await store.saveRecord(record('200'));
    await store.saveRecord({ ...record('200'), notificationStatus: 'officer_sent' });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(data.source, 'mysql_fallback');
    assert.equal(data.pendingSync, true);
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].notificationStatus, 'officer_sent');
});

test('successful primary writes are marked as MySQL rather than fallback data', async () => {
    const db = new FakeDb();
    const file = tempFile();
    const store = new GuildApplicationStore({ db, storageMode: 'auto', dataFile: file, hasMysqlCredentials: true });

    const saved = await store.saveRecord(record('225'));

    assert.equal(saved.storageOrigin, 'mysql');
    assert.equal(db.upserts.length, 1);
    assert.equal(db.upserts[0].params.length, 39);
    assert.equal(db.upserts[0].params[38], 'mysql');
});

test('successful live synchronization clears fallback records but preserves checkpoint', async () => {
    const db = new FakeDb();
    db.fail = true;
    const file = tempFile();
    const store = new GuildApplicationStore({ db, storageMode: 'auto', dataFile: file, hasMysqlCredentials: true });

    await store.saveRecord(record('300'));
    await store.markInitialized({ lastPage: 11, lastPostId: '300' });
    db.fail = false;
    await store.syncFallback();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(db.upserts.length, 1);
    assert.equal(data.pendingSync, false);
    assert.deepEqual(data.records, []);
    assert.equal(data.initialized, true);
    assert.equal(data.checkpoint.lastPage, 11);
    assert.equal(data.checkpoint.lastPostId, '300');
});

test('json storage returns only active 12-hour and 18-hour vote reminder candidates', async () => {
    const file = tempFile();
    const store = new GuildApplicationStore({ storageMode: 'json', dataFile: file });
    const pollCreatedAt = '2026-07-13T00:00:00.000Z';
    await store.initialize();
    await store.saveRecord({
        ...record('400'),
        notificationStatus: 'notified',
        officerMessageUrl: 'https://discord.com/channels/guild/officer/message',
        pollMessageId: 'poll-message',
        pollMessageUrl: 'https://discord.com/channels/guild/court/poll-message',
        pollCreatedAt
    });

    assert.equal((await store.voteReminderCandidates(new Date('2026-07-13T11:59:59.000Z'))).length, 0);
    assert.equal((await store.voteReminderCandidates(new Date('2026-07-13T12:00:00.000Z'))).length, 1);
    assert.equal((await store.voteReminderCandidates(new Date('2026-07-14T00:00:00.000Z'))).length, 0);
});

test('removes known decorative image URLs from the local fallback records', async () => {
    const file = tempFile();
    const store = new GuildApplicationStore({ storageMode: 'json', dataFile: file });
    await store.initialize();
    await store.saveRecord({
        ...record('450'),
        imageUrls: [
            'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4cc.png',
            'https://pokemonrevolution.net/forum/uploads/monthly_2026_07/trainer-card.png'
        ]
    });

    await store.removeStoredImageUrls([
        'https://pokemonrevolution.net/forum/uploads/monthly_2026_01/ww.png.14a076b219f04cdecfd7863e4969cab3.png'
    ]);

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(data.records[0].imageUrls, [
        'https://pokemonrevolution.net/forum/uploads/monthly_2026_07/trainer-card.png'
    ]);
});
