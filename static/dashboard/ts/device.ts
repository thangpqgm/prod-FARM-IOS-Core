export {};

interface ScreenSize {
    width: number;
    height: number;
}

interface DeviceConnectionStatus {
    physical: 'connected' | 'disconnected';
    wda: 'disconnected' | 'connecting' | 'unlock-required' | 'ready' | 'error';
    appium: 'ready' | 'unavailable';
    message: string;
}

type RemoteAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'home' }
    | { type: 'lock' }
    | { type: 'wake' }
    | { type: 'unlock' }
    | { type: 'volumeUp' }
    | { type: 'volumeDown' }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number };

type SwipeDirection = 'left' | 'right' | 'up' | 'down';

interface Point {
    x: number;
    y: number;
    time?: number;
}

function element<T extends Element>(selector: string): T {
    const value = document.querySelector<T>(selector);
    if (!value) throw new Error(`Missing element: ${selector}`);
    return value;
}

const udid = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const elements = {
    screen: element<HTMLImageElement>('#screen'),
    status: element<HTMLElement>('#status'),
    statusText: element<HTMLElement>('#status span:last-child'),
    refresh: element<HTMLButtonElement>('#refresh'),
    toggle: element<HTMLButtonElement>('#toggle'),
    remoteButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-remote-action]')),
    passcodeDialog: element<HTMLDialogElement>('#passcode-dialog'),
    openPasscode: element<HTMLButtonElement>('#open-passcode'),
    closePasscode: element<HTMLButtonElement>('#close-passcode'),
    removeDialog: element<HTMLDialogElement>('#remove-dialog'),
    openRemove: element<HTMLButtonElement>('#open-remove'),
    closeRemove: element<HTMLButtonElement>('#close-remove'),
    passcodeForm: element<HTMLFormElement>('#passcode-form'),
    devicePasscode: element<HTMLInputElement>('#device-passcode'),
    passcodeClear: element<HTMLButtonElement>('#passcode-clear'),
    passcodeState: element<HTMLElement>('#passcode-state'),
    passcodeResult: element<HTMLElement>('#passcode-result'),
    openCalibrate: element<HTMLButtonElement>('#open-calibrate'),
    calibrateDialog: element<HTMLDialogElement>('#calibrate-dialog'),
    closeCalibrate: element<HTMLButtonElement>('#close-calibrate'),
    calScreen: element<HTMLImageElement>('#cal-screen'),
    calControl: element<HTMLInputElement>('#cal-control'),
    calUnlock: element<HTMLButtonElement>('#cal-unlock'),
    calMarkers: element<HTMLElement>('#cal-markers'),
    calPoints: element<HTMLElement>('#cal-points'),
    calStatus: element<HTMLElement>('#cal-status'),
    calProfile: element<HTMLElement>('#cal-profile'),
    calResetAll: element<HTMLButtonElement>('#cal-reset-all'),
    calCancel: element<HTMLButtonElement>('#cal-cancel'),
    calSave: element<HTMLButtonElement>('#cal-save'),
    removeDevice: element<HTMLButtonElement>('#remove-device'),
    removeResult: element<HTMLElement>('#remove-result'),
};

let screenSize: ScreenSize | undefined;
let paused = false;
let connecting = false;
let pointerStart: Point | undefined;
let connectionPoll: number | undefined;
let connectionChecking = false;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, state = ''): void {
    elements.status.className = `status ${state}`;
    elements.statusText.textContent = message;
}

async function jsonRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}

function startStream(): void {
    if (paused || !screenSize) return;
    setStatus('Connecting video stream…');
    elements.screen.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
}

async function connectRemote(): Promise<void> {
    if (paused || connecting || !screenSize) return;
    connecting = true;
    try {
        startStream();
    } finally {
        connecting = false;
    }
}

async function pollConnection(reloadWhenReady = false): Promise<void> {
    if (connectionChecking) return;
    connectionChecking = true;
    window.clearTimeout(connectionPoll);
    try {
        const connection = await jsonRequest<DeviceConnectionStatus>(
            `/api/devices/${encodeURIComponent(udid)}/connection`,
        );
        if (connection.wda === 'ready') {
            if (reloadWhenReady) {
                location.reload();
                return;
            }
            connectionPoll = window.setTimeout(() => void connectRemote(), 2_000);
            return;
        }
        const appium = connection.appium === 'ready' ? '' : ' Appium is unavailable.';
        setStatus(`${connection.message}.${appium}`.replace('..', '.'), connection.wda === 'error' ? 'error' : '');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    } catch (error) {
        setStatus(errorMessage(error), 'error');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    } finally {
        connectionChecking = false;
    }
}

