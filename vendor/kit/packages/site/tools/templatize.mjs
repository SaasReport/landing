#!/usr/bin/env node
/**
 * templatize: turn a client script or page written in one language into a kit template plus a strings table.
 * Every run of text in a string literal, template literal or regex that holds Arabic-script letters (Persian,
 * Arabic, Urdu, …) becomes {{<prefix>.<n>|<escape>}}; HTML tags and attribute names stay in the template, so
 * translators only see text. Identical text within one call shares a key. The result renders back to the input
 * byte for byte (checked before it returns).
 *
 *   import { templatize } from "@saasreport/site/tools/templatize.mjs";
 *   const { template, strings } = templatize(source, { prefix: "s.home", kind: "js" });
 *
 * CLI: node templatize.mjs in.js --prefix s.home [--kind js|html] [--out template.js] [--strings strings.json]
 *
 * It is a porting aid: review the template (numbers, identifiers and markup are left as they are) and give the
 * keys better names where it helps.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../src/template.js";

export const SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "instanceof", "yield", "await"]);

/** Scan JS source into literal chunks: { kind: "str"|"tpl"|"re"|"comment", q, start, end } (end exclusive, the text only). */
export function scanJs(src) {
  const chunks = [];
  let i = 0, prev = "";
  const tplDepth = [];   // brace depth per open template literal expression
  let depth = 0;
  const n = src.length;
  const word = () => { const m = /[\w$]+$/.exec(src.slice(Math.max(0, i - 20), i)); return m ? m[0] : ""; };
  function readTemplate() {
    // at a backtick or a closing brace of ${…}; read static text up to ` or ${
    let s = i;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { chunks.push({ kind: "tpl", q: "`", start: s, end: i }); i++; prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { chunks.push({ kind: "tpl", q: "`", start: s, end: i }); i += 2; tplDepth.push(depth); depth++; prev = "{"; return; }
      i++;
    }
    throw new Error("unterminated template literal");
  }
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; chunks.push({ kind: "comment", start: i, end }); i = end; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2) + 2; chunks.push({ kind: "comment", start: i, end: e }); i = e; continue; }
    if (c === '"' || c === "'") {
      const s = ++i;
      while (src[i] !== c) { if (src[i] === "\\") i++; if (src[i] === "\n" || i >= n) throw new Error(`unterminated string at ${s}`); i++; }
      chunks.push({ kind: "str", q: c, start: s, end: i }); i++; prev = c; continue;
    }
    if (c === "`") { i++; readTemplate(); continue; }
    if (c === "/" && (REGEX_BEFORE.has(prev) || REGEX_KEYWORDS.has(word()))) {
      const s = ++i; let cls = false;
      while (i < n) { const d = src[i]; if (d === "\\") { i += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; else if (d === "\n") throw new Error(`unterminated regex at ${s}`); i++; }
      chunks.push({ kind: "re", q: "/", start: s, end: i }); i++;
      while (/[a-z]/.test(src[i] || "")) i++;
      prev = "/re"; continue;
    }
    if (c === "{") { depth++; prev = "{"; i++; continue; }
    if (c === "}") {
      depth--;
      if (tplDepth.length && tplDepth[tplDepth.length - 1] === depth) { tplDepth.pop(); i++; readTemplate(); continue; }
      prev = "}"; i++; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) { while (/[\w$]/.test(src[i] || "")) i++; prev = "w"; if (REGEX_KEYWORDS.has(word())) prev = ""; continue; }
    prev = c; i++;
  }
  return chunks;
}

const ESC = {
  '"': (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n"),
  "'": (v) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"),
  "`": (v) => v.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"),
};
const FILTER = { '"': "dq", "'": "sq", "`": "tl" };
function unescapeJs(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
    if (e[0] === "u") return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" }[e] ?? e;
  });
}

