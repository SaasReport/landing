/**
 * Prose segmentation shared by the renderer (localizeText) and the checker (scan.js), so "what counts as a number
 * shown to readers" has one definition:
 *
 *   exempt   URLs (http, https, mailto, www.), e-mail addresses, and Latin identifiers: a token of Latin letters,
 *            digits and . _ - + / # : that carries at least one Latin letter (saasreport-cal, ISO-4217, v1.2.0, T+1, PSD2,
 *            /api/v1/calendar)
 *   number   everything else that is a digit: these are reader-facing and take the locale's digits
 */
import { digits } from "./index.js";

const URL_RE = /(?:https?:\/\/|mailto:|www\.)[^\s<>"'«»()\u060C]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /[/A-Za-z0-9][A-Za-z0-9._\-+/#:]*/g;
const HAS_LATIN = /[A-Za-z]/;
/** An Arabic-script letter (a line or value that carries one is Persian copy on a fa site). */
export const PERSIAN_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FF]/;

/** Split prose into [{ text, exempt }] runs (exempt: URL, e-mail or Latin identifier). */
export function segments(text) {
  const s = String(text ?? ""), out = [];
  let last = 0;
  const push = (t, exempt) => { if (t) out.push({ text: t, exempt }); };
  const ranges = [];
  for (const m of s.matchAll(URL_RE)) ranges.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(TOKEN_RE)) {
    const a = m.index, b = a + m[0].length;
    if (HAS_LATIN.test(m[0]) && !ranges.some(([x, y]) => a < y && b > x)) ranges.push([a, b]);
  }
  ranges.sort((p, q) => p[0] - q[0]);
  for (const [a, b] of ranges) { if (a < last) continue; push(s.slice(last, a), false); push(s.slice(a, b), true); last = b; }
  push(s.slice(last), false);
  return out;
}

/**
 * Reader-facing prose in the locale's digits; URLs, e-mails and Latin identifiers stay as they are.
 * For copy that comes from data or content (a Persian sentence with "T+1" and "1404/12/28" → "T+1" and "۱۴۰۴/۱۲/۲۸").
 */
export function localizeText(text, locale = "en") {
  return segments(text).map((r) => (r.exempt ? r.text : digits(r.text, locale))).join("");
}
