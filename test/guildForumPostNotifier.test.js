'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildForumPostNotifier } = require('../features/guild-applications/discord/GuildForumPostNotifier.js');

test('mentions only the owner for a newly observed non-application forum post', async () => {
    const sent = [];
    const officerChannel = {
        id: 'officer-channel',
        isTextBased: () => true,
        async send(payload) {
            sent.push(payload);
            return { id: 'owner-alert' };
        }
    };
    const notifier = new GuildForumPostNotifier({
        client: { channels: { cache: new Map([[officerChannel.id, officerChannel]]), fetch: async () => officerChannel } },
        officerChannelID: officerChannel.id,
        ownerID: 'owner-id',
        botTimezone: 'Etc/UTC'
    });
    const record = {
        postUrl: 'https://example.com/forum/#findComment-100',
        forumUsername: 'ForumApplicant',
        postedAt: '2026-07-14T12:34:56.000Z',
        rawBodyText: 'Is there still room in the guild?',
        classificationConfidence: 0.35
    };

    const result = await notifier.notify(record);
    const embed = sent[0].embeds[0].toJSON();

    assert.match(sent[0].content, /<@owner-id>/);
    assert.match(sent[0].content, /\*\*White Walkers guild application forum page\*\*/);
    assert.doesNotMatch(sent[0].content, /Application likelihood|View Forum Application/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['owner-id'] });
    assert.doesNotMatch(sent[0].content, /officer-role/i);
    assert.equal(embed.color, 0x1bb4c5);
    assert.equal(embed.title, undefined);
    assert.equal(embed.url, undefined);
    assert.equal(embed.footer.text, 'Forum Post Created: July 14, 2026 12:34');
    assert.deepEqual(embed.fields.map(field => field.name), [
        'Application likelihood',
        'Posted by Vangogsan',
        'View Forum Application',
        'Forum Username',
        'Message Content'
    ]);
    assert.equal(embed.fields[0].value, '**35%**');
    assert.equal(embed.fields[1].value, '**No**');
    assert.equal(embed.fields[2].value, '[**Click Here!**](<https://example.com/forum/#findComment-100>)');
    assert.equal(embed.fields.slice(0, 3).every(field => field.inline), true);
    assert.equal(result.record.notificationStatus, 'non_application_alert_sent');
});
