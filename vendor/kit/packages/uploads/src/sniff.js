/**
 * The magic-byte sniffer. The type of an upload is decided from its own bytes; the declared content type and the filename
 * extension are only compared with it (a mismatch is evidence, never a decision input).
 *
 *   sniff(bytes)                       → { type, family, polyglot_suspect, signals: [string] }
 *   matchesDeclared({ contentType, filename }, sniffedType)  → boolean   (false: the claim names another type than the bytes)
 *   ALLOWABLE_TYPES                    the types a policy may allow (= upload-policy.schema.json allowed_types)
 *
 * family: document | image | text | archive | executable | script | unknown. Executables, scripts and archives other than
 * OOXML are never allowable, whatever the form says.
 */
import { hasAt, indexOfBytes, ascii, latin1, u16, u32 } from "./bytes.js";
import { readZip } from "./zip.js";
import { readCfb, oleKind, OLE_MAGIC } from "./cfb.js";
import { isSpace, isWord, isAlpha, isDigit, skipSpace, runWhile, startsWithCI, indexOfCI } from "./lex.js";
import { normaliseFilename } from "./filename.js";
import { tick } from "./work.js";

const T = {
  pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  text: "text/plain", json: "application/json", html: "text/html", xml: "application/xml", js: "application/javascript", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", ole: "application/x-ole-storage",
  octet: "application/octet-stream",
};
export const TYPES = Object.freeze(T);

export const ALLOWABLE_TYPES = Object.freeze([T.pdf, T.png, T.jpeg, T.gif, T.webp, T.svg, T.text, T.json, T.zip, T.docx, T.xlsx, T.pptx, T.doc, T.xls, T.ppt]);

const FAMILY = {
  [T.pdf]: "document", [T.docx]: "document", [T.xlsx]: "document", [T.pptx]: "document", [T.doc]: "document", [T.xls]: "document", [T.ppt]: "document", [T.ole]: "document",
  [T.png]: "image", [T.jpeg]: "image", [T.gif]: "image", [T.webp]: "image", [T.svg]: "image",
  [T.text]: "text", [T.json]: "text", [T.xml]: "text", [T.html]: "script", [T.js]: "script", [T.zip]: "archive", [T.octet]: "unknown",
};
export const familyOf = (type) => FAMILY[type] || "unknown";

/** Fixed signatures at offset 0. */
const MAGIC = [
  [ascii("\x89PNG\r\n\x1a\n"), T.png], [Uint8Array.of(0xff, 0xd8, 0xff), T.jpeg], [ascii("GIF87a"), T.gif], [ascii("GIF89a"), T.gif],
  [ascii("\x7fELF"), "application/x-elf", "executable"],
  [Uint8Array.of(0xfe, 0xed, 0xfa, 0xce), "application/x-mach-binary", "executable"], [Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf), "application/x-mach-binary", "executable"],
  [Uint8Array.of(0xce, 0xfa, 0xed, 0xfe), "application/x-mach-binary", "executable"], [Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe), "application/x-mach-binary", "executable"],
  [Uint8Array.of(0xca, 0xfe, 0xba, 0xbe), "application/java-vm", "executable"],
  [Uint8Array.of(0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0), "application/x-ms-shortcut", "executable"], [ascii("ITSF"), "application/vnd.ms-htmlhelp", "executable"],
  [ascii("MSCF"), "application/vnd.ms-cab-compressed", "archive"], [Uint8Array.of(0x1f, 0x8b), "application/gzip", "archive"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [ascii(`BZh${d}1AY&SY`), "application/x-bzip2", "archive"]),
  [Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0), "application/x-xz", "archive"], [Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), "application/x-7z-compressed", "archive"],
  [ascii("Rar!\x1a\x07"), "application/vnd.rar", "archive"], [ascii("%!PS"), "application/postscript", "script"], [ascii("{\\rtf"), "application/rtf", "document"],
  [ascii("#!"), "text/x-script", "script"], [ascii("<?php"), "application/x-httpd-php", "script"],
];

const sigAt = (b, i, s) => hasAt(b, ascii(s), i);

/** MZ is two bytes: only a PE header or the DOS stub text makes it an executable (a text file may start with "MZ"). */
function isPe(b) {
  if (!hasAt(b, ascii("MZ"))) return false;
  if (b.length >= 0x40) { const pe = u32(b, 0x3c); if (pe > 0 && pe + 4 <= b.length && hasAt(b, ascii("PE\0\0"), pe)) return true; }
  return indexOfBytes(b, ascii("This program"), 0, Math.min(b.length, 256)) >= 0;
}

