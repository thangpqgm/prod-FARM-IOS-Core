import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/db/client.js';
import { FarmRepository } from '../src/db/repository.js';
import { interactions } from '../src/db/schema.js';
import { pruneOldData, rotateLogIfLarge } from '../src/nurture/retention.js';

test('pruneOldData drops old video rows and session files but keeps sessions and recent data', async () => {
    const repository = new FarmRepository(openDatabase(':memory:'));
    const account = repository.createAccount({ deviceUdid: 'u', handle: '@x', keywords: ['a'] });
    const session = repository.startSession(account, 'manual')!;
    const now = new Date('2026-10-26T12:00:00Z');
    const day = 86_400_000;
    const row = { sessionId: session.id, keyword: 'a', caption: 'c', matchedNiche: true, liked: false, saved: false, watchedMs: 1 };
    repository.db.insert(interactions).values([
        { ...row, at: new Date(now.getTime() - 40 * day) },
        { ...row, at: new Date(now.getTime() - 5 * day) },
    ]).run();

    const logDir = await mkdtemp(path.join(os.tmpdir(), 'pf-retention-'));
    const old = new Date(now.getTime() - 40 * day);
    for (const name of ['session-1.log', 'session-1-search-1.png', 'appium.log']) {
        await writeFile(path.join(logDir, name), 'x');
        await utimes(path.join(logDir, name), old, old);
    }
    await writeFile(path.join(logDir, 'session-2.log'), 'recent');

    assert.deepEqual(await pruneOldData(repository, logDir, 30, now), { interactions: 1, files: 2 });
    assert.equal(repository.db.select().from(interactions).all().length, 1);
    assert.ok(repository.session(session.id), 'the session row is kept');
    assert.deepEqual((await readdir(logDir)).sort(), ['appium.log', 'session-2.log'], 'process logs are rotated, not pruned');
    assert.deepEqual(await pruneOldData(repository, logDir, 0, now), { interactions: 0, files: 0 }, '0 keeps everything');
});

test('rotateLogIfLarge keeps one copy and empties the live file in place', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pf-rotate-'));
    const log = path.join(dir, 'appium.log');
    await writeFile(log, 'x'.repeat(50));
    assert.equal(await rotateLogIfLarge(log, 100), false);
    await writeFile(log, 'y'.repeat(200));
    assert.equal(await rotateLogIfLarge(log, 100), true);
    assert.equal((await stat(log)).size, 0);
    assert.equal(await readFile(`${log}.1`, 'utf8'), 'y'.repeat(200));
    assert.equal(await rotateLogIfLarge(path.join(dir, 'missing.log'), 100), false);
});
