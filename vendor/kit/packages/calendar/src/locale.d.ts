/** Month and weekday names (en, ar, fa) and labels in one or two calendars. Weekdays: 0 = Sunday. */
export type System = "gregorian" | "hijri-umalqura" | "hijri-civil" | "jalali";
export type Digits = "latin" | "arabic" | "persian";
/** Any site locale pack (packages/site/src/locales/*.js) fits: code, digits, months, hijriSuffix. */
export interface PackLike { code?: string; lang?: string; digits?: Digits; hijriSuffix?: string; months?: { gregorian?: string[]; hijri?: string[]; jalali?: string[] } }
export interface FormatOptions { system?: System | "hijri"; locale?: string; pack?: PackLike; digits?: Digits; weekday?: boolean; era?: boolean; variant?: "gulf" | "levant" }
export declare const SYSTEMS: System[];
export declare const LOCALES: string[];
export declare const DIGITS: Record<Digits, string>;
export declare const DEFAULT_DIGITS: Record<string, Digits>;
export declare function toDigits(v: unknown, digits?: Digits): string;
export declare function monthNames(system: System | "hijri", locale?: string, o?: { pack?: PackLike; variant?: "gulf" | "levant" }): string[];
export declare function weekdayNames(locale?: string, o?: { start?: number; style?: "long" | "short" }): string[];
export declare function dateParts(n: number, system?: System | "hijri"): { year: number; month: number; day: number };
export declare function monthSpan(system: System | "hijri", y: number, m: number): { first: number; length: number };
export declare function formatDate(n: number, o?: FormatOptions): string;
export declare function monthTitle(system: System | "hijri", y: number, m: number, o?: Omit<FormatOptions, "system" | "weekday">): string;
export declare function formatDual(n: number, o?: Omit<FormatOptions, "system"> & { systems?: (System | "hijri")[]; primary?: System | "hijri" }): { primary: string; secondary: string[]; text: string };
