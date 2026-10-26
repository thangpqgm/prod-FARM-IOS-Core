import type { Browser } from 'webdriverio';

import type { DeviceCoordinates } from '../devices/coordinates.js';
import type { WdaRemoteControl } from '../devices/wda-remote.js';
import { tapCoordinate, typeText } from './actions.js';
import { pointFromWord, recognizeWords, type OcrWord } from './ocr.js';

const VIDEOS_TAB_LABELS = new Set(['videos', 'video']);

/**
 * The "Videos" tab label among OCR words, if it sits in the top quarter of
 * the screen (the tab row). Lower matches are captions or suggestions.
 * `screenHeightPx` is in screenshot pixels, like the word boxes.
 */
export function findVideosTab(words: readonly OcrWord[], screenHeightPx: number): OcrWord | undefined {
    return words
        .filter((word) => VIDEOS_TAB_LABELS.has(word.text.toLowerCase().replace(/[^a-z]/g, '')))
        .filter((word) => word.y + word.height / 2 < screenHeightPx * 0.25)
        .sort((a, b) => a.y - b.y)[0];
}

/**
 * From the Home feed: search `keyword`, switch to the Videos results and open
 * the first one, which leaves a vertical feed of results to scroll.
 */
export async function openSearchResults(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    keyword: string,
    tiktok: DeviceCoordinates['tiktok'],
): Promise<void> {
    await tapCoordinate(driver, tiktok.searchIcon.x, tiktok.searchIcon.y, 'Search');
    await driver.pause(1500);
    // The search field takes focus on open; "\n" submits like the keyboard's Search key.
    await typeText(driver, `${keyword}\n`);
    console.log(`Searched for "${keyword}"`);
    await driver.pause(3500);

    const { scale, screenSize } = await remote.getScreenInfo(udid);
    const tab = findVideosTab(await recognizeWords(await remote.getScreenshot(udid)), screenSize.height * scale);
    const tabPoint = tab ? pointFromWord(tab, scale) : tiktok.searchVideosTab;
    await tapCoordinate(driver, tabPoint.x, tabPoint.y, tab ? 'Videos tab (OCR)' : 'Videos tab (profile)');
    await driver.pause(2500);

    await tapCoordinate(driver, tiktok.searchFirstResult.x, tiktok.searchFirstResult.y, 'First result');
    await driver.pause(2500);
}