function useDeviceSummary(summary: HTMLElement): void {
    const width = Number(summary.dataset.screenWidth);
    const height = Number(summary.dataset.screenHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    screenSize = { width, height };
    const name = summary.querySelector('h1')?.textContent;
    if (name) document.title = `${name} · iOS Automation`;
    void connectRemote();
}

document.addEventListener('htmx:afterSwap', () => {
    const summary = document.querySelector<HTMLElement>('#device-summary[data-screen-width]');
    if (summary) useDeviceSummary(summary);
});

function pointFromEvent(event: PointerEvent): Point {
    if (!screenSize) throw new Error('Screen dimensions are unavailable');
    const rect = elements.screen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * screenSize.width / rect.width),
        y: Math.round((event.clientY - rect.top) * screenSize.height / rect.height),
    };
}

async function sendAction(action: RemoteAction): Promise<void> {
    setStatus('Sending input…');
    elements.remoteButtons.forEach((button) => { button.disabled = true; });
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        setStatus(action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Remote connected', 'ready');
    } catch (error) {
        setStatus(errorMessage(error), 'error');
    } finally {
        elements.remoteButtons.forEach((button) => { button.disabled = false; });
    }
}

function directionalSwipe(direction: SwipeDirection): RemoteAction | undefined {
    if (!screenSize) {
        setStatus('Screen dimensions are unavailable', 'error');
        return;
    }
    const left = Math.round(screenSize.width * 0.22);
    const right = Math.round(screenSize.width * 0.78);
    const top = Math.round(screenSize.height * 0.25);
    const bottom = Math.round(screenSize.height * 0.75);
    const centerX = Math.round(screenSize.width / 2);
    const centerY = Math.round(screenSize.height / 2);
    const points: Record<SwipeDirection, [number, number, number, number]> = {
        left: [right, centerY, left, centerY],
        right: [left, centerY, right, centerY],
        up: [centerX, bottom, centerX, top],
        down: [centerX, top, centerX, bottom],
    };
    const [startX, startY, endX, endY] = points[direction];
    return { type: 'swipe', startX, startY, endX, endY, durationMs: 350 };
}

elements.remoteButtons.forEach((button) => {
    button.addEventListener('click', () => {
        const action = button.dataset.remoteAction;
        if (action === 'home' || action === 'lock' || action === 'wake'
            || action === 'unlock' || action === 'volumeUp' || action === 'volumeDown') {
            void sendAction({ type: action });
            return;
        }
        if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
            const swipe = directionalSwipe(action);
            if (swipe) void sendAction(swipe);
        }
    });
});

elements.screen.addEventListener('pointerdown', (event) => {
    if (!screenSize) return;
    elements.screen.setPointerCapture(event.pointerId);
    pointerStart = { ...pointFromEvent(event), time: performance.now() };
});
elements.screen.addEventListener('pointerup', (event) => {
    if (!pointerStart || !screenSize) return;
    const end = pointFromEvent(event);
    const start = pointerStart;
    pointerStart = undefined;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 12) {
        void sendAction({ type: 'tap', x: end.x, y: end.y });
    } else {
        const durationMs = Math.max(150, Math.min(1200, Math.round(performance.now() - (start.time ?? 0))));
        void sendAction({
            type: 'swipe',
            startX: start.x,
            startY: start.y,
            endX: end.x,
            endY: end.y,
            durationMs,
        });
    }
});
elements.screen.addEventListener('pointercancel', () => { pointerStart = undefined; });
elements.screen.addEventListener('load', () => setStatus('Live video connected', 'ready'));
elements.screen.addEventListener('error', () => {
    if (paused) return;
    elements.screen.removeAttribute('src');
    setStatus('Video stream disconnected; checking the phone connection…', 'error');
    void pollConnection();
});
elements.refresh.addEventListener('click', async () => {
    elements.refresh.disabled = true;
    window.clearTimeout(connectionPoll);
    elements.screen.removeAttribute('src');
    setStatus('Restarting the phone connection…');
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/reconnect`, { method: 'POST' });
        elements.refresh.disabled = false;
        void pollConnection(true);
    } catch (error) {
        setStatus(errorMessage(error), 'error');
        elements.refresh.disabled = false;
    }
});
elements.toggle.addEventListener('click', () => {
    paused = !paused;
    elements.toggle.textContent = paused ? 'Resume stream' : 'Pause stream';
    if (paused) {
        elements.screen.removeAttribute('src');
        setStatus('Video stream paused');
    } else {
        void connectRemote();
    }
});

interface CalPoint { name: string; label: string; default: Point; current: Point; overridden: boolean }

const cal = {
    screen: undefined as { width: number; height: number } | undefined,
    points: [] as CalPoint[],
    overrides: {} as Record<string, { x: number; y: number }>,
    armed: undefined as string | undefined,
};

function calValue(name: string): { x: number; y: number } {
    const point = cal.points.find((entry) => entry.name === name)!;
    return cal.overrides[name] ?? point.default;
}

function renderCalPoints(): void {
    elements.calPoints.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const overridden = point.name in cal.overrides;
        const li = document.createElement('li');
        li.className = `cal-point${overridden ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        const pick = document.createElement('button');
        pick.type = 'button'; pick.className = 'cal-pick';
        pick.textContent = cal.armed === point.name ? `${point.label} — click the screen` : point.label;
        pick.addEventListener('click', () => { cal.armed = cal.armed === point.name ? undefined : point.name; renderCal(); });
        const xy = document.createElement('span');
        xy.className = 'cal-xy'; xy.textContent = `${value.x}, ${value.y}`;
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'cal-reset'; reset.title = 'Reset to profile'; reset.textContent = '↺';
        reset.addEventListener('click', () => { delete cal.overrides[point.name]; renderCal(); });
        li.append(pick, xy, reset);
        return li;
    }));
}

