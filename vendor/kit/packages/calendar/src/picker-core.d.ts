/** Date picker core — the DatePicker web component class (configurable tag and class prefix), not registered. */
export type Profile = "bank" | "government" | "market";
export declare const PREDICTED_NOTE: string;
export declare const WEEKDAY_SHORT: string[];

export interface PickerOptions {
  profile?: Profile;
  businessOnly?: boolean;
  /** Day numbers (days since 1970-01-01). */
  min?: number | null;
  max?: number | null;
}
export interface MatrixCell {
  n: number; jd: number; iso: string; weekday: number;
  business: boolean; weekend: boolean; holiday: boolean; predicted: boolean;
  holidays: { title: string; status: "official" | "predicted" }[];
  disabled: boolean; today: boolean; selected: boolean;
  rangeStart: boolean; rangeEnd: boolean; inRange: boolean;
}
export interface MonthMatrix {
  jy: number; jm: number; title: string; length: number; first: number; weekend: number[];
  /** Saturday-first weeks of 7; null = day of a neighbouring month. */
  weeks: (MatrixCell | null)[][];
}
export type ParsedInput = { date: number } | { start: number; end: number } | { jy: number; jm: number; partial: true } | null;
export interface RangeState { start: number | null; end: number | null }
export interface DayDetail {
  jalali: string; iso: string; date: number; long: string; gregorian: string;
  /** Lunar Hijri date in Persian, in `hijriVariant` (Umm al-Qura unless "civil" was asked for). */
  hijri: string; hijriVariant: "umalqura" | "civil"; weekday: string;
  business: boolean; weekend: boolean; holidays: { title: string; status: "official" | "predicted" }[];
  settlement?: { t: number; date: number; iso: string; jalali: string; long: string; uncertain: boolean };
}
export interface RangeDetail {
  jalali: string; iso: string; start: DayDetail; end: DayDetail; days: number; business: number;
  holidays: { date: string; title: string; status: "official" | "predicted" }[];
}

export declare function formatJalali(n: number, o?: { digits?: "latin" | "fa" }): string;
export declare function parseInput(text: string): ParsedInput;
export declare function parseBound(v: string | number | null | undefined): number | null;
export declare function isDisabled(n: number, o?: PickerOptions): boolean;
export declare function rangeSelect(state: RangeState | null | undefined, n: number): RangeState;
export declare function shiftMonth(jy: number, jm: number, k: number): { jy: number; jm: number };
export declare function addMonths(n: number, k: number): number;
export declare function moveKey(n: number, key: string, o?: { shift?: boolean; rtl?: boolean }): number | null;
export declare function monthMatrix(jy: number, jm: number, o?: PickerOptions & { value?: number | null; range?: RangeState | null; preview?: number | null; today?: number }): MonthMatrix;
export declare function dayDetail(n: number, o?: { profile?: Profile; settlement?: number | null; hijri?: "umalqura" | "civil" }): DayDetail;
/** Lunar Hijri date in Persian: Umm al-Qura by default, "civil" on request; civil where Umm al-Qura is unavailable. */
export declare function hijriLong(n: number, variant?: "umalqura" | "civil"): string;

/**
 * `<kit-date-picker>` attributes: `profile`, `business-only`, `settlement` (T+n), `range`, `min`, `max`
 * (ISO or Jalali), `value`, `for` (id of an input; or put an `<input>` inside), `theme` (light|dark|auto),
 * `digits` (fa|latin, for the text written into the input), `hijri` (umalqura|civil: the lunar date shown,
 * Umm al-Qura by default).
 * Dispatches `change` (CustomEvent<DayDetail | RangeDetail>) when a day or range is chosen.
 */
export declare class DatePicker extends HTMLElement {
  /** Element name (default "kit-date-picker") and class prefix (default "kitdp"); override both in a subclass. */
  static tag: string;
  static prefix: string;
  /** ISO date, or "start/end" ISO interval in range mode; "" when empty. */
  value: string;
  /** Jalali text: "1405/07/08" or "1405/07/08 – 1405/07/12". */
  readonly jalali: string;
  readonly valueAsNumber: number | null;
  readonly start: string;
  readonly end: string;
  readonly detail: DayDetail | RangeDetail | null;
  readonly isOpen: boolean;
  show(): void;
  close(): void;
}

/** Register a picker class under its tag (once); returns the class. */
export declare function definePicker<T extends typeof DatePicker>(cls?: T, tag?: string): T;
