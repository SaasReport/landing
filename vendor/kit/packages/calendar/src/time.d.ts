/** @saasreport/calendar/time — instants, IANA time zones (Intl only), wall-clock time, day bounds, formatting with
 *  time, and working hours over market profiles. Weekdays are ISO (1 = Monday … 7 = Sunday). */
import type { MarketId, Market } from "./markets.js";
import type { FormatOptions } from "./locale.js";
import type { IsoWeekday } from "./weekday.js";
export type Disambiguation = "compatible" | "earlier" | "later" | "reject";
export type InstantLike = Instant | ZonedDateTime | Date | number | string;
export interface WallFields { year: number; month?: number; day?: number; hour?: number; minute?: number; second?: number; millisecond?: number }
export declare class TimeError extends Error {
  code: "invalid_time_zone" | "invalid_instant" | "invalid_format" | "invalid_date" | "invalid_time" | "invalid_offset" | "missing_offset" | "offset_mismatch"
    | "nonexistent_time" | "ambiguous_time" | "invalid_hours" | "invalid_weekday" | "invalid_profiles" | "no_business_time"
    | "invalid_duration" | "invalid_calendar";
}
export declare function isValidTimeZone(tz: unknown): boolean;
export declare function canonicalTimeZone(tz: string): string;
/** UTC offset of tz at an instant, in minutes. */
export declare function offsetMinutes(epochMs: number, tz: string): number;
export declare function formatOffset(minutes: number): string;
export declare function wallToEpoch(tz: string, fields: WallFields, disambiguation?: Disambiguation): number;
/** Calendar systems for month/year arithmetic ("hijri" = "hijri-umalqura"). */
export type MonthCalendar = "gregorian" | "jalali" | "hijri" | "hijri-umalqura" | "hijri-civil";
/** Engine day n plus `months` whole months in a calendar (default gregorian); the day of the month is clamped to the
 *  target month's length (31 Shahrivar + 1 Jalali month = 30 Mehr). Throws TimeError invalid_duration / invalid_calendar. */
