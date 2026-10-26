import { createTestApp, inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// registry.ts resolves DEVICES_CONFIG_PATH at first import, so set it before createTestApp.
const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'pf-accounts-')), 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
await writeFile(configPath, JSON.stringify([
    { name: 'Phone A', udid: 'udid-a', pluginData: {} },
    { name: 'Phone B', udid: 'udid-b', pluginData: {} },
]));

test('accounts: create, validate, update, list with niche keywords, delete', async (context) => {
    const { app } = await createTestApp();
    context.after(() => app.close());

    const invalid = await inject(app, { method: 'POST', url: '/api/accounts', payload: { deviceUdid: 'udid-a', handle: 'x', keywords: [] } });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /keyword/);

    const unknownDevice = await inject(app, { method: 'POST', url: '/api/accounts', payload: { deviceUdid: 'nope', handle: 'x', keywords: ['a'] } });
    assert.equal(unknownDevice.statusCode, 400);

    const created = await inject(app, {
        method: 'POST', url: '/api/accounts',
        payload: { deviceUdid: 'udid-a', handle: 'skin_acc', keywords: '#skincare, review mỹ phẩm, #SKINCARE', dailyTimes: ['20:00', '08:00'] },
    });
    assert.equal(created.statusCode, 201);
    const account = created.json();
    assert.equal(account.handle, '@skin_acc', 'handle gets its @');
    assert.deepEqual(account.keywords, ['#skincare', 'review mỹ phẩm']);
    assert.deepEqual(account.dailyTimes, ['08:00', '20:00']);
    assert.equal(account.nicheFilter, true);
    assert.equal(account.personality, 'casual');

    const duplicate = await inject(app, { method: 'POST', url: '/api/accounts', payload: { deviceUdid: 'udid-a', handle: '@skin_acc', keywords: ['a'] } });
    assert.equal(duplicate.statusCode, 409);

    const badTime = await inject(app, { method: 'PATCH', url: `/api/accounts/${account.id}`, payload: { dailyTimes: ['8am'] } });
    assert.equal(badTime.statusCode, 400);

    const updated = await inject(app, {
        method: 'PATCH', url: `/api/accounts/${account.id}`,
        payload: { keywords: ['#makeup'], personality: 'engaged', minutesPerSession: 20, nicheFilter: false },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().keywords, ['#makeup']);
    assert.equal(updated.json().personality, 'engaged');
    assert.equal(updated.json().handle, '@skin_acc', 'untouched fields stay');

    const overview = await inject(app, { method: 'GET', url: '/api/overview' });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().accounts.length, 1);
    assert.equal(overview.json().devices.find((d: { udid: string }) => d.udid === 'udid-a').accountCount, 1);

    const removed = await inject(app, { method: 'DELETE', url: `/api/accounts/${account.id}` });
    assert.equal(removed.statusCode, 204);
    assert.equal((await inject(app, { method: 'GET', url: '/api/accounts' })).json().length, 0);
});

test('nurture now, the running guard and stop', async (context) => {
    const { app, runner } = await createTestApp();
    context.after(() => app.close());
    const account = (await inject(app, { method: 'POST', url: '/api/accounts', payload: { deviceUdid: 'udid-b', handle: '@gym', keywords: ['#gym'] } })).json();

    const started = await inject(app, { method: 'POST', url: `/api/accounts/${account.id}/nurture` });
    assert.equal(started.statusCode, 201);
    assert.deepEqual(runner.started, [account.id]);
    const sessionId = started.json().id;

    const listed = (await inject(app, { method: 'GET', url: '/api/accounts?deviceUdid=udid-b' })).json();
    assert.equal(listed[0].running, true);
    assert.equal(listed[0].lastSession.id, sessionId);

    const tap = await inject(app, { method: 'POST', url: '/api/devices/udid-b/remote/action', payload: { type: 'home' } });
    assert.equal(tap.statusCode, 409, 'no remote input while a session runs');
    const deleteBusy = await inject(app, { method: 'DELETE', url: `/api/accounts/${account.id}` });
    assert.equal(deleteBusy.statusCode, 409);

    const stopped = await inject(app, { method: 'POST', url: `/api/sessions/${sessionId}/stop` });
    assert.equal(stopped.statusCode, 202);
    assert.deepEqual(runner.stopped, [sessionId]);

    const sessions = (await inject(app, { method: 'GET', url: `/api/sessions?accountId=${account.id}` })).json();
    assert.equal(sessions.length, 1);
});

test('a device with accounts cannot be removed, and cross-origin writes are blocked', async (context) => {
    const { app } = await createTestApp();
    context.after(() => app.close());
    await inject(app, { method: 'POST', url: '/api/accounts', payload: { deviceUdid: 'udid-a', handle: '@keep', keywords: ['a'] } });

    const blocked = await inject(app, { method: 'DELETE', url: '/api/devices/udid-a' });
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error, /@keep/);

    const csrf = await app.inject({ method: 'POST', url: '/api/accounts', headers: { origin: 'http://evil.example' }, payload: {} });
    assert.equal(csrf.statusCode, 403);
});
