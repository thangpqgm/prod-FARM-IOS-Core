import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesNiche, nicheTerms, normalizeText, parseKeywordList } from '../src/nurture/niche.js';
import { dueSlots, pickKeywords } from '../src/nurture/schedule.js';
import { isOnFeed, parsePageSource, pickResultCell, resultCells, searchIconPoint } from '../src/tiktok/search.js';

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

const RESULTS_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TikTok" label="TikTok" enabled="true" visible="true" x="0" y="0" width="375" height="812">
  <XCUIElementTypeSearchField type="XCUIElementTypeSearchField" value="glp1" label="" enabled="true" visible="true" x="40" y="50" width="280" height="36"/>
  <XCUIElementTypeOther type="XCUIElementTypeOther" label="Week 3 on glp1 &amp; my &quot;results&quot;&#10;#weightloss. Photo. Oct 2. anna.fit. 1.2K likes." enabled="true" visible="true" x="8" y="180" width="176" height="330"/>
  <XCUIElementTypeOther type="XCUIElementTypeOther" label="What I eat. Video. Top liked. 2025-9-14. coach.ben. Verified account. 15.5K likes." enabled="true" visible="true" x="191" y="180" width="176" height="330"/>
  <XCUIElementTypeOther type="XCUIElementTypeOther" label="Hidden. Video. Oct 1. x. 3 likes." enabled="true" visible="false" x="8" y="900" width="176" height="330"/>
  <XCUIElementTypeOther type="XCUIElementTypeOther" label="Below. Video. 3d ago. y. 12 likes." enabled="true" visible="true" x="8" y="520" width="176" height="330"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Top" enabled="true" visible="true" x="16" y="100" width="40" height="30"/>
</XCUIElementTypeApplication>`;

test('parsePageSource keeps visible elements and decodes XML entities', () => {
    const elements = parsePageSource(RESULTS_SOURCE);
    assert.equal(elements.some(({ label }) => label.startsWith('Hidden')), false);
    assert.equal(elements.find(({ type }) => type === 'SearchField')?.width, 280);
    assert.equal(elements.find(({ label }) => label.startsWith('Week 3'))?.label,
        'Week 3 on glp1 & my "results"\n#weightloss. Photo. Oct 2. anna.fit. 1.2K likes.');
});

test('resultCells finds result tiles in reading order and pickResultCell takes the top-left one', () => {
    const cells = resultCells(parsePageSource(RESULTS_SOURCE));
    assert.deepEqual(cells.map(({ label }) => label.split('.')[0]), ['Week 3 on glp1 & my "results"\n#weightloss', 'What I eat', 'Below']);
    // TikTok labels videos "Photo" too, so the label's kind is ignored.
    assert.equal(pickResultCell(cells)?.label.startsWith('Week 3'), true);
    assert.equal(pickResultCell([]), undefined);
});

test('searchIconPoint follows the measured notch / no-notch layouts', () => {
    assert.deepEqual(searchIconPoint({ width: 375, height: 812 }), { x: 345, y: 67 });
    assert.deepEqual(searchIconPoint({ width: 375, height: 667 }), { x: 345, y: 43 });
});

test('isOnFeed reads the For You / Following header near the top only', () => {
    const word = (text: string, y: number) => ({ text, x: 100, y, width: 60, height: 30, confidence: 90 });
    assert.equal(isOnFeed([word('For', 120), word('You', 120)], 3), true);
    assert.equal(isOnFeed([word('Following', 150)], 3), true);
    assert.equal(isOnFeed([word('Following', 900)], 3), false, 'lower on the screen is content, not the header');
    assert.equal(isOnFeed([word('Search', 120)], 3), false);
});
