/**
 * The formatter as one classic browser script (Node only: reads the sources): every export of @saasreport/format on
 * globalThis.KitFormat. The site build writes it as /format.js and loads it before every other script of a page; the
 * Worker shell loads /kit/format.js the same way. Client code formats numbers with KitFormat, never with Intl or
 * toLocaleString (CONSTITUTION.md §7). Generated, never edited.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SOURCES = ["index.js", "text.js", "html.js", "markdown.js"];
export const NAMES = ["DIGIT_SETS", "LOCALE_DIGITS", "SEPARATORS", "lang", "digitSetOf", "digits", "toLatinDigits", "toPersianDigits",
  "formatNumber", "formatInteger", "formatPercent", "faWords", "formatOrdinal", "formatRange", "formatList", "formatTime",
  "formatDuration", "formatDate", "formatter", "segments", "localizeText", "localizeHtml", "localizeMarkdown", "localizeMarkdownLine", "READER_ATTRS", "META_CONTENT", "LD_KEYS", "PERSIAN_LETTER",
  // Solar Hijri and calendar-aware dates from @saasreport/calendar/instant (no imports; inlined below in its own scope)
  "formatInstant", "formatJalali", "jalaliFor", "zonedDay"];
const CALENDAR_NAMES = ["formatInstant", "formatJalali", "jalaliFor", "zonedDay"];
/** Source of @saasreport/calendar/instant (the same arithmetic as Workers and Node: browsers never use ICU's Persian calendar). */
function calendarInstant() {
  let file;
  try { file = fileURLToPath(import.meta.resolve("@saasreport/calendar/instant")); }
  catch { file = createRequire(import.meta.url).resolve("@saasreport/calendar/instant"); }
  return readFileSync(file, "utf8");
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;   // the Arabic-script blocks Persian and Arabic text use

/**
 * One source file for a build: the `//#if fa,ar` ... `//#else` ... `//#end` regions of the sources hold the Persian and Arabic data (digit sets,
 * separators, number words, month names). A build that serves a Persian or Arabic locale keeps the `#if` side; a build for Latin-script locales
 * only keeps the `#else` side (its lines are written `//| code`, comments in Node) and carries no Persian or Arabic script at all: a comment
 * that quotes an example in those scripts is left out, and every other comment stays (the reason written inside a `catch` is what the
 * `swallowed-error` gate reads in a built site). Arabic script anywhere else in a Latin-script build is an error here, never a silent leftover.
 * Every line outside a region is kept as it is.
 */
export function scopeSource(text, { persian }) {
  const out = [];
  let mode = null;   // null | "if" | "else"
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^\/\/#if\b/.test(t)) { mode = "if"; continue; }
    if (/^\/\/#else\b/.test(t)) { mode = "else"; continue; }
    if (/^\/\/#end\b/.test(t)) { mode = null; continue; }
    if (mode === "if") { if (persian) out.push(line); continue; }
    if (mode === "else") { if (!persian) out.push(line.replace(/^(\s*)\/\/\| ?/, "$1")); continue; }
    out.push(line);
  }
  const joined = out.join("\n");
  if (persian) return joined;
  const scoped = joined
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => (ARABIC_SCRIPT.test(comment) ? "" : comment))
    .replace(/^[ \t]*\/\/.*$/gm, (comment) => (ARABIC_SCRIPT.test(comment) ? "" : comment));
  const left = scoped.split("\n").findIndex((l) => ARABIC_SCRIPT.test(l));
  if (left !== -1) throw new Error(`format.js for Latin-script locales still holds Arabic-script text at line ${left + 1} of its source: put it in a \`//#if fa,ar\` region`);
  return scoped;
}

/** The language subtags of the locales a site serves, and whether any is Persian or Arabic. No locales given: the full build. */
const needsPersian = (locales) => !locales || locales.some((l) => ["fa", "ar"].includes(String(l?.code ?? l).toLowerCase().split(/[-_]/)[0]));

/** Source text of /kit/format.js. `locales` (codes or { code }) scopes it: Latin-script locales only → no Persian or Arabic tables (scopeSource). */
export function formatForBrowser({ locales } = {}) {
  const persian = needsPersian(locales);
  const src = (t) => scopeSource(t, { persian });
  const body = SOURCES.map((f) => src(readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8"))
    .replace(/^\s*import\b[^;]*?from\s+"\.\/[^"]+";\s*$/gm, "")
    .replace(/^\s*export\s*\{[^}]*\}\s*from\s+"(?:\.\/[^"]+|@saasreport\/calendar\/instant)";\s*$/gm, "")
    .replace(/^export\s+(?=(?:const|function|let|class)\b)/gm, "")).join("\n");
  const cal = src(calendarInstant()).replace(/^export\s+(?=(?:const|function|let|class)\b)/gm, "");
  const calendar = `const { ${CALENDAR_NAMES.join(", ")} } = (() => {\n${cal}\nreturn { ${CALENDAR_NAMES.join(", ")} };\n})();`;
  return `/* GENERATED from @saasreport/format/src (${SOURCES.join(", ")}) and @saasreport/calendar/src/instant.js by @saasreport/format/browser${persian ? "" : " for Latin-script locales (no Persian or Arabic tables)"}; do not edit here. */\n(() => {\n${calendar}\n${body}\nglobalThis.KitFormat = { ${NAMES.join(", ")} };\n})();\n`;
}
