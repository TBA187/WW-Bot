'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeHealth, readContainerMemory, discordCacheCounts } = require('../utils/runtimeHealth.js');
const MIB = 1024 * 1024;

function readFixture(values) {
    return async file => {
        if (!(file in values)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return values[file];
    };
}

test('container memory supports v2 and v1 accounting, separately showing file cache', async () => {
    assert.deepEqual(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory.current': '450887680\n', '/sys/fs/cgroup/memory.max': '536870912\n',
        '/sys/fs/cgroup/memory.stat': 'anon 360000000\nfile 90000000\n'
    })), { used: 450887680, limit: 536870912, fileCache: 90000000 });
    assert.deepEqual(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '100',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '200',
        '/sys/fs/cgroup/memory/memory.stat': 'cache 10\ntotal_cache 15\n'
    })), { used: 100, limit: 200, fileCache: 15 });
});

test('unlimited and unavailable cgroups omit a misleading memory percentage', async () => {
    assert.equal(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory.current': '100', '/sys/fs/cgroup/memory.max': 'max'
    })), null);
    assert.equal(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '100',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712'
    })), null);
    assert.equal(await readContainerMemory(readFixture({})), null);
});

test('runtime samples count caches without fetching Discord or treating buffers as extra RSS', async () => {
    const client = { channels: { cache: new Map([['a', { messages: { cache: new Map([['x', {}], ['y', {}]]) } }], ['b', {}]]) },
        guilds: { cache: new Map([['g', { members: { cache: new Map([['u', {}]]) } }]]) },
        users: { cache: new Map([['u', {}], ['v', {}]]) } };
    assert.deepEqual(discordCacheCounts(client), { messages: 2, members: 1, users: 2 });
    const lines = [];
    let rss = 100 * MIB;
    const health = new RuntimeHealth({ client, consoleObject: { log: line => lines.push(line) },
        memoryUsage: () => ({ rss, heapUsed: 20 * MIB, heapTotal: 40 * MIB, external: 10 * MIB, arrayBuffers: 5 * MIB }),
        heapLimit: () => 256 * MIB, containerMemory: async () => ({ used: 400 * MIB, limit: 512 * MIB, fileCache: 80 * MIB }),
        ocrSnapshot: () => ({ workers: 1, pending: 2, creating: false }) });
    await health.sample();
    rss = 90 * MIB; await health.sample();
    assert.match(lines[0], /RSS 100.0 MiB/);
    assert.match(lines[0], /main heap 20.0\/40.0 MiB/);
    assert.match(lines[0], /container 400.0\/512.0 MiB \(78.1%\)/);
    assert.match(lines[0], /container file cache 80.0 MiB/);
    assert.match(lines[0], /2 messages, 1 members, 2 users/);
    assert.match(lines[0], /OCR: 1 worker\(s\), 2 queued\/active task\(s\)/);
    assert.match(lines[1], /peak sampled 100.0 MiB/);
});

test('memory reporting has one unreferenced timer and suppresses late output after shutdown', async () => {
    let complete, scheduled = 0, cancelled = 0, unreferenced = 0;
    const lines = [];
    const timer = { unref() { unreferenced++; } };
    const health = new RuntimeHealth({ consoleObject: { log: line => lines.push(line) },
        containerMemory: () => new Promise(resolve => { complete = resolve; }),
        schedule: () => { scheduled++; return timer; }, cancel: value => { assert.equal(value, timer); cancelled++; } });
    health.start(); health.start();
    assert.equal(scheduled, 1); assert.equal(unreferenced, 1);
    await health.sample();
    health.stop(); health.stop(); complete(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1); assert.deepEqual(lines, []);
});
