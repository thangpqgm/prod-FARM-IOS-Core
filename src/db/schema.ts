import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export type Personality = 'skimmer' | 'casual' | 'engaged';
export type SessionStatus = 'running' | 'done' | 'failed' | 'stopped';
export type SessionTrigger = 'manual' | 'schedule';

// One TikTok account signed in on one phone, and the niche it is nurtured for.
export const accounts = sqliteTable('accounts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceUdid: text('device_udid').notNull(),
    handle: text('handle').notNull(),
    /** Search terms for the niche; a leading # searches the hashtag. */
    keywords: text('keywords', { mode: 'json' }).$type<string[]>().notNull(),
    personality: text('personality').$type<Personality>().notNull().default('casual'),
    minutesPerSession: integer('minutes_per_session').notNull().default(15),
    keywordsPerSession: integer('keywords_per_session').notNull().default(2),
    /** Minutes of the For You feed after the searches, to see whether the niche stuck. */
    forYouMinutes: integer('for_you_minutes').notNull().default(3),
    /** Host-local "HH:MM" start times; empty means manual runs only. */
    dailyTimes: text('daily_times', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** OCR each caption and only like/save videos that mention the niche. */
    nicheFilter: integer('niche_filter', { mode: 'boolean' }).notNull().default(true),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex('accounts_device_handle').on(table.deviceUdid, table.handle)]);

export const sessions = sqliteTable('sessions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    deviceUdid: text('device_udid').notNull(),
    trigger: text('trigger').$type<SessionTrigger>().notNull(),
    /** "YYYY-MM-DD HH:MM" of the daily time that started it, so a slot runs once. */
    slot: text('slot'),
    status: text('status').$type<SessionStatus>().notNull().default('running'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    videosViewed: integer('videos_viewed').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    nicheMatches: integer('niche_matches').notNull().default(0),
    error: text('error'),
}, (table) => [
    index('sessions_account_started').on(table.accountId, table.startedAt),
    uniqueIndex('sessions_account_slot').on(table.accountId, table.slot),
]);

// One row per video watched, to check whether the bot is actually staying in the niche.
export const interactions = sqliteTable('interactions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    /** The search term that led here; null on the For You feed. */
    keyword: text('keyword'),
    caption: text('caption'),
    /** null when the niche filter is off. */
    matchedNiche: integer('matched_niche', { mode: 'boolean' }),
    liked: integer('liked', { mode: 'boolean' }).notNull(),
    saved: integer('saved', { mode: 'boolean' }).notNull(),
    watchedMs: integer('watched_ms').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, (table) => [index('interactions_session').on(table.sessionId)]);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
