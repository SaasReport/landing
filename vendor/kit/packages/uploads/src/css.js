/**
 * CSS reads for the markup triage, as scanners: comments dropped, escapes decoded ("@\69mport" is "@import", "\75rl(" is "url("),
 * then plain substring tests. No regular expressions.
 */
import { isHex, isSpace } from "./lex.js";
import { isExternalUrl } from "./urls.js";
import { tick } from "./work.js";
const skipSpaces = (t, i) => { const from = i; while (i < t.length && isSpace(t.charCodeAt(i))) i++; tick(i - from + 1); return i; };
/** indexOf that counts the characters it passes over. */
const seek = (t, needle, from = 0) => { const at = t.indexOf(needle, from); tick((at < 0 ? t.length : at) - from + 1); return at; };

/** CSS text with comments removed, backslash escapes decoded and ASCII letters lower-cased. */
export function cssNormalise(css) {
  const out = [];
  const n = css.length;
  tick(n);
  let i = 0;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (c === 47 && css.charCodeAt(i + 1) === 42) {              // /* comment */
      const close = css.indexOf("*/", i + 2);
      tick((close < 0 ? n : close) - i);
      if (close < 0) break;                                      // an unclosed comment runs to the end
      i = close + 2; continue;
    }
    if (c === 92) {                                              // backslash escape
      let j = i + 1;
      while (j < n && j - i - 1 < 6 && isHex(css.charCodeAt(j))) j++;
      if (j > i + 1) {
        const cp = parseInt(css.slice(i + 1, j), 16);
        out.push(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? " " : String.fromCodePoint(cp));
        i = j < n && isSpace(css.charCodeAt(j)) ? j + 1 : j;
      } else if (j < n) { out.push(css[j]); i = j + 1; } else i = j;
      continue;
    }
    out.push(css[i]); i++;
  }
  return out.join("").toLowerCase();
}

/** Functions that take a URL or an image reference without calling it url(): the argument goes through the one URL classifier. */
const URL_FUNCTIONS = ["image-set(", "-webkit-image-set(", "cross-fade(", "-webkit-cross-fade(", "src(", "image(", "element(", "-moz-element(", "paint("];

/** The argument at j: a quoted string, or text up to a space or ")" → { value, end }. */
function argAt(t, j) {
  j = skipSpaces(t, j);
  const q = t[j];
  if (q === '"' || q === "'") { const close = seek(t, q, j + 1); const end = close < 0 ? t.length : close; return { value: t.slice(j + 1, end), end: end + 1 }; }
  let k = j;
  while (k < t.length && t[k] !== ")" && !isSpace(t.charCodeAt(k))) k++;
  tick(k - j + 1);
  return { value: t.slice(j, k), end: k };
}

/** Does this CSS import something, call a script-ish function, or fetch anything the one URL classifier calls external (url(), image-set(), src() ...)? */
export function cssExternal(css) {
  const t = cssNormalise(css);
  tick(4 * t.length);   // the four substring tests
  if (t.includes("@import") || t.includes("expression(") || t.includes("-moz-binding") || t.includes("behavior:")) return true;
  for (const fn of URL_FUNCTIONS) {
    for (let at = seek(t, fn); at >= 0; at = seek(t, fn, at + fn.length)) {
      let j = skipSpaces(t, at + fn.length);
      if (t.startsWith("url(", j)) j += 4;   // image-set(url(...) 1x)
      if (isExternalUrl(argAt(t, j).value)) return true;
    }
  }
  for (let at = seek(t, "url"); at >= 0; at = seek(t, "url", at + 3)) {
    const j = skipSpaces(t, at + 3);
    if (t[j] !== "(") continue;
    if (isExternalUrl(argAt(t, j + 1).value)) return true;
  }
  return false;
}
