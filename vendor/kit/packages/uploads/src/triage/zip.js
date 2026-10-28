/**
 * ZIP and OOXML triage: the central directory, every entry verified by a size-capped inflate, nested archives (never opened:
 * depth 0), path traversal, symlinks, encrypted and duplicate entries, a directory that disagrees with the local headers, and
 * for Office Open XML the macro, ActiveX, embedded-object, external-link and DDE markers.
 *
 *   triageZip(bytes, limits, { ooxml })  → triage result (collector.finish())
 *
 * Declared sizes are never trusted: each deflated entry is inflated with a cap of its declared size + 1 byte and the total
 * output is capped at max_uncompressed_bytes, so a bomb whose header lies is still stopped (and reported as size_lie).
 */
import { readZip, entryBytes } from "../zip.js";
import { sniff } from "../sniff.js";
import { collector } from "./collector.js";
import { parseXml } from "../xml.js";
import { isAlpha, isDigit, isSpace, isWord, indexOfCI, runWhile } from "../lex.js";
import { tick } from "../work.js";

export const EXECUTABLE_EXT = new Set(["exe", "dll", "scr", "sys", "com", "bat", "cmd", "ps1", "ps2", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc", "hta", "lnk", "msi", "msp", "jar", "iso", "img", "dmg", "apk", "cpl", "reg", "sh",
  "pif", "url", "chm", "iqy", "slk", "scf", "gadget", "appref-ms", "settingcontent-ms", "library-ms", "xll", "jnlp", "msix", "appx", "msixbundle", "appxbundle", "inf", "mht", "mhtml", "ocx"]);   // shortcuts, help files, web queries, symbolic-link sheets and shell objects run or fetch on open
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz", "cab", "war", "ear"]);
const HEAD = 600;

/** The marker names this module raises (every one has a fixture in the tests). */
export const ZIP_MARKERS = Object.freeze({
  zip_unreadable: "needs_sandbox", too_many_entries: "block", zip_prefix_data: "block", unsafe_path: "block", symlink_entry: "block", encrypted_entry: "block",
  duplicate_entry: "block", local_header_mismatch: "block", unsupported_compression: "needs_sandbox", size_lie: "block", high_ratio: "block", total_size_limit: "block",
  nested_archive: "block", executable_in_archive: "block", script_in_archive: "block", executable_extension: "block", directory_problem: "needs_sandbox",
});
export const OOXML_MARKERS = Object.freeze({
  macro_enabled_content_type: "block", vba_project: "block", activex_control: "block", embedded_object: "block", external_link: "needs_sandbox", dde_link: "block",
  dde_field: "block", dde_formula: "block", program_action: "block", network_path_target: "block", unsafe_hyperlink: "block", html_part: "block", malformed_markup: "needs_sandbox", xlm_macro_sheet: "block", external_relationship: "block", external_hyperlink: "info", alt_chunk: "needs_sandbox",
  missing_content_types: "block", part_too_large: "needs_sandbox",
});

const isDotSpace = (sg) => { if (sg.length < 2) return false; for (let i = 0; i < sg.length; i++) { const c = sg.charCodeAt(i); if (c !== 46 && c !== 32) return false; } return true; };
/** Names no extractor may be given: absolute, drive-lettered, backslashed, NUL, ".." and "..." / ".. " segments (Windows drops trailing dots and spaces). */
export function unsafePath(n) {
  if (n.startsWith("/") || n.startsWith("\\") || n.includes("\\") || n.includes("\0")) return true;
  if (n.length >= 2 && isAlpha(n.charCodeAt(0)) && n[1] === ":") return true;
  for (const sg of n.split("/")) if (sg === ".." || isDotSpace(sg)) return true;
  return false;
}
/**
 * The name Windows (and most extractors) will really use: only the last path segment counts; an NTFS alternate data stream
 * suffix (":stream", "::$DATA") is not part of the file name; trailing dots, spaces and invisible characters are dropped.
 */
