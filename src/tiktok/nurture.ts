// One nurture session for one account: search each picked niche keyword,
// scroll its video results engaging like a person would, then check the For
// You feed. Started by the farm (NURTURE_SESSION_ID) or by hand:
//   npm run nurture -- --account <id>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { remote, type Browser } from 'webdriverio';

import { openDatabase } from '../db/client.js';
import { FarmRepository } from '../db/repository.js';
import type { Session } from '../db/schema.js';
import { resolveDeviceCoordinates } from '../devices/coordinates.js';
import { loadRegisteredDevices } from '../devices/registry.js';
import { passcodeForDevice } from '../devices/secrets.js';
import { WdaRemoteControl } from '../devices/wda-remote.js';
import { matchesNiche, nicheTerms } from '../nurture/niche.js';
import { logDirectory } from '../nurture/runner.js';
import { pickKeywords } from '../nurture/schedule.js';
import { doubleTapCoordinate, switchTikTokAccount, tapCoordinate } from './actions.js';
import { readCaption } from './caption.js';
import {
    PROFILES, clampToDeadline, decideLike, decideLinger, decideSave, hasTimeRemaining, pickWatchDurationMs,
} from './doomscroll-profile.js';
import { detectEngagementControls } from './engagement-controls.js';
import { coordinateProfile } from './runtime-settings.js';
import { openSearchResults, relaunchTikTok, type SearchOptions } from './search.js';

const repository = new FarmRepository(openDatabase());

function resolveSession(): Session {
    const { values } = parseArgs({ options: { account: { type: 'string' } } });
    if (process.env.NURTURE_SESSION_ID) {
        const session = repository.session(Number(process.env.NURTURE_SESSION_ID));
        if (!session) throw new Error(`Session ${process.env.NURTURE_SESSION_ID} does not exist`);
        return session;
    }
    const account = values.account ? repository.account(Number(values.account)) : undefined;
    if (!account) throw new Error('Pass --account <id> (see the account list on the dashboard)');
    const session = repository.startSession(account, 'manual');
    if (!session) throw new Error('Could not create a session');
    return session;
}

const session = resolveSession();
const account = repository.account(session.accountId);
if (!account) throw new Error(`Account ${session.accountId} no longer exists`);
const udid = account.deviceUdid;
const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
if (!device) throw new Error(`Device ${udid} is not registered`);

const profile = PROFILES[account.personality];
const terms = nicheTerms(account.keywords);
const coordinates = resolveDeviceCoordinates(coordinateProfile(device), device.coordinates);
const tiktok = coordinates.tiktok;
const wdaUrl = process.env.WDA_URL ?? `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
const tiktokBundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': tiktokBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 120,
    'appium:webDriverAgentUrl': wdaUrl,
    'appium:wdaRemotePort': 8100,
    // TikTok's video feed never becomes fully idle; see doomscroll.ts.
    'appium:waitForIdleTimeout': 0,
};

// Cooperative cancellation: the farm's Stop sends SIGTERM. Every wait races
// stopPromise so a stop interrupts immediately.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopRequested = true;
        resolveStop();
    });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function interactionPauseMs(): number {
    return Math.round(200 + Math.random() * 400);
}

const remoteControl = new WdaRemoteControl({
    deviceUdid: udid,
    wdaUrl,
    passcode: await passcodeForDevice(udid),
    passcodeKeypadLayout: coordinates.passcodeKeypad,
});
let driver: Browser | undefined;
const searchOptions: SearchOptions = { bundleId: tiktokBundleId, pause: cancellableDelay };
let like = tiktok.like;
let save = tiktok.save;

async function locateEngagementControls(): Promise<void> {
    try {
        const [screenshot, screen] = await Promise.all([
            remoteControl.getScreenshot(udid),
            remoteControl.getScreenInfo(udid),
        ]);
        const detected = await detectEngagementControls(screenshot, screen.scale);
        if (detected) {
            ({ like, save } = detected);
            console.log(`Detected engagement controls: like=(${like.x}, ${like.y}) save=(${save.x}, ${save.y})`);
            return;
        }
    } catch (error) {
        console.log(`Engagement control detection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    ({ like, save } = tiktok);
    console.log('Using profile coordinates for like/save');
}

