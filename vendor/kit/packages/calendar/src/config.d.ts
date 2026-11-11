/** The project's `calendar` block: { systems, primary, profiles, digits }. */
import type { System, Digits, PackLike } from "./locale.js";
import type { Market, Holiday, Settlement } from "./markets.js";
import type * as B from "./business.js";
export interface CalendarConfig { systems?: (System | "hijri")[]; primary?: System | "hijri"; profiles?: string[] | Record<string, unknown>; digits?: Digits; /** legacy shape */ system?: "jalali" | "gregorian"; holidays?: "iran" | "none"; /** market ids of an already-normalised block (used when profiles is not a list) */ markets?: string[] }
export interface ResolvedCalendar { systems: System[]; primary: System; secondary: System[]; profiles: string[]; profile: string | null; digits: Digits | null; problems: string[] }
export declare function resolveCalendarConfig(c?: CalendarConfig, o?: { locale?: string }): ResolvedCalendar;
export declare function createCalendar(c?: CalendarConfig, o?: { locale?: string; pack?: PackLike }): ResolvedCalendar & {
  markets: Market[];
  label(n: number, o?: object): { primary: string; secondary: string[]; text: string };
  format(n: number, o?: object): string;
  monthTitle(y: number, m: number, o?: object): string;
  holidays(gy: number, profiles?: string[]): Holiday[];
  holidaysBetween(a: number, b: number, profiles?: string[]): Holiday[];
  dayStatus(n: number, profiles?: string[]): ReturnType<typeof B.dayStatus>;
  isBusinessDay(n: number, profiles?: string[]): boolean;
  addBusinessDays(n: number, k: number, profiles?: string[]): B.Moved;
  settlement(n: number, o?: { t?: number }, profiles?: string[]): B.Moved & { t: number };
  settlementCycle(n: number, profile?: string): Settlement | null;
  businessDaysBetween(a: number, b: number, profiles?: string[]): ReturnType<typeof B.businessDaysBetween>;
  businessDays(a: number, b: number, profiles?: string[]): number[];
  monthEnd(n: number, profiles?: string[], o?: { system?: System }): ReturnType<typeof B.monthEnd>;
  adjust(n: number, convention: B.Convention, profiles?: string[], o?: { system?: System }): B.Moved;
};
