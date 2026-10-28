/**
 * Raster image triage: structure (PNG chunk walk to IEND, JPEG to EOI, GIF trailer, WebP RIFF length), data after the end of
 * the image (a second file glued on), pixel dimensions (decompression bombs), and metadata presence (EXIF, text chunks: a
 * re-encode is needed before an image is served inline).
 *
 *   triageImage(bytes, type, limits) → triage result
 *
 * trailing_data: intake cuts a PNG, JPEG, GIF or WebP at its container's end BEFORE triage (pipeline.js, containerEnd), so a record made by intake never
 * carries this marker; it is kept for the callers of triageImage / triage() on bytes that were not cut (a consumer's own pipeline, a test), where data
 * after the end must still be reported, never silently ignored.
 */
import { latin1, u32, u16, hasAt, ascii } from "../bytes.js";
import { collector } from "./collector.js";

export const IMAGE_MARKERS = Object.freeze({ trailing_data: "needs_sandbox", truncated: "needs_sandbox", malformed: "needs_sandbox", huge_dimensions: "needs_sandbox", decompression_bomb: "block", metadata_present: "info" });
export const MAX_PIXELS = 100_000_000;       // above: needs_sandbox
export const BOMB_PIXELS = 400_000_000;      // above: block (decompression bomb)

const be32 = (b, o) => (b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function pixels(c, w, h) {
  const px = w * h;
  if (px > BOMB_PIXELS) c.add("decompression_bomb", "block", "archive_bomb", `${w}x${h}`);
  else if (px > MAX_PIXELS) c.add("huge_dimensions", "needs_sandbox", "needs_sandbox_review", `${w}x${h}`);
}

/** The pixels summed over every frame of an animation: past BOMB_PIXELS the decoded frames alone are a bomb, whatever each frame's size. */
function totalPixels(c, total) {
  if (total > BOMB_PIXELS) c.add("decompression_bomb", "block", "archive_bomb", `${total} pixels in all frames`);
}

/**
 * The container walkers: ONE parser per format, used by the triage (markers) and by the release path (containerEnd: where the image ends).
 * They are hand-written, as the triage always was (no image library is a dependency of this package, and decoding is not wanted: only the
 * outer structure is walked, never the pixel data). Each returns { end } (the offset one past the container's own last byte) or
 * { end: -1, why } when the structure cannot be followed to its end.
 */
const BAD = (why) => ({ end: -1, why });

/** PNG: the signature, then chunks (length, type, data, crc) to IEND. visit(type, p, len) sees each chunk. */
function pngWalk(b, visit) {
  let p = 8;
  while (p + 12 <= b.length) {
    const len = be32(b, p), type = latin1(b, p + 4, p + 8);
    if (len > b.length || p + 12 + len > b.length) return BAD("chunk runs past the end");
    visit?.(type, p, len);
    p += 12 + len;
    if (type === "IEND") return { end: p };
  }
  return BAD("no IEND");
}

/**
 * JPEG: markers, each segment by its length, and after a scan header (SOS) the entropy-coded data up to the next marker (stuffed 0xFF00 and
 * restart markers are data); the container ends at EOI. A 0xFFD9 inside a segment (a thumbnail) or after EOI (appended data) is not the end.
 * visit(marker, p, len) sees each segment before the first scan's data.
 */
function jpegWalk(b, visit) {
  let p = 2, scanned = false;
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) return BAD("bytes between segments");
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }                                   // fill byte
    if (m === 0xd9) return { end: p + 2 };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    if (p + 4 > b.length) return BAD("no EOI");
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return BAD("bad segment length");
    if (!scanned) visit?.(m, p, len);
    p += 2 + len;
    if (m === 0xda) {                                                    // entropy-coded data: runs to the next real marker
      scanned = true;
      while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
      if (p + 1 >= b.length) return BAD("no EOI");
    }
  }
  return BAD("no EOI");
}

/** GIF: header, logical screen descriptor (+ global colour table), then extension and image blocks (sub-blocks to a zero length) to the trailer 0x3B. */
function gifWalk(b, visit) {
  if (b.length < 13) return BAD("no GIF trailer");
  let p = 13;
  if (b[10] & 0x80) p += 3 * (2 ** ((b[10] & 7) + 1));
  const subBlocks = () => { while (p < b.length && b[p] !== 0) p += 1 + b[p]; p++; };
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) return { end: p + 1 };
    if (t === 0x21) { p += 2; subBlocks(); }
    else if (t === 0x2c) { if (p + 10 > b.length) return BAD("no GIF trailer"); const packed = b[p + 9]; visit?.(u16(b, p + 5), u16(b, p + 7)); p += 10; if (packed & 0x80) p += 3 * (2 ** ((packed & 7) + 1)); p++; subBlocks(); }
    else return BAD("unknown GIF block");
  }
  return BAD("no GIF trailer");
}