function textKind(bytes) {
  const sample = bytes.subarray(0, 65536);
  let t = null;
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) {
    try { t = new TextDecoder(sample[0] === 0xff ? "utf-16le" : "utf-16be", { fatal: true }).decode(sample.subarray(2), { stream: true }); } catch { return null; /* not valid UTF-16: not text (null), so the type is not text */ }
  } else {
    if (sample.indexOf(0) !== -1) return null;
    try { t = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true }); } catch { return null; /* not valid UTF-8: not text (null), so the type is not text */ }
  }
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/**
 * The text classifier is a forward-only scanner (lex.js), not a set of regular expressions: a nested lazy comment group
 * backtracked exponentially on a 350-byte file, and \s*[\w$]*\s* in the JavaScript test was quadratic. Leading whitespace and
 * comments of any length are skipped (each search moves forward once), so padding cannot hide markup.
 */
const COMMENT_OPEN = "<!--";

/** The index after any comments that start at i, or -1 for one that never closes. */
function skipComments(t, i) {
  while (t.startsWith(COMMENT_OPEN, i)) {
    const j = t.indexOf("-->", i + 4);
    if (j < 0) return -1;
    i = skipSpace(t, j + 3);
  }
  return i;
}

const HTML_PREFIXES = ["<html", "<head", "<body", "<script", "<iframe", "<meta", "<style", "<link", "<form", "<table", "<div", "<img", "<object", "<embed", "<base", "<title", "<frameset"];
const boundary = (t, i) => i >= t.length || isSpace(t.charCodeAt(i)) || t[i] === ">";
function htmlTagAt(t, i) {
  if (t[i] !== "<") return false;
  if (startsWithCI(t, i, "<!doctype") && startsWithCI(t, skipSpace(t, i + 9), "html") && skipSpace(t, i + 9) > i + 9) return true;
  for (const p of HTML_PREFIXES) if (startsWithCI(t, i, p)) return true;
  if ((startsWithCI(t, i, "<p") || startsWithCI(t, i, "<a")) && boundary(t, i + 2)) return true;
  if (startsWithCI(t, i, "<h") && t.charCodeAt(i + 2) >= 49 && t.charCodeAt(i + 2) <= 54 && boundary(t, i + 3)) return true;
  return false;
}
const startsHtml = (t) => { const i = skipComments(t, skipSpace(t, 0)); return i >= 0 && htmlTagAt(t, i); };

function svgTagAt(t, i) { return startsWithCI(t, i, "<svg") && boundary(t, i + 4); }
function startsSvg(t) {
  let i = skipSpace(t, 0);
  if (startsWithCI(t, i, "<?xml")) {   // the declaration ends at the first ">" and must close with "?>"
    const gt = t.indexOf(">", i);
    if (gt > 0 && t[gt - 1] === "?") i = skipSpace(t, gt + 1);
  }
  i = skipComments(t, i);
  if (i < 0) return false;
  if (startsWithCI(t, i, "<!doctype") && skipSpace(t, i + 9) > i + 9 && startsWithCI(t, skipSpace(t, i + 9), "svg")) {
    const gt = t.indexOf(">", i);
    if (gt > 0 && gt - i <= 4100) i = skipSpace(t, gt + 1);
  }
  return svgTagAt(t, i);
}

/** Markup that has no business in a text file: <script, <iframe, <html, <object, <embed or <svg (spaces allowed after "<"), within the window. */
const MARKUP_NAMES = ["script", "iframe", "html", "object", "embed", "svg"];
function markupWithin(t, from, to) {
  const end = Math.min(t.length, to);
  for (let i = t.indexOf("<", from); i >= 0 && i < end; i = t.indexOf("<", i + 1)) {
    let j = i + 1;
    for (let k = 0; k < 8 && isSpace(t.charCodeAt(j)); k++) j++;   // bounded: browsers accept no space after "<"
    for (const name of MARKUP_NAMES) if (startsWithCI(t, j, name) && !isWord(t.charCodeAt(j + name.length) || 0)) return true;
  }
  return false;
}

