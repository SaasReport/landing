/** @saasreport/calendar — financial calendar engine (Solar Hijri / Gregorian / lunar Hijri, Iranian holidays). Days are integers (days since 1970-01-01 UTC). */
export type Day = number;
export type ProfileName = "bank" | "government" | "market";
export type Convention = "following" | "modified_following" | "preceding" | "modified_preceding" | "nearest" | "none";
export interface Options { profile?: ProfileName; /** legacy Saturday-first weekday numbers (0 = Saturday … 6 = Friday) */ weekend?: number[]; /** false: ignore the built-in holiday table */ holidays?: boolean }
export interface Jalali { jy: number; jm: number; jd: number }
export interface Hijri { hy: number; hm: number; hd: number }
export interface Gregorian { gy: number; gm: number; gd: number }
export interface CalendarEvent { title: string; holiday: boolean; kind: "solar" | "lunar" | "finance" | "culture"; status: "official" | "predicted" | "fixed"; hijri?: string }
export interface Holiday extends CalendarEvent { date: Day }
export interface DayStatus { business: boolean; weekend: boolean; holiday: boolean; uncertain: boolean }
export interface Moved { date: Day; moved: number; uncertain: boolean }
export interface Instalment { n: number; scheduled: Day; due: Day; moved: number; uncertain: boolean; amount: number }
export interface Described extends DayStatus {
  date: Day; iso: string; weekday: number; weekday_fa: string;
  jalali: Jalali & { text: string; long: string }; hijri: Hijri & { long: string }; gregorian: Gregorian & { long: string };
  season: string; quarter: number; day_of_year: number; days_in_year: number; leap_year: boolean; events: CalendarEvent[];
}
export class CalendarError extends Error { code: string }
export const VERSION: string; export const TZ: "Asia/Tehran"; export const RANGE: { min: number; max: number };
export const J_MONTHS: string[]; export const H_MONTHS: string[]; export const G_MONTHS: string[]; export const WEEKDAYS: string[]; export const SEASONS: string[];
export const PROFILES: Record<ProfileName, { title: string; weekend: number[] }>;
export const CONVENTIONS: Record<Convention, string>;
export function fa(v: unknown): string; export function latin(s: string): string;
export function fromISO(iso: string): Day; export function toISO(n: Day): string; export function today(now?: Date): Day;
/** Legacy convention, unchanged: 0 = Saturday … 6 = Friday (also PROFILES[*].weekend and Options.weekend). New code: isoWeekday. */
export function weekday(n: Day): number;
/** ISO weekday: 1 = Monday … 7 = Sunday (the canonical convention; converters in "@saasreport/calendar/weekday"). */
export function isoWeekday(n: Day): 1 | 2 | 3 | 4 | 5 | 6 | 7;
export function toJalali(n: Day): Jalali; export function toHijri(n: Day): Hijri; export function toGregorian(n: Day): Gregorian;
export function fromJalali(jy: number, jm: number, jd: number): Day; export function nowruz(jy: number): Day; export function isLeap(jy: number): boolean; export function monthLength(jy: number, jm: number): number;
export function parseDate(input: string | number, now?: Date): Day;
export function registerOfficialLunar(table: Record<number, Record<string, string>>): void; export function officialYears(): number[];
export function yearEvents(jy: number): Map<Day, CalendarEvent[]>; export function eventsOn(n: Day): CalendarEvent[]; export function holidaysOn(n: Day): CalendarEvent[]; export function holidays(jy: number): Holiday[];
export function dayStatus(n: Day, o?: Options): DayStatus; export function isBusinessDay(n: Day, o?: Options): boolean;
export function adjust(n: Day, convention?: Convention, o?: Options): Moved; export function addBusinessDays(n: Day, k: number, o?: Options): Moved;
export function businessDaysBetween(a: Day, b: Day, o?: Options): { business: number; calendar: number; uncertain: boolean };
export function settlement(n: Day, t?: number, o?: Options): Moved;
export function schedule(p: { start: string | Day; count?: number; amount?: number; day?: number; convention?: Convention; interval?: number } & Options): Instalment[];
export function deadline(n: Day, days: number, type?: "business" | "calendar", o?: Options): Moved;
export function describe(n: Day, o?: Options): Described;
export function month(jy: number, jm: number, o?: Options): { jy: number; jm: number; title: string; length: number; first: Day; cells: (Described & { inMonth: boolean })[] };
/** Official holidays as iCalendar. from/to: Jalali years (integers below 3000, the legacy form) or inclusive dates (ISO
 *  "2026-10-01", Jalali "1405/07/09", or day numbers; `unit` forces how numbers are read). No range: the current Jalali
 *  year at `now`. uidPrefix defaults to "cal-"; a project passes its own. */
export function ics(p?: {
  from?: number | string; to?: number | string; unit?: "year" | "day"; now?: Date;
  name?: string; domain?: string; prodid?: string; timeZone?: string; uidPrefix?: string;
}): string;
