import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { AccountInput, FarmRepository } from '../db/repository.js';
import type { Personality } from '../db/schema.js';
import { discoverConnectedDevices, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, mutateRegisteredDevices, redactDevice, PASSCODE_PATTERN, type RegisteredDevice } from '../devices/registry.js';
import {
    CALIBRATABLE_POINTS, POINT_LABELS, coordinatesForProfile, resolveDeviceCoordinates, validateCoordinateOverrides,
} from '../devices/coordinates.js';
import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import type {
    DeviceRegistrationManager, RegistrationAction, RegistrationUpdate,
} from '../devices/registration.js';
import { type RemoteAction } from '../devices/wda-remote.js';
import { requestWdaService } from '../devices/wda-service-client.js';
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import { parseKeywordList } from '../nurture/niche.js';
import { RunnerError, sessionLogPath, type NurtureControl } from '../nurture/runner.js';
import { TIME_PATTERN } from '../nurture/schedule.js';

export interface CreateAppOptions {
    repository: FarmRepository;
    runner: NurtureControl;
    /** Serve the HTML dashboard from static/dashboard (off in API-only tests). */
    dashboard?: boolean;
    registrations?: DeviceRegistrationManager;
    logger?: boolean;
    /** Device discovery; injectable so tests don't need usbmuxd. */
    discoverDevices?: () => Promise<Device[]>;
}

interface LoadedDashboard {
    indexHtml: string;
    deviceHtml: string;
    registerDeviceHtml: string;
    styles: string;
    indexScript: string;
    deviceScript: string;
    registerDeviceScript: string;
    htmx: string;
}

const DASHBOARD_ROOT = fileURLToPath(new URL('../../static/dashboard/', import.meta.url));
const PERSONALITIES: readonly Personality[] = ['skimmer', 'casual', 'engaged'];

