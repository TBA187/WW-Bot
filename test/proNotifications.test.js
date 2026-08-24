const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getContestKey,
    getNextAltoMareSchedule,
    getNextContestSchedule,
    getNextContestScheduleForContest,
    mentionBatches,
    sendUserReminder,
    sendScheduledReminder
} = require('../tasks/proNotifications.js');

test('Alto Mare reminders use the fixed 01:00 UTC race cycle', () => {
    const now = Date.UTC(2026, 7, 18, 0, 0, 0);
    const schedule = getNextAltoMareSchedule(now);

    assert.equal(schedule.reminderTime, Date.UTC(2026, 7, 18, 0, 45, 0));
    assert.equal(schedule.raceStart, Date.UTC(2026, 7, 18, 1, 0, 0));
});

test('Alto Mare skips a reminder that has already passed', () => {
    const now = Date.UTC(2026, 7, 18, 0, 45, 1);
    const schedule = getNextAltoMareSchedule(now);

    assert.equal(schedule.reminderTime, Date.UTC(2026, 7, 18, 6, 45, 0));
    assert.equal(schedule.raceStart, Date.UTC(2026, 7, 18, 7, 0, 0));
});

test('BCC and FCC use the supplied alternating Saturday anchor', () => {
    const anchorSaturday = Date.UTC(2026, 7, 29, 0, 0, 0);
    const followingSaturday = Date.UTC(2026, 8, 5, 0, 0, 0);

    assert.equal(getContestKey(anchorSaturday, 10), 'BCC');
    assert.equal(getContestKey(anchorSaturday, 22), 'FCC');
    assert.equal(getContestKey(followingSaturday, 10), 'FCC');
    assert.equal(getContestKey(followingSaturday, 22), 'BCC');
});

test('Saturday contest reminders choose the next event without sending late', () => {
    const beforeFirstReminder = getNextContestSchedule(Date.UTC(2026, 7, 29, 9, 29, 0));
    const afterFirstReminder = getNextContestSchedule(Date.UTC(2026, 7, 29, 9, 30, 1));

    assert.equal(beforeFirstReminder.contestKey, 'BCC');
    assert.equal(beforeFirstReminder.reminderTime, Date.UTC(2026, 7, 29, 9, 30, 0));
    assert.equal(afterFirstReminder.contestKey, 'FCC');
    assert.equal(afterFirstReminder.reminderTime, Date.UTC(2026, 7, 29, 21, 30, 0));
});

test('BCC and FCC each expose their own next event time', () => {
    const now = Date.UTC(2026, 7, 29, 9, 30, 0);
    const nextBcc = getNextContestScheduleForContest('BCC', now);
    const nextFcc = getNextContestScheduleForContest('FCC', now);

    assert.equal(nextBcc.eventStart, Date.UTC(2026, 7, 29, 10, 0, 0));
    assert.equal(nextFcc.eventStart, Date.UTC(2026, 7, 29, 22, 0, 0));
});

test('reminders mention only subscribed users', async () => {
    const sentMessages = [];
    const client = {
        channels: {
            fetch: async channelId => {
                assert.equal(channelId, 'channel-id');
                return {
                    isTextBased: () => true,
                    send: async message => sentMessages.push(message)
                };
            }
        }
    };

    await sendUserReminder(client, {
        channelId: 'channel-id'
    }, 'Test reminder', ['user-1', 'user-2']);

    assert.deepEqual(sentMessages, [{
        content: '<@user-1>, <@user-2>\nTest reminder',
        allowedMentions: {
            parse: [],
            users: ['user-1', 'user-2']
        }
    }]);
});

test('reminders still send normally when no members opted in', async () => {
    const sentMessages = [];
    const client = {
        channels: {
            fetch: async () => ({
                isTextBased: () => true,
                send: async message => sentMessages.push(message)
            })
        }
    };

    await sendUserReminder(client, { channelId: 'channel-id' }, 'Test reminder');

    assert.deepEqual(sentMessages, [{
        content: 'Test reminder',
        allowedMentions: {
            parse: [],
            users: []
        }
    }]);
});

test('large subscriber lists are split without losing a user mention', () => {
    const users = Array.from({ length: 200 }, (_, index) => `user-${index}`);
    const batches = mentionBatches(users, 'x'.repeat(1800));

    assert.ok(batches.length > 1);
    assert.match(batches[0].content, /^<@user-0>/);
    assert.ok(batches.every(batch => batch.content.length <= 2000));
    assert.deepEqual(
        batches.flatMap(batch => batch.userIds).sort(),
        users.sort()
    );
});

test('a disabled notification does not send a Discord message', async () => {
    const client = {
        channels: {
            fetch: async () => {
                throw new Error('A disabled notification should not fetch the channel.');
            }
        }
    };
    const notificationStore = {
        getSetting: () => ({ enabled: false }),
        getEnabledUserIds: () => ['user-1']
    };

    const sent = await sendScheduledReminder(
        client,
        { channelId: 'channel-id', roleId: 'role-id' },
        notificationStore,
        'alto_mare',
        'This should not be sent.'
    );

    assert.equal(sent, false);
});
