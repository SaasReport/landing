/** @saasreport/calendar/markets — market profiles and multi-market business-day maths. Weekdays here are the legacy
 *  Sunday-first convention (0 = Sunday … 6 = Saturday); isoDow / weekendIsoOf give ISO weekdays (1 = Monday … 7 = Sunday). */
import type { HijriVariant } from "./hijri.js";
export type MarketId = "sa" | "ae" | "bh" | "qa" | "kw" | "om" | "my" | "id" | "pk" | "tr" | "uk" | "us" | "eu" | "in" | "cn" | "sg" | "au" | "ir" | "ir:government" | "ir:market" | (string & {});
export type Status = "verified" | "partial" | "unverified";
export interface Localized { en?: string; ar?: string; fa?: string; zh?: string }
export interface Rule {
  id: string; kind: "fixed" | "nth" | "easter" | "hijri" | "hijri-last-weekday" | "dates" | "chinese" | "qingming" | "table";
  month?: number; day?: number; weekday?: number; n?: number; offset?: number;
  hm?: number; hd?: number | "last"; through?: [number, number | "last"]; days?: number;
  /** Chinese lunisolar month and day (kind "chinese"). */ lm?: number; ld?: number | "last";
  dates?: [string, string, string?][]; except?: string[];
  /** Published dates per Gregorian year; in a published year the rule yields exactly these (official, not predicted). */
  table?: Record<number, string[]>;
  /** Substitution for this rule: false = none, "instead" = a weekend date moves to the next free weekday, or a profile policy. */
  observe?: false | "instead" | "fed" | "sunday-next" | "substitute"; observeSince?: string;
  since?: string; until?: string; half?: boolean; name?: Localized; source?: string; checked?: string;
}
export interface Settlement { t: number; from?: string; scope: string; source: string }
export interface Market {
  id: string; name: Localized; currency?: string;
  /** Legacy field, unchanged (eu: "Europe/Frankfurt", which is not an IANA zone). Use `timeZone`. */ timezone?: string;
  /** Default IANA time zone for the time layer (eu: Europe/Berlin). */ timeZone?: string;
  /** Holiday data version, "<pack>-<yyyy.mm.dd>", e.g. "uk-2026.09.30", "iran-2026.10.01". */ dataVersion?: string;
  /** Date the sources were read (custom profiles). */ checked?: string;
  weekend: number[] | { from?: string; days: number[] }[];
  hijri?: HijriVariant; status: Status; sources: { title: string; url: string }[]; notes: string[];
  holidays: Rule[]; observe?: "fed" | "sunday-next" | "substitute"; settlement?: Settlement[]; iran?: string;
  /** Years whose official list was read, with that list's URL. */ published?: Record<number, string>;
  /** Make-up working days per year: [ISO date, holiday rule id] (weekend days that are working days, e.g. China's 调休). */
  workdays?: Record<number, [string, string][]>;
}
export interface MakeUpWorkday { date: number; iso: string; id: "workday"; for: string | null; title: Localized; source: string | null; profile: string }
export interface Holiday {
  date: number; iso: string; id: string; title: Localized; predicted: boolean; profile: string; source: string | null;
  half?: true; observed?: true; of?: string; official?: true; hijriYear?: number; note?: { en: string; ar: string };
}
export declare const CHECKED: string;
export declare const PREDICTED_NOTE: { en: string; ar: string };
export declare const NAMES: Record<string, Localized>;
export declare const MARKET_IDS: string[];
export declare class MarketError extends Error { code: string }
export declare const rules: {
  fixed(id: string, month: number, day: number, extra?: Partial<Rule>): Rule;
  nth(id: string, month: number, weekday: number, n: number, extra?: Partial<Rule>): Rule;
  easter(id: string, offset: number, extra?: Partial<Rule>): Rule;
  hijri(id: string, hm: number, hd: number | "last", extra?: Partial<Rule>): Rule;
  hijriLastWeekday(id: string, hm: number, weekday: number, extra?: Partial<Rule>): Rule;
  dates(id: string, list: [string, string, string?][], extra?: Partial<Rule>): Rule;
  chinese(id: string, lm: number, ld: number | "last", extra?: Partial<Rule>): Rule;
  qingming(id: string, extra?: Partial<Rule>): Rule;
  table(id: string, table: Record<number, string[]>, extra?: Partial<Rule>): Rule;
};
export declare const LUNISOLAR_NOTE: { en: string; ar: string };
/** Make-up working days of a profile in Gregorian year gy. */
export declare function makeUpWorkdays(id: MarketId, gy: number): MakeUpWorkday[];
export declare function isMakeUpWorkday(id: MarketId, n: number): boolean;
export declare function makeUpWorkdaysBetween(id: MarketId, a: number, b: number): MakeUpWorkday[];
export declare function dow(n: number): number;
export declare function market(id: MarketId | Market): Market;
export declare function markets(): Market[];
export declare function registerMarket(profile: Partial<Market> & { id: string }): void;
/** registerOfficial("pk", { 1447: { "eid-al-fitr": ["2026-03-21", "2026-03-22", "2026-03-23"] } }) */
export declare function registerOfficial(id: MarketId, table: Record<number, Record<string, string[]>>): void;
export declare function weekendOf(id: MarketId, n?: number): number[];
export declare function isWeekend(id: MarketId, n: number): boolean;
export declare function yearHolidays(id: MarketId, gy: number): Holiday[];
export declare function holidaysOn(id: MarketId, n: number): Holiday[];
export declare function holidaysBetween(id: MarketId, a: number, b: number): Holiday[];
export declare function holidayTitle(h: Holiday, locale?: string): string;
export declare function settlementCycle(id: MarketId | Market, n?: number): Settlement | null;
export declare function summary(): { id: string; name: Localized; weekend: number[]; status: Status; hijri: string | null; holidays: number; settlement: Settlement[] | null; sources: { title: string; url: string }[] }[];
export declare const IRAN_DATA_VERSION: string;
export declare const MARKET_TIME_ZONES: Readonly<Record<string, string>>;
/** ISO weekday (1 = Monday … 7 = Sunday). */
export declare function isoDow(n: number): 1 | 2 | 3 | 4 | 5 | 6 | 7;
export declare function weekendIsoOf(id: MarketId, n?: number): number[];
export declare function marketTimeZone(id: MarketId | Market): string;
export interface PackHoliday { id: string; kind: Rule["kind"] | "jalali"; title: Localized; predicted: boolean; source: string | null; checked: string | null; since?: string; until?: string; half?: true; published?: number[] }
export interface HolidayPack {
  id: string; pack: string; dataVersion: string; status: Status; checked: string | null; timeZone: string; hijri: string | null;
  sources: { title: string; url: string | null }[]; sourceUrls: string[];
  coverage: { from: number; to: number; basis: string[] };
  /** Hijri years with announced dates registered (Iran: Solar Hijri years from registerOfficialLunar). */ official: number[];
  holidays: PackHoliday[];
  /** Years whose official list was read (profiles with published tables). */ published?: number[];
  /** Make-up working days (profiles that have them). */ workdays?: { date: string; for: string }[];
}
export declare function holidayPack(id: MarketId | Market): HolidayPack;
export declare function holidayPacks(): HolidayPack[];
export declare function holidayProvenance(h: Holiday): { profile: string; dataVersion: string; source: string | null; checked: string | null; predicted: boolean; official: boolean };
export { toHijri, hijriMonthLength } from "./hijri.js";
