export type Terms = Array<[string, string]> | Record<string, string>;
export interface SpeakOptions { locale?: string; terms?: Terms; defaults?: boolean }
export interface Line { speaker: string; text: string; [k: string]: unknown }
export function numberWords(n: number): string;
export function ordinalWords(n: number): string;
export function numberWordsEn(n: number): string;
export function ordinalWordsEn(n: number): string;
export function yearWordsEn(y: number): string;
export function numberWordsAr(n: number): string;
export function ordinalWordsAr(n: number): string;
/** code → [English singular, English plural, Arabic] for USD, SAR, AED, MYR, GBP, EUR. */
export const CURRENCIES: Record<string, [string, string, string]>;
export const TERMS_AR: Array<[string, string]>;
export function toLatinDigits(s: string): string;
export const TERMS_FA: Array<[string, string]>;
export const TERMS_EN: Array<[string, string]>;
export function termsFor(locale?: string, o?: { terms?: Terms; defaults?: boolean }): Array<[string, string]>;
export function speakable(text: string, options?: string | SpeakOptions): string;
export function unspeakable(text: string, options?: string | SpeakOptions): string;
export function numbersIn(s: string): number[];
export function mergeTurns<T extends Line>(lines: T[]): T[];
export const CHARS_PER_SECOND: number;
export function estimateMs(lines: Array<Line | [string, string] | string>, cps?: number): number;
/** The settlement wording ("T+n" read aloud) per language. */
export const SETTLEMENT: Record<"fa" | "ar", { plus: string; plusN: string }>;
/** The normaliser's language data (number words, month names, currency names, spelled letters), one validated export. */
export const WORD_TABLES: Record<string, unknown>;
