// Reminder changes must wait until Discord has accepted the officer's request.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageFlags } = require('discord.js');
const DungeonRecruitment = require('../commands/dungeon_recruitment.js');

function fixture(options = {}) {
    // Avoid the constructor's production storage restoration and timers.
    const command = Object.assign(Object.create(DungeonRecruitment.prototype), {
        officerRoleID: 'officer', activeRuns: new Map()
    });
    const run = { id: 'run', dungeonName: 'Forlorn', partyLeaderId: 'leader', closed: false,
        createdAt: Date.now(), remindersEnabled: true, reminderCounter: 2,
        remindersStopAt: Date.now() + 60_000 };
    command.activeRuns.set(run.id, run);
    const calls = [];
    command.saveRuns = () => { calls.push('save'); };
    const interaction = {
        user: { id: 'officer' }, calls,
        member: { roles: { cache: new Collection([['officer', { id: 'officer' }]]) } },
        options: { getString: key => options[key] ?? null },
        async deferReply(payload) { calls.push(['defer', payload]); this.deferred = true; },
        async reply(payload) { calls.push(['reply', payload]); },
        async editReply(payload) { calls.push(['edit', payload]); }
    };
    return { command, run, interaction, calls };
}

for (const [mode, options] of [
    ['one run', { active_dungeon_runs: 'run', post_reminder: 'no' }],
    ['all runs', { disable_all_reminders: 'yes' }]
]) {
    test(`reminder changes for ${mode} wait for acknowledgement`, async () => {
        const { command, run, interaction, calls } = fixture(options);
        let accept;
        const gate = new Promise(resolve => { accept = resolve; });
        interaction.deferReply = payload => {
            calls.push(['defer', payload]);
            return gate.then(() => { interaction.deferred = true; });
        };
        const pending = command.executeReminderCommand(interaction);
        assert.deepEqual(calls, [['defer', { flags: MessageFlags.Ephemeral }]]);
        assert.equal(run.remindersEnabled, true);
        accept(); await pending;
        assert.equal(run.remindersEnabled, false);
        assert.deepEqual(calls.map(call => typeof call === 'string' ? call : call[0]), ['defer', 'save', 'edit']);
        assert.match(calls[2][1].content, /Dungeon reminders updated/u);
    });

    test(`expired acknowledgement for ${mode} leaves reminder state and storage untouched`, async () => {
        const { command, run, interaction, calls } = fixture(options);
        const before = { ...run };
        interaction.deferReply = async () => { throw Object.assign(Error('Unknown interaction'), { code: 10062 }); };
        await assert.rejects(command.executeReminderCommand(interaction), error => error.code === 10062);
        assert.deepEqual(run, before);
        assert.deepEqual(calls, []);
    });

    test(`reminder changes for ${mode} report success only after persistence completes`, async () => {
        const { command, interaction, calls } = fixture(options);
        let accept, entered;
        const saving = new Promise(resolve => { accept = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        command.saveRuns = async () => { calls.push('save'); entered(); await saving; };
        const pending = command.executeReminderCommand(interaction);
        await started;
        assert.deepEqual(calls.map(call => typeof call === 'string' ? call : call[0]), ['defer', 'save']);
        accept();
        await pending;
        assert.match(calls.at(-1)[1].content, /Dungeon reminders updated/u);
    });

    test(`failed reminder persistence for ${mode} restores state without claiming success`, async () => {
        const { command, run, interaction, calls } = fixture(options);
        command.saveRuns = async () => { throw new Error('disk full'); };
        await assert.rejects(command.executeReminderCommand(interaction), /disk full/);
        assert.equal(run.remindersEnabled, true);
        assert.equal(run.reminderCounter, 2);
        assert.equal(calls.some(call => call[0] === 'edit'), false);
        assert.equal(command.runButtonQueues.size, 0);
    });
}

test('a run closing while acknowledgement is pending cannot be re-enabled', async () => {
    for (const options of [{ active_dungeon_runs: 'run', post_reminder: 'yes' }, { disable_all_reminders: 'no' }]) {
        const { command, run, interaction } = fixture(options);
        run.remindersEnabled = false;
        interaction.deferReply = async () => { run.closed = true; interaction.deferred = true; };
        await command.executeReminderCommand(interaction);
        assert.equal(run.remindersEnabled, false);
    }
});

test('a dungeon close waits until a reminder change has finished saving', async () => {
    const { command, run, interaction } = fixture({ active_dungeon_runs: 'run', post_reminder: 'no' });
    let accept, entered;
    const saving = new Promise(resolve => { accept = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    command.saveRuns = async () => { entered(); await saving; };
    const reminder = command.executeReminderCommand(interaction);
    await started;
    let closed = false;
    command.closeRunNow = async () => { closed = true; run.closed = true; };
    const close = command.closeRun(run.id, 'deadline', {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    accept();
    await Promise.all([reminder, close]);
    assert.equal(closed, true);
    assert.equal(command.runButtonQueues.size, 0);
});
