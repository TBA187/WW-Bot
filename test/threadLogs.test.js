const test = require('node:test');
const assert = require('node:assert/strict');

const { isAutomaticArchiveUpdate } = require('../events/threadLogs.js');

test('automatic thread archives without an audit entry are ignored', () => {
    assert.equal(
        isAutomaticArchiveUpdate({ archived: false }, { archived: true }, null),
        true
    );
});

test('manual archives and unarchives continue to be logged', () => {
    assert.equal(
        isAutomaticArchiveUpdate({ archived: false }, { archived: true }, { executor: { id: 'staff' } }),
        false
    );
    assert.equal(
        isAutomaticArchiveUpdate({ archived: true }, { archived: false }, null),
        false
    );
});
