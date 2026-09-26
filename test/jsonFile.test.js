'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTextIfChanged } = require('../utils/jsonFile.js');

test('a failed JSON snapshot write preserves the previous file and removes the partial temp file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-json-write-'));
    const file = path.join(directory, 'state.json');
    const temp = `${file}.tmp`;
    fs.writeFileSync(file, 'previous');

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (filePath, contents, ...options) => {
        if (filePath === temp) {
            originalWriteFileSync(filePath, 'partial');
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return originalWriteFileSync(filePath, contents, ...options);
    };
    try {
        assert.throws(() => writeTextIfChanged(file, temp, 'updated'), { code: 'ENOSPC' });
    } finally {
        fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
    assert.equal(fs.existsSync(temp), false);
    assert.equal(writeTextIfChanged(file, temp, 'updated'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'updated');
});
