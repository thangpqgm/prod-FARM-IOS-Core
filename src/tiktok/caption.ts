import sharp from 'sharp';

import { recognizeWords } from './ocr.js';

// Caption, @handle, hashtags and the sound name sit in the lower-left of the
// player, left of the like/comment/save column and above the tab bar.
const CAPTION_REGION = { left: 0, top: 0.62, width: 0.8, height: 0.3 };

/** OCR text of the playing video's caption area; '' when nothing is legible. */
export async function readCaption(screenshot: Buffer): Promise<string> {
    const { width, height } = await sharp(screenshot).metadata();
    if (!width || !height) return '';
    const region = await sharp(screenshot).extract({
        left: Math.round(width * CAPTION_REGION.left),
        top: Math.round(height * CAPTION_REGION.top),
        width: Math.round(width * CAPTION_REGION.width),
        height: Math.round(height * CAPTION_REGION.height),
    }).png().toBuffer();
    return (await recognizeWords(region)).map(({ text }) => text).join(' ');
}
