import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FarmRepository } from '../db/repository.js';
import type { Session, SessionTrigger } from '../db/schema.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { dueSlots } from './schedule.js';

const NURTURE_ENTRYPOINT = fileURLToPath(new URL('../tiktok/nurture.ts', import.meta.url));

export function logDirectory(): string {
    return path.resolve(process.env.FARM_LOG_DIR ?? 'logs');
}

export function sessionLogPath(sessionId: number): string {
    return path.join(logDirectory(), `session-${sessionId}.log`);
}

export class RunnerError extends Error {
    constructor(readonly statusCode: number, message: string) { super(message); }
}

/** What the web app needs from the runner; the tests substitute a fake. */
export interface NurtureControl {
    activeSession(deviceUdid: string): number | undefined;
    start(accountId: number): Promise<Session>;
    stop(sessionId: number): boolean;
}

interface RunningSession {
    sessionId: number;
    child: ChildProcess;
    stopRequested: boolean;
    exited: Promise<void>;
}

export interface NurtureRunnerOptions {
    loadDevices?: () => Promise<RegisteredDevice[]>;
    spawnSession?: (sessionId: number, logPath: string) => ChildProcess;
    windowMinutes?: number;
}

function spawnNurture(sessionId: number, logPath: string): ChildProcess {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');
    try {
        return spawn(process.execPath, ['--import', 'tsx', NURTURE_ENTRYPOINT], {
            cwd: process.cwd(),
            env: { ...process.env, NURTURE_SESSION_ID: String(sessionId) },
            stdio: ['ignore', logFd, logFd],
        });
    } finally {
        closeSync(logFd);
    }
}

async function lastLogLine(logPath: string): Promise<string | undefined> {
    try {
        const lines = (await readFile(logPath, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean);
        return lines.at(-1)?.slice(0, 500);
    } catch {
        return undefined;
    }
}

/**
 * Runs one nurture process per phone. A phone runs a single session at a
 * time; scheduled slots that find their phone busy are retried on the next
 * tick until their run window closes.
 */
export class NurtureRunner implements NurtureControl {
    private readonly running = new Map<string, RunningSession>();
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly spawnSession: (sessionId: number, logPath: string) => ChildProcess;
    private readonly windowMinutes: number;
    private timer: NodeJS.Timeout | undefined;
    private ticking = false;

    constructor(private readonly repository: FarmRepository, options: NurtureRunnerOptions = {}) {
        this.loadDevices = options.loadDevices ?? (() => loadRegisteredDevices());
        this.spawnSession = options.spawnSession ?? spawnNurture;
        this.windowMinutes = options.windowMinutes ?? Number(process.env.NURTURE_RUN_WINDOW_MINUTES ?? 120);
    }

    activeSession(deviceUdid: string): number | undefined {
        return this.running.get(deviceUdid)?.sessionId;
    }

    async start(accountId: number, trigger: SessionTrigger = 'manual', slot: string | null = null): Promise<Session> {
        const account = this.repository.account(accountId);
        if (!account) throw new RunnerError(404, 'Không tìm thấy acc');
        if (account.keywords.length === 0) throw new RunnerError(400, 'Acc chưa có keyword nào');
        const device = (await this.loadDevices()).find(({ udid }) => udid === account.deviceUdid);
        if (!device) throw new RunnerError(409, 'Máy của acc này chưa được đăng ký');
        if (device.disabled) throw new RunnerError(409, 'Máy của acc này đang bị tắt');
        if (this.running.has(account.deviceUdid)) throw new RunnerError(409, 'Máy đang chạy một phiên khác');

        const session = this.repository.startSession(account, trigger, slot);
        if (!session) throw new RunnerError(409, `Khung giờ ${slot} đã chạy rồi`);
        const logPath = sessionLogPath(session.id);
        let child: ChildProcess;
        try {
            child = this.spawnSession(session.id, logPath);
        } catch (error) {
            this.repository.finishSession(session.id, 'failed', error instanceof Error ? error.message : String(error));
            throw error;
        }
        const entry: RunningSession = { sessionId: session.id, child, stopRequested: false, exited: Promise.resolve() };
        entry.exited = new Promise<void>((resolve) => {
            child.once('exit', (code) => {
                void (async () => {
                    if (this.running.get(account.deviceUdid) === entry) this.running.delete(account.deviceUdid);
                    if (code === 0) this.repository.finishSession(session.id, 'done');
                    else if (entry.stopRequested) this.repository.finishSession(session.id, 'stopped');
                    else this.repository.finishSession(session.id, 'failed', await lastLogLine(logPath) ?? `Exited with code ${code}`);
                    resolve();
                })();
            });
        });
        child.once('error', (error) => {
            console.error(`[nurture] session ${session.id}: ${error.message}`);
        });
        this.running.set(account.deviceUdid, entry);
        console.log(`[nurture] session ${session.id} started for ${account.handle} (${trigger}${slot ? ` ${slot}` : ''})`);
        return session;
    }

    stop(sessionId: number): boolean {
        for (const entry of this.running.values()) {
            if (entry.sessionId !== sessionId) continue;
            entry.stopRequested = true;
            entry.child.kill('SIGTERM');
            return true;
        }
        return false;
    }

    /** Starts every due daily slot whose phone is free. */
    async tick(now = new Date()): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            for (const account of this.repository.listAccounts()) {
                if (!account.enabled || this.running.has(account.deviceUdid)) continue;
                const slot = dueSlots(account.dailyTimes, now, this.windowMinutes)
                    .find((candidate) => !this.repository.hasSlot(account.id, candidate));
                if (!slot) continue;
                try {
                    await this.start(account.id, 'schedule', slot);
                } catch (error) {
                    // A missing/disabled device or no keywords: try again next tick while the window is open.
                    if (!(error instanceof RunnerError)) throw error;
                }
            }
        } finally {
            this.ticking = false;
        }
    }

    startScheduler(intervalMs = 30_000): void {
        const run = () => void this.tick().catch((error) => console.error('[nurture] scheduler tick failed', error));
        this.timer = setInterval(run, intervalMs);
        run();
    }

    async close(): Promise<void> {
        clearInterval(this.timer);
        const entries = [...this.running.values()];
        for (const entry of entries) {
            entry.stopRequested = true;
            entry.child.kill('SIGTERM');
        }
        await Promise.race([
            Promise.all(entries.map(({ exited }) => exited)),
            new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
    }
}