/** WebP: a RIFF container whose own size field (plus the 8 bytes of "RIFF" and the size) is the end. */
function webpWalk(b) {
  if (b.length < 12) return BAD("short RIFF");
  const end = u32(b, 4) + 8;
  if (end < 12) return BAD("RIFF size too small");
  return end > b.length ? BAD("RIFF length past the end") : { end };
}

/** Where the container of a PNG, JPEG, GIF or WebP ends: the offset one past its last byte, or -1 (another type, or a structure that cannot be followed). */
export function containerEnd(bytes, type) {
  const r = type === "image/png" ? pngWalk(bytes) : type === "image/jpeg" ? jpegWalk(bytes) : type === "image/gif" ? gifWalk(bytes) : type === "image/webp" ? webpWalk(bytes) : BAD("not a raster image");
  return r.end;
}

function png(c, b) {
  let sawIhdr = false;
  const r = pngWalk(b, (type, p) => {
    if (type === "IHDR" && be32(b, p) === 13) { sawIhdr = true; pixels(c, be32(b, p + 8), be32(b, p + 12)); }
    else if (/^(tEXt|iTXt|zTXt|eXIf)$/.test(type)) c.add("metadata_present", "info", "none", type);
  });
  if (!sawIhdr) { c.add("malformed", "needs_sandbox", "could_not_check"); c.incomplete("no IHDR"); }
  if (r.end < 0) { c.add("truncated", "needs_sandbox", "could_not_check"); c.incomplete(r.why); }
  else if (r.end < b.length) c.add("trailing_data", "needs_sandbox", "needs_sandbox_review", `${b.length - r.end} bytes`);
}

function jpeg(c, b) {
  let sized = false;
  const r = jpegWalk(b, (m, p, len) => {
    if (m === 0xe1 && hasAt(b, ascii("Exif\0\0"), p + 4)) c.add("metadata_present", "info", "none", "EXIF");
    if (m === 0xed) c.add("metadata_present", "info", "none", "IPTC");
    if (!sized && ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf))) { sized = true; pixels(c, (b[p + 7] << 8) | b[p + 8], (b[p + 5] << 8) | b[p + 6]); }
  });
  if (r.end < 0) {
    if (r.why === "bad segment length" || r.why === "bytes between segments") { c.add("malformed", "needs_sandbox", "could_not_check"); c.incomplete(r.why); }
    else { c.add("truncated", "needs_sandbox", "could_not_check"); c.incomplete(r.why); }
  } else {
    let nonWs = 0;
    for (let i = r.end; i < b.length; i++) if (b[i] !== 0 && b[i] !== 10 && b[i] !== 13 && b[i] !== 32) nonWs++;
    if (nonWs > 0) c.add("trailing_data", "needs_sandbox", "needs_sandbox_review", `${b.length - r.end} bytes`);
  }
}

function gif(c, b) {
  if (b.length >= 10) pixels(c, u16(b, 6), u16(b, 8));
  let total = 0;
  const r = gifWalk(b, (w, h) => { pixels(c, w, h); total += w * h; });   // each frame's own image descriptor, not only the logical screen
  totalPixels(c, total);
  if (r.end < 0) { c.add("truncated", "needs_sandbox", "could_not_check"); c.incomplete(r.why); }
  else if (r.end < b.length) c.add("trailing_data", "needs_sandbox", "needs_sandbox_review", `${b.length - r.end} bytes`);
}

const WEBP_MAX_CHUNKS = 10_000;
const le24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const le16 = (b, o) => b[o] | (b[o + 1] << 8);

/**
 * The size of one WebP image chunk's payload at p (length len): VP8 (lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height),
 * VP8L (lossless: signature 0x2f, then 14-bit width-1 and height-1) or VP8X (24-bit canvas width-1 and height-1). Returns [w, h], or a reason string.
 */
function webpImageSize(b, id, p, len) {
  if (id === "VP8 ") {
    if (len < 10) return "VP8 chunk too short";
    if (b[p + 3] !== 0x9d || b[p + 4] !== 0x01 || b[p + 5] !== 0x2a) return "VP8 bad start code";
    return [le16(b, p + 6) & 0x3fff, le16(b, p + 8) & 0x3fff];
  }
  if (id === "VP8L") {
    if (len < 5) return "VP8L chunk too short";
    if (b[p] !== 0x2f) return "VP8L bad signature";
    const v = (b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16) | (b[p + 4] << 24)) >>> 0;
    if (v >>> 29 !== 0) return "VP8L unsupported version";   // bits 29-31 must be 0
    return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1];
  }
  if (len < 10) return "VP8X chunk too short";
  return [1 + le24(b, p + 4), 1 + le24(b, p + 7)];
}

