/** @saasreport/calendar/parse — one date/datetime parser for the new APIs; returns a tagged result, never throws.
 *  Accepts ISO dates and datetimes, Jalali and Hijri numeric dates, "today", and dates with month names
 *  ("۹ مهر ۱۴۰۵", "پنجشنبه ۹ مهر ۱۴۰۵", "٢٠ ربيع الآخر ١٤٤٨ هـ", "1 October 2026"); a leading weekday must match. */
import type { Instant, ZonedDateTime, Disambiguation } from "./time.js";
import type { IsoWeekday } from "./weekday.js";
export type ParseErrorCode = "empty" | "invalid_format" | "invalid_date" | "out_of_range" | "invalid_time" | "invalid_offset" | "missing_offset"
  | "offset_mismatch" | "invalid_time_zone" | "invalid_option" | "unsupported_calendar";
export interface ParsedDate {
  ok: true; input: unknown; kind: "date"; system: "gregorian" | "jalali" | "hijri-umalqura" | "hijri-civil";
  /** Engine day number of the date as written. */ day: number; iso: string;
  parts: { year: number; month: number; day: number }; weekday: IsoWeekday;
}
export interface ParsedDateTime extends Omit<ParsedDate, "kind" | "system"> {
  kind: "datetime"; system: "gregorian"; instant: Instant; zoned: ZonedDateTime; offsetMinutes: number; timeZone: string;
}
export interface ParseFailure { ok: false; input: unknown; error: { code: ParseErrorCode; message: string } }
export type ParseResult = ParsedDate | ParsedDateTime | ParseFailure;
export interface ParseOptions { timeZone?: string; now?: Date | number; hijri?: "umalqura" | "civil"; disambiguation?: Disambiguation }
/** Persian/Arabic-Indic digits → Latin; bidi and tatweel marks removed. Letters unchanged (see normalizeText). */
export declare function normalizeDigits(s: unknown): string;
/** normalizeDigits plus ي/ى → ی, ك → ک, ZWJ removed, ZWNJ kept once between letters, whitespace collapsed. */
export declare function normalizeText(s: unknown): string;
/** The calendar and month number of a month name in en, fa or ar (any ي/ی, ك/ک, ZWNJ or spacing); null when unknown. */
export declare function parseMonthName(name: string): { system: "gregorian" | "jalali" | "hijri"; month: number } | null;
export declare function parseInput(input: unknown, options?: ParseOptions): ParseResult;
export declare function parse(input: unknown, options?: ParseOptions): ParseResult;
