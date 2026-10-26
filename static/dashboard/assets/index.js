const PERSONALITY_LABELS = {
    skimmer: 'Lướt nhanh', casual: 'Bình thường', engaged: 'Tương tác nhiều',
};
const STATUS_LABELS = {
    running: 'đang chạy', done: 'xong', failed: 'lỗi', stopped: 'đã dừng',
};
function byId(id) {
    const value = document.getElementById(id);
    if (!value)
        throw new Error(`Missing element: #${id}`);
    return value;
}
const elements = {
    devices: byId('devices'),
    deviceCount: byId('device-count'),
    accounts: byId('accounts'),
    accountCount: byId('account-count'),
    addAccount: byId('add-account'),
    refresh: byId('refresh'),
    pageError: byId('page-error'),
};
let overview;
let openId = null;
let editorRow = null;
function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'class')
            node.className = value;
        else
            node.setAttribute(name, value);
    }
    for (const child of children)
        if (child)
            node.append(child);
    return node;
}
function button(label, className, onClick) {
    const node = el('button', { type: 'button', class: className }, label);
    node.addEventListener('click', (event) => {
        event.stopPropagation();
        void onClick();
    });
    return node;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function jsonRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
    });
    if (response.status === 204)
        return undefined;
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(data.error ?? `Lỗi (${response.status})`);
    return data;
}
function relativeTime(value) {
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60)
        return 'vừa xong';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} phút trước`;
    if (seconds < 86_400)
        return `${Math.floor(seconds / 3600)} giờ trước`;
    return new Date(value).toLocaleString('vi-VN');
}
function sessionSummary(session) {
    const parts = [`${session.videosViewed} video`, `♥ ${session.likes}`, `🔖 ${session.saves}`];
    if (session.videosViewed > 0 && session.nicheMatches > 0) {
        parts.push(`niche ${Math.round((session.nicheMatches / session.videosViewed) * 100)}%`);
    }
    return parts.join(' · ');
}
function deviceName(udid) {
    return overview?.devices.find((device) => device.udid === udid)?.name ?? `${udid.slice(0, 8)}… (chưa đăng ký)`;
}
// ── Devices ─────────────────────────────────────────────────────────────
function deviceCard(device) {
    const online = Boolean(device.connected) && !device.disabled;
    const state = device.disabled ? ['off', 'đã tắt']
        : device.runningSessionId !== null ? ['running', `đang nuôi ${device.runningHandle ?? ''}`.trim()]
            : online ? ['ready', 'sẵn sàng'] : ['offline', 'không kết nối'];
    const preview = online
        ? el('img', {
            class: 'device-preview', alt: `Màn hình ${device.name}`, draggable: 'false',
            src: `/api/devices/${encodeURIComponent(device.udid)}/remote/screenshot?t=${Date.now()}`,
        })
        : el('div', { class: 'device-icon', 'aria-hidden': 'true' });
    if (preview instanceof HTMLImageElement)
        preview.addEventListener('error', () => { preview.style.visibility = 'hidden'; });
    return el('a', { class: `farm-device ${state[0]}`, href: `/devices/${encodeURIComponent(device.udid)}` }, el('div', { class: `device-preview-frame${online ? '' : ' unavailable'}` }, preview), el('div', { class: 'farm-device-copy' }, el('h3', {}, device.name), el('span', { class: `status ${state[0]}` }, el('span', { class: 'dot' }), state[1]), el('p', {}, device.accountCount ? `${device.accountCount} acc` : 'chưa có acc')));
}
function unregisteredCard(device) {
    return el('a', { class: 'farm-device unregistered', href: '/devices/register' }, el('div', { class: 'device-preview-frame unavailable' }, el('div', { class: 'device-icon', 'aria-hidden': 'true' })), el('div', { class: 'farm-device-copy' }, el('h3', {}, device.name), el('span', { class: 'status' }, el('span', { class: 'dot' }), 'chưa đăng ký'), el('p', {}, el('span', { class: 'button secondary small' }, 'Đăng ký'))));
}
function renderDevices(data) {
    const registered = [...data.devices].sort((a, b) => Number(Boolean(b.connected)) - Number(Boolean(a.connected)));
    const cards = [...registered.map(deviceCard), ...data.unregistered.map(unregisteredCard)];
    const pluggedIn = data.devices.filter((device) => device.connected).length + data.unregistered.length;
    elements.deviceCount.textContent = `(${pluggedIn})`;
    elements.devices.replaceChildren(...(cards.length ? cards : [el('div', { class: 'empty-state' }, el('h3', {}, 'Chưa thấy máy nào'), el('p', {}, 'Cắm iPhone qua USB, mở khóa và chọn "Tin cậy máy tính này", rồi bấm Quét lại.'))]));
}
// ── Accounts ────────────────────────────────────────────────────────────
function keywordChips(keywords, limit = 4) {
    const shown = keywords.slice(0, limit).map((keyword) => el('span', { class: 'chip' }, keyword));
    const more = keywords.length > limit ? el('span', { class: 'chip more' }, `+${keywords.length - limit}`) : null;
    return el('div', { class: 'chips' }, ...shown, more);
}
function lastRunCell(account) {
    const session = account.lastSession;
    if (account.running && session) {
        return el('div', { class: 'last-run' }, el('span', { class: 'status running' }, el('span', { class: 'dot' }), 'đang chạy'), el('small', {}, sessionSummary(session)));
    }
    if (!session)
        return el('span', { class: 'muted' }, 'chưa chạy');
    return el('div', { class: 'last-run' }, el('span', { class: `status ${session.status}` }, el('span', { class: 'dot' }), `${STATUS_LABELS[session.status]} · ${relativeTime(session.startedAt)}`), el('small', { title: session.error ?? '' }, session.status === 'failed' && session.error ? session.error : sessionSummary(session)));
}
async function runAction(action) {
    elements.pageError.hidden = true;
    try {
        await action();
        await refresh();
    }
    catch (error) {
        elements.pageError.textContent = errorMessage(error);
        elements.pageError.hidden = false;
    }
}
function accountRow(account) {
    const toggle = () => { openId = openId === account.id ? null : account.id; editorRow = null; render(); };
    const runButton = account.running && account.lastSession
        ? button('■ Dừng', 'button danger small', () => runAction(() => jsonRequest(`/api/sessions/${account.lastSession.id}/stop`, { method: 'POST' })))
        : button('▶ Nuôi', 'button primary small', () => runAction(() => jsonRequest(`/api/accounts/${account.id}/nurture`, { method: 'POST' })));
    const row = el('tr', { class: `account-row${openId === account.id ? ' open' : ''}` }, el('td', {}, el('strong', {}, account.handle), account.enabled ? null : el('span', { class: 'tag' }, 'tắt lịch')), el('td', {}, deviceName(account.deviceUdid)), el('td', {}, keywordChips(account.keywords)), el('td', {}, account.dailyTimes.length ? account.dailyTimes.join(', ') : el('span', { class: 'muted' }, 'chạy tay')), el('td', {}, lastRunCell(account)), el('td', { class: 'row-actions' }, runButton, button(openId === account.id ? 'Đóng' : 'Sửa', 'button secondary small', toggle)));
    row.addEventListener('click', toggle);
    return row;
}
// The editor keeps its own DOM between polls so typing is never interrupted.
function chipEditor(values, placeholder, inputType, normalize) {
    const list = el('div', { class: 'chips editable' });
    const input = el('input', { type: inputType, placeholder });
    const draw = () => {
        list.replaceChildren(...values.map((value, index) => el('span', { class: 'chip' }, value, button('×', 'chip-remove', () => { values.splice(index, 1); draw(); }))));
    };
    const add = () => {
        for (const value of normalize(input.value)) {
            if (!values.some((existing) => existing.toLowerCase() === value.toLowerCase()))
                values.push(value);
        }
        if (inputType === 'time')
            values.sort();
        input.value = '';
        draw();
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || (inputType === 'text' && event.key === ',')) {
            event.preventDefault();
            add();
        }
        else if (event.key === 'Backspace' && !input.value && values.length) {
            values.pop();
            draw();
        }
    });
    input.addEventListener('blur', () => { if (input.value)
        add(); });
    draw();
    return el('div', { class: 'chip-editor' }, list, el('div', { class: 'chip-input' }, input, button(inputType === 'time' ? 'Thêm giờ' : 'Thêm', 'button secondary small', add)));
}
function field(label, control, help) {
    return el('label', { class: 'field' }, el('span', {}, label), control, help ? el('small', {}, help) : null);
}
function numberInput(value, min, max, onChange) {
    const input = el('input', { type: 'number', min: String(min), max: String(max), value: String(value) });
    input.addEventListener('input', () => onChange(Number(input.value)));
    return input;
}
function checkbox(label, checked, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'checkbox-option' }, input, label);
}
async function loadSessions(accountId, target) {
    try {
        const sessions = await jsonRequest(`/api/sessions?accountId=${accountId}&limit=8`);
        target.replaceChildren(...(sessions.length ? sessions.map((session) => el('li', {}, el('span', { class: `status ${session.status}` }, el('span', { class: 'dot' }), STATUS_LABELS[session.status]), el('span', {}, new Date(session.startedAt).toLocaleString('vi-VN')), el('span', { class: 'muted' }, session.trigger === 'schedule' ? `theo lịch ${session.slot?.slice(-5) ?? ''}` : 'chạy tay'), el('span', {}, sessionSummary(session)), el('a', { href: `/api/sessions/${session.id}/log`, target: '_blank', rel: 'noopener' }, 'log'), session.error ? el('small', { class: 'run-error' }, session.error) : null)) : [el('li', { class: 'muted' }, 'Chưa có phiên nào.')]));
    }
    catch (error) {
        target.replaceChildren(el('li', { class: 'run-error' }, errorMessage(error)));
    }
}
function buildEditor(account) {
    const devices = overview?.devices ?? [];
    const draft = account
        ? { ...account, keywords: [...account.keywords], dailyTimes: [...account.dailyTimes] }
        : {
            deviceUdid: devices.find((device) => device.connected)?.udid ?? devices[0]?.udid ?? '', handle: '',
            keywords: [], personality: 'casual', minutesPerSession: 15, keywordsPerSession: 2, forYouMinutes: 3,
            dailyTimes: [], nicheFilter: true, enabled: true,
        };
    const message = el('span', { class: 'run-meta', 'aria-live': 'polite' });
    const deviceSelect = el('select', {});
    for (const device of devices)
        deviceSelect.add(new Option(device.name, device.udid, false, device.udid === draft.deviceUdid));
    deviceSelect.addEventListener('change', () => { draft.deviceUdid = deviceSelect.value; });
    const handleInput = el('input', { type: 'text', placeholder: '@ten_acc', value: draft.handle });
    handleInput.addEventListener('input', () => { draft.handle = handleInput.value; });
    const personalitySelect = el('select', {});
    for (const [value, label] of Object.entries(PERSONALITY_LABELS)) {
        personalitySelect.add(new Option(label, value, false, value === draft.personality));
    }
    personalitySelect.addEventListener('change', () => { draft.personality = personalitySelect.value; });
    const save = async () => {
        const body = JSON.stringify(draft);
        return account
            ? jsonRequest(`/api/accounts/${account.id}`, { method: 'PATCH', body })
            : jsonRequest('/api/accounts', { method: 'POST', body });
    };
    const withMessage = (pending, action) => async () => {
        message.textContent = pending;
        message.classList.remove('error');
        try {
            await action();
        }
        catch (error) {
            message.textContent = errorMessage(error);
            message.classList.add('error');
        }
    };
    const sessionList = el('ul', { class: 'session-list' });
    if (account)
        void loadSessions(account.id, sessionList);
    const actions = el('div', { class: 'form-actions' }, account ? button('Xóa acc', 'button danger', withMessage('Đang xóa…', async () => {
        if (!confirm(`Xóa ${account.handle}? Lịch sử phiên của acc cũng bị xóa.`)) {
            message.textContent = '';
            return;
        }
        await jsonRequest(`/api/accounts/${account.id}`, { method: 'DELETE' });
        openId = null;
        editorRow = null;
        await refresh();
    })) : null, message, el('span', { class: 'spacer' }), button('Hủy', 'button secondary', () => { openId = null; editorRow = null; render(); }), account ? button('▶ Lưu & nuôi ngay', 'button secondary', withMessage('Đang lưu…', async () => {
        await save();
        await jsonRequest(`/api/accounts/${account.id}/nurture`, { method: 'POST' });
        message.textContent = 'Đã bắt đầu phiên nuôi.';
        await refresh();
        void loadSessions(account.id, sessionList);
    })) : null, button(account ? 'Lưu' : 'Thêm acc', 'button primary', withMessage('Đang lưu…', async () => {
        const saved = await save();
        message.textContent = 'Đã lưu.';
        if (!account) {
            openId = saved.id;
            editorRow = null;
        }
        await refresh();
    })));
    const form = el('div', { class: 'account-editor' }, el('div', { class: 'editor-grid' }, field('Máy', deviceSelect), field('Acc TikTok', handleInput, 'Acc phải đang đăng nhập trên máy này.'), el('div', { class: 'field wide' }, el('span', {}, 'Niche — keywords / hashtag'), chipEditor(draft.keywords, 'vd. #skincare hoặc review mỹ phẩm, Enter để thêm', 'text', (value) => value.split(',').map((entry) => entry.trim().replace(/\s+/g, ' ')).filter(Boolean)), el('small', {}, 'Mỗi phiên chọn ngẫu nhiên vài keyword để search, rồi lướt video kết quả.')), el('div', { class: 'field wide' }, el('span', {}, 'Giờ tự chạy mỗi ngày'), chipEditor(draft.dailyTimes, '', 'time', (value) => (/^\d{2}:\d{2}$/.test(value) ? [value] : [])), el('small', {}, 'Để trống nếu chỉ muốn bấm chạy tay.')), field('Thời gian search (phút)', numberInput(draft.minutesPerSession, 1, 180, (value) => { draft.minutesPerSession = value; })), field('Số keyword mỗi phiên', numberInput(draft.keywordsPerSession, 1, 10, (value) => { draft.keywordsPerSession = value; })), field('Lướt For You sau đó (phút)', numberInput(draft.forYouMinutes, 0, 60, (value) => { draft.forYouMinutes = value; }), '0 = bỏ qua.'), field('Kiểu tương tác', personalitySelect), el('div', { class: 'field wide checks' }, checkbox('Lọc theo niche: chỉ like/save video có caption chứa keyword (đọc bằng OCR)', draft.nicheFilter, (value) => { draft.nicheFilter = value; }), checkbox('Bật lịch tự chạy', draft.enabled, (value) => { draft.enabled = value; }))), actions, account ? el('div', { class: 'editor-sessions' }, el('h4', {}, 'Phiên gần đây'), sessionList) : null);
    return el('tr', { class: 'editor-row' }, el('td', { colspan: '6' }, form));
}
function renderAccounts(data) {
    elements.accountCount.textContent = `(${data.accounts.length})`;
    if (openId !== null && openId !== 'new' && !data.accounts.some(({ id }) => id === openId)) {
        openId = null;
        editorRow = null;
    }
    const rows = [];
    if (openId === 'new') {
        editorRow ??= buildEditor(undefined);
        rows.push(editorRow);
    }
    for (const account of data.accounts) {
        rows.push(accountRow(account));
        if (openId === account.id) {
            editorRow ??= buildEditor(account);
            rows.push(editorRow);
        }
    }
    if (!data.accounts.length && openId !== 'new') {
        rows.push(el('tr', {}, el('td', { colspan: '6', class: 'muted-cell' }, data.devices.length ? 'Chưa có acc nào. Bấm "+ Thêm acc" để gán acc và niche cho một máy.'
            : 'Đăng ký một máy trước, sau đó thêm acc cho máy đó.')));
    }
    elements.accounts.replaceChildren(...rows);
}
function render() {
    if (!overview)
        return;
    renderDevices(overview);
    renderAccounts(overview);
}
async function refresh() {
    try {
        overview = await jsonRequest('/api/overview');
        render();
    }
    catch (error) {
        elements.pageError.textContent = `Không tải được dữ liệu: ${errorMessage(error)}`;
        elements.pageError.hidden = false;
    }
}
elements.addAccount.addEventListener('click', () => {
    if (!overview?.devices.length) {
        elements.pageError.textContent = 'Đăng ký một máy trước khi thêm acc.';
        elements.pageError.hidden = false;
        return;
    }
    openId = 'new';
    editorRow = null;
    render();
});
elements.refresh.addEventListener('click', () => void refresh());
await refresh();
setInterval(() => void refresh(), 5_000);
export {};
