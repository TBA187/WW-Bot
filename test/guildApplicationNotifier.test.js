'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessagePayload } = require('discord.js');
const { GuildApplicationNotifier } = require('../features/guild-applications/discord/GuildApplicationNotifier.js');

function fakeMessage(id, channel) {
    return {
        id,
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
        channel,
        edits: [],
        replies: [],
        async edit(payload) {
            this.edits.push(payload);
            return this;
        },
        async reply(payload) {
            this.replies.push(payload);
            return fakeMessage(`reply-${this.replies.length}`, channel);
        }
    };
}

function fakeChannel(id, sent) {
    const channel = {
        id,
        isTextBased: () => true,
        messages: { fetch: async () => null },
        async send(payload) {
            sent.push({ channelId: id, payload });
            return fakeMessage(`${id}-message-${sent.length}`, channel);
        }
    };
    return channel;
}

test('creates an immutable 24-hour poll, cross-links both messages, and only pings Officers', async () => {
    const sent = [];
    const officer = fakeChannel('officer-channel', sent);
    const court = fakeChannel('court-channel', sent);
    const channels = new Map([[officer.id, officer], [court.id, court]]);
    const notifier = new GuildApplicationNotifier({
        client: {
            channels: {
                cache: channels,
                fetch: async id => channels.get(id)
            }
        },
        guildId: 'guild',
        officerChannelID: officer.id,
        courtHouseChannelID: court.id,
        officerRoleID: 'officer-role'
    });
    const record = {
        postId: '100',
        postUrl: 'https://example.com/forum/#findComment-100',
        ign: 'ApplicantIGN',
        ignConfidence: 0.98,
        age: '22',
        country: 'Denmark',
        interests: 'PvP',
        imageUrls: []
    };
    let officerSaved = false;

    const updated = await notifier.notify(record, {
        downloadedImages: [],
        onOfficerMessage: async partial => {
            officerSaved = Boolean(partial.officerMessageId);
        }
    });

    assert.equal(officerSaved, true);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].payload.allowedMentions, { parse: [], roles: ['officer-role'] });
    assert.equal(sent[1].payload.poll.question.text, 'Invite ApplicantIGN to White Walkers?');
    assert.deepEqual(sent[1].payload.poll.answers, [{ text: 'Yes' }, { text: 'No' }]);
    assert.equal(sent[1].payload.poll.duration, 24);
    assert.equal(sent[1].payload.poll.allowMultiselect, false);
    const serializedPoll = MessagePayload.create({
        client: {
            options: {
                allowedMentions: undefined,
                enforceNonce: false,
                failIfNotExists: true,
                jsonTransformer: value => value
            }
        }
    }, sent[1].payload).resolveBody().body.poll;
    assert.equal(serializedPoll.question.text, 'Invite ApplicantIGN to White Walkers?');
    assert.equal(serializedPoll.answers[0].poll_media.text, 'Yes');
    assert.equal(serializedPoll.answers[1].poll_media.text, 'No');
    assert.equal(serializedPoll.duration, 24);
    assert.equal(serializedPoll.allow_multiselect, false);
    assert.match(sent[1].payload.content, /Guild Application from \*\*ApplicantIGN:\*\*/);
    assert.match(sent[1].payload.content, /View Application in Discord/);
    assert.match(sent[1].payload.content, /officer-channel/);
    assert.match(sent[0].payload.content, /pro_revolution_online:1526117366159638628/);
    assert.match(sent[0].payload.content, /PRO Forum Application/);
    assert.equal(updated.notificationStatus, 'notified');
    assert.match(updated.pollMessageUrl, /court-channel/);
    assert.equal(updated.pollCreatedAt, '2026-07-13T12:00:00.000Z');
});

test('still alerts Officers but skips the poll when IGN is unreliable', async () => {
    const sent = [];
    const officer = fakeChannel('officer-channel', sent);
    const channels = new Map([[officer.id, officer]]);
    const notifier = new GuildApplicationNotifier({
        client: { channels: { cache: channels, fetch: async id => channels.get(id) } },
        guildId: 'guild',
        officerChannelID: officer.id,
        courtHouseChannelID: 'court-channel',
        officerRoleID: 'officer-role'
    });

    const updated = await notifier.notify({
        postUrl: 'https://example.com/post',
        ign: null,
        ignConfidence: 0,
        imageUrls: []
    });

    assert.equal(sent.length, 1);
    assert.equal(updated.notificationStatus, 'notified_no_poll');
});

