/**
 * Native PDF triage in bounded JavaScript (Workers, Node): a tokenizer for PDF objects that
 *   - resolves #xx escapes in names before matching (/J#53 is /JS), so obfuscation does not hide a marker;
 *   - decodes /ObjStm object streams (FlateDecode, ASCIIHexDecode, ASCII85Decode, LZWDecode, RunLengthDecode, chains up to
 *     max_filter_chain) and scans what is inside, because a keyword scanner never sees objects in a compressed stream;
 *   - reports each marker with a count and the first object that carries it;
 *   - flags a header that is not at byte 0 (polyglot), a missing %%EOF (truncated), data after the last %%EOF, a start
 *     xref that points nowhere, incremental updates, unknown filters, and decoding bombs.
 * It never says safe. A limit hit or parse failure is "analysis incomplete".
 *
 *   triagePdf(bytes, limits) → { engine, engine_version, complete, markers, statement, verdict, reason_code }
 */
import { latin1, ascii, indexOfBytes, u32, hasAt } from "../bytes.js";
import { isDigit, isAlpha, isWord, isHex, isSpace, runWhile, startsWithAt } from "../lex.js";
import { inflateZlib } from "../zip.js";
import { collector } from "./collector.js";
import { tick } from "../work.js";

/** Name tokens that matter and what each means for the verdict. Every entry has a fixture in the tests. */
export const PDF_MARKERS = Object.freeze({
  JavaScript: { severity: "block" }, JS: { severity: "block" }, Launch: { severity: "block" }, EmbeddedFile: { severity: "block" },
  EF: { severity: "block" }, EmbeddedFiles: { severity: "block" }, FileAttachment: { severity: "block" },   // /Type /EmbeddedFile is optional: the /EF dictionary, the /EmbeddedFiles name tree and a /FileAttachment annotation carry a file without it
  RichMedia: { severity: "block" }, XFA: { severity: "block" }, Encrypt: { severity: "block" }, "3D": { severity: "block" }, GoToE: { severity: "block" },
  AA: { severity: "needs_sandbox" }, OpenAction: { severity: "needs_sandbox" }, URI: { severity: "needs_sandbox" }, SubmitForm: { severity: "needs_sandbox" },
  ImportData: { severity: "needs_sandbox" }, GoToR: { severity: "needs_sandbox" }, AcroForm: { severity: "needs_sandbox" }, Filespec: { severity: "needs_sandbox" },
  Movie: { severity: "needs_sandbox" }, Sound: { severity: "needs_sandbox" }, Rendition: { severity: "needs_sandbox" },
  ObjStm: { severity: "info" },
});