const isIdent = (c) => isWord(c) || c === 36;
/** A word followed by whitespace or by a given character, the shapes JavaScript source starts with. */
function startsJs(t) {
  const i = skipSpace(t, 0);
  const c = t[i];
  if (c === '"' || c === "'") return t.startsWith("use strict", i + 1) && (t[i + 11] === '"' || t[i + 11] === "'");
  if (startsWithCI(t, i, "import") && t.startsWith("import", i) && isSpace(t.charCodeAt(i + 6))) return true;
  if (t.startsWith("export", i) && isSpace(t.charCodeAt(i + 6))) return true;
  if ((t.startsWith("(function", i) && !isWord(t.charCodeAt(i + 9) || 0)) || (t.startsWith("!function", i) && !isWord(t.charCodeAt(i + 9) || 0))) return true;
  if (t.startsWith("()", i) && t.startsWith("=>", skipSpace(t, i + 2))) return true;
  for (const kw of ["var", "let", "const"]) {
    if (t.startsWith(kw, i) && isSpace(t.charCodeAt(i + kw.length))) {
      const j = skipSpace(t, i + kw.length), k = runWhile(t, j, isIdent);
      if (k > j && t[skipSpace(t, k)] === "=") return true;
    }
  }
  if (t.startsWith("function", i)) { const j = runWhile(t, skipSpace(t, i + 8), isIdent); if (t[skipSpace(t, j)] === "(") return true; }
  if (t.startsWith("document.", i) || t.startsWith("window.", i)) return true;
  if (t.startsWith("eval", i) && t[skipSpace(t, i + 4)] === "(") return true;
  return false;
}

function classifyText(bytes, t, signals) {
  if (startsSvg(t)) return T.svg;
  if (startsHtml(t)) return T.html;
  const lead = skipSpace(t, 0);
  if (startsWithCI(t, lead, "<?xml")) {
    const head = t.slice(0, 4096);
    for (let i = indexOfCI(head, "<svg"); i >= 0; i = indexOfCI(head, "<svg", i + 1)) if (boundary(t, i + 4)) return T.svg;
    return T.xml;
  }
  if (startsJs(t)) { signals.push("javascript_like_text"); return T.js; }
  // markup anywhere in the first 4096 characters, or in the 4096 after the leading comments (a long comment must not push it out of view)
  const after = skipComments(t, lead);
  if (markupWithin(t, 0, 4096) || (after > 0 && markupWithin(t, after, after + 4096))) { signals.push("markup_inside_text"); return T.html; }
  const ch = t.slice(lead, lead + 1);
  if ((ch === "{" || ch === "[") && bytes.length <= 4 * 1024 * 1024) { try { JSON.parse(t.length === bytes.length || bytes.length <= 65536 ? t : new TextDecoder().decode(bytes)); return T.json; } catch { /* starts like JSON but does not parse: it is plain text */ } }
  return T.text;
}

/**
 * Binary signatures that must not follow the start of an image: a second format glued on (polyglot). A 2 to 4 byte signature occurs by
 * chance in compressed image data (a 4-byte one in about 0.2% to 1% of 10 MB photos, "MZ" in nearly every one), so PK\x03\x04, MZ and
 * \x7fELF count only with the structure of a real zip local header, PE image (e_lfanew at "PE\0\0") or ELF identification behind them.
 */
