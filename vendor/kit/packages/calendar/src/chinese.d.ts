/** The Chinese lunisolar calendar (农历) and the Qingming solar term, from the Hong Kong Observatory's tables. */
export declare const LUNAR_RANGE: { readonly from: number; readonly to: number };
export declare function leapMonth(ly: number): number;
export declare function lunarMonths(ly: number): { month: number; leap: boolean; length: 29 | 30 }[] | null;
export declare function lunarNewYear(ly: number): number | null;
export declare function fromLunar(ly: number, lm: number, ld: number | "last", o?: { leap?: boolean }): number | null;
export declare function toLunar(n: number): { ly: number; lm: number; ld: number; leap: boolean } | null;
export declare function qingming(gy: number): number | null;