/** Structural markers the triage raises itself (name → severity). Also covered by tests. */
export const PDF_STRUCTURAL = Object.freeze({
  pdf_header_offset: "block", polyglot_data: "block", decompression_bomb: "block",
  trailing_data: "needs_sandbox", incremental_updates: "needs_sandbox", malformed_xref: "needs_sandbox", unknown_filter: "needs_sandbox", filter_chain_too_deep: "needs_sandbox",
  truncated: "needs_sandbox", unterminated_object: "needs_sandbox", unterminated_stream: "needs_sandbox", object_limit: "needs_sandbox", nesting_too_deep: "needs_sandbox", objstm_undecodable: "needs_sandbox",
});

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const ws = (c) => WS.has(c) || isSpace(c);
const skipWsRun = (s, i) => runWhile(s, i, ws);
const notAlnum = (s, i) => i >= s.length || !(isAlpha(s.charCodeAt(i)) || isDigit(s.charCodeAt(i)));
/** "<digits> <digits> obj" at i → { num, end } or null (one to ten digits, one to five digits, whitespace between, no letter or digit after "obj"). */
function objAt(s, i) {
  const a = runWhile(s, i, isDigit);
  if (a === i || a - i > 10) return null;
  const b0 = skipWsRun(s, a);
  if (b0 === a) return null;
  const b = runWhile(s, b0, isDigit);
  if (b === b0 || b - b0 > 5) return null;
  const k = skipWsRun(s, b);
  if (k === b || !s.startsWith("obj", k) || !notAlnum(s, k + 3)) return null;
  return { num: s.slice(i, a), end: k + 3 };
}
/** "<digits> <digits> R" at i → { num, end } or null. */
function refAt(s, i) {
  const a = runWhile(s, i, isDigit);
  if (a === i || a - i > 10) return null;
  const b0 = skipWsRun(s, a);
  if (b0 === a) return null;
  const b = runWhile(s, b0, isDigit);
  if (b === b0 || b - b0 > 5) return null;
  const k = skipWsRun(s, b);
  if (k === b || s[k] !== "R" || !notAlnum(s, k + 1)) return null;
  return { num: Number(s.slice(i, a)), end: k + 1 };
}
/** A number at i: [+-]? (digits [. digits] | . digits) → end index or -1. */
function numEnd(s, i) {
  let j = i;
  if (s[j] === "+" || s[j] === "-") j++;
  const d = runWhile(s, j, isDigit);
  if (d > j) { j = d; if (s[j] === ".") j = runWhile(s, j + 1, isDigit); return j; }
  if (s[j] === ".") { const f = runWhile(s, j + 1, isDigit); return f > j + 1 ? f : -1; }
  return -1;
}
const isKwChar = (c) => isAlpha(c) || isDigit(c) || c === 95 || c === 42 || c === 39 || c === 34;
const TRAILING_SCRIPT = ["<script", "<html", "<?php"];
/** indexOf that counts the characters it passes over (the work counter, work.js). */
const seek = (s, needle, from = 0) => { const at = s.indexOf(needle, from); tick((at < 0 ? s.length : at) - from + 1); return at; };

/** Is there markup or script in the data after the last %%EOF ("<" then spaces then script or html, or <?php)? */
function trailingScript(t) {
  const lower = t.toLowerCase();
  tick(lower.length);
  for (let i = seek(lower, "<"); i >= 0; i = seek(lower, "<", i + 1)) {
    const j = runWhile(lower, i + 1, isSpace);
    for (const name of ["script", "html"]) if (lower.startsWith(name, j) && !isWord(lower.charCodeAt(j + name.length) || 0)) return true;
    if (lower.startsWith("?php", i + 1)) return true;
  }
  return false;
}
const MAX_DEPTH = 48;
const FILTER_ABBREV = { Fl: "FlateDecode", AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", RL: "RunLengthDecode" };

/** A tolerant PDF tokenizer: values are { t: "name"|"num"|"str"|"dict"|"array"|"ref"|"kw", v }; garbage is skipped, never thrown. */
function reader(s, onName) {
  let i = 0, depth = 0, deep = false;
  const api = {
    get i() { return i; }, set i(v) { i = v; }, get deep() { return deep; }, s,
    skipWs() {
      for (;;) {
        const c = s.charCodeAt(i);
        if (WS.has(c)) i++;
        else if (c === 37) { while (i < s.length && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; }
        else break;
      }
    },
    name() {
      i++; // "/"
      let out = "";
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (WS.has(c) || DELIM.has(c)) break;
        if (c === 35 && i + 2 < s.length + 0 && isHex(s.charCodeAt(i + 1)) && isHex(s.charCodeAt(i + 2))) { out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16)); i += 3; }
        else { out += s[i]; i++; }
      }
      onName?.(out);
      return out;
    },
    value() {
      api.skipWs();
      if (i >= s.length) return undefined;
      const c = s.charCodeAt(i);
      if (c === 47) return { t: "name", v: api.name() };
      if (c === 40) { // literal string with balanced parentheses and backslash escapes
        let n = 0;
        while (i < s.length) { const d = s.charCodeAt(i); if (d === 92) i++; else if (d === 40) n++; else if (d === 41 && --n === 0) { i++; break; } i++; }
        return { t: "str" };
      }
      if (c === 60 && s.charCodeAt(i + 1) === 60) {
        i += 2;
        if (++depth > MAX_DEPTH) { deep = true; depth--; return { t: "dict", v: {} }; }
        const d = {};
        for (;;) {
          api.skipWs();
          if (i >= s.length) break;
          if (s.charCodeAt(i) === 62 && s.charCodeAt(i + 1) === 62) { i += 2; break; }
          if (s.charCodeAt(i) !== 47) { const before = i; const junk = api.value(); if (junk === undefined || i === before) i++; continue; }
          const key = api.name();
          const v = api.value();
          if (v !== undefined && !(v.t === "kw" && (v.v === "endobj" || v.v === "stream"))) d[key] = v; else if (v) { i -= v.v.length; break; }
        }
        depth--;
        return { t: "dict", v: d };
      }
      if (c === 60) { while (i < s.length && s.charCodeAt(i) !== 62) i++; i++; return { t: "str" }; }
      if (c === 91) {
        i++;
        if (++depth > MAX_DEPTH) { deep = true; depth--; return { t: "array", v: [] }; }
        const a = [];
        for (;;) {
          api.skipWs();
          if (i >= s.length) break;
          if (s.charCodeAt(i) === 93) { i++; break; }
          const before = i; const v = api.value();
          if (v === undefined || i === before) { i++; continue; }
          if (v.t === "kw" && (v.v === "endobj" || v.v === "stream" || v.v === "endstream")) { i -= v.v.length; break; }
          a.push(v);
        }
        depth--;
        return { t: "array", v: a };
      }
      if (c === 62 || c === 93 || c === 41 || c === 123 || c === 125) { i++; return undefined; }
      if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
        const r = refAt(s, i);
        if (r) { i = r.end; return { t: "ref", v: r.num }; }
        const ne = numEnd(s, i);
        if (ne > i) { const v = Number(s.slice(i, ne)); i = ne; return { t: "num", v }; }
        i++;
        return undefined;
      }
      if (isAlpha(c)) { const e = runWhile(s, i, isKwChar); const v = s.slice(i, e); i = e; return { t: "kw", v }; }
      i++;
      return undefined;
    },
  };
  return api;
}

