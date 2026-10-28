/**
 * localizeMarkdown(md, locale, { persianLinesOnly }): Markdown with the locale's digits in what readers see, by the
 * rules of the checker (scan.js scanMarkdown / scanText):
 *   prose and the front matter's title / description / summary / subtitle / excerpt are localized;
 *   code fences, code spans, link and image targets, autolinks, HTML tags and reference definitions stay as they are;
 *   an ordered-list item "1. text" becomes "- ۱. text" (CommonMark markers need ASCII digits; the item stays a list
 *   item and its number is Persian), or "- text" when the text already starts with its own number.
 * persianLinesOnly: only lines that carry Persian (llms.txt and other mixed files).
 */
import { localizeText, PERSIAN_LETTER } from "./text.js";
import { digits, digitSetOf } from "./index.js";

const FM_LINE = /^(title|description|summary|subtitle|excerpt)(\s*:\s*)(.*)$/;
const PROTECT = /`[^`]*`|\]\([^)]*\)|<(?:https?:|mailto:)[^>]*>|<\/?[a-zA-Z][^>]*>|<!--.*?-->|&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

//#if fa,ar
const DIGIT_START = /^[0-9۰-۹٠-٩]/;
//#else
//| const DIGIT_START = /^[0-9]/;
//#end
/** One line of Markdown prose, protected spans kept. */
export function localizeMarkdownLine(line, locale) {
  if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) return line;                     // reference definition
  let out = "", last = 0;
  for (const m of line.matchAll(PROTECT)) { out += localizeText(line.slice(last, m.index), locale) + m[0]; last = m.index + m[0].length; }
  return out + localizeText(line.slice(last), locale);
}

export function localizeMarkdown(md, locale = "en", { persianLinesOnly = false } = {}) {
  const src = String(md ?? "");
  if (digitSetOf(locale) === "latin") return src;
  const lines = src.split("\n");
  let i = 0, fence = null;
  if (lines[0] === "---") {
    for (i = 1; i < lines.length && lines[i] !== "---"; i++) {
      const m = lines[i].match(FM_LINE);
      if (m) lines[i] = `${m[1]}${m[2]}${localizeText(m[3], locale)}`;
    }
    i++;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence ? (l.trim().startsWith(fence) ? null : fence) : f[1]; continue; }
    if (fence || (persianLinesOnly && !PERSIAN_LETTER.test(l))) continue;
    const ol = l.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      const rest = localizeMarkdownLine(ol[3], locale);
      lines[i] = DIGIT_START.test(rest) ? `${ol[1]}- ${rest}` : `${ol[1]}- ${digits(ol[2], locale)}. ${rest}`;
      continue;
    }
    lines[i] = localizeMarkdownLine(l, locale);
  }
  return lines.join("\n");
}