const ZIP_METHODS = new Set([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 14, 18, 19, 20, 93, 94, 95, 96, 97, 98, 99]);
/** A zip local file header at p: version needed, a known method, a sane name (printable, fits), the name and extra field inside the bytes. */
function zipLocalAt(b, p) {
  if (p + 30 > b.length || u16(b, p + 4) > 100 || !ZIP_METHODS.has(u16(b, p + 8))) return false;
  const nameLen = u16(b, p + 26), extraLen = u16(b, p + 28);
  if (nameLen < 1 || nameLen > 1024 || p + 30 + nameLen + extraLen > b.length) return false;
  for (let k = p + 30; k < p + 30 + nameLen; k++) if (b[k] < 0x20 || b[k] === 0x7f) return false;
  return true;
}
/** A DOS/PE image at p, by structure alone (never the stub bytes): "MZ", then a u32 e_lfanew at 0x3c that points at "PE\0\0" inside the bytes. */
function peAt(b, p) {
  if (p + 0x40 > b.length) return false;
  const pe = u32(b, p + 0x3c);
  return pe >= 4 && p + pe + 4 <= b.length && hasAt(b, ascii("PE\0\0"), p + pe);
}
const ELF_MACHINES = new Set([2, 3, 4, 6, 7, 8, 9, 10, 15, 18, 19, 20, 21, 22, 23, 40, 42, 43, 50, 62, 83, 92, 94, 183, 189, 243, 247, 258]);
/** An ELF image at p: EI_CLASS 1|2, EI_DATA 1|2, EI_VERSION 1, e_type 1-4, a known e_machine, e_version 1, and e_phoff / e_shoff (at least one set) inside the bytes. */
function elfAt(b, p) {
  const c = b[p + 4], d = b[p + 5];
  if ((c !== 1 && c !== 2) || (d !== 1 && d !== 2) || b[p + 6] !== 1 || p + (c === 1 ? 52 : 64) > b.length) return false;
  const le = d === 1, r16 = (o) => (le ? u16(b, p + o) : (b[p + o] << 8) | b[p + o + 1]);
  const r32 = (o) => (le ? u32(b, p + o) : ((b[p + o] << 24) | (b[p + o + 1] << 16) | (b[p + o + 2] << 8) | b[p + o + 3]) >>> 0);
  const off = (o) => { if (c === 1) return r32(o); const lo = le ? r32(o) : r32(o + 4), hi = le ? r32(o + 4) : r32(o); return hi ? Infinity : lo; };
  if (r16(16) < 1 || r16(16) > 4 || !ELF_MACHINES.has(r16(18)) || r32(20) !== 1) return false;
  const ph = off(c === 1 ? 28 : 32), sh = off(c === 1 ? 32 : 40), left = b.length - p;
  return (ph > 0 || sh > 0) && ph < left && sh < left;
}
const GLUED = [["PK\x03\x04", "zip", zipLocalAt], ["%PDF-", "pdf"], ["\x7fELF", "elf", elfAt], ["This program cannot be run", "pe"], ["MZ", "pe", peAt]];

/** Names of tags that make an image a polyglot on their own: the classifier's HTML_PREFIXES plus svg and math (a name is the whole run of name characters, never a prefix). */
const GLUED_NAMES = new Set([...HTML_PREFIXES.map((p) => p.slice(1)), "svg", "math"]);
const MAX_SPACE_AFTER_LT = 8;       // browsers accept none; a bounded few, never an unbounded run
const MAX_TAG_LOOKAHEAD = 512;      // the attribute window of one tag, in text characters
const MAX_NAME = 12;                // longer than every name in GLUED_NAMES
/** HTML whitespace (tag and attribute separators): tab, LF, FF, CR, space. NUL and every other control byte is an ordinary character. */
const isHtmlWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isTagNameChar = (c) => isWord(c) || c === 45 || c === 58;
/** Attributes whose value is a URL: a script URL there runs when the element is used. */
const URL_ATTRS = new Set(["src", "href", "xlink:href", "action", "formaction", "data", "poster", "background", "lowsrc", "dynsrc"]);
const lowerOf = (c) => (c >= 65 && c <= 90 ? c + 32 : c);

/** An event handler attribute name: "on" and at least one letter, nothing else (the "=" is checked by the caller). */
function isHandlerName(t, a, b) {
  if (b - a < 3 || lowerOf(t.charCodeAt(a)) !== 111 || lowerOf(t.charCodeAt(a + 1)) !== 110) return false;
  for (let k = a + 2; k < b; k++) if (!isAlpha(t.charCodeAt(k))) return false;
  return true;
}
/** Does the value a..b start with "javascript:" (leading controls and spaces dropped, tab, LF and CR inside the scheme ignored, as browsers do)? */
function isScriptUrl(t, a, b) {
  const lit = "javascript:";
  let k = a, m = 0;
  while (k < b && t.charCodeAt(k) <= 32) k++;
  for (; k < b && m < lit.length; k++) {
    const c = t.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13) continue;
    if (lowerOf(c) !== lit.charCodeAt(m)) return false;
    m++;
  }
  return m === lit.length;
}
/**
 * The attributes of one tag, from j to the window end: true when one is an event handler (on[a-z]+ then "=") or a URL attribute holding a
 * script URL. One forward pass; returns where the scan ended ("next": after the closing ">", or the window end), so the caller never rescans it.
 */
