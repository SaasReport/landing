/**
 * Persian copy out of source files: the segments a reader (or a listener) gets, with where they are.
 *
 *   segments(file, src, { literals }) → [{ line, text, start, end, key }]
 *     line: 1-based line of the segment's first character; text: plain text (markup, code and URLs removed);
 *     start/end: the raw region in src the text came from (rewriteSegments edits it in place); key: the property name the
 *     value belongs to, when there is one (JSON key, JS `key:`, front-matter key), so a config can skip verbatim quotations.
 *
 * Kinds by extension: .json (every string value, keys skipped), .js/.mjs/.cjs/.ts (string and template literals, via the
 * `literals` tokenizer the caller passes: the CLI's canon tokenizer), .md (paragraphs; code fences and spans dropped),
 * .html/.svg (text and reader-facing attributes; script, style, pre and code dropped), .txt (paragraphs).
 * Only segments with Persian letters are returned. Pure: the caller reads and writes files.
 */
import { hasPersian } from "./normalize.js";

export function kindOf(file) {
  const m = /\.([a-z]+)$/i.exec(file || "");
  const ext = m ? m[1].toLowerCase() : "";
  if (ext === "json") return "json";
  if (["js", "mjs", "cjs", "ts"].includes(ext)) return "js";
  if (["md", "markdown"].includes(ext)) return "md";
  if (["html", "htm", "svg"].includes(ext)) return "html";
  if (ext === "txt") return "text";
  return null;
}

const INLINE = new Set(["a", "b", "i", "em", "strong", "span", "bdi", "bdo", "small", "sup", "sub", "mark", "abbr", "u", "s", "q", "cite", "dfn", "time", "data", "var", "kbd", "samp", "tspan", "wbr"]);
const ENTITIES = { nbsp: " ", zwnj: "\u200C", zwj: "\u200D", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–", rlm: "\u200F", lrm: "\u200E", middot: "·" };
const keepNewlines = (s) => s.replace(/[^\n]/g, "");

/**
 * «[label](target)» and «![alt](target)» → the label; the target goes with its parentheses balanced, so a target like
 * «/a/(b) ها/می رود.png» is not read as prose. A target that never closes runs to the end of the line.
 */
function stripLinks(text) {
  let out = "", at = 0;
  const re = /!?\[([^\]\n]*)\]\(/g;
  for (let m; (m = re.exec(text)); ) {
    if (m.index < at) continue;
    let i = m.index + m[0].length, depth = 1;
    while (i < text.length && text[i] !== "\n") {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) { i++; break; }
      i++;
    }
    i = Math.min(i, text.length);
    out += text.slice(at, m.index) + m[1];
    at = i;
    re.lastIndex = i;
  }
  return out + text.slice(at);
}

/**
 * Markup → plain text, line count kept: tags vanish (block tags become a paragraph separator U+2029), code spans and
 * ${…} expressions become U+FFFC, Markdown links keep their text, entities are decoded.
 */
export function plainText(s) {
  return String(s ?? "")
    .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => `\uFFFC${keepNewlines(m)}`)
    .replace(/<!--[\s\S]*?-->/g, keepNewlines)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (m, tag) => (INLINE.has(tag.toLowerCase()) ? keepNewlines(m) : `\u2029${keepNewlines(m)}`))
    .replace(/\$\{[^}]*\}/g, "\uFFFC")
    .replace(/`[^`\n]*`/g, "\uFFFC")
    .replace(/^[\s\S]*$/, stripLinks)
    .replace(/\bhttps?:\/\/[^\s)»"']+/g, "\uFFFC")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\*\*|__/g, "")
    .replace(/\uFFFC{2,}/g, "\uFFFC")
    // a line break inside a paragraph (a Markdown soft wrap, "  \n" or "\" + newline) continues the sentence: U+2028, which the
    // rules read as a space and line numbers still count; a blank line, or a line that starts a list item, heading, quote or
    // table row, ends it
    .replace(/(?<!\n)(?: {2,}|\\)?\n(?!\s*\n|\s*(?:[-*+>#|]|\d+[.)])\s)/g, "\u2028");
}

/** JavaScript string escapes → characters (the literal's raw text as the tokenizer returns it). */
const unescapeJs = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|t|r|.)/g, (m, e) => {
  if (e[0] === "u") return String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16));
  if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
  return { n: "\n", t: "\t", r: "\r" }[e] ?? e;
});

const lineAt = (src, i) => { let n = 1; for (let k = src.indexOf("\n"); k !== -1 && k < i; k = src.indexOf("\n", k + 1)) n++; return n; };

function jsonSegments(src) {
  const out = [];
  for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
    const after = src.slice(m.index + m[0].length).match(/^\s*(.)/);
    if (after && after[1] === ":") continue; // a key
    let value;
    try { value = JSON.parse(m[0]); } catch { continue; /* a quoted run that is not a JSON string is not a JSON value */ }
    if (!hasPersian(value)) continue;
    const key = /"([^"\\]+)"\s*:\s*$/.exec(src.slice(Math.max(0, m.index - 200), m.index))?.[1] ?? null;
    out.push({ line: lineAt(src, m.index), text: plainText(value), start: m.index + 1, end: m.index + m[0].length - 1, key });
  }
  return out;
}

function jsSegments(src, literals) {
  if (typeof literals !== "function") throw new Error("segments: a JavaScript source needs the literals tokenizer");
  const out = [];
  for (const l of literals(src)) {
    if (!hasPersian(l.value)) continue;
    const key = /([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:\s*$/.exec(l.context || "")?.[1]?.replace(/^["']|["']$/g, "") ?? null;
    out.push({ line: l.line, text: plainText(unescapeJs(l.value)), start: l.start, end: l.end, key });
  }
  return out;
}

/** Paragraphs (blank-line separated) of a text, as regions; fenced code is skipped. */
function paragraphSegments(src, toText) {
  const out = [];
  let fence = false;
  const lines = src.split("\n");
  let offset = 0, startOff = null, startLine = 0, buf = [];
  const flush = (endOff) => {
    if (startOff != null && buf.length) {
      while (endOff > startOff && src[endOff - 1] === "\n") endOff--;
      const raw = src.slice(startOff, endOff);
      if (hasPersian(raw)) out.push({ line: startLine, text: toText(raw), start: startOff, end: endOff });
    }
    startOff = null; buf = [];
  };
  lines.forEach((ln, i) => {
    const isFence = /^\s*(```|~~~)/.test(ln);
    if (isFence) { flush(offset); fence = !fence; }
    else if (fence) { /* code */ }
    else if (!ln.trim()) flush(offset);
    else { if (startOff == null) { startOff = offset; startLine = i + 1; } buf.push(ln); }
    offset += ln.length + 1;
  });
  flush(Math.min(offset, src.length));
  return out;
}

