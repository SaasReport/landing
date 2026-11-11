/**
 * Filename normalisation, done ONCE: every rule that looks at a name (extension checks, double extensions, the stored record,
 * the download name) reads the result of normaliseFilename, never the raw input. The original name is metadata only: it is never
 * part of a storage key and is never put in a Content-Disposition header unescaped (serve.js). What comes out is a plain name that
 * cannot climb a path, hide behind a right-to-left override or a zero-width character, name an NTFS alternate data stream, or
 * collide with a reserved device name.
 *
 *   normaliseFilename(name, { maxLength = 120 }) → { name, full, extension, parts, changed, reasons }
 *     name       the display name, at most maxLength characters (the extension kept)
 *     full       the whole normalised name (the input is clipped to its last MAX_INPUT characters first): what the record stores and every rule reads
 *     parts      EVERY dot-separated part of `full` after the first, lower case, each trimmed of Unicode white space (a.png.php → ["png", "php"])
 *     extension  the last part when it is a plain extension (letters and digits, at most 10), else null
 *
 * No regular expressions: character loops only (a regex on a long run of ". " was quadratic).
 */
import { isAlpha, isDigit } from "./lex.js";
import { tick } from "./work.js";

export const MAX_INPUT = 1024;
const RESERVED = new Set(["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"]);
/** A Windows device name: con prn aux nul conin$ conout$ clock$, com0-9, lpt0-9 (the superscript digits are digits after NFKC). */
export function isDeviceName(part) {
  const l = part.toLowerCase();
  return RESERVED.has(l) || ((l.startsWith("com") || l.startsWith("lpt")) && l.length === 4 && isDigit(l.charCodeAt(3)));
}

/** Unicode White_Space, the whole property. */
export const isWhiteSpace = (c) => (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
/** Unicode Default_Ignorable_Code_Point, the whole property: characters a renderer or a filesystem layer may drop, so a name must not depend on them. */
export const isDefaultIgnorable = (c) => c === 0xad || c === 0x34f || c === 0x61c || (c >= 0x115f && c <= 0x1160) || (c >= 0x17b4 && c <= 0x17b5) || (c >= 0x180b && c <= 0x180f) || (c >= 0x200b && c <= 0x200f)
  || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0x3164 || (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff || c === 0xffa0 || (c >= 0x1bca0 && c <= 0x1bca3) || (c >= 0x1d173 && c <= 0x1d17a) || (c >= 0xe0000 && c <= 0xe0fff);
const isBidi = (c) => c === 0x61c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const isInvisible = (c) => isDefaultIgnorable(c) || c === 0x2028 || c === 0x2029;
const isControl = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f);
const isUnsafe = (c) => c === 60 || c === 62 || c === 58 || c === 34 || c === 124 || c === 63 || c === 42 || c === 92 || c === 47;

/** s without the characters that satisfy pred; second value: whether any were removed. */
function strip(s, pred) {
  tick(s.length);
  let out = "", removed = false;
  for (const ch of s) { if (pred(ch.codePointAt(0))) removed = true; else out += ch; }   // by code point: the ignorable tag characters are outside the BMP
  return removed ? out : s;
}

/** The collapse, trim and split steps shared by the whole name and its stream-less form. → { base, ext, full } */
function shape(s, note) {
  tick(3 * s.length);   // the collapse, dot and trim passes below each read the whole name once
  let spaced = "", prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const space = isWhiteSpace(s.charCodeAt(i));
    if (space) { if (!prevSpace) spaced += " "; prevSpace = true; } else { spaced += s[i]; prevSpace = false; }
  }
  s = spaced;
  // dots: runs collapse to one, leading and trailing dots go
  let dotted = "", prevDot = false;
  for (let i = 0; i < s.length; i++) { const dot = s.charCodeAt(i) === 46; if (!(dot && prevDot)) dotted += s[i]; prevDot = dot; }
  if (dotted !== spaced) note("dots_collapsed");
  // every dot-separated part is trimmed of white space on its own ("php " and " php" are php) and a part that is a device name is made harmless
  const segs = [];
  for (const raw of dotted.split(".")) {
    let a = 0, z = raw.length;
    while (a < z && isWhiteSpace(raw.charCodeAt(a))) a++;
    while (z > a && isWhiteSpace(raw.charCodeAt(z - 1))) z--;
    let seg = raw.slice(a, z);
    if (seg === "") continue;
    if (isDeviceName(seg)) { seg = `_${seg}`; note("reserved_name"); }
    segs.push(seg);
  }
  s = segs.join(".");
  if (s !== dotted) note("parts_trimmed");
  let ext = "", base = s;
  const dot = s.lastIndexOf(".");
  if (dot > 0 && dot < s.length - 1) { base = s.slice(0, dot); ext = s.slice(dot + 1); if (ext !== ext.toLowerCase()) note("extension_lowercased"); ext = ext.toLowerCase(); }
  return { base, ext, full: ext ? `${base}.${ext}` : base };
}
const partsOf = (full) => full.split(".").slice(1).map((p) => p.toLowerCase());
function plainExtension(parts) {
  const last = parts.at(-1) ?? "";
  if (last.length < 1 || last.length > 10) return null;
  for (let i = 0; i < last.length; i++) { const c = last.charCodeAt(i); if (!(isAlpha(c) || isDigit(c))) return null; }
  return last;
}

