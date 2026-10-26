import { and, desc, eq, sql } from 'drizzle-orm';

import type { FarmDatabase } from './client.js';
import {
    accounts, interactions, sessions,
    type Account, type NewAccount, type Session, type SessionStatus, type SessionTrigger,
} from './schema.js';

export type AccountInput = Omit<NewAccount, 'id' | 'createdAt'>;

export interface AccountWithLastSession extends Account {
    lastSession: Session | null;
}

export interface InteractionInput {
    keyword: string | null;
    caption: string | null;
    matchedNiche: boolean | null;
    liked: boolean;
    saved: boolean;
    watchedMs: number;
}

export class FarmRepository {
    constructor(readonly db: FarmDatabase) {}

    listAccounts(): AccountWithLastSession[] {
        const rows = this.db.select().from(accounts).orderBy(accounts.deviceUdid, accounts.handle).all();
        return rows.map((account) => ({ ...account, lastSession: this.lastSession(account.id) }));
    }

    account(id: number): Account | undefined {
        return this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    }

    accountsOnDevice(deviceUdid: string): Account[] {
        return this.db.select().from(accounts).where(eq(accounts.deviceUdid, deviceUdid)).all();
    }

    createAccount(input: AccountInput): Account {
        return this.db.insert(accounts).values(input).returning().get();
    }

    updateAccount(id: number, input: Partial<AccountInput>): Account | undefined {
        if (Object.keys(input).length === 0) return this.account(id);
        return this.db.update(accounts).set(input).where(eq(accounts.id, id)).returning().get();
    }

    deleteAccount(id: number): boolean {
        return this.db.delete(accounts).where(eq(accounts.id, id)).run().changes > 0;
    }

    /** Returns undefined when this account already has a session for `slot`. */
    startSession(account: Account, trigger: SessionTrigger, slot: string | null = null): Session | undefined {
        return this.db.insert(sessions)
            .values({ accountId: account.id, deviceUdid: account.deviceUdid, trigger, slot })
            .onConflictDoNothing()
            .returning()
            .get();
    }

    session(id: number): Session | undefined {
        return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    }

    lastSession(accountId: number): Session | null {
        return this.db.select().from(sessions).where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.startedAt), desc(sessions.id)).limit(1).get() ?? null;
    }

    listSessions(limit = 50, accountId?: number): Session[] {
        return this.db.select().from(sessions)
            .where(accountId === undefined ? undefined : eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.startedAt), desc(sessions.id)).limit(limit).all();
    }

    hasSlot(accountId: number, slot: string): boolean {
        return Boolean(this.db.select({ id: sessions.id }).from(sessions)
            .where(and(eq(sessions.accountId, accountId), eq(sessions.slot, slot))).get());
    }

    /** Records one watched video and bumps the session's counters in the same transaction. */
    recordInteraction(sessionId: number, input: InteractionInput): void {
        this.db.transaction((tx) => {
            tx.insert(interactions).values({ sessionId, ...input }).run();
            tx.update(sessions).set({
                videosViewed: sql`${sessions.videosViewed} + 1`,
                likes: sql`${sessions.likes} + ${input.liked ? 1 : 0}`,
                saves: sql`${sessions.saves} + ${input.saved ? 1 : 0}`,
                nicheMatches: sql`${sessions.nicheMatches} + ${input.matchedNiche ? 1 : 0}`,
            }).where(eq(sessions.id, sessionId)).run();
        });
    }

    /** Only a still-running session is finished, so the first writer's outcome wins. */
    finishSession(id: number, status: Exclude<SessionStatus, 'running'>, error?: string): void {
        this.db.update(sessions)
            .set({ status, finishedAt: new Date(), error: error ?? null })
            .where(and(eq(sessions.id, id), eq(sessions.status, 'running')))
            .run();
    }

    /** Sessions left "running" by a crash of the process that owned them. */
    failOrphanedSessions(): number {
        return this.db.update(sessions)
            .set({ status: 'failed', finishedAt: new Date(), error: 'Farm was restarted while this session was running' })
            .where(eq(sessions.status, 'running'))
            .run().changes;
    }
}