const filtersOf = (dict) => {
  const f = dict.Filter;
  if (!f) return [];
  const list = f.t === "array" ? f.v : [f];
  return list.filter((x) => x?.t === "name").map((x) => FILTER_ABBREV[x.v] || x.v);
};

function ascii85(s, max) {
  const out = []; let tuple = [], n = 0;
  tick(s.length);
  { const open = s.indexOf("<~"); if (open >= 0 && runWhile(s, 0, ws) === open) s = s.slice(open + 2); const close = s.indexOf("~>"); if (close >= 0) s = s.slice(0, close); }   // the optional <~ prefix and the ~> end marker
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (WS.has(c)) continue;
    if (ch === "z" && tuple.length === 0) { out.push(0, 0, 0, 0); n += 4; }
    else if (c >= 33 && c <= 117) {
      tuple.push(c - 33);
      if (tuple.length === 5) { let v = 0; for (const d of tuple) v = v * 85 + d; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); tuple = []; n += 4; }
    } else return { bytes: Uint8Array.from(out), error: "bad ASCII85" };
    if (n > max) return { bytes: Uint8Array.from(out.slice(0, max)), truncated: true };
  }
  if (tuple.length > 1) { const k = tuple.length; while (tuple.length < 5) tuple.push(84); let v = 0; for (const d of tuple) v = v * 85 + d; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, k - 1)); }
  return { bytes: Uint8Array.from(out) };
}
function asciiHex(s) {
  tick(s.length);
  const gt = s.indexOf(">");
  let h = "";
  for (let i = 0; i < (gt < 0 ? s.length : gt); i++) { const c = s.charCodeAt(i); if (!ws(c)) { if (!isHex(c)) return { bytes: new Uint8Array(0), error: "bad ASCIIHex" }; h += s[i]; } }
  const b = new Uint8Array(Math.ceil(h.length / 2));
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2).padEnd(2, "0"), 16);
  return { bytes: b };
}
function runLength(b, max) {
  const out = [];
  for (let i = 0; i < b.length && out.length <= max;) {
    const l = b[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k <= l && i < b.length; k++) out.push(b[i++]); }
    else { const v = b[i++]; for (let k = 0; k < 257 - l; k++) out.push(v); }
  }
  return out.length > max ? { bytes: Uint8Array.from(out.slice(0, max)), truncated: true } : { bytes: Uint8Array.from(out) };
}
function lzw(b, max, early = 1) {
  const out = []; let bits = 0, acc = 0, width = 9, dict = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); width = 9; };
  reset(); let prev = null;
  for (let i = 0; i < b.length; i++) {
    acc = (acc << 8) | b[i]; bits += 8;
    while (bits >= width) {
      const code = (acc >> (bits - width)) & ((1 << width) - 1); bits -= width; acc &= (1 << bits) - 1;
      if (code === 256) { reset(); prev = null; continue; }
      if (code === 257) return { bytes: Uint8Array.from(out) };
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev && code === dict.length) entry = [...prev, prev[0]];
      else return { bytes: Uint8Array.from(out), error: "bad LZW" };
      for (const x of entry) out.push(x);
      if (out.length > max) return { bytes: Uint8Array.from(out.slice(0, max)), truncated: true };
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= (1 << width) && width < 12) width++;
    }
  }
  return { bytes: Uint8Array.from(out) };
}

