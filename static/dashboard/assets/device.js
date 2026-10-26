function element(selector) {
    const value = document.querySelector(selector);
    if (!value)
        throw new Error(`Missing element: ${selector}`);
    return value;
}
const udid = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const elements = {
    screen: element('#screen'),
    status: element('#status'),
    statusText: element('#status span:last-child'),
    refresh: element('#refresh'),
    toggle: element('#toggle'),
    remoteButtons: Array.from(document.querySelectorAll('[data-remote-action]')),
    passcodeDialog: element('#passcode-dialog'),
    openPasscode: element('#open-passcode'),
    closePasscode: element('#close-passcode'),
    removeDialog: element('#remove-dialog'),
    openRemove: element('#open-remove'),
    closeRemove: element('#close-remove'),
    passcodeForm: element('#passcode-form'),
    devicePasscode: element('#device-passcode'),
    passcodeClear: element('#passcode-clear'),
    passcodeState: element('#passcode-state'),
    passcodeResult: element('#passcode-result'),
    openCalibrate: element('#open-calibrate'),
    calibrateDialog: element('#calibrate-dialog'),
    closeCalibrate: element('#close-calibrate'),
    calScreen: element('#cal-screen'),
    calControl: element('#cal-control'),
    calUnlock: element('#cal-unlock'),
    calMarkers: element('#cal-markers'),
    calPoints: element('#cal-points'),
    calStatus: element('#cal-status'),
    calProfile: element('#cal-profile'),
    calResetAll: element('#cal-reset-all'),
    calCancel: element('#cal-cancel'),
    calSave: element('#cal-save'),
    removeDevice: element('#remove-device'),
    removeResult: element('#remove-result'),
};
let screenSize;
let paused = false;
let connecting = false;
let pointerStart;
let connectionPoll;
let connectionChecking = false;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function setStatus(message, state = '') {
    elements.status.className = `status ${state}`;
    elements.statusText.textContent = message;
}
async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
function startStream() {
    if (paused || !screenSize)
        return;
    setStatus('Connecting video stream…');
    elements.screen.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
}
async function connectRemote() {
    if (paused || connecting || !screenSize)
        return;
    connecting = true;
    try {
        startStream();
    }
    finally {
        connecting = false;
    }
}
async function pollConnection(reloadWhenReady = false) {
    if (connectionChecking)
        return;
    connectionChecking = true;
    window.clearTimeout(connectionPoll);
    try {
        const connection = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/connection`);
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
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    }
    finally {
        connectionChecking = false;
    }
}
function useDeviceSummary(summary) {
    const width = Number(summary.dataset.screenWidth);
    const height = Number(summary.dataset.screenHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height))
        return;
    screenSize = { width, height };
    const name = summary.querySelector('h1')?.textContent;
    if (name)
        document.title = `${name} · iOS Automation`;
    void connectRemote();
}
document.addEventListener('htmx:afterSwap', () => {
    const summary = document.querySelector('#device-summary[data-screen-width]');
    if (summary)
        useDeviceSummary(summary);
});
function pointFromEvent(event) {
    if (!screenSize)
        throw new Error('Screen dimensions are unavailable');
    const rect = elements.screen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * screenSize.width / rect.width),
        y: Math.round((event.clientY - rect.top) * screenSize.height / rect.height),
    };
}
async function sendAction(action) {
    setStatus('Sending input…');
    elements.remoteButtons.forEach((button) => { button.disabled = true; });
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        setStatus(action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Remote connected', 'ready');
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
    }
    finally {
        elements.remoteButtons.forEach((button) => { button.disabled = false; });
    }
}
function directionalSwipe(direction) {
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
    const points = {
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
            if (swipe)
                void sendAction(swipe);
        }
    });
});
elements.screen.addEventListener('pointerdown', (event) => {
    if (!screenSize)
        return;
    elements.screen.setPointerCapture(event.pointerId);
    pointerStart = { ...pointFromEvent(event), time: performance.now() };
});
elements.screen.addEventListener('pointerup', (event) => {
    if (!pointerStart || !screenSize)
        return;
    const end = pointFromEvent(event);
    const start = pointerStart;
    pointerStart = undefined;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 12) {
        void sendAction({ type: 'tap', x: end.x, y: end.y });
    }
    else {
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
    if (paused)
        return;
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
    }
    catch (error) {
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
    }
    else {
        void connectRemote();
    }
});
const cal = {
    screen: undefined,
    points: [],
    overrides: {},
    armed: undefined,
};
function calValue(name) {
    const point = cal.points.find((entry) => entry.name === name);
    return cal.overrides[name] ?? point.default;
}
function renderCalPoints() {
    elements.calPoints.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const overridden = point.name in cal.overrides;
        const li = document.createElement('li');
        li.className = `cal-point${overridden ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'cal-pick';
        pick.textContent = cal.armed === point.name ? `${point.label} — click the screen` : point.label;
        pick.addEventListener('click', () => { cal.armed = cal.armed === point.name ? undefined : point.name; renderCal(); });
        const xy = document.createElement('span');
        xy.className = 'cal-xy';
        xy.textContent = `${value.x}, ${value.y}`;
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'cal-reset';
        reset.title = 'Reset to profile';
        reset.textContent = '↺';
        reset.addEventListener('click', () => { delete cal.overrides[point.name]; renderCal(); });
        li.append(pick, xy, reset);
        return li;
    }));
}
function renderCalMarkers() {
    if (!cal.screen)
        return;
    elements.calMarkers.replaceChildren(...cal.points.map((point) => {
        const value = calValue(point.name);
        const marker = document.createElement('span');
        marker.className = `m${point.name in cal.overrides ? ' overridden' : ''}${cal.armed === point.name ? ' armed' : ''}`;
        marker.style.left = `${(value.x / cal.screen.width) * 100}%`;
        marker.style.top = `${(value.y / cal.screen.height) * 100}%`;
        marker.title = point.label;
        return marker;
    }));
}
function renderCal() {
    renderCalPoints();
    renderCalMarkers();
}
async function openCalibrate() {
    elements.calStatus.textContent = 'Loading…';
    elements.calibrateDialog.showModal();
    try {
        const data = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/coordinates`);
        cal.screen = data.screenSize;
        cal.points = data.points;
        cal.overrides = {};
        for (const point of data.points)
            if (point.overridden)
                cal.overrides[point.name] = point.current;
        cal.armed = undefined;
        elements.calControl.checked = false;
        elements.calScreen.parentElement?.classList.remove('controlling');
        elements.calProfile.textContent = data.profile;
        elements.calScreen.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
        elements.calStatus.textContent = '';
        renderCal();
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}
function closeCalibrate() {
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
    if (!confirm('Reset all touch points to the profile defaults?'))
        return;
    cal.overrides = {};
    cal.armed = undefined;
    renderCal();
});
function calPointFromEvent(event) {
    const rect = elements.calScreen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * cal.screen.width / rect.width),
        y: Math.round((event.clientY - rect.top) * cal.screen.height / rect.height),
    };
}
async function calSendAction(action) {
    elements.calStatus.textContent = 'Sending input…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/remote/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
        });
        elements.calStatus.textContent = action.type === 'tap' ? `Tapped (${action.x}, ${action.y})` : 'Sent.';
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
}
let calPointerStart;
elements.calControl.addEventListener('change', () => {
    elements.calScreen.parentElement?.classList.toggle('controlling', elements.calControl.checked);
    if (elements.calControl.checked) {
        cal.armed = undefined;
        renderCal();
    }
});
elements.calUnlock.addEventListener('click', () => void calSendAction({ type: 'unlock' }));
elements.calScreen.addEventListener('click', (event) => {
    if (elements.calControl.checked || !cal.armed || !cal.screen)
        return;
    cal.overrides[cal.armed] = calPointFromEvent(event);
    cal.armed = undefined;
    renderCal();
});
elements.calScreen.addEventListener('pointerdown', (event) => {
    if (!elements.calControl.checked || !cal.screen)
        return;
    elements.calScreen.setPointerCapture(event.pointerId);
    calPointerStart = { ...calPointFromEvent(event), time: performance.now() };
});
elements.calScreen.addEventListener('pointerup', (event) => {
    if (!calPointerStart || !cal.screen)
        return;
    const start = calPointerStart;
    const end = calPointFromEvent(event);
    calPointerStart = undefined;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 12) {
        void calSendAction({ type: 'tap', x: end.x, y: end.y });
    }
    else {
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
        for (const point of cal.points)
            point.overridden = point.name in cal.overrides;
        renderCal();
    }
    catch (error) {
        elements.calStatus.textContent = errorMessage(error);
    }
    finally {
        elements.calSave.disabled = false;
    }
});
async function patchPasscode(passcode, pending, done) {
    elements.passcodeResult.textContent = pending;
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passcode }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        const data = await response.json();
        elements.passcodeState.textContent = data.hasPasscode ? '· set' : '· not set';
        elements.devicePasscode.value = '';
        elements.passcodeResult.textContent = done;
    }
    catch (error) {
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
    if (!confirm('Clear this device’s passcode? Automation will not be able to unlock a locked phone.'))
        return;
    void patchPasscode('', 'Clearing…', 'Passcode cleared.');
});
elements.removeDevice.addEventListener('click', async () => {
    elements.removeDevice.disabled = true;
    elements.removeResult.textContent = 'Removing…';
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udid)}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error ?? `Request failed (${response.status})`);
        }
        location.href = '/';
    }
    catch (error) {
        elements.removeDevice.disabled = false;
        elements.removeResult.textContent = errorMessage(error);
    }
});
const loadedSummary = document.querySelector('#device-summary[data-screen-width]');
if (loadedSummary)
    useDeviceSummary(loadedSummary);
const accountList = element('#device-accounts');
async function loadDeviceAccounts() {
    try {
        const accounts = await jsonRequest(`/api/accounts?deviceUdid=${encodeURIComponent(udid)}`);
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
                    }
                    catch (error) {
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
    }
    catch (error) {
        accountList.textContent = errorMessage(error);
    }
}
void loadDeviceAccounts();
setInterval(() => void loadDeviceAccounts(), 5_000);
export {};
