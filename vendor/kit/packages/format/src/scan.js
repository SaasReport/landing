/**
 * The digits scanner behind `kit check digits` (docs/CONSTITUTION.md §7): on a Persian page every number shown to
 * readers is in Persian digits (۰–۹). It reads rendered output and reports every ASCII digit (0–9) or Arabic-Indic
 * digit (٠–٩) a reader would see, and every «·» standing next to a Persian digit (it reorders in RTL).
 *
 * What is read:
 *   html / svg  text nodes; the attributes aria-label, aria-description, aria-valuetext, aria-roledescription, alt,
 *               title, placeholder, label; <meta> description / og:* / twitter:* content; JSON-LD names,
 *               descriptions, headlines and texts that are in Persian (carry Arabic-script letters)
 *   md          Markdown prose and the title / description / summary of the front matter
 *   txt         lines that carry Persian (llms.txt and other mixed files: the fa parts)
 *
 * Exempt (never reported):
 *   <code>, <pre>, <kbd>, <samp>, <script> (except JSON-LD), <style>, and in Markdown code spans and fences
 *   URLs and hrefs (attributes other than the ones above are not read; Markdown link targets; bare URLs)
 *   Latin identifiers: a token of Latin letters and digits (saasreport-cal, ISO-4217, v1.2.0, T+1, PSD2) – see text.js
 *   an element marked data-digits="latin" with a data-digits-reason="…" (a marker without a reason is a finding)
 *
 * scanDigits(source, { type, locale }) → [{ line, kind, where, match, context }]
 *   kind: "latin-digit" | "arabic-digit" | "bidi-dot" | "marker"
 */
import { segments, PERSIAN_LETTER } from "./text.js";
import { META_CONTENT, LD_KEYS, READER_ATTRS } from "./html.js";

const RAW = new Set(["script", "style"]);
const EXEMPT = new Set(["code", "pre", "kbd", "samp"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ATTRS = READER_ATTRS;
const META = META_CONTENT;
const FM_KEYS = /^(title|description|summary|subtitle|excerpt)\s*:\s*(.*)$/;

const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", laquo: "«", raquo: "»", middot: "·", ndash: "–", mdash: "—", hellip: "…", times: "×" };
/** HTML character references decoded (numeric references would otherwise read as digits). */
export const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === "#") { const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch { return " "; /* not a code point: the entity reads as a space */ } }
  return NAMED[e.toLowerCase()] ?? " ";
});

function lineIndex(src) {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1);
  return (i) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; } return lo + 1; };
}
const clip = (s) => s.replace(/\s+/g, " ").trim().slice(0, 90);

/** Findings in one run of reader-facing prose. */
export function scanProse(text, { where = "text", line = 1 } = {}) {
  const out = [];
  const t = String(text ?? "");
  for (const seg of segments(t)) {
    if (seg.exempt) continue;
    for (const m of seg.text.matchAll(/[0-9]+|[٠-٩]+/g)) {
      out.push({ line, kind: /[0-9]/.test(m[0]) ? "latin-digit" : "arabic-digit", where, match: m[0], context: clip(t) });
    }
    for (const m of seg.text.matchAll(/[۰-۹][\s‌‎‏]*·|·[\s‌‎‏]*[۰-۹]/g)) {
      out.push({ line, kind: "bidi-dot", where, match: m[0], context: clip(t) });
    }
  }
  return out;
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function scanJsonLd(json, line, out) {
  let data;
  try { data = JSON.parse(json); } catch { return; /* a JSON-LD block that is not JSON has no strings to scan */ }
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, k));
    if (typeof v === "string" && LD_KEYS.has(key) && PERSIAN_LETTER.test(v)) out.push(...scanProse(v, { where: `json-ld:${key}`, line }));
  };
  walk(data);
}