/** Decode a stream through its filter chain: { bytes, unknown, truncated, error }. */
async function decodeStream(raw, filters, maxOut) {
  let cur = raw;
  for (const f of filters) {
    let r;
    if (f === "FlateDecode") r = await inflateZlib(cur, maxOut);
    else if (f === "ASCIIHexDecode") r = asciiHex(latin1(cur));
    else if (f === "ASCII85Decode") r = ascii85(latin1(cur), maxOut);
    else if (f === "RunLengthDecode") r = runLength(cur, maxOut);
    else if (f === "LZWDecode") r = lzw(cur, maxOut);
    else return { bytes: cur, unknown: f };
    if (r.truncated) return { bytes: r.bytes, truncated: true };
    if (r.error && !r.bytes.length) return { bytes: r.bytes, error: r.error };
    cur = r.bytes;
  }
  return { bytes: cur };
}

const PE_SIG = ascii("PE\0\0"), THIS_PROGRAM = ascii("This program"), PK_LOCAL = ascii("PK\x03\x04"), PK_END = ascii("PK\x05\x06"), ELF = ascii("\x7fELF"), MZ = ascii("MZ");
const MAX_MZ_CANDIDATES = 2000;

/**
 * A second file's signature anywhere in the bytes: a zip local header or end record, an ELF header, a PE (MZ with a PE header at
 * e_lfanew, or the DOS stub text). Returns what was found or null. Random stream data hits a 4-byte signature about once in 4 GB
 * and an "MZ" that is not a PE is ignored, so a real PDF does not trip this.
 */
function embeddedSignature(bytes, c) {
  if (indexOfBytes(bytes, PK_LOCAL) >= 0) return "zip local header";
  if (indexOfBytes(bytes, PK_END) >= 0) return "zip end record";
  if (indexOfBytes(bytes, ELF) >= 0) return "ELF header";
  let seen = 0;
  for (let i = indexOfBytes(bytes, MZ); i >= 0; i = indexOfBytes(bytes, MZ, i + 2)) {
    if (++seen > MAX_MZ_CANDIDATES) { c.incomplete("too many MZ candidates"); break; }
    const pe = i + 0x3c + 4 <= bytes.length ? u32(bytes, i + 0x3c) : 0;
    if ((pe > 0 && hasAt(bytes, PE_SIG, i + pe)) || indexOfBytes(bytes, THIS_PROGRAM, i, Math.min(bytes.length, i + 256)) >= 0) return "PE header";
  }
  return null;
}

/** /Linearized in the first 2048 bytes with an /L that equals the length of the file (from the header): the file's own claim, and true. */
function linearization(text, length) {
  const head = text.slice(0, 2048);
  if (!head.includes("/Linearized")) return false;
  for (let at = seek(head, "/L"); at >= 0; at = seek(head, "/L", at + 2)) {
    const j = at + 2;
    if (!ws(head.charCodeAt(j))) continue;   // /Linearized, /Length … are other names
    const k = skipWsRun(head, j), e = runWhile(head, k, isDigit);
    if (e > k && e - k <= 12 && Number(head.slice(k, e)) === length) return true;
  }
  return false;
}

