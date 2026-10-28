/* ID3v2.3 tag, UTF-16 text frames (every podcast app reads them, RTL scripts included). */
function frame(id, data) {
  const f = new Uint8Array(10 + data.length);
  f.set([...id].map((c) => c.charCodeAt(0)), 0);
  new DataView(f.buffer).setUint32(4, data.length);
  f.set(data, 10);
  return f;
}
function utf16(text) {
  const out = [0xff, 0xfe];
  for (const ch of String(text ?? "")) { const c = ch.codePointAt(0); if (c > 0xffff) continue; out.push(c & 0xff, c >> 8); }
  return out;
}
const textFrame = (id, text) => frame(id, new Uint8Array([1, ...utf16(text), 0, 0]));

/** ISO 639-2 code for the COMM frame from a BCP 47 locale ("fa-IR" → "fas"). */
export function id3Lang(locale = "en") {
  const map = { fa: "fas", en: "eng", ar: "ara", de: "deu", fr: "fra", es: "spa", tr: "tur", ur: "urd", ru: "rus", it: "ita", pt: "por", nl: "nld", zh: "zho", ja: "jpn" };
  const l = String(locale).toLowerCase().split(/[-_]/)[0];
  return map[l] || (l.length === 3 ? l : "und");
}

/**
 * Build an ID3v2.3 tag to put in front of the MP3 frames.
 * @param {{title?: string, artist?: string, album?: string, year?: string|number, comment?: string, genre?: string, track?: string|number, lang?: string}} t
 * @returns {Uint8Array}
 */
export function id3Tag({ title, artist, album, year, comment, genre = "Podcast", track, lang = "eng" }) {
  const frames = [];
  if (title != null) frames.push(textFrame("TIT2", title));
  if (artist != null) frames.push(textFrame("TPE1", artist));
  if (album != null) frames.push(textFrame("TALB", album));
  if (year != null) frames.push(textFrame("TYER", String(year)));
  if (track != null) frames.push(textFrame("TRCK", String(track)));
  if (genre) frames.push(textFrame("TCON", genre));
  if (comment) {
    const code = [...String(lang).padEnd(3, " ").slice(0, 3)].map((x) => x.charCodeAt(0));
    frames.push(frame("COMM", new Uint8Array([1, ...code, 0xff, 0xfe, 0, 0, ...utf16(comment), 0, 0])));
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0], 0); // "ID3" v2.3, no flags
  [21, 14, 7, 0].forEach((sh, i) => { tag[6 + i] = (size >> sh) & 0x7f; }); // syncsafe size
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

/** Read back the text frames of a tag (for tests and tooling). */
export function readId3(bytes) {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const out = {}, dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = (u8) => { let s = ""; for (let i = 0; i + 1 < u8.length; i += 2) { const c = u8[i] | (u8[i + 1] << 8); if (c === 0xfeff) continue; if (!c) break; s += String.fromCharCode(c); } return s; };
  for (let o = 10; o + 10 <= 10 + size;) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4)), len = dv.getUint32(o + 4);
    if (!len) break;
    const data = bytes.subarray(o + 10, o + 10 + len);
    if (id === "COMM") { const rest = data.subarray(4); const cut = rest.findIndex((b, i) => i % 2 === 0 && b === 0 && rest[i + 1] === 0 && i > 1); out.COMM = dec(rest.subarray(cut + 2)); out.COMM_LANG = String.fromCharCode(...data.subarray(1, 4)); }
    else out[id] = dec(data.subarray(1));
    o += 10 + len;
  }
  out.size = 10 + size;
  return out;
}
