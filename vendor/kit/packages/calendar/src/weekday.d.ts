/** @saasreport/calendar/weekday — the canonical weekday convention (ISO 8601: 1 = Monday … 7 = Sunday) and adapters
 *  to the legacy ones: "saturday0" (index.js: 0 = Saturday … 6 = Friday) and "sunday0" (markets.js, business.js,
 *  locale.js, kit.config.js: 0 = Sunday … 6 = Saturday). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type WeekdayConvention = "iso" | "sunday0" | "saturday0";
export declare const MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6, SUNDAY: 7;
export declare const ISO_WEEKDAYS: readonly IsoWeekday[];
export declare const WEEKDAY_CONVENTIONS: Readonly<Record<WeekdayConvention, { first: number; description: string; legacy: boolean }>>;
/** ISO weekday of an engine day number. */
export declare function isoWeekday(n: number): IsoWeekday;
export declare function fromSundayIndex(d: number): IsoWeekday;
export declare function toSundayIndex(iso: number): number;
export declare function fromSaturdayIndex(d: number): IsoWeekday;
export declare function toSaturdayIndex(iso: number): number;
export declare function convertWeekday(v: number, from: WeekdayConvention, to: WeekdayConvention): number;
/** Persian/Arabic text normalised for matching: digits → Latin, ي/ى → ی, ك → ک, bidi marks/ZWJ/tatweel removed,
 *  ZWNJ kept once between letters, whitespace collapsed. */
export declare function normalizeText(s: unknown): string;
/** Lookup key for a month/weekday name: normalizeText, lower case, alef forms → ا, ة → ه, no spaces/ZWNJ/hyphens/apostrophes. */
export declare function foldName(s: unknown): string;
/** ISO weekday from 1–7 or a name ("Mon", "monday", "دوشنبه", "يكشنبه", "سه شنبه", "الإثنين"); null when unknown. */
export declare function parseWeekday(v: unknown): IsoWeekday | null;