/** The offset after the last "startxref <digits>", or null. */
function lastStartxref(text) {
  let found = null;
  for (let at = seek(text, "startxref"); at >= 0; at = seek(text, "startxref", at + 9)) {
    const j = skipWsRun(text, at + 9);
    if (j === at + 9) continue;
    const e = runWhile(text, j, isDigit);
    if (e > j && e - j <= 12) found = Number(text.slice(j, e));
  }
  return found;
}

/** Does "xref" or "<n> <n> obj" start at `at` (after whitespace)? */
function xrefPointsAt(text, at) {
  const i = skipWsRun(text, at);
  if (text.startsWith("xref", i) && notWord(text, i + 4)) return true;
  const o = objAt(text, i);
  return o !== null;
}
const notWord = (s, i) => i >= s.length || !isWord(s.charCodeAt(i));

export async function triagePdf(bytes, limits) {
  const c = collector();
  const text = latin1(bytes);
  const head = indexOfBytes(bytes, ascii("%PDF-"), 0, Math.min(bytes.length, 1024));
  if (head < 0) { c.incomplete("no PDF header"); return c.finish(); }
  if (head > 0) c.add("pdf_header_offset", "block", "polyglot_suspect");

  // ---- whole-file signatures: a second file glued anywhere (before, between, after) is a polyglot, wherever the last %%EOF is
  const embedded = embeddedSignature(bytes, c);
  if (embedded) c.add("polyglot_data", "block", "polyglot_suspect", embedded);

  // ---- tail: %%EOF, data after it, incremental updates, startxref
  const eofs = [];
  for (let at = seek(text, "%%EOF"); at >= 0; at = seek(text, "%%EOF", at + 5)) eofs.push(at);
  const lin = linearization(text, bytes.length - head);
  if (!eofs.length) { c.add("truncated", "needs_sandbox", "could_not_check"); c.incomplete("no %%EOF"); }
  else {
    const last = eofs[eofs.length - 1] + 5;
    // what follows the last %%EOF, trimmed of trailing whitespace by an index loop
    let tailEnd = text.length;
    while (tailEnd > last && (WS.has(text.charCodeAt(tailEnd - 1)))) { tailEnd--; tick(); }
    const trailing = text.slice(last, tailEnd);
    // any data after %%EOF is a second file or a payload until shown otherwise
    if (trailing.length > 0) {
      c.add("trailing_data", "needs_sandbox", "needs_sandbox_review");
      if (trailingScript(trailing)) c.add("polyglot_data", "block", "polyglot_suspect");
    }
    // a linearized file legitimately has two %%EOF, and only when its /L says it is exactly this long: a bare /Linearized claim tolerates nothing
    const updates = eofs.length - 1;
    if (updates > (lin ? 1 : 0)) c.add("incremental_updates", "needs_sandbox", "needs_sandbox_review");
    else if (updates > 0) c.add("incremental_updates", "info");
  }
  const sx = lastStartxref(text);
  if (sx === null) { if (eofs.length) { c.add("malformed_xref", "needs_sandbox", "could_not_check"); c.incomplete("no startxref"); } }
  else if (!xrefPointsAt(text, head + sx)) { c.add("malformed_xref", "needs_sandbox", "could_not_check"); c.incomplete("startxref points nowhere"); }

  // ---- one pass over every object, trailer and stray token
  let currentRef = null;
  const onName = (n) => { const m = PDF_MARKERS[n]; if (m) c.add(n, m.severity, "active_content_found", currentRef); };
  const rd = reader(text, onName);
  const objStms = [];
  let objects = 0;
  const len = text.length;
  tick(len);
  const lastEndobj = text.lastIndexOf("endobj");   // one search: a per-object indexOf to the end is quadratic when objects lack their endobj
  let mark = 0;
  while (rd.i < len) {
    tick(Math.max(1, rd.i - mark)); mark = rd.i;   // the characters the tokenizer has passed since the last turn
    rd.skipWs();
    if (rd.i >= len) break;
    const m = objAt(text, rd.i);
    if (!m) {
      const before = rd.i;
      currentRef = null;
      rd.value();
      if (rd.i === before) rd.i++;
      continue;
    }
    if (++objects > limits.max_pdf_objects) { c.add("object_limit", "needs_sandbox", "could_not_check"); c.incomplete("object limit"); break; }
    currentRef = `obj ${m.num}`;
    rd.i = m.end;
    const v = rd.value();
    rd.skipWs();
    const dict = v?.t === "dict" ? v.v : null;
    if (text.startsWith("stream", rd.i) && dict) {
      let p = rd.i + 6;
      if (text.charCodeAt(p) === 13 && text.charCodeAt(p + 1) === 10) p += 2; else if (text.charCodeAt(p) === 10 || text.charCodeAt(p) === 13) p += 1;
      let end = -1;
      if (dict.Length?.t === "num" && Number.isInteger(dict.Length.v) && dict.Length.v >= 0 && text.startsWith("endstream", skipWsRun(text, p + dict.Length.v))) end = p + dict.Length.v;
      if (end < 0) { end = seek(text, "endstream", p); }
      if (end < 0) { c.add("unterminated_stream", "needs_sandbox", "could_not_check", currentRef); c.incomplete("unterminated stream"); rd.i = len; break; }
      if (dict.Type?.t === "name" && dict.Type.v === "ObjStm") objStms.push({ ref: currentRef, dict, start: p, end });
      rd.i = end + 9;
    } else if (!text.startsWith("endobj", rd.i) && v === undefined) { /* empty object */ }
    // advance past endobj when present; a missing endobj is tolerated until the next object header
    rd.skipWs();
    if (text.startsWith("endobj", rd.i)) rd.i += 6;
    else if (objAt(text, rd.i) === null && lastEndobj < rd.i && rd.i < len - 16) { c.add("unterminated_object", "needs_sandbox", "could_not_check", currentRef); c.incomplete("object without endobj"); }
  }
  if (rd.deep) { c.add("nesting_too_deep", "needs_sandbox", "could_not_check"); c.incomplete("nesting too deep"); }
  currentRef = null;

  // ---- object streams: the objects keyword scanners never see
  let decodedTotal = 0;
  for (const st of objStms) {
    const filters = filtersOf(st.dict);
    if (filters.length > limits.max_filter_chain) { c.add("filter_chain_too_deep", "needs_sandbox", "could_not_check", st.ref); c.incomplete("filter chain too deep"); continue; }
    c.add("ObjStm", "info", "none", st.ref);
    const raw = bytes.subarray(st.start, st.end);
    const room = Math.max(0, limits.max_pdf_decoded_bytes - decodedTotal);
    const dec = await decodeStream(raw, filters, room);
    if (dec.unknown) { c.add("unknown_filter", "needs_sandbox", "could_not_check", st.ref); c.incomplete(`unknown filter ${dec.unknown}`); continue; }
    if (dec.truncated) { c.add("decompression_bomb", "block", "archive_bomb", st.ref); continue; }
    if (dec.error && !dec.bytes.length) { c.add("objstm_undecodable", "needs_sandbox", "could_not_check", st.ref); c.incomplete("object stream undecodable"); continue; }
    decodedTotal += dec.bytes.length;
    if (dec.bytes.length > limits.min_ratio_bytes && raw.length > 0 && dec.bytes.length / raw.length > limits.max_ratio) { c.add("decompression_bomb", "block", "archive_bomb", st.ref); continue; }
    currentRef = `${st.ref} (ObjStm)`;
    const inner = reader(latin1(dec.bytes), onName);
    let guard = 0;
    tick(inner.s.length);
    while (inner.i < inner.s.length && guard++ < inner.s.length) { const before = inner.i; inner.value(); if (inner.i === before) inner.i++; }
    if (inner.deep) { c.add("nesting_too_deep", "needs_sandbox", "could_not_check", st.ref); c.incomplete("nesting too deep"); }
  }
  return c.finish();
}
