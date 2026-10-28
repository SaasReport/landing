/** Business-day maths across one or more market profiles (every market must be open). */
import type { MarketId, Market, Holiday } from "./markets.js";
export type Profiles = MarketId | Market | (MarketId | Market)[];
export type Convention = "following" | "modified_following" | "preceding" | "modified_preceding" | "nearest" | "none";
export type System = "gregorian" | "hijri-umalqura" | "hijri-civil" | "jalali";
export interface Moved { date: number; iso: string; moved: number; uncertain: boolean }
export interface MarketStatus { profile: string; open: boolean; weekend: boolean; holiday: boolean; half: boolean; uncertain: boolean; /** A make-up working day (weekend day that is open). */ makeUp?: true; holidays: (Holiday | { title: { fa: string }; predicted: boolean })[] }
export declare const CONVENTIONS: Convention[];
export declare function marketStatus(n: number, profile: MarketId | Market): MarketStatus;
export declare function dayStatus(n: number, profiles: Profiles): { date: number; iso: string; business: boolean; closed: string[]; half: boolean; uncertain: boolean; markets: MarketStatus[] };
export declare function isBusinessDay(n: number, profiles: Profiles): boolean;
export declare function adjust(n: number, convention: Convention, profiles: Profiles, o?: { system?: System }): Moved;
export declare function addBusinessDays(n: number, k: number, profiles: Profiles): Moved;
/** T+t; without t, the longest official cycle of the profiles on that day. */
export declare function settlement(n: number, profiles: Profiles, o?: { t?: number }): Moved & { t: number };
export declare function businessDaysBetween(a: number, b: number, profiles: Profiles): { business: number; calendar: number; closed: { date: number; iso: string; closed: string[] }[]; uncertain: boolean };
export declare function businessDays(a: number, b: number, profiles: Profiles): number[];
export declare function monthEnd(n: number, profiles: Profiles, o?: { system?: System }): { date: number; iso: string; calendarEnd: number; uncertain: boolean };