test('recovers already-sent application and poll messages after a crash without sending duplicates', async () => {
    const sent = [];
    const postUrl = 'https://example.com/forum/#findComment-101';
    const officer = fakeChannel('officer-channel', sent);
    const court = fakeChannel('court-channel', sent);
    const officerMessage = fakeMessage('existing-officer', officer);
    officerMessage.author = { id: 'bot-id' };
    officerMessage.url = 'https://discord.com/existing-officer';
    officerMessage.content = `a new application to join White Walkers ${postUrl}`;
    const pollMessage = fakeMessage('existing-poll', court);
    pollMessage.author = { id: 'bot-id' };
    pollMessage.url = 'https://discord.com/existing-poll';
    pollMessage.content = `Guild Application from **ApplicantIGN:** ${postUrl}`;
    officer.messages.fetch = async input => typeof input === 'string' ? null : new Map([[officerMessage.id, officerMessage]]);
    court.messages.fetch = async input => typeof input === 'string' ? null : new Map([[pollMessage.id, pollMessage]]);
    const channels = new Map([[officer.id, officer], [court.id, court]]);
    const notifier = new GuildApplicationNotifier({
        client: {
            user: { id: 'bot-id' },
            channels: { cache: channels, fetch: async id => channels.get(id) }
        },
        guildId: 'guild',
        officerChannelID: officer.id,
        courtHouseChannelID: court.id,
        officerRoleID: 'officer-role'
    });
    let officerSaved = 0;
    let pollSaved = 0;

    const updated = await notifier.notify({
        postId: '101',
        postUrl,
        ign: 'ApplicantIGN',
        ignConfidence: 0.98,
        imageUrls: []
    }, {
        onOfficerMessage: async () => { officerSaved += 1; },
        onPollMessage: async () => { pollSaved += 1; }
    });

    assert.equal(sent.length, 0);
    assert.equal(officerSaved, 1);
    assert.equal(pollSaved, 1);
    assert.equal(updated.officerMessageId, 'existing-officer');
    assert.equal(updated.pollMessageId, 'existing-poll');
    assert.equal(updated.notificationStatus, 'notified');
});

test('low-extraction fallback shows one raw Guild Application field', async () => {
    const sent = [];
    const officer = fakeChannel('officer-channel', sent);
    const channels = new Map([[officer.id, officer]]);
    const notifier = new GuildApplicationNotifier({
        client: { channels: { cache: channels, fetch: async id => channels.get(id) } },
        guildId: 'guild',
        officerChannelID: officer.id,
        courtHouseChannelID: 'court-channel',
        officerRoleID: 'officer-role'
    });

    await notifier.notify({
        postUrl: 'https://example.com/post',
        rawBodyText: 'The complete raw application text from storage.',
        ign: null,
        ignConfidence: 0,
        imageUrls: []
    }, { useRawApplicationFallback: true });

    const fields = sent[0].payload.embeds[0].toJSON().fields;
    assert.deepEqual(fields, [{
        name: 'Guild Application',
        value: 'The complete raw application text from storage.',
        inline: false
    }]);
});

test('application embed cleans metadata, orders fields, and includes WW branding', () => {
    const notifier = new GuildApplicationNotifier({
        client: { channels: { cache: new Map() } },
        guildId: 'guild',
        officerChannelID: 'officer-channel',
        courtHouseChannelID: 'court-channel',
        officerRoleID: 'officer-role'
    });
    const payload = notifier.buildNormalPayload({
        postUrl: 'https://example.com/post',
        postedAt: '2025-08-01T16:33:54Z',
        ign: 'foxcomeback',
        age: '37',
        country: 'viet nam',
        interests: 'Hunting and dungeons\nEdited August 1, 2025Aug 1 by Foxcomeback',
        extraInformation: 'Screen shot of your pokemon ID\nDiscord: fox.user'
    }, [{ buffer: Buffer.from('image'), name: 'card.png', url: 'https://example.com/card.png' }]);
    const embed = payload.embeds[0].toJSON();

    assert.equal(embed.color, 0x1bb4c5);
    assert.equal(embed.title, 'White Walker Guild Application');
    assert.equal(embed.url, 'https://pokemonrevolution.net/forum/topic/228820-white-walkers-the-memory-of-the-winter/');
    assert.equal(embed.author, undefined);
    assert.equal(embed.footer.text, 'Guild Application Submitted: August 1, 2025 16:33');
    assert.equal(embed.footer.icon_url, 'attachment://ww_logo.png');
    assert.deepEqual(embed.fields.map(field => field.name), [
        'In-Game Name',
        'Age',
        'Country',
        'Interests in game',
        'Extra Information',
        'Screenshot of Trainer Card'
    ]);
    assert.equal(embed.fields[3].value, 'Hunting and dungeons');
    assert.equal(embed.fields[4].value, 'Discord: fox.user');
    assert.equal(embed.fields[5].value, '-# *1 image attached!*');
    assert.equal(payload.files[0].name, 'ww_logo.png');
    assert.equal(payload.files.length, 2);
});