const isJunk = (c) => c <= 32 || (c >= 0x7f && c <= 0xa0) || c === 0xad || c === 0x61c || c === 0x180e || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 46;
export function effectiveName(n) {
  let seg = n.slice(Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")) + 1);
  const colon = seg.indexOf(":");
  if (colon >= 0) seg = seg.slice(0, colon);
  let end = seg.length;
  while (end > 0 && isJunk(seg.charCodeAt(end - 1))) end--;
  return seg.slice(0, end);
}
const isXmlish = (name) => { const l = name.toLowerCase(); return l.endsWith(".xml") || l.endsWith(".rels") || l.endsWith(".vml"); };
const ext = (n) => {
  const name = effectiveName(n), dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  const e = name.slice(dot + 1);
  for (let i = 0; i < e.length; i++) { const c = e.charCodeAt(i); if (!(isAlpha(c) || isDigit(c) || c === 45)) return ""; }
  return e.toLowerCase();
};

/* Part names, matched as path segments. */
const segs = (name) => name.toLowerCase().split("/");
const inDir = (name, dir) => segs(name).slice(0, -1).includes(dir);
const lastIs = (name, file) => segs(name).at(-1) === file;
const digitsAfter = (s, prefix) => s.startsWith(prefix) && runWhile(s, prefix.length, isDigit) === s.length;
/** The parts the OOXML rules read in full (case sensitive, as the format is). */
function wantFullPart(name) {
  if (name === "[Content_Types].xml" || name.endsWith(".rels")) return true;
  const parts = name.split("/");
  if (parts.length === 2 && parts[0] === "word" && parts[1].endsWith(".xml")) { const b = parts[1].slice(0, -4); return b === "document" || b === "footnotes" || b === "endnotes" || digitsAfter(b, "header") || digitsAfter(b, "footer"); }
  if (parts.length === 3 && parts[0] === "xl" && parts[1] === "worksheets") return parts[2].endsWith(".xml") && digitsAfter(parts[2].slice(0, -4), "sheet") && parts[2].length > 9;
  if (parts.length === 3 && parts[0] === "xl" && parts[1] === "externalLinks") return parts[2].endsWith(".xml") && parts[2].length > 4;
  if (parts.length === 3 && parts[0] === "ppt" && ["slides", "slideLayouts", "slideMasters", "notesSlides"].includes(parts[1])) return parts[2].endsWith(".xml") && parts[2].length > 4;
  return false;
}
/**
 * An HTML (or MHTML) part inside an Office package has no legitimate use, and HTML is not XML: no XML rule may judge it and an HTML5
 * tokenizer is not worth carrying for a part nobody needs. Any such part is a block, whatever it contains.
 */
const HTML_PART = (name) => { const l = name.toLowerCase(); return l.endsWith(".html") || l.endsWith(".htm") || l.endsWith(".xhtml") || l.endsWith(".mht") || l.endsWith(".mhtml"); };

/** The URL schemes a hyperlink of an Office document may carry without being a finding: web, mail and phone. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
/** "file", "ms-msdt", "search-ms", "javascript" … the scheme of a target (letters, digits, + - .), or "" for a relative reference. A "\\" or "//" start is a network path. */
function schemeOf(target) {
  const t = target.trim();
  if (t.startsWith("\\") || t.startsWith("//")) return "//";
  const colon = t.indexOf(":");
  if (colon <= 0) return "";
  for (let i = 0; i < colon; i++) { const c = t.charCodeAt(i); if (!(isAlpha(c) || isDigit(c) || c === 43 || c === 45 || c === 46)) return ""; }
  return t.slice(0, colon).toLowerCase();
}
const isNetworkPath = (t) => schemeOf(t) === "//" || schemeOf(t) === "file";

/** A DDE formula in a spreadsheet cell: "app|topic!item": a "|" after a name character with a "!" later. One pass. */
export function ddeFormula(content) {
  const bang = content.lastIndexOf("!");
  tick(content.length);
  if (bang < 0) return false;
  for (let p = content.indexOf("|"); p >= 0 && p < bang; p = content.indexOf("|", p + 1)) {
    tick();
    const prev = p > 0 ? content.charCodeAt(p - 1) : 0;
    if (isWord(prev) || prev === 46) return true;
  }
  return false;
}
/** Does the field instruction name DDE or DDEAUTO as a word? */
function ddeField(instr) {
  for (const word of ["ddeauto", "dde"]) {
    for (let at = indexOfCI(instr, word); at >= 0; at = indexOfCI(instr, word, at + 1)) {
      if (!(at > 0 && isWord(instr.charCodeAt(at - 1))) && !(at + word.length < instr.length && isWord(instr.charCodeAt(at + word.length)))) return true;
    }
  }
  return false;
}
const lastSeg = (t) => String(t || "").split("/").pop().toLowerCase();

function ooxmlParts(c, entries, parts) {
  const names = entries.map((e) => e.name);
  if (!names.includes("[Content_Types].xml")) c.add("missing_content_types", "block", "active_content_found");
  for (const n of names) {
    tick(n.length);
    if (lastIs(n, "vbaproject.bin") || lastIs(n, "vbadata.xml") || inDir(n, "macros")) c.add("vba_project", "block", "active_content_found", n);
    else if (HTML_PART(n)) c.add("html_part", "block", "active_content_found", n);
    else if (inDir(n, "activex")) c.add("activex_control", "block", "active_content_found", n);
    else if (inDir(n, "embeddings") || oleObjectBin(n)) c.add("embedded_object", "block", "active_content_found", n);
    else if (n.toLowerCase().startsWith("xl/externallinks/") && !n.endsWith(".rels")) c.add("external_link", "needs_sandbox", "needs_sandbox_review", n);
    else if (n.toLowerCase().startsWith("xl/macrosheets/")) c.add("xlm_macro_sheet", "block", "active_content_found", n);
  }
  const order = [...parts.keys()].sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : 0));
  for (const name of order) {
    if (c.blocked && name !== "[Content_Types].xml") break;   // a block is already the verdict: the remaining parts are not worth the CPU
    const { events, problems } = parseXml(parts.get(name));
    if (name === "[Content_Types].xml") contentTypes(c, name, events);
    else if (name.endsWith(".rels")) relationships(c, name, events);
    else officePart(c, name, events);
    if (problems.length) { c.add("malformed_markup", "needs_sandbox", "could_not_check", name); c.incomplete(`part ${name}: ${problems[0]}`); }
  }
}
const oleObjectBin = (n) => { const l = n.toLowerCase(); if (!l.endsWith(".bin")) return false; let e = l.length - 4; while (e > 0 && isDigit(l.charCodeAt(e - 1))) e--; return l.slice(0, e).endsWith("oleobject"); };