async function saveFailureScreenshot(label: string): Promise<string | undefined> {
    try {
        const file = path.join(logDirectory(), `session-${session.id}-${label}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, await remoteControl.getScreenshot(udid));
        return file;
    } catch {
        return undefined;
    }
}

/**
 * Watches and swipes until `deadline`. With the niche filter on, the caption
 * is read first: off-niche videos are skimmed and never liked or saved.
 */
async function scrollFeed(activeDriver: Browser, keyword: string | null, deadline: number): Promise<void> {
    const timeLeft = () => !stopRequested && hasTimeRemaining(Date.now(), deadline);
    while (timeLeft()) {
        const videoStart = Date.now();
        let caption: string | null = null;
        let matchedNiche: boolean | null = null;
        if (account!.nicheFilter) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, 1200));
            if (!timeLeft()) break;
            try {
                caption = await readCaption(await remoteControl.getScreenshot(udid));
                matchedNiche = matchesNiche(caption, terms);
            } catch (error) {
                console.log(`Caption OCR failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const relevant = matchedNiche !== false;
        const watchMs = pickWatchDurationMs(relevant ? profile : PROFILES.skimmer) - (Date.now() - videoStart);
        await cancellableDelay(clampToDeadline(Date.now(), deadline, watchMs));
        if (!timeLeft()) break;

        let liked = false;
        let saved = false;
        if (relevant && decideLike(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (!timeLeft()) break;
            await doubleTapCoordinate(activeDriver, like.x, like.y, 'Like');
            liked = true;
        }
        if (relevant && decideSave(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (!timeLeft()) break;
            await tapCoordinate(activeDriver, save.x, save.y, 'Save');
            saved = true;
        }
        if (relevant) {
            const { linger, extraMs } = decideLinger(profile);
            if (linger) await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        }
        repository.recordInteraction(session.id, {
            keyword, caption, matchedNiche, liked, saved, watchedMs: Date.now() - videoStart,
        });
        console.log(`Video: niche=${matchedNiche ?? 'n/a'} liked=${liked} saved=${saved}${caption ? ` caption="${caption.slice(0, 80)}"` : ''}`);
        if (!timeLeft()) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (!timeLeft()) break;
        // Coordinate swipes bypass XCTest's element lookup, which can hang on
        // TikTok's continuously updating feed.
        await activeDriver.performActions([{
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, x: tiktok.swipe.x, y: tiktok.swipe.startY },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 100 },
                { type: 'pointerMove', duration: tiktok.swipe.durationMs, x: tiktok.swipe.x, y: tiktok.swipe.endY },
                { type: 'pointerUp', button: 0 },
            ],
        }]);
        await activeDriver.releaseActions();
    }
}

const keywords = pickKeywords(account.keywords, account.keywordsPerSession);
console.log(`Session ${session.id}: ${account.handle} on ${device.name}, keywords=${JSON.stringify(keywords)}, `
    + `${account.warmupMinutes} min warm-up + ${account.minutesPerSession} min search + ${account.forYouMinutes} min For You, `
    + `personality=${account.personality}, `
    + `nicheFilter=${account.nicheFilter}`);

try {
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening TikTok on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: Number(process.env.APPIUM_PORT ?? 4725),
        path: '/',
        logLevel: 'warn',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: tiktokBundleId });
    await cancellableDelay(3000);

    console.log(`Switching to TikTok account "${account.handle}"`);
    await switchTikTokAccount(driver, remoteControl, udid, account.handle, {
        profileTabX: tiktok.profileTab.x,
        profileTabY: tiktok.profileTab.y,
        switcherTriggerX: tiktok.accountSwitcher.x,
        switcherTriggerY: tiktok.accountSwitcher.y,
    });

    // Warm-up: scroll For You for a while first, then search from that same
    // feed, instead of opening the app straight into Search.
    let onFeed = false;
    if (!stopRequested && account.warmupMinutes > 0) {
        console.log(`Warming up on the For You feed for ${account.warmupMinutes} min before searching`);
        await relaunchTikTok(driver, searchOptions);
        await locateEngagementControls();
        await scrollFeed(driver, null, Date.now() + account.warmupMinutes * 60_000);
        onFeed = true;
    }

    const perKeywordMs = (account.minutesPerSession * 60_000) / Math.max(1, keywords.length);
    let searchFailures = 0;
    for (const keyword of keywords) {
        if (stopRequested) break;
        const relaunch = !onFeed;
        onFeed = false;
        try {
            await openSearchResults(driver, remoteControl, udid, keyword, { ...searchOptions, relaunch });
        } catch (error) {
            searchFailures += 1;
            const screenshot = await saveFailureScreenshot(`search-${searchFailures}`);
            console.error(`Search for "${keyword}" failed: ${error instanceof Error ? error.message : String(error)}`
                + `${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
            continue;
        }
        await locateEngagementControls();
        await scrollFeed(driver, keyword, Date.now() + perKeywordMs);
    }
    if (keywords.length > 0 && searchFailures === keywords.length) {
        throw new Error('Every keyword search failed; see the search-*.png screenshots in the log folder');
    }

    if (!stopRequested && account.forYouMinutes > 0) {
        console.log('Checking the For You feed');
        await relaunchTikTok(driver, searchOptions);
        await locateEngagementControls();
        await scrollFeed(driver, null, Date.now() + account.forYouMinutes * 60_000);
    }

    repository.finishSession(session.id, stopRequested ? 'stopped' : 'done');
    const result = repository.session(session.id);
    console.log(`Finished session ${session.id}: status=${result?.status} videos=${result?.videosViewed} `
        + `likes=${result?.likes} saves=${result?.saves} nicheMatches=${result?.nicheMatches}`);
} catch (error) {
    repository.finishSession(session.id, stopRequested ? 'stopped' : 'failed', error instanceof Error ? error.message : String(error));
    throw error;
} finally {
    if (driver) await driver.deleteSession().catch(() => {});
}
