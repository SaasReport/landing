/** Byte helpers with no Node APIs (Workers, Node, browsers): hashing, latin1 views, searching, concatenation. */
import { tick } from "./work.js";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export const toHex = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };

/** sha256 of bytes, lowercase hex (WebCrypto). */
export async function sha256Hex(bytes) { return toHex(await crypto.subtle.digest("SHA-256", bytes)); }

/** A byte range as a latin1 string (one char per byte): safe to search with regular expressions. */
export function latin1(bytes, start = 0, end = bytes.length) {
  let s = "";
  const stop = Math.min(end, bytes.length);
  tick(Math.max(0, stop - Math.max(0, start)));
  for (let i = Math.max(0, start); i < stop; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(stop, i + 8192)));
  return s;
}

/** latin1 string back to bytes. */
export function fromLatin1(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; }

export const ascii = (s) => fromLatin1(s);

/** Does `bytes` have `sig` at `offset`? */
export function hasAt(bytes, sig, offset = 0) {
  if (offset < 0 || offset + sig.length > bytes.length) return false;
  tick(sig.length);
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** First index of `needle` in `hay` at or after `from` (before `to`), or -1. */
export function indexOfBytes(hay, needle, from = 0, to = hay.length) {
  const n = needle.length, last = Math.min(to, hay.length) - n;
  if (!n) return from;
  for (let i = from; i <= last; i++) {
    const at = hay.indexOf(needle[0], i);
    tick((at < 0 ? hay.length : at) - i + 1);
    i = at;
    if (i < 0 || i > last) return -1;
    let j = 1;
    while (j < n && hay[i + j] === needle[j]) j++;
    if (j === n) return i;
  }
  return -1;
}

export function lastIndexOfBytes(hay, needle, from = hay.length - needle.length) {
  for (let i = Math.min(from, hay.length - needle.length); i >= 0; i--) { tick(); if (hasAt(hay, needle, i)) return i; }
  return -1;
}

export function concat(chunks, total = chunks.reduce((n, c) => n + c.length, 0)) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const u16 = (b, o) => b[o] | (b[o + 1] << 8);
export const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