function webp(c, b) {
  const r = webpWalk(b);
  if (r.end < 0) { c.add("truncated", "needs_sandbox", "could_not_check"); c.incomplete(r.why); }
  else if (r.end < b.length) c.add("trailing_data", "needs_sandbox", "needs_sandbox_review", `${b.length - r.end} bytes`);
  if (r.end >= 0) {
    // the chunks inside the RIFF: the first must be an image chunk (VP8, VP8L or VP8X); every image chunk's size (and every animation frame's) is bounded
    const end = r.end;
    let p = 12, n = 0, sawImage = false, bad = null, mismatch = null, canvas = null, total = 0;
    const size = (id, at, len, counted = true) => { const s = webpImageSize(b, id, at, len); if (typeof s === "string") { bad ??= s; return; } sawImage = true; pixels(c, s[0], s[1]); if (counted) total += s[0] * s[1]; return s; };
    if (p + 8 > end) bad = "no WebP chunk";
    while (!bad && p + 8 <= end && n++ < WEBP_MAX_CHUNKS) {
      const id = latin1(b, p, p + 4), len = u32(b, p + 4), at = p + 8;
      if (at + len > end) { bad = `${id} chunk runs past the end`; break; }
      if (p === 12 && id !== "VP8 " && id !== "VP8L" && id !== "VP8X") { bad = "first chunk is not an image chunk"; break; }
      if (id === "EXIF" || id === "XMP ") c.add("metadata_present", "info", "none", id.trim());
      else if (id === "VP8 " || id === "VP8L") size(id, at, len);
      else if (id === "VP8X") { const s = webpImageSize(b, id, at, len); if (typeof s === "string") bad = s; else if (canvas) bad = "second VP8X chunk"; else { pixels(c, s[0], s[1]); canvas = s; } }
      else if (id === "ANMF") {   // an animation frame: its own 24-bit width-1 and height-1 (after x and y), then the frame's image chunk
        if (len < 24) { bad = "ANMF chunk too short"; break; }
        const fw = 1 + le24(b, at + 6), fh = 1 + le24(b, at + 9);
        pixels(c, fw, fh);
        // the frame's own chunks must tile the payload exactly (pad bytes included) and hold exactly one image chunk (VP8 or VP8L, ALPH may come first):
        // a decoder that honoured a later image chunk would see a frame this triage never bounded. Every image chunk is bounded and counted either way.
        // The INNER size is what a decoder allocates: it counts in the total (not the header's) and is never larger than the header says.
        let q = at + 16, images = 0, firstInner = null;
        while (q + 8 <= at + len) {
          const subId = latin1(b, q, q + 4), subLen = u32(b, q + 4), next = q + 8 + subLen + (subLen % 2);
          if (next > at + len) break;
          if (subId === "VP8 " || subId === "VP8L") {
            const inner = size(subId, q + 8, subLen, false);
            if (typeof inner === "string" || !inner) total += fw * fh;
            else { total += inner[0] * inner[1]; if (images === 0) firstInner = inner; }
            images++;
          }
          q = next;
        }
        if (images !== 1) mismatch ??= images === 0 ? "ANMF frame has no image chunk" : "ANMF frame has more than one image chunk";
        else if (q !== at + len) mismatch ??= "ANMF frame chunks do not tile its payload";
        if (firstInner && (firstInner[0] > fw || firstInner[1] > fh)) mismatch ??= `ANMF frame is ${firstInner[0]}x${firstInner[1]} inside a ${fw}x${fh} header`;
        // the frame (offset in units of 2 pixels, plus size) lies inside the VP8X canvas
        if (!canvas) mismatch ??= "ANMF frame without a VP8X canvas";
        else if (2 * le24(b, at) + fw > canvas[0] || 2 * le24(b, at + 3) + fh > canvas[1]) mismatch ??= `ANMF frame at ${2 * le24(b, at)},${2 * le24(b, at + 3)} (${fw}x${fh}) is outside the ${canvas[0]}x${canvas[1]} canvas`;
      }
      p = at + len + (len % 2);
    }
    bad ??= mismatch;   // kept apart so the walk goes on and every frame still counts in the total
    if (!bad && p > end) bad = "last chunk's pad byte lies beyond the end";
    else if (!bad && p + 8 <= end) bad = "too many WebP chunks";
    else if (!bad && p < end) bad = `${end - p} bytes after the last chunk`;
    if (!bad && !sawImage) bad = "no image chunk";
    totalPixels(c, total);
    if (bad) { c.add("malformed", "needs_sandbox", "could_not_check", bad); c.incomplete(bad); }
  }
}

export function triageImage(bytes, type) {
  const c = collector();
  if (type === "image/png") png(c, bytes);
  else if (type === "image/jpeg") jpeg(c, bytes);
  else if (type === "image/gif") gif(c, bytes);
  else if (type === "image/webp") webp(c, bytes);
  else c.incomplete(`no image triage for ${type}`);
  return c.finish();
}
