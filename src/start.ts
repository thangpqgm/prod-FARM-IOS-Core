// `npm start`: everything the farm needs in one process tree — Appium, the
// WDA supervisor, the nurture scheduler and the dashboard. It prints the
// dashboard address; it never opens a browser.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './api/app.js';
import { openDatabase, databasePath } from './db/client.js';
import { FarmRepository } from './db/repository.js';
import { DeviceRegistrationService } from './devices/registration.js';
import { logDirectory, NurtureRunner } from './nurture/runner.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.WEB_HOST ?? '127.0.0.1';
const port = Number(process.env.WEB_PORT ?? 2610);
const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
const appiumPort = Number(process.env.APPIUM_PORT ?? 4725);

// The dashboard has no login: anyone who can reach it can tap the phones.
if (!LOOPBACK_HOSTS.has(host) && process.env.WEB_ALLOW_REMOTE !== 'true') {
    throw new Error(`WEB_HOST=${host} would expose the dashboard, which has no login, to the network. `
        + 'Keep 127.0.0.1, or set WEB_ALLOW_REMOTE=true if the network is trusted.');
}
if (process.platform !== 'darwin') {
    console.warn('Warning: driving iPhones needs macOS with Xcode. The dashboard still runs, but devices will not connect.');
}

const children: Array<{ name: string; child: ChildProcess }> = [];
let stopping = false;

function startChild(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
    mkdirSync(logDirectory(), { recursive: true });
    const logPath = path.join(logDirectory(), `${name}.log`);
    const logFd = openSync(logPath, 'a');
    let child: ChildProcess;
    try {
        child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] });
    } finally {
        closeSync(logFd);
    }
    child.once('exit', (code, signal) => {
        if (!stopping && code !== 0) console.error(`${name} exited (${signal ?? `code ${code}`}); see ${path.relative(process.cwd(), logPath)}`);
    });
    child.once('error', (error) => console.error(`${name} could not start: ${error.message}`));
    children.push({ name, child });
}

async function appiumRunning(): Promise<boolean> {
    try {
        return (await fetch(`http://${appiumHost}:${appiumPort}/status`, { signal: AbortSignal.timeout(1_500) })).ok;
    } catch {
        return false;
    }
}

const repository = new FarmRepository(openDatabase());
const orphaned = repository.failOrphanedSessions();
if (orphaned) console.log(`Marked ${orphaned} session(s) left running by the last shutdown as failed`);

if (await appiumRunning()) {
    console.log(`Using the Appium server already running on ${appiumHost}:${appiumPort}`);
} else {
    startChild('appium', process.execPath, [
        path.join(projectRoot, 'node_modules/appium/index.js'),
        '--address', appiumHost, '--base-path', '/', '--port', String(appiumPort), '--log-level', 'info',
    ], { APPIUM_HOME: path.join(projectRoot, '.appium2') });
}
// Exits straight away (code 0) when a supervisor is already running.
startChild('wda-service', process.execPath, ['--import', 'tsx', path.join(projectRoot, 'src/devices/wda-service.ts')]);

const runner = new NurtureRunner(repository);
const registrations = new DeviceRegistrationService();
await registrations.start();
const app = await createApp({ repository, runner, registrations, dashboard: true });
await app.listen({ host, port });
runner.startScheduler();

const address = app.server.address() as AddressInfo;
const shownHost = host.includes(':') ? `[${host}]` : host;
const shownPath = (file: string) => {
    const relative = path.relative(process.cwd(), file);
    return relative && !relative.startsWith('..') ? relative : file;
};
console.log([
    '',
    'Phone Farm đang chạy',
    `  Dashboard: http://${shownHost}:${address.port}`,
    `  Dữ liệu:   ${shownPath(databasePath())}`,
    `  Log:       ${shownPath(logDirectory())}/`,
    'Nhấn Ctrl+C để dừng.',
    '',
].join('\n'));

async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`\nĐang dừng (${signal})…`);
    await runner.close();
    await app.close();
    await registrations.close();
    await Promise.all(children.map(({ child }) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
    })));
    repository.db.$client.close();
    process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