export declare function addMonths(n: number, months: number, calendar?: MonthCalendar): number;
/** Units ZonedDateTime.plus/minus accept; any other key throws TimeError "invalid_duration". years and months must be integers. */
export interface ZonedDuration { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }
export declare const ISO_DATETIME: RegExp;
export declare function isoDateTimeFields(text: string): (Required<Omit<WallFields, never>> & { offset: number | null; timeZone: string | null }) | null;
export declare class Instant {
  readonly epochMs: number;
  constructor(epochMs: number);
  static from(v: InstantLike): Instant;
  static now(): Instant;
  static fromEpochSeconds(s: number): Instant;
  readonly epochSeconds: number;
  /** Exact time only; months/years/weeks or any other unit throw TimeError "invalid_duration" (use ZonedDateTime). */
  plus(d: { days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }): Instant;
  minus(d: { days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }): Instant;
  until(other: InstantLike): number;
  compare(other: InstantLike): -1 | 0 | 1;
  equals(other: InstantLike): boolean;
  toZoned(timeZone: string): ZonedDateTime;
  toDate(): Date;
  toString(): string; toJSON(): string; valueOf(): number;
  /** ISO text for string and default hints (`${i}`, "" + i); epoch ms for the number hint (+i, a - b, a < b). */
  [Symbol.toPrimitive](hint: "number"): number; [Symbol.toPrimitive](hint: "string" | "default"): string;
}
export declare class LocalDate {
  readonly year: number; readonly month: number; readonly day: number;
  constructor(year: number, month: number, day: number);
  static of(y: number, m: number, d: number): LocalDate;
  static fromDay(n: number): LocalDate;
  static parse(iso: string): LocalDate;
  readonly dayNumber: number; readonly isoWeekday: IsoWeekday;
  plusDays(k: number): LocalDate;
  compare(o: LocalDate): -1 | 0 | 1; equals(o: LocalDate): boolean;
  toString(): string; toJSON(): string;
}
export declare class LocalTime {
  readonly hour: number; readonly minute: number; readonly second: number; readonly millisecond: number;
  constructor(hour?: number, minute?: number, second?: number, millisecond?: number);
  static of(h: number, m?: number, s?: number, ms?: number): LocalTime;
  /** "08:00", "16:45:10", "24:00"; Persian or Arabic-Indic digits too. */
  static parse(s: string | LocalTime): LocalTime;
  static fromMilliseconds(ms: number): LocalTime;
  readonly milliseconds: number;
  compare(o: string | LocalTime): -1 | 0 | 1;
  toString(): string; toJSON(): string;
}
export declare class ZonedDateTime {
  readonly epochMs: number; readonly timeZone: string; readonly offsetMinutes: number;
  readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number; readonly millisecond: number;
  constructor(epochMs: number, timeZone: string);
  static fromInstant(i: InstantLike, timeZone: string): ZonedDateTime;
  static from(v: ZonedDateTime | string | (WallFields & { timeZone?: string }), o?: { disambiguation?: Disambiguation; timeZone?: string }): ZonedDateTime;
  /** The engine's day number of the local date. */
  readonly dayNumber: number; readonly isoWeekday: IsoWeekday; readonly offset: string; readonly hoursInDay: number;
  toInstant(): Instant; toLocalDate(): LocalDate; toLocalTime(): LocalTime;
  withTimeZone(tz: string): ZonedDateTime;
  withTime(t: string | LocalTime, o?: { disambiguation?: Disambiguation }): ZonedDateTime;
  startOfDay(): ZonedDateTime;
  /** Years and months in `calendar` (default gregorian, clamped to month end), then weeks/days (wall-clock time kept),
   *  then exact hours/minutes/seconds/milliseconds. Unknown units throw TimeError "invalid_duration". */
  plus(d: ZonedDuration, o?: { disambiguation?: Disambiguation; calendar?: MonthCalendar }): ZonedDateTime;
  minus(d: ZonedDuration, o?: { disambiguation?: Disambiguation; calendar?: MonthCalendar }): ZonedDateTime;
  compare(o: InstantLike): -1 | 0 | 1; equals(o: unknown): boolean;
  /** "2026-03-08T03:30:00-04:00[America/New_York]" */
  toString(): string; toJSON(): string; valueOf(): number;
  /** ISO text with offset and [zone] for string and default hints (String(z), `${z}`, "" + z); epoch ms for the number hint. */
  [Symbol.toPrimitive](hint: "number"): number; [Symbol.toPrimitive](hint: "string" | "default"): string;
}
export declare function startOfDay(n: number, timeZone: string): ZonedDateTime;
export declare function endOfDay(n: number, timeZone: string): ZonedDateTime;
export declare function dayBounds(n: number, timeZone: string): { day: number; iso: string; start: Instant; end: Instant; hours: number };
export declare function dayOf(instant: InstantLike, timeZone: string): number;
export declare function formatDateTime(v: InstantLike, o?: Omit<FormatOptions, "system"> & { system?: FormatOptions["system"]; timeZone?: string; seconds?: boolean; offset?: boolean; timeZoneName?: boolean }): string;
export type Hours = string | { open: string; close: string } | (string | { open: string; close: string })[] | null;
export interface Session { start: Instant; end: Instant; day: number; uncertain: boolean }
export interface WorkingHours {
  readonly timeZone: string; readonly profiles: string[];
  sessions(n: number): readonly Session[];
  sessionAt(i: InstantLike): Session | null;
  isOpen(i: InstantLike): boolean;
  nextOpen(i: InstantLike): Instant;
  nextClose(i: InstantLike): Instant;
  previousClose(i: InstantLike): Instant;
  addBusinessHours(i: InstantLike, hours: number): Instant;
  businessHoursBetween(a: InstantLike, b: InstantLike): number;
  status(i: InstantLike): { open: boolean; session: Session | null; day: number; iso: string; business: ReturnType<typeof import("./business.js").dayStatus> };
}
export declare function workingHours(o: {
  profiles: MarketId | Market | (MarketId | Market)[]; timeZone?: string; hours?: Hours;
  /** Keys: ISO weekday 1–7 or a name ("thursday", "fri"); null closes that weekday. */
  byWeekday?: Record<string | number, Hours>;
  halfDayClose?: string | null;
}): WorkingHours;
