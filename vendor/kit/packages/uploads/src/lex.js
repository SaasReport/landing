/**
 * Scanner primitives. No regular expressions: every function here moves forward over a string or byte array exactly once, so the
 * cost of anything built on them is linear in the input, whatever the input is. The upload code reads attacker bytes only through
 * these (and through the tokenizers in xml.js, pdf-lex.js and text-sniff.js built on them); the gate test in
 * test/regex-gate.test.mjs fails on any regular expression with a quantifier in this package.
 */
import { tick } from "./work.js";

/** JavaScript's \s, written out: tab, LF, VT, FF, CR, space, NBSP, Ogham space, the U+2000 block, line and paragraph separators, NNBSP, MMSP, ideographic space, BOM. */
export function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
export const isDigit = (c) => c >= 48 && c <= 57;
export const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
export const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
export const isWord = (c) => isAlpha(c) || isDigit(c) || c === 95;
/** XML/HTML name characters, widened to anything that cannot end a name: letters, digits, "_", ":", "-", ".", and non-ASCII. */
export const isNameChar = (c) => isWord(c) || c === 58 || c === 45 || c === 46 || c > 127;

/** The index of the first character at or after i that does NOT satisfy pred (s.length when all do). */
export function runWhile(s, i, pred) {
  const from = i;
  while (i < s.length && pred(s.charCodeAt(i))) i++;
  tick(i - from + 1);
  return i;
}
export const skipSpace = (s, i) => runWhile(s, i, isSpace);

const lowerCode = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
/** Does `s` have the ASCII text `lit` (given in lower case) at i, ignoring ASCII case? */
export function startsWithCI(s, i, lit) {
  if (i < 0 || i + lit.length > s.length) return false;
  tick(lit.length);
  for (let k = 0; k < lit.length; k++) if (lowerCode(s.charCodeAt(i + k)) !== lit.charCodeAt(k)) return false;
  return true;
}
/** Does `s` have `lit` at i (case sensitive)? */
export const startsWithAt = (s, lit, i = 0) => s.startsWith(lit, i);

/** The first index at or after `from` where the lower-case ASCII `lit` occurs, ignoring ASCII case; -1 when none. One pass. */
export function indexOfCI(s, lit, from = 0) {
  const first = lit.charCodeAt(0), n = s.length - lit.length;
  tick(Math.max(0, n - from + 1));
  for (let i = from; i <= n; i++) {
    const c = lowerCode(s.charCodeAt(i));
    if (c === first && startsWithCI(s, i, lit)) return i;
  }
  return -1;
}
export const includesCI = (s, lit) => indexOfCI(s, lit) >= 0;

/** Is every character of s a digit (and s non-empty, at most max long)? */
export function allDigits(s, max = Infinity) {
  if (!s.length || s.length > max) return false;
  tick(s.length);
  for (let i = 0; i < s.length; i++) if (!isDigit(s.charCodeAt(i))) return false;
  return true;
}

/** Is s of the shape: one character satisfying `first`, then at least min and at most max characters satisfying `rest`? */
export function hasShape(s, first, rest, { min = 0, max = Infinity } = {}) {
  if (typeof s !== "string" || s.length < 1 + min || s.length > 1 + max || !first(s.charCodeAt(0))) return false;
  tick(s.length);
  for (let i = 1; i < s.length; i++) if (!rest(s.charCodeAt(i))) return false;
  return true;
}
export const isLowerAlpha = (c) => c >= 97 && c <= 122;