/**
 * Markdown: YAML front matter one value per segment (a flow list [a, b] one item each, so its commas stay YAML), then the
 * body as paragraphs.
 */
function markdownSegments(src) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!fm) return paragraphSegments(src, plainText);
  const out = [];
  let off = 4;
  fm[1].split("\n").forEach((ln, i) => {
    const m = /^(\s*[\w-]+\s*:\s*)(.*)$/.exec(ln);
    if (m && hasPersian(m[2])) {
      const key = m[1].trim().replace(/:$/, "").trim();
      const v0 = off + m[1].length;
      const list = /^\[(.*)\]\s*$/.exec(m[2]);
      if (list) {
        let p = v0 + 1;
        for (const item of list[1].split(",")) {
          const lead = item.length - item.trimStart().length, t = item.trim().replace(/^["']|["']$/g, "");
          if (hasPersian(t)) out.push({ line: i + 2, text: t, start: p + lead, end: p + lead + item.trim().length, key });
          p += item.length + 1;
        }
      } else out.push({ line: i + 2, text: plainText(m[2].replace(/^["']|["']$/g, "")), start: v0, end: v0 + m[2].length, key });
    }
    off += ln.length + 1;
  });
  const body = fm[0].length;
  for (const p of paragraphSegments(src.slice(body), plainText)) {
    out.push({ ...p, line: p.line + (src.slice(0, body).match(/\n/g) || []).length, start: p.start + body, end: p.end + body });
  }
  return out;
}

function htmlSegments(src) {
  const out = [];
  // reader-facing attributes, each its own segment
  for (const m of src.matchAll(/\s(alt|title|aria-label|placeholder|content|aria-description)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const v = m[3] ?? m[4] ?? "";
    if (!hasPersian(v)) continue;
    const start = m.index + m[0].indexOf(m[2]) + 1;
    out.push({ line: lineAt(src, m.index), text: plainText(v), start, end: start + v.length });
  }
  // text: the whole document as paragraphs of plain text (tags removed, line count kept)
  // script, style, pre and code are not prose: blanked to U+FFFC (offsets and lines kept), as the Markdown path does, so a
  // «<code>#15803D</code>،» is not read as «word space comma»
  const blanked = src.replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, "\uFFFC"));
  for (const p of paragraphSegments(blanked, plainText)) out.push({ ...p, attrs: false });
  return out;
}

export function segments(file, src, { literals, kind = kindOf(file) } = {}) {
  src = String(src ?? "");
  if (kind === "json") return jsonSegments(src);
  if (kind === "js") return jsSegments(src, literals);
  if (kind === "md") return markdownSegments(src);
  if (kind === "html") return htmlSegments(src);
  if (kind === "text") return paragraphSegments(src, (s) => s);
  return [];
}

/**
 * Rewrite segments in place: fn(rawRegion) → new raw region, applied from the end so offsets stay valid.
 * Regions that overlap an earlier rewrite are skipped. → the new source.
 */
export function rewriteSegments(src, segs, fn) {
  let out = String(src);
  let floor = Infinity;
  for (const s of [...segs].sort((a, b) => b.start - a.start)) {
    if (s.end > floor) continue;
    const raw = out.slice(s.start, s.end);
    const next = fn(raw, s);
    if (next !== raw) out = out.slice(0, s.start) + next + out.slice(s.end);
    floor = s.start;
  }
  return out;
}
