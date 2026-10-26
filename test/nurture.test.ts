import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesNiche, nicheTerms, normalizeText, parseKeywordList } from '../src/nurture/niche.js';
import { dueSlots, pickKeywords } from '../src/nurture/schedule.js';
import { findVideosTab } from '../src/tiktok/search.js';

test('normalizeText folds case, Vietnamese marks and hashtag symbols', () => {
    assert.equal(normalizeText('#Review Mỹ Phẩm'), 'review my pham');
    assert.equal(normalizeText('Đồ ăn  @ngon'), 'do an ngon');
});

test('matchesNiche matches plain words, diacritic-less OCR and glued hashtags', () => {
    const terms = nicheTerms(['#skincare', 'review mỹ phẩm', '  ']);
    assert.deepEqual(terms, ['skincare', 'review my pham']);
    assert.equal(matchesNiche('my morning SKINCARE routine', terms), true);
    assert.equal(matchesNiche('review my pham gia re', terms), true, 'OCR dropped the diacritics');
    assert.equal(matchesNiche('@shop #reviewmypham #fyp', terms), true, 'hashtag glues the words');
    assert.equal(matchesNiche('funny cat compilation', terms), false);
    assert.equal(matchesNiche('', terms), false);
});

test('parseKeywordList splits, trims and de-duplicates case-insensitively', () => {
    assert.deepEqual(parseKeywordList('#gym, workout\n#GYM ,,  leg  day '), ['#gym', 'workout', 'leg day']);
    assert.deepEqual(parseKeywordList(['a', ' A ', 'b']), ['a', 'b']);
});

test('pickKeywords returns a distinct random subset', () => {
    const keywords = ['a', 'b', 'c', 'd'];
    const picked = pickKeywords(keywords, 2, () => 0);
    assert.equal(picked.length, 2);
    assert.equal(new Set(picked).size, 2);
    assert.deepEqual(pickKeywords(keywords, 10).sort(), keywords);
});

test('dueSlots opens a slot at its time for the run window, including past midnight', () => {
    const at = (hours: number, minutes: number, day = 10) => new Date(2026, 9, day, hours, minutes);
    assert.deepEqual(dueSlots(['08:00', '20:00'], at(7, 59), 120), []);
    assert.deepEqual(dueSlots(['08:00', '20:00'], at(8, 0), 120), ['2026-10-10 08:00']);
    assert.deepEqual(dueSlots(['08:00'], at(9, 59), 120), ['2026-10-10 08:00']);
    assert.deepEqual(dueSlots(['08:00'], at(10, 0), 120), [], 'window closed');
    assert.deepEqual(dueSlots(['23:30'], at(0, 15, 11), 120), ['2026-10-10 23:30']);
    assert.deepEqual(dueSlots(['bad', '25:00'], at(8, 0), 120), []);
});

test('findVideosTab only accepts the label in the tab row', () => {
    const word = (text: string, y: number) => ({ text, x: 200, y, width: 80, height: 30, confidence: 90 });
    const height = 1334;
    assert.equal(findVideosTab([word('Videos', 900), word('Videos', 190)], height)?.y, 190);
    assert.equal(findVideosTab([word('Video', 200)], height)?.text, 'Video');
    assert.equal(findVideosTab([word('video', 800)], height), undefined, 'caption text lower down');
    assert.equal(findVideosTab([word('Top', 190)], height), undefined);
});
