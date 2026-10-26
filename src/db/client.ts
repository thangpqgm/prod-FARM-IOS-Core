import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type FarmDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function databasePath(): string {
    return path.resolve(process.env.FARM_DB_PATH ?? 'farm.db');
}

/**
 * Opens (creating if needed) the farm's SQLite file and applies pending
 * migrations. WAL lets the web process and every nurture process write to the
 * same file; busy_timeout makes a writer wait for a lock instead of failing.
 */
export function openDatabase(file = databasePath()): FarmDatabase {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const client = new Database(file);
    client.pragma('journal_mode = WAL');
    client.pragma('busy_timeout = 5000');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client, { schema });
    migrate(db, { migrationsFolder });
    return db;
}