function scanAttributes(t, j, end) {
  while (j < end) {
    const c = t.charCodeAt(j);
    if (c === 62) return { hit: false, next: j + 1 };
    if (isHtmlWs(c) || c === 47) { j++; continue; }
    const a = j++;                                       // an attribute name (a leading "=" belongs to it, as in HTML)
    while (j < end) { const d = t.charCodeAt(j); if (isHtmlWs(d) || d === 47 || d === 61 || d === 62) break; j++; }
    const nameEnd = j;
    let k = nameEnd;
    while (k < end && isHtmlWs(t.charCodeAt(k))) k++;
    if (k >= end || t.charCodeAt(k) !== 61) continue;     // no value
    if (isHandlerName(t, a, nameEnd)) return { hit: true, next: k };
    k++;
    while (k < end && isHtmlWs(t.charCodeAt(k))) k++;
    const q = t.charCodeAt(k);
    let vs = k, ve;
    if (q === 34 || q === 39) { vs = k + 1; ve = vs; while (ve < end && t.charCodeAt(ve) !== q) ve++; j = Math.min(end, ve + 1); }
    else { ve = vs; while (ve < end && !isHtmlWs(t.charCodeAt(ve)) && t.charCodeAt(ve) !== 62) ve++; j = ve; }
    if (nameEnd - a <= 10 && URL_ATTRS.has(t.slice(a, nameEnd).toLowerCase()) && isScriptUrl(t, vs, ve)) return { hit: true, next: j };
  }
  return { hit: false, next: end };
}
/**
 * Script or markup glued behind an image, in ONE forward pass (`stats.steps` counts the characters examined, so a test can prove linearity):
 * "<?php"; a tag whose name is a known name (followed by whitespace, "/" or ">"; spaces after "<" bounded); any other "<letter" tag whose attributes
 * hold an event handler or a script URL; or a "#!/" at the start of a line. The scan position moves forward only: a tag's attribute window is
 * never examined again by the next "<".
 */
function gluedText(t, stats = null) {
  let steps = 0;
  const done = (r) => { tick(steps); if (stats) stats.steps = (stats.steps || 0) + steps; return r; };
  for (let i = t.indexOf("<"); i >= 0 && i < t.length;) {
    let j = i + 1;
    for (let k = 0; k < MAX_SPACE_AFTER_LT && isSpace(t.charCodeAt(j)); k++) j++;
    if (startsWithCI(t, j, "?php")) return done(true);
    let e = j;
    while (e < t.length && isTagNameChar(t.charCodeAt(e))) e++;
    steps += e - i + 1;
    const c = e < t.length ? t.charCodeAt(e) : 62;
    if (e === j || !isAlpha(t.charCodeAt(j)) || !(isHtmlWs(c) || c === 47 || c === 62)) { i = t.indexOf("<", Math.max(e, i + 1)); continue; }
    if (e - j <= MAX_NAME && GLUED_NAMES.has(t.slice(j, e).toLowerCase())) return done(true);
    const end = Math.min(t.length, e + MAX_TAG_LOOKAHEAD);
    const r = scanAttributes(t, e, end);
    steps += r.next - e;
    if (r.hit) return done(true);
    i = t.indexOf("<", r.next);
  }
  steps += t.length;
  for (let i = t.indexOf("#!/"); i >= 0; i = t.indexOf("#!/", i + 1)) if (i === 0 || t[i - 1] === "\n" || t[i - 1] === "\r") return done(true);
  return done(false);
}

/** The bytes a..b read as UTF-16 starting at byte offset a+parity: one char per unit when the unit is ASCII, 0xffff otherwise (it disqualifies a tag, it never matches). */
function utf16Ascii(bytes, a, b, parity, le) {
  const codes = [];
  for (let p = a + parity; p + 1 < b; p += 2) { const lo = le ? bytes[p] : bytes[p + 1], hi = le ? bytes[p + 1] : bytes[p]; codes.push(hi === 0 ? lo : 0xffff); }
  let s = "";
  for (let k = 0; k < codes.length; k += 8192) s += String.fromCharCode.apply(null, codes.slice(k, k + 8192));
  return s;
}

/** Polyglot scan window: the whole image in bounded chunks, each overlapping the next so a signature or tag on a seam is still seen. */
const CHUNK = 1024 * 1024, OVERLAP = 4096;

