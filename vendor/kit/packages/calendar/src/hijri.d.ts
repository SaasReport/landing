/** @saasreport/calendar/hijri — Umm al-Qura (ICU islamic-umalqura, AH 1300–1600) and civil (tabular) Hijri on day numbers. */
export type HijriVariant = "umalqura" | "civil";
export interface HijriDate { hy: number; hm: number; hd: number }
export declare const HIJRI_VARIANTS: HijriVariant[];
export declare const UMALQURA_RANGE: { min: 1300; max: 1600 };
export declare const CIVIL_RANGE: { min: number; max: number };
export declare class HijriError extends Error { code: "unsupported_calendar" | "out_of_range" | "invalid_date" | "invalid_variant" | "internal" }
export declare function hasUmmAlQura(): boolean;
export declare function isCivilLeap(hy: number): boolean;
/** Day number (days since 1970-01-01) → Hijri date. */
export declare function toHijri(n: number, variant?: HijriVariant): HijriDate;
export declare function fromHijri(hy: number, hm: number, hd: number | "last", variant?: HijriVariant): number;
export declare function tryFromHijri(hy: number, hm: number, hd: number | "last", variant?: HijriVariant): number | null;
export declare function hijriMonthLength(hy: number, hm: number, variant?: HijriVariant): 29 | 30;
export declare function hijriYearLength(hy: number, variant?: HijriVariant): number;
export declare function hijriYearsOf(gy: number, variant?: HijriVariant): number[];
