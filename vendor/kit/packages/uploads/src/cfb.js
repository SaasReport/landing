/**
 * A bounded reader of OLE2 / Compound File Binary containers (legacy .doc .xls .ppt, encrypted OOXML, .msg): the directory
 * only (storage and stream names), so triage can see VBA storages, embedded objects and encrypted packages without parsing any
 * stream. Everything is bounded by the container's own size; a malformed container returns ok:false.
 */
import { hasAt, u16, u32 } from "./bytes.js";

export const OLE_MAGIC = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff;

export function readCfb(bytes, { maxEntries = 10000 } = {}) {
  const fail = (reason) => ({ ok: false, reason, entries: [] });
  if (bytes.length < 512 || !hasAt(bytes, OLE_MAGIC)) return fail("no OLE2 header");
  if (u16(bytes, 28) !== 0xfffe) return fail("unexpected byte order");
  const shift = u16(bytes, 30);
  if (shift !== 9 && shift !== 12) return fail("unexpected sector size");
  const ss = 1 << shift, nFat = u32(bytes, 44), firstDir = u32(bytes, 48), firstDifat = u32(bytes, 68), nDifat = u32(bytes, 72);
  const maxSectors = Math.floor((bytes.length - 512) / ss) + 1;
  const off = (s) => 512 + s * ss;
  if (nFat > maxSectors) return fail("more FAT sectors than the file holds");
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const s = u32(bytes, 76 + i * 4); if (s !== FREESECT) fatSectors.push(s); }
  let d = firstDifat;
  for (let i = 0; i < nDifat && d !== ENDOFCHAIN && d !== FREESECT && fatSectors.length < nFat; i++) {
    if (off(d) + ss > bytes.length) return fail("DIFAT out of range");
    for (let k = 0; k < ss / 4 - 1 && fatSectors.length < nFat; k++) { const s = u32(bytes, off(d) + k * 4); if (s !== FREESECT) fatSectors.push(s); }
    d = u32(bytes, off(d) + ss - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    if (off(s) + ss > bytes.length) return fail("FAT sector out of range");
    for (let k = 0; k < ss / 4; k++) fat.push(u32(bytes, off(s) + k * 4));
  }
  const dirBytes = [];
  let s = firstDir, hops = 0;
  while (s !== ENDOFCHAIN && s !== FREESECT) {
    if (++hops > maxSectors || s >= fat.length || off(s) + ss > bytes.length) return fail("directory chain is broken");
    dirBytes.push([off(s), ss]);
    s = fat[s];
  }
  const entries = [];
  for (const [o, len] of dirBytes) {
    for (let p = o; p + 128 <= o + len; p += 128) {
      const type = bytes[p + 66];
      if (type === 0) continue;
      const nameLen = Math.min(u16(bytes, p + 64), 64);
      let name = "";
      for (let k = 0, chars = Math.max(0, (nameLen - 2) >> 1); k < chars; k++) name += String.fromCharCode(u16(bytes, p + k * 2));
      entries.push({ name, type, size: u32(bytes, p + 120), start: u32(bytes, p + 116) });
      if (entries.length > maxEntries) return fail("too many directory entries");
    }
  }
  return { ok: true, entries };
}

/** The Office application a container is, from its stream names: word, excel, powerpoint, encrypted-ooxml or null. */
export function oleKind(entries) {
  const names = new Set(entries.map((e) => e.name));
  if (names.has("EncryptedPackage") || names.has("EncryptionInfo")) return "encrypted-ooxml";
  if (names.has("WordDocument")) return "word";
  if (names.has("Workbook") || names.has("Book")) return "excel";
  if (names.has("PowerPoint Document")) return "powerpoint";
  return null;
}
