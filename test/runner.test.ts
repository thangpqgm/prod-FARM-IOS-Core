import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/db/client.js';
import { FarmRepository } from '../src/db/repository.js';
import { NurtureRunner, RunnerError } from '../src/nurture/runner.js';

process.env.FARM_LOG_DIR = await mkdtemp(path.join(os.tmpdir(), 'pf-runner-logs-'));

class FakeChild extends EventEmitter {
    signals: string[] = [];
    kill(signal: string) { this.signals.push(signal); return true; }
    exit(code: number | null) { this.emit('exit', code, null); }
}

function setup() {
    const repository = new FarmRepository(openDatabase(':memory:'));
    const children: FakeChild[] = [];
    const runner = new NurtureRunner(repository, {
        loadDevices: async () => [
            { name: 'A', udid: 'udid-a', pluginData: {} },
            { name: 'Off', udid: 'udid-off', disabled: true, pluginData: {} },
        ],
        spawnSession: () => {
            const child = new FakeChild();
            children.push(child);
            return child as unknown as ChildProcess;
        },
        windowMinutes: 60,
    });
    return { repository, runner, children };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('one session per phone; exit codes map to done / failed / stopped', async () => {
    const { repository, runner, children } = setup();
    const first = repository.createAccount({ deviceUdid: 'udid-a', handle: '@one', keywords: ['a'] });
    const second = repository.createAccount({ deviceUdid: 'udid-a', handle: '@two', keywords: ['b'] });

    const session = await runner.start(first.id);
    assert.equal(runner.activeSession('udid-a'), session.id);
    await assert.rejects(runner.start(second.id), (error: unknown) => error instanceof RunnerError && error.statusCode === 409);

    children[0]!.exit(0);
    await settle();
    assert.equal(runner.activeSession('udid-a'), undefined);
    assert.equal(repository.session(session.id)?.status, 'done');

    const failing = await runner.start(second.id);
    children[1]!.exit(1);
    await until(() => repository.session(failing.id)?.status !== 'running');
    assert.equal(repository.session(failing.id)?.status, 'failed');

    const stopping = await runner.start(first.id);
    assert.equal(runner.stop(stopping.id), true);
    assert.deepEqual(children[2]!.signals, ['SIGTERM']);
    children[2]!.exit(null);
    await settle();
    assert.equal(repository.session(stopping.id)?.status, 'stopped');
});

test('disabled phones and keyword-less accounts are refused', async () => {
    const { repository, runner } = setup();
    const off = repository.createAccount({ deviceUdid: 'udid-off', handle: '@off', keywords: ['a'] });
    const empty = repository.createAccount({ deviceUdid: 'udid-a', handle: '@empty', keywords: [] });
    await assert.rejects(runner.start(off.id), /tắt/);
    await assert.rejects(runner.start(empty.id), /keyword/);
});

test('tick starts a due daily slot exactly once', async () => {
    const { repository, runner, children } = setup();
    const account = repository.createAccount({ deviceUdid: 'udid-a', handle: '@daily', keywords: ['a'], dailyTimes: ['08:00'] });
    repository.createAccount({ deviceUdid: 'udid-a', handle: '@paused', keywords: ['a'], dailyTimes: ['08:00'], enabled: false });

    await runner.tick(new Date(2026, 9, 10, 7, 30));
    assert.equal(children.length, 0, 'not due yet');

    await runner.tick(new Date(2026, 9, 10, 8, 5));
    assert.equal(children.length, 1);
    assert.equal(repository.lastSession(account.id)?.slot, '2026-10-10 08:00');
    assert.equal(repository.lastSession(account.id)?.trigger, 'schedule');

    children[0]!.exit(0);
    await settle();
    await runner.tick(new Date(2026, 9, 10, 8, 30));
    assert.equal(children.length, 1, 'the same slot does not run twice');
});

test('recordInteraction bumps the session counters', () => {
    const repository = new FarmRepository(openDatabase(':memory:'));
    const account = repository.createAccount({ deviceUdid: 'u', handle: '@x', keywords: ['a'] });
    const session = repository.startSession(account, 'manual')!;
    repository.recordInteraction(session.id, { keyword: 'a', caption: 'a b', matchedNiche: true, liked: true, saved: false, watchedMs: 5000 });
    repository.recordInteraction(session.id, { keyword: null, caption: 'zzz', matchedNiche: false, liked: false, saved: false, watchedMs: 2000 });
    const counted = repository.session(session.id)!;
    assert.equal(counted.videosViewed, 2);
    assert.equal(counted.likes, 1);
    assert.equal(counted.saves, 0);
    assert.equal(counted.nicheMatches, 1);

    repository.finishSession(session.id, 'done');
    repository.finishSession(session.id, 'failed', 'late');
    assert.equal(repository.session(session.id)?.status, 'done', 'first outcome wins');
});
