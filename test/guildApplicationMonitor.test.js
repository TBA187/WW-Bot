'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuildApplicationMonitor } = require('../features/guild-applications/GuildApplicationMonitor.js');
const { GuildApplicationParser } = require('../features/guild-applications/parsing/GuildApplicationParser.js');
const { GuildApplicationStore } = require('../features/guild-applications/storage/GuildApplicationStore.js');

function tempFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-monitor-'));
    return path.join(directory, 'guild_applications.json');
}

function forumPost(id, userId, postedAt) {
    return {
        postId: String(id),
        page: 1,
        postUrl: `https://example.com/page/1/#findComment-${id}`,
        forumUserId: String(userId),
        forumUsername: `User${userId}`,
        profileUrl: `https://example.com/profile/${userId}-user/`,
        profileSlug: `user${userId}`,
        postedAt,
        bodyText: `IGN: Player${userId}\nAge: 25\nCountry: Denmark\nWhat you love to do in PRO: PvP and dungeons`,
        imageUrls: []
    };
}

function makeMonitor(posts, notifierCalls, file, nonApplicationCalls = [], reapplicationCooldownHours = 0) {
    const forum = {
        async fetchPage() { return { page: 1, lastPage: 1, posts: [...posts] }; },
        async downloadPostImages() { return []; }
    };
    const store = new GuildApplicationStore({ storageMode: 'json', dataFile: file });
    return new GuildApplicationMonitor({
        forumClient: forum,
        parser: new GuildApplicationParser(),
        ocr: { resolveIgn: async () => ({ ign: null, confidence: 0, output: [] }), close: async () => {} },
        store,
        notifier: {
            async notify(record, options) {
                notifierCalls.push(record.postId);
                record.officerMessageId = `officer-${record.postId}`;
                record.officerMessageUrl = `https://discord.test/${record.postId}`;
                await options.onOfficerMessage(record);
                record.notificationStatus = 'notified';
                record.notifiedAt = new Date().toISOString();
                return record;
            }
        },
        nonApplicationNotifier: {
            async notify(record) {
                nonApplicationCalls.push(record.postId);
                record.notificationStatus = 'non_application_alert_sent';
                record.notifiedAt = new Date().toISOString();
                return { record };
            }
        },
        reapplicationCooldownHours,
        clock: () => new Date('2026-07-13T12:00:00.000Z')
    });
}

test('empty storage builds a complete baseline with zero notifications', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);

    await monitor.runOnce();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(data.initialized, true);
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].isBaseline, true);
    assert.deepEqual(notifications, []);
});

test('new applications are stored before one officer notification is sent', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);
    await monitor.runOnce();

    posts.push(forumPost(2, 200, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.deepEqual(notifications, ['2']);
    assert.equal(data.records.find(item => item.postId === '2').notificationStatus, 'notified');
});

test('repeat applications from the same forum user are announced without a waiting period', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, ['2']);
    assert.equal(repeatApplication.classification, 'application');
    assert.equal(repeatApplication.notificationStatus, 'notified');
});

test('a positive application cooldown suppresses repeat applications inside the configured window', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file, [], 24);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, []);
    assert.equal(repeatApplication.classification, 'duplicate_user');
    assert.equal(repeatApplication.notificationStatus, 'not_required');
});

test('a repeat application is announced at the configured cooldown boundary', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T11:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file, [], 24);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, ['2']);
    assert.equal(repeatApplication.classification, 'application');
    assert.equal(repeatApplication.notificationStatus, 'notified');
});

test('new non-applications are saved before the owner-only alert is sent', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const applicationNotifications = [];
    const nonApplicationNotifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, applicationNotifications, file, nonApplicationNotifications);
    await monitor.runOnce();

    posts.push({
        ...forumPost(2, 200, '2026-07-13T11:00:00.000Z'),
        bodyText: 'Is there still room in the guild?'
    });
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(applicationNotifications, []);
    assert.deepEqual(nonApplicationNotifications, ['2']);
    assert.equal(data.records.find(item => item.postId === '2').notificationStatus, 'non_application_alert_sent');
});
