// OCR output and keywords differ in case, diacritics (OCR often drops or
// garbles Vietnamese marks) and hashtag spacing, so both sides are folded to
// plain lowercase ASCII-ish text before comparing.
export function normalizeText(value: string): string {
    return value.normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[#@]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Distinct, normalized terms for a list of keywords; empty entries are dropped. */
export function nicheTerms(keywords: readonly string[]): string[] {
    return [...new Set(keywords.map(normalizeText).filter(Boolean))];
}

/**
 * True when the caption mentions any term. A term also matches with its spaces
 * removed, because hashtags glue words together ("review my pham" ↔ "#reviewmypham").
 */
export function matchesNiche(caption: string, terms: readonly string[]): boolean {
    const text = normalizeText(caption);
    if (!text) return false;
    const compact = text.replace(/ /g, '');
    return terms.some((term) => text.includes(term) || compact.includes(term.replace(/ /g, '')));
}

/** Parses a comma/newline separated list, trimming and de-duplicating case-insensitively. */
export function parseKeywordList(value: string | readonly string[]): string[] {
    const raw = typeof value === 'string' ? value.split(/[,\n]/) : value;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of raw) {
        const keyword = entry.trim().replace(/\s+/g, ' ');
        const key = keyword.toLowerCase();
        if (!keyword || seen.has(key)) continue;
        seen.add(key);
        result.push(keyword);
    }
    return result;
}
