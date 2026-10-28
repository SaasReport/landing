/**
 * A bounded ZIP reader for triage: the central directory (names, sizes, flags, attributes) without inflating anything,
 * plus a size-capped inflate (WebCrypto-era DecompressionStream, present on Workers and Node 18+).
 *
 *   readZip(bytes, { maxEntries }) → { ok, entries, prefixBytes, problems }
 *   inflateRaw(bytes, maxOut)      → { bytes, truncated, error }        raw deflate (ZIP entries)
 *   inflateZlib(bytes, maxOut)     → { bytes, truncated, error }        zlib (PDF /FlateDecode)
 *   entryBytes(zipBytes, entry, maxOut) → { bytes, truncated, error } | null   (null: a method that is not stored/deflate)
 */
import { hasAt, indexOfBytes, lastIndexOfBytes, u16, u32, ascii, concat } from "./bytes.js";
import { tick } from "./work.js";

const SIG_EOCD = ascii("PK\x05\x06"), SIG_EOCD64_LOC = ascii("PK\x06\x07"), SIG_CEN = ascii("PK\x01\x02"), SIG_LOC = ascii("PK\x03\x04");
const u64 = (b, o) => { const hi = u32(b, o + 4); return hi > 0x1fffff ? Number.MAX_SAFE_INTEGER : hi * 4294967296 + u32(b, o); };

/** The bytes decoded as the archive names them (UTF-8 when flag bit 11 is set, else latin1 as an approximation of cp437). */
function entryName(raw, flags) {
  if (flags & 0x800) return new TextDecoder("utf-8").decode(raw);
  tick(raw.length);
  let s = ""; for (const c of raw) s += String.fromCharCode(c); return s;
}

/** A central-directory reading. problems: strings; ok is false when the directory cannot be trusted at all. */
export function readZip(bytes, { maxEntries = 1000 } = {}) {
  const problems = [];
  const eocd = lastIndexOfBytes(bytes, SIG_EOCD, bytes.length - 22);
  if (eocd < 0 || eocd < bytes.length - 22 - 65535) return { ok: false, entries: [], prefixBytes: 0, problems: ["end of central directory not found"], zip64: false };
  let total = u16(bytes, eocd + 10), cdSize = u32(bytes, eocd + 12), cdOffset = u32(bytes, eocd + 16), zip64 = false;
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && hasAt(bytes, SIG_EOCD64_LOC, loc)) {
      const e64 = u64(bytes, loc + 8);
      if (e64 + 56 <= bytes.length && hasAt(bytes, ascii("PK\x06\x06"), e64)) { zip64 = true; total = u64(bytes, e64 + 32); cdSize = u64(bytes, e64 + 40); cdOffset = u64(bytes, e64 + 48); }
      else problems.push("zip64 locator points nowhere");
    } else problems.push("zip64 values without a locator");
  }
  if (cdOffset + cdSize > bytes.length) return { ok: false, entries: [], prefixBytes: 0, problems: [...problems, "central directory out of range"], zip64 };
  if (total > maxEntries) return { ok: true, entries: [], prefixBytes: 0, problems, zip64, entryCount: total, overLimit: true };
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > bytes.length || !hasAt(bytes, SIG_CEN, p)) { problems.push(`central directory entry ${i} is not where it should be`); break; }
    tick(46);
    const flags = u16(bytes, p + 8), method = u16(bytes, p + 10), madeBy = u16(bytes, p + 4);
    let compSize = u32(bytes, p + 20), size = u32(bytes, p + 24), localOffset = u32(bytes, p + 42);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32), ext = u32(bytes, p + 38);
    if (p + 46 + nameLen + extraLen + commentLen > bytes.length) { problems.push(`central directory entry ${i} runs past the end`); break; }
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      let q = p + 46 + nameLen; const end = q + extraLen;
      while (q + 4 <= end) {
        tick();
        const id = u16(bytes, q), len = u16(bytes, q + 2);
        if (id === 1) { let r = q + 4; if (size === 0xffffffff) { size = u64(bytes, r); r += 8; } if (compSize === 0xffffffff) { compSize = u64(bytes, r); r += 8; } if (localOffset === 0xffffffff) localOffset = u64(bytes, r); break; }
        q += 4 + len;
      }
    }
    const name = entryName(rawName, flags);
    let dataOffset = -1, localMismatch = false;
    if (localOffset + 30 <= bytes.length && hasAt(bytes, SIG_LOC, localOffset)) {
      const ln = u16(bytes, localOffset + 26), le = u16(bytes, localOffset + 28);
      dataOffset = localOffset + 30 + ln + le;
      const localName = bytes.subarray(localOffset + 30, localOffset + 30 + ln);
      tick(ln);
      if (localName.length !== rawName.length || localName.some((c, k) => c !== rawName[k])) localMismatch = true;
    } else localMismatch = true;
    entries.push({
      name, method, flags, compSize, size, localOffset, dataOffset, localMismatch,
      encrypted: Boolean(flags & 1), dir: name.endsWith("/"),
      symlink: (madeBy >> 8) === 3 && (((ext >>> 16) & 0xf000) === 0xa000),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // bytes before the first local header: a prefix (a self-extractor, a document glued to an archive)
  const first = entries.reduce((m, e) => (e.localOffset < m ? e.localOffset : m), Infinity);
  const prefixBytes = Number.isFinite(first) ? first : 0;
  if (entries.length !== total) problems.push(`directory announces ${total} entries, ${entries.length} found`);
  return { ok: true, entries, prefixBytes, problems, zip64, entryCount: total };
}

async function inflate(format, data, maxOut) {
  const out = []; let size = 0, truncated = false, error = null;
  let reader;
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data).catch(() => {}); writer.close().catch(() => {});   // the stream is already errored; the inflate result reports it
    reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxOut - size;
      if (value.length > room) { out.push(value.subarray(0, Math.max(0, room))); size = maxOut; truncated = true; reader.cancel().catch(() => {}); break; }   // cancelling an already finished reader; the output is truncated and flagged
      out.push(value); size += value.length;
    }
  } catch (e) { error = String(e?.message || e).slice(0, 100); }
  return { bytes: concat(out, size), truncated, error };
}
export const inflateRaw = (data, maxOut) => inflate("deflate-raw", data, maxOut);
export const inflateZlib = (data, maxOut) => inflate("deflate", data, maxOut);

/** One entry's bytes, capped at maxOut. null for a compression method other than stored (0) and deflate (8). */
export async function entryBytes(zipBytes, entry, maxOut) {
  if (entry.dataOffset < 0 || entry.encrypted) return null;
  const raw = zipBytes.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
  if (entry.method === 0) return { bytes: raw.subarray(0, maxOut), truncated: raw.length > maxOut, error: raw.length < entry.compSize ? "short" : null };
  if (entry.method === 8) return inflateRaw(raw, maxOut);
  return null;
}

export { indexOfBytes };