function contentTypes(c, name, events) {
  for (const e of events) {
    if (e.t !== "start") continue;
    for (const a of e.attrs) { const v = a.value.toLowerCase(); if (v.includes("macroenabled") || v.includes("vbaproject")) c.add("macro_enabled_content_type", "block", "active_content_found", name); }
  }
}

function relationships(c, name, events) {
  for (const e of events) {
    if (e.t !== "start" || e.name.local !== "relationship") continue;
    const a = {};
    for (const x of e.attrs) a[x.local] = x.value;
    const type = lastSeg(a.type), target = a.target || "";
    if ((a.targetmode || "").trim().toLowerCase() === "external") {
      if (type === "hyperlink") {
        if (SAFE_SCHEMES.has(schemeOf(target)) || (schemeOf(target) === "" && !target.trim().startsWith("\\"))) c.add("external_hyperlink", "info", "none", name);
        else c.add("unsafe_hyperlink", "block", "active_content_found", `${name}: ${schemeOf(target) || "path"}`);
      } else c.add("external_relationship", "block", "active_content_found", `${name}: ${type || "unknown"}`);
    } else if (isNetworkPath(target)) c.add("network_path_target", "block", "active_content_found", name);
    else if (type === "afchunk") c.add("alt_chunk", "needs_sandbox", "needs_sandbox_review", name);
  }
}

/** Word, Excel and PowerPoint parts: DDE links, fields and formulas, program-launching actions. Text collected in one pass. */
function officePart(c, name, events) {
  let instrDepth = 0, instr = "", fDepth = 0, formula = "";
  for (const e of events) {
    if (e.t === "text") { if (instrDepth > 0) instr += e.value; if (fDepth > 0) formula += e.value; continue; }
    if (e.t === "end") {
      const l = e.name.local;
      if (l === "instrtext" && instrDepth > 0) instrDepth--;
      if (l === "f" && fDepth > 0 && --fDepth === 0) { if (ddeFormula(formula)) c.add("dde_formula", "block", "active_content_found", name); formula = ""; }
      continue;
    }
    if (e.t !== "start") continue;
    const l = e.name.local;
    if (l === "ddelink" || l === "olelink") c.add("dde_link", "block", "active_content_found", name);
    if (l === "instrtext" && !e.selfClosing) instrDepth++;
    if (l === "f" && !e.selfClosing) fDepth++;
    for (const a of e.attrs) {
      if (a.local === "instr") instr += ` ${a.value}`;
      const v = a.value.toLowerCase();
      if (v.includes("ppaction://program") || v.includes("ppaction://macro")) c.add("program_action", "block", "active_content_found", name);
    }
  }
  if (fDepth > 0 && ddeFormula(formula)) c.add("dde_formula", "block", "active_content_found", name);
  if (ddeField(instr)) c.add("dde_field", "block", "active_content_found", name);
}