function renderCalMarkers(): void {
    if (!cal.screen) return;
    elements.calMarkers.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const marker = document.createElement('span');
        marker.className = `m${point.name in cal.overrides ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        marker.style.left = `${(value.x / cal.screen!.width) * 100}%`;
        marker.style.top = `${(value.y / cal.screen!.height) * 100}%`;
        marker.title = point.label;
        return marker;
    }));
}

function renderCal(): void {
    renderCalPoints();
    renderCalMarkers();
}

async function openCalibrate(): Promise<void> {
    elements.calStatus.textContent = 'Loading…';
    elements.calibrateDialog.showModal();
    try {
        const data = await jsonRequest<{ profile: string; screenSize: { width: number; height: number }; points: CalPoint[] }>(
            `/api/devices/${encodeURIComponent(udid)}/coordinates`,
        );
        cal.screen = data.screenSize;
        cal.points = data.points;
        cal.overrides = {};
        for (const point of data.points) if (point.overridden) cal.overrides[point.name] = point.current;
        cal.armed = undefined;
        elements.calControl.checked = false;
        elements.calScreen.parentElement?.classList.remove('controlling');
        elements.calProfile.textContent = data.profile;
        elements.calScreen.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
        elements.calStatus.textContent = '';
        renderCal();
    } catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}

function closeCalibrate(): void {
    elements.calScreen.src = '';
    elements.calibrateDialog.close();
}

elements.openCalibrate.addEventListener('click', () => void openCalibrate());
elements.closeCalibrate.addEventListener('click', closeCalibrate);
elements.calCancel.addEventListener('click', closeCalibrate);

elements.openPasscode.addEventListener('click', () => {
    elements.passcodeResult.textContent = '';
    elements.passcodeDialog.showModal();
});
elements.closePasscode.addEventListener('click', () => elements.passcodeDialog.close());
elements.openRemove.addEventListener('click', () => {
    elements.removeResult.textContent = '';
    elements.removeDialog.showModal();
});
elements.closeRemove.addEventListener('click', () => elements.removeDialog.close());
elements.calResetAll.addEventListener('click', () => {
    if (!confirm('Reset all touch points to the profile defaults?')) return;
    cal.overrides = {}; cal.armed = undefined; renderCal();
});
function calPointFromEvent(event: PointerEvent | MouseEvent): Point {
    const rect = elements.calScreen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * cal.screen!.width / rect.width),
        y: Math.round((event.clientY - rect.top) * cal.screen!.height / rect.height),
    };
}

async function calSendAction(action: RemoteAction): Promise<void> {
    elements.calStatus.textContent = 'Sending input…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        elements.calStatus.textContent = action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Sent.';
    } catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}

let calPointerStart: (Point & { time: number }) | undefined;

elements.calControl.addEventListener('change', () => {
    elements.calScreen.parentElement?.classList.toggle('controlling', elements.calControl.checked);
    if (elements.calControl.checked) { cal.armed = undefined; renderCal(); }
});

elements.calUnlock.addEventListener('click', () => void calSendAction({ type: 'unlock' }));

elements.calScreen.addEventListener('click', (event) => {
    if (elements.calControl.checked || !cal.armed || !cal.screen) return;
    cal.overrides[cal.armed] = calPointFromEvent(event);
    cal.armed = undefined;
    renderCal();
});
elements.calScreen.addEventListener('pointerdown', (event) => {
    if (!elements.calControl.checked || !cal.screen) return;
    elements.calScreen.setPointerCapture(event.pointerId);
    calPointerStart = { ...calPointFromEvent(event), time: performance.now() };
});
elements.calScreen.addEventListener('pointerup', (event) => {
    if (!calPointerStart || !cal.screen) return;
    const start = calPointerStart;
    const end = calPointFromEvent(event);
    calPointerStart = undefined;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 12) {
        void calSendAction({ type: 'tap', x: end.x, y: end.y });
    } else {
        const durationMs = Math.max(150, Math.min(1200, Math.round(performance.now() - start.time)));
        void calSendAction({ type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y, durationMs });
    }
});
elements.calScreen.addEventListener('pointercancel', () => { calPointerStart = undefined; });
elements.calSave.addEventListener('click', async () => {
    elements.calSave.disabled = true;
    elements.calStatus.textContent = 'Saving…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ coordinates: cal.overrides }),
        });
        const count = Object.keys(cal.overrides).length;
        elements.calStatus.textContent = count ? `Saved ${count} override${count === 1 ? '' : 's'}.` : 'Cleared all overrides.';
        for (const point of cal.points) point.overridden = point.name in cal.overrides;
        renderCal();
    } catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    } finally {
        elements.calSave.disabled = false;
    }
});

async function patchPasscode(passcode: string, pending: string, done: string): Promise<void> {
    elements.passcodeResult.textContent = pending;
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passcode }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        const data = await response.json() as { hasPasscode?: boolean };
        elements.passcodeState.textContent = data.hasPasscode ? '· set' : '· not set';
        elements.devicePasscode.value = '';
        elements.passcodeResult.textContent = done;
    } catch (error) {
        elements.passcodeResult.textContent = errorMessage(error);
    }
}

elements.passcodeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = elements.devicePasscode.value.trim();
    if (!/^\d{4,}$/.test(value)) {
        elements.passcodeResult.textContent = 'Enter at least four digits.';
        return;
    }
    void patchPasscode(value, 'Saving…', 'Passcode saved.');
});

elements.passcodeClear.addEventListener('click', () => {
    if (!confirm('Clear this device’s passcode? Automation will not be able to unlock a locked phone.')) return;
    void patchPasscode('', 'Clearing…', 'Passcode cleared.');
});

elements.removeDevice.addEventListener('click', async () => {
    elements.removeDevice.disabled = true;
    elements.removeResult.textContent = 'Removing…';
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        location.href = '/';
    } catch (error) {
        elements.removeDevice.disabled = false;
        elements.removeResult.textContent = errorMessage(error);
    }
});


const loadedSummary = document.querySelector<HTMLElement>('#device-summary[data-screen-width]');
if (loadedSummary) useDeviceSummary(loadedSummary);

interface DeviceAccount {
    id: number;
    handle: string;
    keywords: string[];
    running: boolean;
    lastSession: { id: number; status: string; startedAt: string } | null;
}

const accountList = element<HTMLUListElement>('#device-accounts');

async function loadDeviceAccounts(): Promise<void> {
    try {
        const accounts = await jsonRequest<DeviceAccount[]>(`/api/accounts?deviceUdid=${encodeURIComponent(udid)}`);
        if (!accounts.length) {
            const empty = document.createElement('li');
            empty.className = 'muted';
            empty.textContent = 'Chưa có acc nào trên máy này.';
            accountList.replaceChildren(empty);
            return;
        }
        accountList.replaceChildren(...accounts.map((account) => {
            const item = document.createElement('li');
            const handle = document.createElement('strong');
            handle.textContent = account.handle;
            const keywords = document.createElement('span');
            keywords.className = 'muted';
            keywords.textContent = account.keywords.join(', ');
            item.append(handle, keywords);
            if (account.running && account.lastSession) {
                const stop = document.createElement('button');
                stop.type = 'button';
                stop.className = 'button danger small';
                stop.textContent = '■ Dừng';
                const sessionId = account.lastSession.id;
                stop.addEventListener('click', async () => {
                    stop.disabled = true;
                    try {
                        await jsonRequest(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
                    } catch (error) {
                        window.alert(errorMessage(error));
                    }
                    void loadDeviceAccounts();
                });
                const state = document.createElement('span');
                state.className = 'status running';
                state.innerHTML = '<span class="dot"></span>đang chạy';
                item.append(state, stop);
            }
            return item;
        }));
    } catch (error) {
        accountList.textContent = errorMessage(error);
    }
}

void loadDeviceAccounts();
setInterval(() => void loadDeviceAccounts(), 5_000);
