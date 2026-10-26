export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A random `count` of the keywords, in random order (all of them when count ≥ length). */
export function pickKeywords(keywords: readonly string[], count: number, random: () => number = Math.random): string[] {
    const pool = [...keywords];
    for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
    }
    return pool.slice(0, Math.max(0, count));
}

function localDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The daily slot that is due at `now` (host local time), as "YYYY-MM-DD HH:MM".
 * A slot is due from its start time until `windowMinutes` later; yesterday's
 * slots are checked too so a 23:30 start can still run after midnight.
 */
export function dueSlots(dailyTimes: readonly string[], now: Date, windowMinutes: number): string[] {
    const due: string[] = [];
    for (const dayOffset of [-1, 0]) {
        for (const time of dailyTimes) {
            if (!TIME_PATTERN.test(time)) continue;
            const [hours, minutes] = time.split(':').map(Number) as [number, number];
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes);
            const elapsedMs = now.getTime() - start.getTime();
            if (elapsedMs >= 0 && elapsedMs < windowMinutes * 60_000) due.push(`${localDate(start)} ${time}`);
        }
    }
    return due;
}
