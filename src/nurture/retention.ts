import { copyFile, readdir, stat, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { FarmRepository } from '../db/repository.js';

export const DEFAULT_RETENTION_DAYS = 30;
const SESSION_FILE = /^session-\d+(\.log|-.+\.png)$/;

export function retentionDays(): number {
    const value = Number(process.env.FARM_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETENTION_DAYS;
}

export interface PruneResult {
    interactions: number;
    files: number;
}

/**
 * Keeps the farm's disk use flat: per-video interaction rows and per-session
 * logs/screenshots older than `days` are deleted. Session rows stay — they
 * are tiny and hold the history counters. `days` = 0 keeps everything.
 * SQLite reuses the freed pages, so farm.db stops growing once it holds `days` of data.
 */
export async function pruneOldData(repository: FarmRepository, logDir: string, days: number, now = new Date()): Promise<PruneResult> {
    if (days <= 0) return { interactions: 0, files: 0 };
    const before = new Date(now.getTime() - days * 86_400_000);
    const interactions = repository.pruneInteractions(before);
    let files = 0;
    let names: string[] = [];
    try {
        names = await readdir(logDir);
    } catch { /* no log folder yet */ }
    for (const name of names) {
        if (!SESSION_FILE.test(name)) continue;
        const file = path.join(logDir, name);
        try {
            if ((await stat(file)).mtime < before) {
                await unlink(file);
                files += 1;
            }
        } catch { /* removed concurrently */ }
    }
    return { interactions, files };
}

/**
 * Keeps one previous copy of a long-running process log and empties it once
 * it passes `maxBytes`. Copy-then-truncate (not rename) because Appium and the
 * WDA supervisor keep the file open; they write in append mode, so after the
 * truncate their next line simply lands at the start of the emptied file.
 */
export async function rotateLogIfLarge(logPath: string, maxBytes = 10 * 1024 * 1024): Promise<boolean> {
    try {
        if ((await stat(logPath)).size <= maxBytes) return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
    await copyFile(logPath, `${logPath}.1`);
    await truncate(logPath, 0);
    return true;
}