/** HTML or SVG source → findings. */
export function scanHtml(src) {
  const s = String(src), out = [], lineAt = lineIndex(s);
  const stack = [];                                  // { tag, exempt }
  const exempt = () => stack.some((e) => e.exempt);
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (m[2] == null) {
      if (tok.startsWith("<")) continue;            // comment, doctype, CDATA, processing instruction, stray "<"
      if (!exempt()) out.push(...scanProse(decodeEntities(tok), { line: lineAt(m.index) }));
      continue;
    }
    const tag = m[2].toLowerCase(), closing = m[1] === "/";
    if (closing) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const rawAttrs = m[3] || "", selfClosing = /\/\s*$/.test(rawAttrs);
    const a = parseAttrs(rawAttrs.replace(/\/\s*$/, ""));
    const line = lineAt(m.index);
    let mark = false;
    if (a["data-digits"] != null) {
      if (a["data-digits"] === "latin" && String(a["data-digits-reason"] || "").trim()) mark = true;
      else out.push({ line, kind: "marker", where: `<${tag}>`, match: `data-digits="${a["data-digits"]}"`, context: 'data-digits="latin" needs a data-digits-reason="…" (why these digits stay Latin)' });
    }
    const ex = mark || EXEMPT.has(tag) || exempt();
    if (!ex) {
      for (const [k, v] of Object.entries(a)) if (ATTRS.has(k) && v) out.push(...scanProse(v, { where: `attr:${k}`, line }));
      if (tag === "meta" && META.test(a.name || a.property || "") && a.content) out.push(...scanProse(a.content, { where: `meta:${a.name || a.property}`, line }));
    }
    if (RAW.has(tag) && !selfClosing) {
      const end = s.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      const body = s.slice(re.lastIndex, end < 0 ? s.length : end);
      if (tag === "script" && /ld\+json/i.test(a.type || "") && !ex) scanJsonLd(body, line, out);
      re.lastIndex = end < 0 ? s.length : end;
      continue;
    }
    if (!VOID.has(tag) && !selfClosing) stack.push({ tag, exempt: mark || EXEMPT.has(tag) });
  }
  return out;
}

/** Markdown source → findings (prose and the reader-facing front matter fields). */
export function scanMarkdown(src, { personOnly = false } = {}) {
  const out = [];
  const lines = String(src).split("\n");
  let i = 0, fence = null;
  if (lines[0] === "---") {
    for (i = 1; i < lines.length && lines[i] !== "---"; i++) {
      const fm = lines[i].match(FM_KEYS);
      if (fm) out.push(...scanProse(fm[2].replace(/^["']|["']$/g, ""), { where: `front-matter:${fm[1]}`, line: i + 1 }));
    }
    i++;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence ? (l.trim().startsWith(fence) ? null : fence) : f[1]; continue; }
    if (fence) continue;
    if (personOnly && !PERSIAN_LETTER.test(l)) continue;
    const prose = decodeEntities(l
      .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/, "")           // reference definitions
      .replace(/`[^`]*`/g, " ")                           // code spans
      .replace(/<!--.*?-->/g, " ")
      .replace(/\]\([^)]*\)/g, "] ")                      // link and image targets
      .replace(/<(?:https?:|mailto:)[^>]*>/g, " ")        // autolinks
      .replace(/<\/?[a-zA-Z][^>]*>/g, " "));              // inline HTML tags
    out.push(...scanProse(prose, { where: "md", line: i + 1 }));
  }
  return out;
}

/** Plain text (llms.txt): only the lines that carry Persian are Persian copy. */
export const scanText = (src) => scanMarkdown(src, { personOnly: true });

/** Type of a file by name: html | svg | md | txt | null. */
export function typeOf(file) {
  const f = String(file).toLowerCase();
  if (/\.html?$/.test(f)) return "html";
  if (/\.svg$/.test(f)) return "svg";
  if (/\.(md|markdown)$/.test(f)) return "md";
  if (/\.txt$/.test(f)) return "txt";
  return null;
}

/** Scan one source: type html | svg | md | txt (default from options.file). */
export function scanDigits(source, { type, file } = {}) {
  const t = type || typeOf(file || "");
  if (t === "html" || t === "svg") return scanHtml(source);
  if (t === "md") return scanMarkdown(source);
  if (t === "txt") return scanText(source);
  throw new Error(`scanDigits: unknown type ${JSON.stringify(t)} (html, svg, md or txt)`);
}

/** Is an HTML document Persian (<html lang="fa…">)? Documents in other languages are not scanned. */
export const isPersianHtml = (src) => /<html\b[^>]*\blang\s*=\s*["']?fa\b/i.test(String(src).slice(0, 2000));

/** "file:line kind where «match» — context" lines for a report. */
export const formatFindings = (findings, file = "") => findings.map((f) => `${file}${file ? ":" : ""}${f.line} ${f.kind} ${f.where} «${f.match}» ${f.context}`);
