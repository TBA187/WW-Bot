'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InteractionDiagnostics, setInteractionContext } = require('../utils/interactionDiagnostics.js');

function fixture(options = {}) {
    const rest = new EventEmitter(), warnings = [];
    let elapsed = 0;
    const tracker = new InteractionDiagnostics({ rest, now: () => 1000, clock: () => elapsed,
        consoleObject: { warn: value => warnings.push(value) },
        eventLoopUtilization: (...args) => ({ active: args.length ? 120 : 0 }), ...options });
    const interaction = { id: '123', channelId: 'channel', user: { id: 'officer' },
        commandName: 'pvp_crown', createdTimestamp: 807 };
    const advance = ms => { elapsed += ms; };
    const response = (id, status, retries = 0, retryAfter = null) => rest.emit('response',
        { path: `/interactions/${id}/private-interaction-token/callback`, retries, data: { token: 'private-body' } },
        { status, headers: { get: () => retryAfter } });
    return { rest, warnings, tracker, interaction, advance, response };
}

test('expired acknowledgements distinguish local delay, API wait, retries and rate limits without retaining tokens', async () => {
    const f = fixture();
    f.interaction.deferReply = async function () {
        assert.equal(this, f.interaction);
        f.response('other', 500, 9);
        f.response('123', 429, 0, '0.5');
        f.response('123', 500);
        f.advance(3501);
        f.response('123', 404, 1);
        throw Object.assign(new Error('Unknown interaction'), { code: 10062, status: 404 });
    };
    f.tracker.track(f.interaction);
    setInteractionContext(f.interaction, { server: 'Silver', targetId: 'winner', phase: 'acknowledging crown', crownSaved: false });
    f.advance(7);
    await assert.rejects(f.interaction.deferReply(), error => error.code === 10062);
    const message = f.tracker.describe(f.interaction, f.tracker.errorReason(f.interaction, 10062));
    for (const text of ['193 ms old on arrival', '7 ms before deferReply', '3501 ms awaiting acknowledgement',
        '3701 ms old after acknowledgement', '120 ms event loop active', 'HTTP 404', '3 HTTP response(s)',
        '1 transport/server retry(s)', '1 rate limit(s)', '500 ms requested rate-limit wait',
        'server Silver', 'target winner', 'No crown or defense was recorded', 'Retry the command']) assert.ok(message.includes(text), text);
    assert.doesNotMatch(message, /private|\/interactions\//u);
    assert.deepEqual(f.warnings, []);
    assert.equal(f.tracker.active.size, 0);
    assert.equal(f.rest.listenerCount('response'), 0);
});

test('slow successful acknowledgements never invite a retry while the command is still processing', async () => {
    const f = fixture();
    f.interaction.deferReply = async () => { f.advance(1900); f.response('123', 204); f.interaction.deferred = true; return 'accepted'; };
    f.tracker.track(f.interaction);
    setInteractionContext(f.interaction, { crownSaved: false });
    assert.equal(await f.interaction.deferReply(), 'accepted');
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /acknowledgement was slow/u);
    assert.doesNotMatch(f.warnings[0], /Retry|No crown|Do not repeat/u);
    assert.equal(f.rest.listenerCount('response'), 0);
});

test('fast responses remain quiet and later replies do not replace initial timings or saved state', async () => {
    const f = fixture();
    f.interaction.deferReply = async () => { f.advance(50); f.interaction.deferred = true; };
    f.interaction.reply = async payload => { f.advance(5000); return payload; };
    f.tracker.track(f.interaction);
    const wrapped = f.interaction.deferReply;
    f.tracker.track(f.interaction);
    assert.equal(f.interaction.deferReply, wrapped);
    await f.interaction.deferReply();
    setInteractionContext(f.interaction, { crownSaved: true, phase: 'public crown response' });
    assert.equal(await f.interaction.reply('later'), 'later');
    const message = f.tracker.describe(f.interaction, f.tracker.errorReason(f.interaction, 10062));
    assert.match(message, /was rejected after acknowledgement/u);
    assert.match(message, /50 ms awaiting acknowledgement/u);
    assert.match(message, /is saved\. Do not repeat/u);
    assert.deepEqual(f.warnings, []);
});

test('already-acknowledged errors and uncertain saves direct staff to check history before retrying', async () => {
    const f = fixture();
    f.tracker.track(f.interaction);
    setInteractionContext(f.interaction, { crownSaved: false });
    const duplicate = f.tracker.describe(f.interaction, f.tracker.errorReason(f.interaction, 40060));
    assert.match(duplicate, /was already acknowledged/u);
    assert.match(duplicate, /Check \/pvp_history before retrying/u);
    assert.doesNotMatch(duplicate, /Retry the command/u);
    setInteractionContext(f.interaction, { phase: 'saving crown', crownSaved: undefined });
    const uncertain = f.tracker.describe(f.interaction, 'failed');
    assert.match(uncertain, /save status is uncertain/u);
    assert.doesNotMatch(uncertain, /No crown or defense/u);
});

test('overlapping acknowledgements retain their own HTTP statuses and clean up shared listeners', async () => {
    const f = fixture();
    let completeFirst, completeSecond;
    f.interaction.deferReply = () => new Promise(resolve => { completeFirst = resolve; });
    const second = { ...f.interaction, id: '456', deferReply: () => new Promise(resolve => { completeSecond = resolve; }) };
    f.tracker.track(f.interaction); f.tracker.track(second);
    const firstReply = f.interaction.deferReply(), secondReply = second.deferReply();
    assert.equal(f.rest.listenerCount('response'), 1);
    f.response('123', 204); f.response('456', 200);
    completeFirst(); await firstReply;
    assert.equal(f.rest.listenerCount('response'), 1);
    completeSecond(); await secondReply;
    assert.equal(f.rest.listenerCount('response'), 0);
    assert.match(f.tracker.describe(f.interaction, 'finished'), /HTTP 204/u);
    assert.match(f.tracker.describe(second, 'finished'), /HTTP 200/u);
});

test('shutdown and failed diagnostic delivery cannot interfere with acknowledgement results', async () => {
    const f = fixture({ consoleObject: { warn: () => { throw Error('Logger unavailable'); } } });
    let complete;
    f.interaction.deferReply = () => new Promise(resolve => { complete = resolve; });
    f.tracker.track(f.interaction);
    const reply = f.interaction.deferReply();
    f.tracker.stop();
    assert.equal(f.rest.listenerCount('response'), 0);
    assert.equal(f.tracker.active.size, 0);
    f.advance(2500); complete('accepted');
    assert.equal(await reply, 'accepted');
});

test('initial error recovery stops at the Discord deadline and cannot acknowledge an accepted interaction twice', async () => {
    const f = fixture();
    f.tracker.track(f.interaction);
    assert.equal(f.tracker.canAcknowledge(f.interaction), true);
    f.advance(2806);
    assert.equal(f.tracker.canAcknowledge(f.interaction), true);
    f.advance(1);
    assert.equal(f.tracker.canAcknowledge(f.interaction), false);
    const accepted = fixture();
    accepted.interaction.deferReply = async () => {};
    accepted.tracker.track(accepted.interaction);
    await accepted.interaction.deferReply();
    assert.equal(accepted.tracker.canAcknowledge(accepted.interaction), false);
});