/** Thrown inside route bodies / registry mutations; mapped to its status by setErrorHandler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

// Shown at the foot of every dashboard page. Override the link with
// PHONE_FARM_BRAND_URL; the text is fixed.
const FOOTER_HTML = `Built by <a href="${escapeHtml(process.env.PHONE_FARM_BRAND_URL ?? 'https://agniverse.co')}" target="_blank" rel="noopener">Agniverse</a>, with love and curry &#10084;&#65039;`;

function integerInRange(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw httpError(400, `${name} phải là số nguyên từ ${min} đến ${max}`);
    }
    return value;
}

function booleanField(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw httpError(400, `${name} phải là true/false`);
    return value;
}

export function normalizeHandle(value: string): string {
    const handle = value.trim().replace(/^@+/, '');
    return handle ? `@${handle}` : '';
}

/** Validates an account body; with `partial`, only the fields present are checked and returned. */
export function parseAccountInput(body: Record<string, unknown>, partial: boolean): Partial<AccountInput> {
    const input: Partial<AccountInput> = {};
    const has = (key: string) => body[key] !== undefined;
    if (!partial || has('deviceUdid')) {
        if (typeof body.deviceUdid !== 'string' || !body.deviceUdid.trim()) throw httpError(400, 'Chọn máy cho acc');
        input.deviceUdid = body.deviceUdid.trim();
    }
    if (!partial || has('handle')) {
        const handle = typeof body.handle === 'string' ? normalizeHandle(body.handle) : '';
        if (!handle) throw httpError(400, 'Nhập tên acc TikTok (vd. @ten_acc)');
        input.handle = handle;
    }
    if (!partial || has('keywords')) {
        const raw = body.keywords;
        const keywords = typeof raw === 'string' ? parseKeywordList(raw)
            : Array.isArray(raw) ? parseKeywordList(raw.filter((entry): entry is string => typeof entry === 'string'))
                : [];
        if (keywords.length === 0) throw httpError(400, 'Thêm ít nhất một keyword cho niche');
        if (keywords.length > 50) throw httpError(400, 'Tối đa 50 keyword mỗi acc');
        input.keywords = keywords;
    }
    if (has('personality')) {
        if (!PERSONALITIES.includes(body.personality as Personality)) throw httpError(400, 'Kiểu tương tác không hợp lệ');
        input.personality = body.personality as Personality;
    }
    if (has('minutesPerSession')) input.minutesPerSession = integerInRange(body.minutesPerSession, 'Thời lượng', 1, 180);
    if (has('keywordsPerSession')) input.keywordsPerSession = integerInRange(body.keywordsPerSession, 'Số keyword mỗi phiên', 1, 10);
    if (has('warmupMinutes')) input.warmupMinutes = integerInRange(body.warmupMinutes, 'Thời gian lướt trước khi search', 0, 30);
    if (has('forYouMinutes')) input.forYouMinutes = integerInRange(body.forYouMinutes, 'Thời gian For You', 0, 60);
    if (has('dailyTimes')) {
        if (!Array.isArray(body.dailyTimes) || !body.dailyTimes.every((time) => typeof time === 'string' && TIME_PATTERN.test(time))) {
            throw httpError(400, 'Giờ chạy phải có dạng HH:MM');
        }
        input.dailyTimes = [...new Set(body.dailyTimes as string[])].sort();
    }
    if (has('nicheFilter')) input.nicheFilter = booleanField(body.nicheFilter, 'nicheFilter');
    if (has('enabled')) input.enabled = booleanField(body.enabled, 'enabled');
    return input;
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
    const { repository, runner } = options;
    const discover = options.discoverDevices ?? discoverConnectedDevices;

    // Server-rendered HTML must never be cached — a stale page + fresh assets
    // (or vice versa) breaks the dashboard after an update.
    app.addHook('onSend', async (_request, reply) => {
        const type = reply.getHeader('content-type');
        if (typeof type === 'string' && type.includes('text/html') && !reply.hasHeader('cache-control')) {
            reply.header('cache-control', 'no-cache');
        }
    });

    // CSRF guard: the dashboard has no login, so a page open in the same
    // browser must not be able to tap the phone or start sessions with a
    // cross-origin POST. Writes need an Origin whose host matches ours.
    app.addHook('onRequest', async (request, reply) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
        const origin = request.headers.origin;
        let originHost: string | undefined;
        try { originHost = origin ? new URL(origin).host : undefined; } catch { /* invalid origin */ }
        const hostMatches = originHost !== undefined && ['http', 'https'].some((scheme) => {
            try { return new URL(`${scheme}://${request.headers.host}`).host === originHost; } catch { return false; }
        });
        if (!hostMatches) return reply.code(403).send({ error: 'Cross-origin write blocked' });
    });

    const remote = new RegistryWdaRemoteControl();
    const assetHash = (body: string) => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 10);

    let dashboard: LoadedDashboard | null = null;
    if (options.dashboard) {
        const require = createRequire(import.meta.url);
        const [indexHtml, deviceHtml, registerDeviceHtml, styles, indexScript, deviceScript, registerDeviceScript, htmx] = await Promise.all([
            readFile(path.join(DASHBOARD_ROOT, 'templates/index.html'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'templates/device.html'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'templates/register-device.html'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'styles.css'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'assets/index.js'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'assets/device.js'), 'utf8'),
            readFile(path.join(DASHBOARD_ROOT, 'assets/register-device.js'), 'utf8'),
            readFile(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8'),
        ]);
        // Content-hash every asset URL in the templates so a changed file gets a
        // fresh URL that no browser can serve stale.
        const versions: Record<string, string> = {
            'styles.css': assetHash(styles), 'index.js': assetHash(indexScript), 'device.js': assetHash(deviceScript),
            'register-device.js': assetHash(registerDeviceScript), 'htmx.min.js': assetHash(htmx),
        };
        const finalize = (html: string) => {
            let out = html.replaceAll('__FOOTER__', FOOTER_HTML);
            for (const [name, v] of Object.entries(versions)) out = out.replaceAll(`/assets/${name}`, `/assets/${name}?v=${v}`);
            return out;
        };
        dashboard = {
            indexHtml: finalize(indexHtml), deviceHtml: finalize(deviceHtml), registerDeviceHtml: finalize(registerDeviceHtml),
            styles, indexScript, deviceScript, registerDeviceScript, htmx,
        };
    }

    const findRegistered = async (udid: string) => (await loadRegisteredDevices()).find((device) => device.udid === udid);
    const assertIdle = (udid: string, message: string) => {
        if (runner.activeSession(udid) !== undefined) throw httpError(409, message);
    };
    const accountsWithRunState = () => repository.listAccounts().map((account) => {
        const runningSessionId = runner.activeSession(account.deviceUdid);
        return {
            ...account,
            running: runningSessionId !== undefined && runningSessionId === account.lastSession?.id,
        };
    });

    app.get('/health', async () => ({ ok: true }));

    // Everything the main page shows, in one poll.
    app.get('/api/overview', async () => {
        const [registered, connected] = await Promise.all([loadRegisteredDevices(), discover()]);
        const online = new Map(connected.map((device) => [device.udid, device]));
        const accounts = accountsWithRunState();
        const registeredIds = new Set(registered.map(({ udid }) => udid));
        return {
            devices: registered.map((device) => {
                const sessionId = runner.activeSession(device.udid);
                return {
                    ...redactDevice(device),
                    connected: device.disabled ? null : online.get(device.udid) ?? null,
                    runningSessionId: sessionId ?? null,
                    runningHandle: sessionId === undefined ? null
                        : accounts.find((account) => account.lastSession?.id === sessionId)?.handle ?? null,
                    accountCount: accounts.filter((account) => account.deviceUdid === device.udid).length,
                };
            }),
            unregistered: connected.filter(({ udid }) => !registeredIds.has(udid)),
            accounts,
        };
    });

    app.get('/api/devices', async () => {
        const [registered, connected] = await Promise.all([loadRegisteredDevices(), discover()]);
        const online = new Map(connected.map((device) => [device.udid, device]));
        return registered.map((device) => ({
            ...redactDevice(device),
            connected: device.disabled ? null : online.get(device.udid) ?? null,
        }));
    });
    app.get('/api/devices/discovered', async () => discover());
    app.get('/api/device-registrations/candidates', async (_request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return { devices: await options.registrations.candidates() };
    });
    app.post<{ Body: { udid?: string } }>('/api/device-registrations', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        if (!request.body?.udid?.trim()) return reply.code(400).send({ error: 'Device UDID is required' });
        return reply.code(201).send(await options.registrations.create(request.body.udid.trim()));
    });
    app.get<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return await options.registrations.get(request.params.id)
            ?? reply.code(404).send({ error: 'Registration draft not found' });
    });
    app.patch<{ Params: { id: string }; Body: RegistrationUpdate }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return options.registrations.update(request.params.id, request.body);
    });
    app.post<{ Params: { id: string; action: RegistrationAction }; Body: { authorizeTeamRegistration?: boolean } }>(
        '/api/device-registrations/:id/actions/:action', async (request, reply) => {
            if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
            if (!['refresh', 'prepare', 'verify', 'finalize'].includes(request.params.action)) {
                return reply.code(404).send({ error: 'Unknown registration action' });
            }
            return options.registrations.run(request.params.id, request.params.action, {
                authorizeTeamRegistration: request.body?.authorizeTeamRegistration === true,
            });
        },
    );
    app.delete<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        await options.registrations.cancel(request.params.id);
        return reply.code(204).send();
    });
    app.patch<{ Params: { udid: string }; Body: { name?: string; passcode?: string; coordinates?: unknown; disabled?: boolean } }>(
        '/api/devices/:udid', async (request, reply) => {
            const { passcode, coordinates, name, disabled } = request.body ?? {};
            if (passcode !== undefined && passcode !== '' && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            if (disabled === true) assertIdle(request.params.udid, 'Stop the running session before disconnecting this device');
            const updated = await mutateRegisteredDevices((devices) => {
                const device = devices.find((entry) => entry.udid === request.params.udid);
                if (!device) throw httpError(404, 'Device not found');
                if (name !== undefined) device.name = name;
                if (disabled === true) device.disabled = true;
                else if (disabled === false) delete device.disabled;
                // passcode: a value sets it, '' clears it, omitting it leaves it
                if (passcode === '') delete device.passcode;
                else if (passcode !== undefined) device.passcode = passcode;
                // coordinates: the object replaces the whole override map; {} clears it
                if (coordinates !== undefined) {
                    const overrides = validateCoordinateOverrides(coordinates, device.coordinateProfile);
                    if (Object.keys(overrides).length === 0) delete device.coordinates;
                    else device.coordinates = overrides;
                }
                return device;
            });
            remote.forget(request.params.udid);
            return redactDevice(updated);
        },
    );
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/coordinates', async (request, reply) => {
        const device = await findRegistered(request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const base = coordinatesForProfile(device.coordinateProfile).tiktok;
        const effective = resolveDeviceCoordinates(device.coordinateProfile, device.coordinates).tiktok;
        return {
            profile: device.coordinateProfile ?? 'iphone8',
            screenSize: coordinatesForProfile(device.coordinateProfile).screenSize,
            points: CALIBRATABLE_POINTS.map((name) => ({
                name, label: POINT_LABELS[name],
                default: base[name], current: effective[name],
                overridden: Boolean(device.coordinates?.[name]),
            })),
        };
    });
    app.delete<{ Params: { udid: string } }>('/api/devices/:udid', async (request, reply) => {
        if (!await findRegistered(request.params.udid)) return reply.code(404).send({ error: 'Device not found' });
        assertIdle(request.params.udid, 'Stop the running session before removing this device');
        const accounts = repository.accountsOnDevice(request.params.udid);
        if (accounts.length) {
            return reply.code(409).send({ error: `Xóa hoặc chuyển các acc trên máy này trước: ${accounts.map(({ handle }) => handle).join(', ')}` });
        }
        await mutateRegisteredDevices((devices) => {
            const index = devices.findIndex(({ udid }) => udid === request.params.udid);
            if (index >= 0) devices.splice(index, 1);
        });
        remote.forget(request.params.udid);
        return reply.code(204).send();
    });

    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/info', async (request, reply) => {
        const device = (await discover()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device is not connected' });
        return { device, screen: await remote.getScreenInfo(device.udid) };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/screenshot', async (request, reply) => {
        try {
            return reply.header('cache-control', 'no-store').type('image/png').send(await remote.getScreenshot(request.params.udid));
        } catch {
            // A flapping device shouldn't spew 500s into the log every 5s from the grid poll.
            return reply.code(503).header('cache-control', 'no-store').send();
        }
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/stream', async (request, reply) => {
        // Close the upstream device stream the moment the browser goes away —
        // otherwise every page change leaks a live MJPEG connection.
        const abort = new AbortController();
        request.raw.once('close', () => abort.abort());
        const upstream = await remote.getMjpegStream(request.params.udid, abort.signal);
        if (!upstream.body) return reply.code(503).send({ error: 'Device stream is unavailable' });
        return reply.header('cache-control', 'no-store, no-cache, must-revalidate')
            .type(upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=--BoundaryString')
            .send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
    });
    app.post<{ Params: { udid: string }; Body: RemoteAction }>('/api/devices/:udid/remote/action', async (request) => {
        assertIdle(request.params.udid, 'Remote input is disabled while a nurture session is running');
        await remote.performAction(request.params.udid, request.body);
        return { ok: true };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/connection', async (request, reply) => {
        const registered = await findRegistered(request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        // Prefer the real per-device state the wda-service supervisor tracks
        // (physical, wda, appium, retryCount, message).
        try {
            const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const status = (JSON.parse(response.body).devices as DeviceConnectionStatus[])
                    .find((entry) => entry.udid === registered.udid);
                if (status) return status;
            }
        } catch { /* supervisor socket unavailable — fall back to a probe */ }
        const connected = (await discover()).some(({ udid }) => udid === registered.udid);
        let wda = false;
        try {
            wda = (await fetch(`http://127.0.0.1:${registered.wdaLocalPort ?? 8100}/status`, { signal: AbortSignal.timeout(2_000) })).ok;
        } catch { /* WDA not up */ }
        const fallback: DeviceConnectionStatus = {
            udid: registered.udid, physical: connected ? 'connected' : 'disconnected',
            wda: wda ? 'ready' : connected ? 'connecting' : 'disconnected', appium: 'unavailable',
            managed: false, message: wda ? 'WDA is ready' : connected ? 'Waiting for WDA' : 'Reconnect the USB cable',
            retryCount: 0, updatedAt: new Date().toISOString(),
        };
        return fallback;
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/reconnect', async (request, reply) => {
        assertIdle(request.params.udid, 'Cannot reconnect while a nurture session is running');
        remote.forget(request.params.udid);
        return reply.code(202).send({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
    });

    app.get<{ Querystring: { deviceUdid?: string } }>('/api/accounts', async (request) => {
        const accounts = accountsWithRunState();
        return request.query.deviceUdid ? accounts.filter(({ deviceUdid }) => deviceUdid === request.query.deviceUdid) : accounts;
    });
    app.post<{ Body: Record<string, unknown> }>('/api/accounts', async (request, reply) => {
        const input = parseAccountInput(request.body ?? {}, false) as AccountInput;
        if (!await findRegistered(input.deviceUdid)) return reply.code(400).send({ error: 'Máy này chưa được đăng ký' });
        try {
            return reply.code(201).send(repository.createAccount(input));
        } catch (error) {
            if (isUniqueViolation(error)) return reply.code(409).send({ error: `${input.handle} đã có trên máy này` });
            throw error;
        }
    });
    app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/accounts/:id', async (request, reply) => {
        const id = Number(request.params.id);
        const current = repository.account(id);
        if (!current) return reply.code(404).send({ error: 'Không tìm thấy acc' });
        const input = parseAccountInput(request.body ?? {}, true);
        if (input.deviceUdid && input.deviceUdid !== current.deviceUdid) {
            if (!await findRegistered(input.deviceUdid)) return reply.code(400).send({ error: 'Máy này chưa được đăng ký' });
            assertIdle(current.deviceUdid, 'Dừng phiên đang chạy trước khi chuyển acc sang máy khác');
        }
        try {
            return repository.updateAccount(id, input);
        } catch (error) {
            if (isUniqueViolation(error)) return reply.code(409).send({ error: 'Acc này đã có trên máy đó' });
            throw error;
        }
    });
    app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
        const account = repository.account(Number(request.params.id));
        if (!account) return reply.code(404).send({ error: 'Không tìm thấy acc' });
        const running = runner.activeSession(account.deviceUdid);
        if (running !== undefined && repository.session(running)?.accountId === account.id) {
            return reply.code(409).send({ error: 'Dừng phiên đang chạy trước khi xóa acc' });
        }
        repository.deleteAccount(account.id);
        return reply.code(204).send();
    });
    app.post<{ Params: { id: string } }>('/api/accounts/:id/nurture', async (request, reply) => {
        try {
            return reply.code(201).send(await runner.start(Number(request.params.id)));
        } catch (error) {
            if (error instanceof RunnerError) return reply.code(error.statusCode).send({ error: error.message });
            throw error;
        }
    });

    app.get<{ Querystring: { accountId?: string; limit?: string } }>('/api/sessions', async (request) => {
        const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50) || 50));
        const accountId = request.query.accountId ? Number(request.query.accountId) : undefined;
        return repository.listSessions(limit, accountId);
    });
    app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (request, reply) => {
        if (!runner.stop(Number(request.params.id))) return reply.code(409).send({ error: 'Phiên này không còn chạy' });
        return reply.code(202).send({ ok: true });
    });
    app.get<{ Params: { id: string } }>('/api/sessions/:id/log', async (request, reply) => {
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || !repository.session(id)) return reply.code(404).send({ error: 'Không tìm thấy phiên' });
        try {
            return reply.type('text/plain; charset=utf-8').send(await readFile(sessionLogPath(id), 'utf8'));
        } catch {
            return reply.type('text/plain; charset=utf-8').send('(chưa có log)');
        }
    });

    if (dashboard) {
        const pages = dashboard;
        // Templates request these with a ?v=<contenthash>. A versioned request is
        // safe to cache forever; a bare one (bookmark) must revalidate via ETag.
        const asset = (contentType: string, body: string) => {
            const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
            return async (request: FastifyRequest, reply: FastifyReply) => {
                const versioned = Boolean((request.query as { v?: string }).v);
                reply.header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
                    .header('etag', etag);
                if (request.headers['if-none-match'] === etag) return reply.code(304).send();
                return reply.type(contentType).send(body);
            };
        };
        app.get('/assets/styles.css', asset('text/css', pages.styles));
        app.get('/assets/index.js', asset('text/javascript', pages.indexScript));
        app.get('/assets/device.js', asset('text/javascript', pages.deviceScript));
        app.get('/assets/register-device.js', asset('text/javascript', pages.registerDeviceScript));
        app.get('/assets/htmx.min.js', asset('text/javascript', pages.htmx));
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/summary', async (request, reply) => {
            const device = (await discover()).find(({ udid }) => udid === request.params.udid);
            if (!device) return reply.type('text/html').send('<section id="device-summary" class="device-summary error"><div><h2>Device disconnected</h2></div></section>');
            const screen = await remote.getScreenInfo(device.udid);
            return reply.type('text/html').send(`<section id="device-summary" class="device-summary" data-screen-width="${screen.screenSize.width}" data-screen-height="${screen.screenSize.height}"><div><span class="eyebrow">Connected device</span><h1>${escapeHtml(device.name)}</h1><p>iOS ${escapeHtml(device.osVersion)} · ${screen.screenSize.width} × ${screen.screenSize.height} points · ${screen.scale}×</p></div><code>${escapeHtml(device.udid)}</code></section>`);
        });
        app.get('/', async (_request, reply) => reply.type('text/html').send(pages.indexHtml));
        app.get('/devices/register', async (_request, reply) => reply.type('text/html').send(pages.registerDeviceHtml));
        app.get<{ Params: { udid: string } }>('/devices/:udid', async (request, reply) => {
            const device: RegisteredDevice | undefined = await findRegistered(request.params.udid);
            if (!device) return reply.code(404).type('text/html').send('<!doctype html><title>Not found</title><p>Device not found. <a href="/">Back</a></p>');
            return reply.type('text/html').send(pages.deviceHtml
                .replaceAll('__DEVICE_UDID__', encodeURIComponent(device.udid))
                .replaceAll('__DEVICE_HASPASSCODE__', device.passcode ? '· set' : '· not set'));
        });
    }

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);
        const failure = error as Error & { statusCode?: number };
        void reply.code(failure.statusCode && failure.statusCode >= 400 ? failure.statusCode : 400)
            .send({ error: failure.message });
    });
    return app;
}