/**
 * `start` is the end of the type's own signature (PNG 8, JPEG 3, GIF 6, WebP 12): payload right after the magic must be seen.
 * Nothing is left unscanned. Markup is looked for as bytes (latin1) and as UTF-16LE and UTF-16BE at either alignment. `opts` exists for tests.
 */
export function scanPolyglot(bytes, signals, start, { chunk = CHUNK, overlap = OVERLAP, stats = null } = {}) {
  const n = bytes.length;
  const found = new Set();
  for (let a = Math.min(start, n); a < n; a += chunk) {
    const b = Math.min(n, a + chunk + overlap);
    for (const [sig, name, valid] of GLUED) {
      const needle = ascii(sig);
      for (let at = indexOfBytes(bytes, needle, a, b); at >= 0; at = indexOfBytes(bytes, needle, at + 1, b)) if (!valid || valid(bytes, at)) { found.add(`embedded_${name}`); break; }
    }
    if (gluedText(latin1(bytes, a, b), stats)) found.add("embedded_script_or_markup");
    else for (const [parity, le] of [[0, true], [1, true], [0, false], [1, false]]) if (gluedText(utf16Ascii(bytes, a, b, parity, le), stats)) { found.add("embedded_script_or_markup"); break; }
  }
  for (const f of found) signals.push(f);
  return found.size > 0;
}
const polyglot = scanPolyglot;

/** The sniffed type of bytes: { type, family, polyglot_suspect, signals }. */
export function sniff(bytes) {
  const signals = [];
  const out = (type, family = familyOf(type), polyglotSuspect = false) => ({ type, family, polyglot_suspect: polyglotSuspect, signals });
  if (!bytes || bytes.length === 0) { signals.push("empty"); return out(T.octet, "unknown"); }
  // PDF: "%PDF-" within the first 1024 bytes (readers accept junk before it: the offset is a polyglot signal)
  const pdfAt = indexOfBytes(bytes, ascii("%PDF-"), 0, Math.min(bytes.length, 1024));
  if (pdfAt === 0) return out(T.pdf);
  if (pdfAt > 0) { signals.push("pdf_header_offset"); return out(T.pdf, "document", true); }
  if (hasAt(bytes, ascii("RIFF")) && hasAt(bytes, ascii("WEBP"), 8)) return out(T.webp, "image", polyglot(bytes, signals, 12));
  for (const [sig, type, family] of MAGIC) if (hasAt(bytes, sig)) return out(type, family || familyOf(type), [T.png, T.jpeg, T.gif].includes(type) ? polyglot(bytes, signals, sig.length) : false);
  if (isPe(bytes)) return out("application/x-msdownload", "executable");
  if (bytes.length > 262 && hasAt(bytes, ascii("ustar"), 257)) return out("application/x-tar", "archive");
  if (hasAt(bytes, OLE_MAGIC)) {
    const c = readCfb(bytes);
    if (!c.ok) { signals.push("ole_unreadable"); return out(T.ole); }
    const k = oleKind(c.entries);
    return out(k === "word" ? T.doc : k === "excel" ? T.xls : k === "powerpoint" ? T.ppt : T.ole);
  }
  if (sigAt(bytes, 0, "PK\x03\x04") || sigAt(bytes, 0, "PK\x05\x06") || sigAt(bytes, 0, "PK\x07\x08")) {
    const z = readZip(bytes, { maxEntries: 10000 });
    if (!z.ok) { signals.push("zip_unreadable"); return out(T.zip); }
    const names = new Set(z.entries.map((e) => e.name));
    const has = (p) => z.entries.some((e) => e.name.startsWith(p));
    if (names.has("[Content_Types].xml")) {
      if (has("word/")) return out(T.docx);
      if (has("xl/")) return out(T.xlsx);
      if (has("ppt/")) return out(T.pptx);
      signals.push("ooxml_unknown_application");
      return out(T.zip);
    }
    if (names.has("META-INF/MANIFEST.MF")) return out("application/java-archive", "archive");
    if (names.has("mimetype")) return out("application/vnd.oasis.opendocument", "archive");
    return out(T.zip);
  }
  const t = textKind(bytes);
  if (t == null) return out(T.octet, "unknown");
  const type = classifyText(bytes, t, signals);
  return out(type);
}

