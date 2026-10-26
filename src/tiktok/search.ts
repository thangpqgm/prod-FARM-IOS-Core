// Keyword search, ported from the tiktok-mkt-system search_ios.py flow that
// was measured on a real iPhone (TikTok 44.x, English UI, 2026-10-26):
// relaunch → tap the magnifier on the feed by coordinate → type into the
// auto-focused SearchField → read result cells from the element tree → open one.
// The element tree hangs while a video feed plays, so it is only read once
// OCR confirms the app has left the feed.
import type { Browser } from 'webdriverio';

import type { WdaRemoteControl } from '../devices/wda-remote.js';
import { typeText } from './actions.js';
import { recognizeWords, type OcrWord } from './ocr.js';

export interface ScreenElement {
    type: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SearchOptions {
    bundleId: string;
    /** A wait that returns early when the session is being stopped. */
    pause: (ms: number) => Promise<void>;
}

// Result cell label: "<caption>. Photo|Video. [badge.] <date>. <author>[. Verified account]. <N> likes."
const RESULT_CELL = /^(?<caption>[\s\S]*)\. (?<kind>Photo|Video)\. (?<rest>.+)\. (?<likes>[\d.,]+[KMB]?) likes?\.$/;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, code: string) => {
        if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
        if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
        return XML_ENTITIES[code] ?? entity;
    });
}

/** Visible elements of an XCUITest page source, in document order. */
export function parsePageSource(xml: string): ScreenElement[] {
    const elements: ScreenElement[] = [];
    for (const match of xml.matchAll(/<XCUIElementType\w+\s([^>]*?)\/?>/g)) {
        const attributes: Record<string, string> = {};
        for (const [, name, value] of match[1]!.matchAll(/(\w+)="([^"]*)"/g)) attributes[name!] = decodeXml(value!);
        if (attributes.visible !== 'true') continue;
        elements.push({
            type: (attributes.type ?? '').replace(/^XCUIElementType/, ''),
            label: attributes.label ?? '',
            x: Number(attributes.x ?? 0),
            y: Number(attributes.y ?? 0),
            width: Number(attributes.width ?? 0),
            height: Number(attributes.height ?? 0),
        });
    }
    return elements;
}

/** Search result cells, top to bottom then left to right. */
export function resultCells(elements: readonly ScreenElement[]): ScreenElement[] {
    return elements
        .filter((element) => element.type === 'Other' && RESULT_CELL.test(element.label))
        .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The first video result (the feed loop that follows scrolls videos); a photo post only if there is no video. */
export function pickResultCell(cells: readonly ScreenElement[]): ScreenElement | undefined {
    return cells.find((cell) => RESULT_CELL.exec(cell.label)?.groups?.kind === 'Video') ?? cells[0];
}

/** Where the magnifier sits on the feed: 30pt from the right, lower on notched (≥812pt tall) screens. */
export function searchIconPoint(screen: { width: number; height: number }): { x: number; y: number } {
    return { x: screen.width - 30, y: screen.height >= 812 ? 67 : 43 };
}

/** True while the "For You" / "Following" header is in the top 110pt, i.e. still on the video feed. */
export function isOnFeed(words: readonly OcrWord[], scale: number): boolean {
    const top = words.filter((word) => (word.y + word.height / 2) / scale < 110).map((word) => word.text.trim());
    return top.includes('Following') || top.some((text, index) => text === 'For' && top[index + 1] === 'You')
        || top.includes('For You');
}

export async function relaunchTikTok(driver: Browser, { bundleId, pause }: SearchOptions): Promise<void> {
    await driver.execute('mobile: terminateApp', { bundleId });
    await pause(1000);
    await driver.activateApp(bundleId);
    // TikTok keeps loading after launch; taps sent earlier are swallowed.
    await pause(8000);
}

async function waitForElements<T>(
    driver: Browser, pause: SearchOptions['pause'], timeoutMs: number, pick: (elements: ScreenElement[]) => T | undefined,
): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = pick(parsePageSource(await driver.getPageSource()));
        if (found) return found;
        await pause(1000);
    }
    return undefined;
}

/**
 * From a fresh launch: open Search, search `keyword` and open a result from
 * the Top tab, leaving the result playing so the caller can scroll on.
 */
export async function openSearchResults(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    keyword: string,
    options: SearchOptions,
): Promise<void> {
    const { pause } = options;
    await relaunchTikTok(driver, options);

    const { screenSize, scale } = await remote.getScreenInfo(udid);
    const icon = searchIconPoint(screenSize);
    let field: ScreenElement | undefined;
    for (let attempt = 1; attempt <= 2 && !field; attempt += 1) {
        // Absolute tap (no element snapshot): the playing feed makes snapshots hang.
        await remote.performAction(udid, { type: 'tap', ...icon });
        console.log(`Tapped Search at (${icon.x}, ${icon.y}) (attempt ${attempt})`);
        await pause(1500);
        if (isOnFeed(await recognizeWords(await remote.getScreenshot(udid)), scale)) continue;
        field = await waitForElements(driver, pause, 20_000, (elements) => elements.find(({ type }) => type === 'SearchField'));
    }
    if (!field) throw new Error('Could not open the TikTok Search page');

    // The field normally takes focus with the keyboard up; tap it if the keyboard is missing.
    const elements = parsePageSource(await driver.getPageSource());
    if (!elements.some(({ type }) => type === 'Key')) {
        await remote.performAction(udid, { type: 'tap', x: Math.round(field.x + field.width / 2), y: Math.round(field.y + field.height / 2) });
        await pause(800);
    }
    await typeText(driver, `${keyword}\n`);
    console.log(`Searched for "${keyword}"`);

    const cells = await waitForElements(driver, pause, 30_000, (current) => {
        const found = resultCells(current);
        return found.length ? found : undefined;
    });
    const cell = cells && pickResultCell(cells);
    if (!cell) throw new Error(`No search results appeared for "${keyword}"`);
    // Tap the thumbnail part of the cell, clear of the author name underneath.
    const target = { x: Math.round(cell.x + cell.width / 2), y: Math.round(cell.y + Math.min(cell.height / 3, 120)) };
    await remote.performAction(udid, { type: 'tap', ...target });
    console.log(`Opened result: ${cell.label.slice(0, 100)}`);
    await pause(3000);
}