test('multiple images keep only the trainer card in the application embed', () => {
    const notifier = new GuildApplicationNotifier({ client: { channels: { cache: new Map() } } });
    const payload = notifier.buildNormalPayload({
        postUrl: 'https://example.com/post',
        postedAt: '2026-01-01T00:00:00Z',
        ign: 'Applicant',
        age: '20',
        country: 'Denmark',
        interests: 'PvP'
    }, [
        { buffer: Buffer.from('one'), name: 'one.png' },
        { buffer: Buffer.from('two'), name: 'two.png' }
    ]);
    const screenshot = payload.embeds[0].toJSON().fields.at(-1);

    assert.equal(screenshot.name, 'Screenshot of Trainer Card');
    assert.equal(screenshot.value, '-# *2 images attached!*');
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.files.length, 2);
});

test('additional images are posted as ordinary messages in batches of ten', async () => {
    const notifier = new GuildApplicationNotifier({ client: { channels: { cache: new Map() } } });
    const channel = {};
    const message = fakeMessage('application-message', channel);
    const images = Array.from({ length: 22 }, (_, index) => ({
        buffer: Buffer.from(`image-${index}`),
        name: `image-${index}.png`
    }));

    await notifier.sendRemainingAttachments(message, images);

    assert.equal(message.replies.length, 3);
    assert.equal(message.replies[0].content, '**Additional Images:**');
    assert.equal(message.replies[0].files.length, 10);
    assert.equal(message.replies[1].files.length, 10);
    assert.equal(message.replies[2].files.length, 1);
    assert.equal(message.replies.every(reply => !reply.embeds), true);
});

test('zero images show N/A and the correct plural count', () => {
    const notifier = new GuildApplicationNotifier({ client: { channels: { cache: new Map() } } });
    const payload = notifier.buildNormalPayload({
        postUrl: 'https://example.com/post',
        postedAt: '2026-01-01T00:00:00.000Z',
        ign: 'Applicant',
        age: '20',
        country: 'Denmark',
        interests: 'PvP'
    }, []);
    const screenshot = payload.embeds[0].toJSON().fields.at(-1);

    assert.equal(screenshot.value, '*N/A*\n-# *0 images attached!*');
});

test('attachment filenames are removed from displayed application text', () => {
    const notifier = new GuildApplicationNotifier({ client: { channels: { cache: new Map() } } });
    const payload = notifier.buildNormalPayload({
        postUrl: 'https://example.com/post',
        postedAt: '2026-01-01T00:00:00.000Z',
        ign: 'Applicant',
        age: '20',
        country: 'Denmark',
        interests: 'I enjoy PvP IMG_20250122_063112.jpg.058478e8c100841d3be51d449139e89b2.jpg'
    }, []);
    const interests = payload.embeds[0].toJSON().fields.find(field => field.name === 'Interests in game');

    assert.equal(interests.value, 'I enjoy PvP');
});

test('invalid stored countries fall back to a valid narrative country', () => {
    const notifier = new GuildApplicationNotifier({ client: { channels: { cache: new Map() } } });
    const payload = notifier.buildNormalPayload({
        postUrl: 'https://example.com/application',
        postedAt: '2026-07-13T12:00:00.000Z',
        ign: 'Aaronlee191',
        age: '23',
        country: 'PokeMMO',
        interests: 'PvP',
        extraInformation: 'I am 23 years old and from Singapore.'
    }, []);
    const countryField = payload.embeds[0].toJSON().fields.find(field => field.name === 'Country');

    assert.equal(countryField.value, 'Singapore');
});