/* ---------- declared type and extension ---------- */

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download", "application/unknown"]);
const CT_ALIAS = { "image/jpg": T.jpeg, "image/pjpeg": T.jpeg, "application/x-pdf": T.pdf, "text/csv": T.text, "application/csv": T.text, "text/markdown": T.text, "text/x-markdown": T.text,
  "text/tab-separated-values": T.text, "text/x-log": T.text, "application/x-zip-compressed": T.zip, "application/x-zip": T.zip, "text/xml": T.xml };

/** Sniffed types a claim is compatible with (the claim is the key, the bytes the members). */
const COMPAT = {
  [T.text]: [T.text, T.json], [T.json]: [T.json, T.text], [T.zip]: [T.zip, T.docx, T.xlsx, T.pptx],
  [T.xml]: [T.xml, T.svg, T.text],
};
const EXT = {
  pdf: [T.pdf], png: [T.png], jpg: [T.jpeg], jpeg: [T.jpeg], jpe: [T.jpeg], jfif: [T.jpeg], gif: [T.gif], webp: [T.webp], svg: [T.svg], svgz: [T.svg],
  txt: [T.text], text: [T.text], csv: [T.text, T.json], tsv: [T.text], md: [T.text], log: [T.text], json: [T.json, T.text],
  zip: [T.zip, T.docx, T.xlsx, T.pptx],
  docx: [T.docx], docm: [T.docx], dotx: [T.docx], dotm: [T.docx], xlsx: [T.xlsx], xlsm: [T.xlsx], xltx: [T.xlsx], xltm: [T.xlsx], pptx: [T.pptx], pptm: [T.pptx], ppsx: [T.pptx], potx: [T.pptx],
  doc: [T.doc, T.ole], dot: [T.doc, T.ole], xls: [T.xls, T.ole], xlt: [T.xls, T.ole], ppt: [T.ppt, T.ole], pps: [T.ppt, T.ole],
  html: [T.html], htm: [T.html], xhtml: [T.html], js: [T.js, T.text], mjs: [T.js, T.text], xml: [T.xml, T.svg],
  exe: ["application/x-msdownload"], dll: ["application/x-msdownload"], scr: ["application/x-msdownload"], sys: ["application/x-msdownload"],
};

/** The extension of a filename as the normaliser sees it (letters and digits, at most 10), or null. */
export const extensionOf = (filename) => normaliseFilename(filename).extension;

/**
 * Extensions a server, a shell or a script host acts on. Policy (docs/UPLOADS.md, "Double extensions"): a name that carries one
 * of them as ANY dot-separated part after the first (a.png.php, a.php.png, a.php::$DATA, a.php., a.php<zero-width>.png) is a type
 * mismatch whatever the bytes are, because servers that map every extension of a name (Apache multi-extension handlers) and
 * Windows (trailing dots, alternate data streams) run the dangerous part. The name is metadata and downloads are attachments,
 * so this is defence in depth; it refuses the name instead of trusting every consumer of it. (Not in the list, on purpose: com,
 * pl, py, sh and cer, which are domain and certificate suffixes in ordinary names such as "amazon.com.pdf".)
 */
export const EXECUTABLE_NAME_PARTS = Object.freeze(new Set([
  "php", "php3", "php4", "php5", "php7", "phtml", "phar", "pht", "asp", "aspx", "ashx", "asmx", "jsp", "jspx", "cgi", "bash", "zsh", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh", "hta",
  "jar", "msi", "lnk", "pif", "scr", "exe", "dll", "html", "htm", "xhtml", "shtml", "js", "mjs", "jse",
]));
/** The dangerous extension parts of a filename (after the first), read from the normalised name. */
export const executableNameParts = (filename) => normaliseFilename(filename).parts.filter((p) => EXECUTABLE_NAME_PARTS.has(p));

/** False when the declared content type, or the filename extension, names another type than the bytes. */
export function matchesDeclared({ contentType = null, filename = null } = {}, sniffedType) {
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!GENERIC.has(ct)) {
    const claim = CT_ALIAS[ct] || ct;
    const ok = claim === sniffedType || (COMPAT[claim] || []).includes(sniffedType);
    if (!ok) return false;
  }
  const nf = normaliseFilename(filename);   // idempotent: a name that is already normalised comes back the same
  const ext = nf.extension;
  if (ext && EXT[ext] && !EXT[ext].includes(sniffedType)) return false;
  for (const part of nf.parts) if (EXECUTABLE_NAME_PARTS.has(part) && !(EXT[part] || []).includes(sniffedType)) return false;
  return true;
}
