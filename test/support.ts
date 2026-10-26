import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

// Fastify's `inject` sends `Host: localhost:80`. createApp's CSRF hook rejects
// state-changing requests whose Origin doesn't match the Host, so route write
// requests through here to attach the matching Origin a browser would send.
export const INJECT_ORIGIN = 'http://localhost:80';

export function inject(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return app.inject(options);
    return app.inject({ ...options, headers: { origin: INJECT_ORIGIN, ...options.headers } });
}

export interface FakeRunner {
    active: Map<string, number>;
    started: number[];
    stopped: number[];
    activeSession(deviceUdid: string): number | undefined;
    start(accountId: number): Promise<import('../src/db/schema.js').Session>;
    stop(sessionId: number): boolean;
}

// The app against an in-memory database and a runner that records calls
// instead of spawning processes. Imports are dynamic so a test can set
// DEVICES_CONFIG_PATH before src/devices/registry.ts reads it.
export async function createTestApp() {
    const { createApp } = await import('../src/api/app.js');
    const { openDatabase } = await import('../src/db/client.js');
    const { FarmRepository } = await import('../src/db/repository.js');
    const repository = new FarmRepository(openDatabase(':memory:'));
    const runner: FakeRunner = {
        active: new Map(),
        started: [],
        stopped: [],
        activeSession(deviceUdid) { return this.active.get(deviceUdid); },
        async start(accountId) {
            const account = repository.account(accountId);
            if (!account) throw new Error('missing account');
            const session = repository.startSession(account, 'manual')!;
            this.started.push(accountId);
            this.active.set(account.deviceUdid, session.id);
            return session;
        },
        stop(sessionId) { this.stopped.push(sessionId); return true; },
    };
    const app = await createApp({ repository, runner, discoverDevices: async () => [] });
    return { app, repository, runner };
}
