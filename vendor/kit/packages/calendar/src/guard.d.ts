/** Static rules: source that names ICU's Persian calendar. */
export const ICU_PERSIAN_RULES: readonly { id: string; re: RegExp }[];
/** JavaScript source with comments blanked out (strings, template literals and regex literals kept). */
export function stripComments(src: string): string;
/** The ids of the rules a source breaks (JS comments ignored; html: only <!-- --> comments ignored). */
export function icuPersianUses(src: string, options?: { html?: boolean }): string[];
export interface IntlGuardViolation { what: string; locales: unknown; calendar?: unknown; stack: string }
export interface IntlGuard {
  readonly violations: IntlGuardViolation[];
  /** Run fn with the guard open (only for tests comparing the arithmetic with ICU). */
  allow<T>(fn: () => T): T;
  restore(): void;
}
/** Wrap Intl.DateTimeFormat, Intl.Locale and Date#toLocale*String on scope: anything resolving to the Persian calendar is recorded and throws. */
export function installIntlGuard(options?: { scope?: typeof globalThis; onViolation?: (v: IntlGuardViolation) => void }): IntlGuard;