/** Split a text (string contents or HTML) into [kind, text] parts: "tag" (markup, with attribute values split out) and "text". */
function htmlParts(raw) {
  const parts = [];
  // a chunk of a template literal may start inside a tag opened before a ${…} (…%;top:50%">text): that prefix is markup
  const lt = raw.indexOf("<"), gt = raw.indexOf(">");
  const start = gt >= 0 && (lt < 0 || gt < lt) && /["']>$/.test(raw.slice(0, gt + 1)) ? gt + 1 : 0;
  if (start) parts.push(["tag", raw.slice(0, start)]);
  let last = start;
  const re = /<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(raw));) {
    if (m.index > last) parts.push(["text", raw.slice(last, m.index)]);
    const tag = m[0];
    let t = 0;
    for (const a of tag.matchAll(/(=\s*)(["'])([^"']*)\2/g)) {
      const vs = a.index + a[1].length + 1;
      parts.push(["tag", tag.slice(t, vs)], ["text", a[3]]);
      t = vs + a[3].length;
    }
    parts.push(["tag", tag.slice(t)]);
    last = m.index + tag.length;
  }
  if (last < raw.length) parts.push(["text", raw.slice(last)]);
  return parts;
}

/**
 * templatize(src, { prefix, kind: "js" | "html", keyStart, table, skip(chunk) }) → { template, strings, comments }.
 * `table` (a Map text → key) is shared when several calls should reuse keys; `comments` lists comments that hold
 * Arabic-script text (left as they are, for you to rewrite).
 */
export function templatize(src, { prefix = "s", kind = "js", keyStart = 1, table = new Map(), skip = () => false, pad = 0 } = {}) {
  const strings = {};
  let next = keyStart;
  const keyFor = (text) => {
    if (table.has(text)) return table.get(text);
    const k = String(next++).padStart(pad, "0");
    table.set(text, k);
    strings[k] = text;
    return k;
  };
  const edits = [];
  const comments = [];
  const runsIn = (raw, q, base) => {
    const esc = ESC[q];
    for (const [pk, text] of (q === "/" ? [["text", raw]] : htmlParts(raw))) {
      if (pk === "text" && SCRIPT.test(text)) {
        const lead = /^\s*/.exec(text)[0].length, trail = /\s*$/.exec(text)[0].length;
        const core = text.slice(lead, text.length - trail);
        let value = q === "/" || !esc ? core : unescapeJs(core);
        let filter = q === "/" || !esc ? "" : `|${FILTER[q]}`;
        if (esc && esc(value) !== core) { value = core; filter = ""; }
        const k = keyFor(value);
        edits.push({ start: base + lead, end: base + text.length - trail, to: `{{${prefix}.${k}${filter}}}` });
      }
      base += text.length;
    }
  };
  if (kind === "html") {
    runsIn(src, "", 0);
  } else {
    for (const c of scanJs(src)) {
      if (skip(c, src)) continue;
      const raw = src.slice(c.start, c.end);
      if (!SCRIPT.test(raw)) continue;
      if (c.kind === "comment") { comments.push({ at: c.start, text: raw }); continue; }
      runsIn(raw, c.q, c.start);
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let template = "", last = 0;
  for (const e of edits) { template += src.slice(last, e.start) + e.to; last = e.end; }
  template += src.slice(last);
  return { template, strings, comments, table };
}

/** Put a flat { "a.b.1": v } back into nested objects. */
export function nest(prefix, strings) {
  const out = {};
  for (const [k, v] of Object.entries(strings)) out[k] = v;
  return prefix.split(".").reduceRight((acc, key) => ({ [key]: acc }), out);
}

/** True when the template renders back to the source. */
export function roundTrips(src, template, ctx) { return renderTemplate(template, ctx) === src; }

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const file = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
  const src = readFileSync(file, "utf8");
  const prefix = opt("prefix", "s");
  const { template, strings, comments } = templatize(src, { prefix, kind: opt("kind", file.endsWith(".html") ? "html" : "js") });
  const ctx = nest(prefix, strings);
  if (!roundTrips(src, template, ctx)) throw new Error("the template does not render back to the input");
  if (opt("out")) writeFileSync(opt("out"), template); else process.stdout.write(template);
  if (opt("strings")) writeFileSync(opt("strings"), JSON.stringify(strings, null, 2) + "\n");
  for (const c of comments) console.error(`comment with text at ${c.at}: ${c.text.slice(0, 80)}`);
  console.error(`${Object.keys(strings).length} strings`);
}
