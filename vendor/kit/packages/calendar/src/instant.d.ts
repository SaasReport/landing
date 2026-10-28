import type { Jalali } from "./index.js";

/** The day number of an instant's wall-clock date in a time zone (Gregorian Intl parts only, never ICU Persian). */
export function zonedDay(date: Date | string | number, timeZone?: string): number;
/** The Jalali date of an instant in a time zone, by arithmetic. */
export function jalaliFor(date: Date | string | number, timeZone?: string): Jalali & { n: number };
export interface FormatJalaliOptions extends Omit<Intl.DateTimeFormatOptions, "calendar" | "numberingSystem" | "timeZone"> {
  /** BCP 47 tag; only its language/region are used, on the Gregorian calendar with Latin digits. Default "fa". */
  locale?: string;
  /** IANA time zone. Default "UTC". */
  timeZone?: string;
  /** Twelve Jalali month names (default: the kit's names for the language). */
  months?: readonly string[];
}
/** Intl's layout for the locale and options, with the arithmetic Jalali year, month and day. Latin digits. */
export function formatJalali(date: Date | string | number, options?: FormatJalaliOptions): string;
/** Jalali month names (fa, en, ar). */
export const J_MONTH_NAMES: Readonly<Record<"fa" | "en" | "ar", readonly string[]>>;
/** Day number of Nowruz of Jalali year jy (unchecked). */
export function nowruzDay(jy: number): number;
/** Jalali date of a day number, by arithmetic. */
export function toJalali(n: number): Jalali;
/** The locale tag without its calendar keyword (never resolved through ICU). */
export function withoutCalendar(locale: string): string;
/** "jalali" when the locale's own calendar is Persian (explicit or CLDR default), else undefined. */
export function ownSystem(locale: string): "jalali" | undefined;
/** An Intl tag for dates in `system` that never resolves to ICU's Persian calendar. */
export function dateTag(locale: string, system?: string): string;
export interface FormatInstantOptions extends Omit<Intl.DateTimeFormatOptions, "calendar" | "timeZone"> {
  locale?: string;
  /** "jalali" (arithmetic), "gregorian", "hijri" …; omitted: the locale's own calendar. */
  calendar?: string;
  timeZone?: string;
}
/** An instant in a calendar system: Jalali by arithmetic, other calendars through Intl. */
export function formatInstant(date: Date | string | number, options?: FormatInstantOptions): string;