export async function triageZip(bytes, limits, { ooxml = false } = {}) {
  const c = collector();
  const z = readZip(bytes, { maxEntries: limits.max_zip_entries });
  if (!z.ok) { c.add("zip_unreadable", "needs_sandbox", "could_not_check"); c.incomplete(z.problems[0] || "zip unreadable"); return c.finish(); }
  if (z.overLimit) { c.add("too_many_entries", "block", "archive_bomb"); return c.finish(); }
  for (const p of z.problems) { c.add("directory_problem", "needs_sandbox", "could_not_check", p); c.incomplete(p); }
  if (z.prefixBytes > 0) c.add("zip_prefix_data", "block", "polyglot_suspect");

  const seen = new Set();
  let declaredTotal = 0;
  for (const e of z.entries) {
    tick(e.name.length);
    declaredTotal += e.size;
    const key = (e.name.slice(0, e.name.lastIndexOf("/") + 1) + effectiveName(e.name)).toLowerCase();   // a.txt, a.txt. and a.txt::$DATA are one file on Windows
    if (seen.has(key)) c.add("duplicate_entry", "block", "archive_not_allowed", e.name); else seen.add(key);
    if (unsafePath(e.name)) c.add("unsafe_path", "block", "archive_not_allowed", e.name);
    if (e.symlink) c.add("symlink_entry", "block", "archive_not_allowed", e.name);
    if (e.encrypted) c.add("encrypted_entry", "block", "archive_not_allowed", e.name);
    if (e.localMismatch) c.add("local_header_mismatch", "block", "archive_not_allowed", e.name);
    if (e.method !== 0 && e.method !== 8 && !e.dir) { c.add("unsupported_compression", "needs_sandbox", "could_not_check", e.name); c.incomplete(`compression method ${e.method}`); }
    if (!e.dir && e.compSize > 0 && e.size > e.compSize * 1032 + 64) c.add("size_lie", "block", "archive_bomb", e.name);
    if (!e.dir && e.size > limits.min_ratio_bytes && e.compSize > 0 && e.size / e.compSize > limits.max_ratio) c.add("high_ratio", "block", "archive_bomb", e.name);
    if (!e.dir && EXECUTABLE_EXT.has(ext(e.name))) c.add("executable_extension", "block", "active_content_found", e.name);
    else if (!e.dir && ARCHIVE_EXT.has(ext(e.name))) c.add("nested_archive", "block", "archive_not_allowed", e.name);
  }
  if (declaredTotal > limits.max_uncompressed_bytes) { c.add("total_size_limit", "block", "archive_bomb"); return c.finish(); }
  if (declaredTotal > limits.min_ratio_bytes && bytes.length > 0 && declaredTotal / bytes.length > limits.max_ratio) c.add("high_ratio", "block", "archive_bomb", "(whole archive)");

  // verify every entry by inflating it with a cap, keep the head (nested type) and the parts the OOXML checks read
  let budget = limits.max_uncompressed_bytes, inspected = 0;
  const parts = new Map();
  for (const e of z.entries) {
    if (e.dir || e.encrypted || e.localMismatch) continue;
    const wantFull = ooxml && wantFullPart(e.name);
    if (wantFull && ++inspected > limits.max_parts_inspected) { c.incomplete("more parts than the inspection limit"); continue; }
    const cap = Math.min(e.size + 1, budget);
    const r = await entryBytes(bytes, e, wantFull ? Math.min(cap, limits.max_xml_part_bytes + 1) : cap);
    if (!r) continue;
    if (r.error && !r.bytes.length && e.size > 0) { c.add("directory_problem", "needs_sandbox", "could_not_check", e.name); c.incomplete(`entry ${e.name}: ${r.error}`); continue; }
    if (r.truncated && wantFull && e.size > limits.max_xml_part_bytes) { c.add("part_too_large", "needs_sandbox", "could_not_check", e.name); c.incomplete(`part ${e.name} over the inspection cap`); }
    else if (r.truncated || r.bytes.length > e.size) { c.add("size_lie", "block", "archive_bomb", e.name); continue; }
    budget -= r.bytes.length;
    if (budget <= 0) { c.add("total_size_limit", "block", "archive_bomb"); break; }
    const head = r.bytes.subarray(0, HEAD);
    if (head.length >= 2) {
      const s = sniff(head);
      if (s.family === "archive" || s.type === "application/zip" || (head[0] === 0x50 && head[1] === 0x4b)) c.add("nested_archive", "block", "archive_not_allowed", e.name);
      else if (s.family === "executable") c.add("executable_in_archive", "block", "active_content_found", e.name);
      else if (s.family === "script" && !(ooxml && isXmlish(e.name))) c.add("script_in_archive", "block", "active_content_found", e.name);
    }
    if (wantFull && r.bytes.length <= limits.max_xml_part_bytes) parts.set(e.name, new TextDecoder("utf-8").decode(r.bytes));
  }
  if (ooxml) ooxmlParts(c, z.entries, parts);
  return c.finish();
}