export function normaliseFilename(input, { maxLength = 120 } = {}) {
  const reasons = [];
  const note = (r) => { if (!reasons.includes(r)) reasons.push(r); };
  let s = String(input ?? "");
  const original = s;
  if (s.length > MAX_INPUT) { s = s.slice(-MAX_INPUT); note("input_clipped"); }
  const edit = (t, reason) => { if (t !== s) { s = t; note(reason); } };
  edit(s.normalize("NFKC"), "unicode_normalised");   // fullwidth dots and letters become the ASCII ones the filesystem sees
  edit(strip(s, isBidi), "bidi_controls_removed");
  edit(strip(s, isInvisible), "invisible_removed");
  edit(strip(s, isControl), "control_removed");
  // a path is never a name: keep what follows the last separator (either kind), and drop a "C:" drive prefix
  const sep = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (sep >= 0) { s = s.slice(sep + 1); note("path_removed"); }
  if (s.length > 2 && isAlpha(s.charCodeAt(0)) && s[1] === ":") s = s.slice(2);
  // an NTFS alternate data stream is not part of the name Windows opens: "a.php::$DATA" is a.php. The name is kept whole too
  // (":" becomes "_"), and the rules read the parts of both forms.
  tick(3 * s.length);   // the normalisation, the separator search and the unsafe-character pass
  const colon = s.indexOf(":");
  const streamless = colon >= 0 ? s.slice(0, colon) : null;
  let whole = "";
  for (let i = 0; i < s.length; i++) whole += isUnsafe(s.charCodeAt(i)) ? "_" : s[i];
  if (whole !== s) note("unsafe_characters_replaced");
  const main = shape(whole, note);
  let { base, ext } = main;
  const parts = partsOf(main.full);
  let extension = plainExtension(parts);
  if (streamless !== null) {
    note("stream_suffix_seen");
    const bare = shape(streamless, () => {});
    for (const p of partsOf(bare.full)) if (!parts.includes(p)) parts.push(p);
    extension ??= plainExtension(partsOf(bare.full));
  }
  if (!base) { base = "file"; note("empty_name"); }
  const full = ext ? `${base}.${ext}` : base;
  const room = Math.max(1, maxLength - (ext ? ext.length + 1 : 0));
  let shown = base;
  if ([...base].length > room) { shown = [...base].slice(0, room).join(""); note("truncated"); }
  const name = ext ? `${shown}.${ext}` : shown;
  return { name, full, extension, parts, changed: name !== original, reasons };
}
