// Synthetic files built by structure for the upload tests. No real malware: a "malicious by structure" file only carries the
// markers the triage looks for (a name token, a zip entry name), and none of it executes anything.
import { deflateRawSync, deflateSync } from "node:zlib";

export const enc = (s) => new TextEncoder().encode(s);
export const bin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);   // a string of byte values (latin1), for signatures
export const cat = (...parts) => { const bs = parts.map((p) => (typeof p === "string" ? bin(p) : p)); const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of bs) { out.set(b, o); o += b.length; } return out; };

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const le16 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255);
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const be32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

/**
 * entries: [{ name, data, method = 8, flags = 0, symlink, lieSize, localName, version }]  → zip bytes.
 * lieSize: the uncompressed size written in the headers (a lie). localName: the name in the local header when it differs.
 */
export function zip(entries, { prefix = new Uint8Array(0), comment = "" } = {}) {
  const parts = [prefix]; let offset = prefix.length; const central = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc(e.data) : e.data || new Uint8Array(0);
    const method = e.method ?? 8;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const nameBytes = enc(e.name), localName = enc(e.localName ?? e.name);
    const size = e.lieSize ?? data.length;
    const local = cat("PK\x03\x04", le16(20), le16(e.flags ?? 0), le16(method), le16(0), le16(0), le32(crc32(data)), le32(comp.length), le32(size), le16(localName.length), le16(0), localName, comp);
    central.push({ e, nameBytes, comp, size, offset, crc: crc32(data), method });
    parts.push(local); offset += local.length;
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) {
    const ext = c.e.symlink ? (0o120777 << 16) >>> 0 : 0;
    const made = c.e.symlink ? (3 << 8) | 20 : 20;
    const rec = cat("PK\x01\x02", le16(made), le16(20), le16(c.e.flags ?? 0), le16(c.method), le16(0), le16(0), le32(c.crc), le32(c.comp.length), le32(c.size), le16(c.nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(ext), le32(c.offset), c.nameBytes);
    parts.push(rec); cdSize += rec.length;
  }
  const cm = enc(comment);
  parts.push(cat("PK\x05\x06", le16(0), le16(0), le16(central.length), le16(central.length), le32(cdSize), le32(cdStart), le16(cm.length), cm));
  return cat(...parts);
}

/** A tiny OOXML package. kind: docx | xlsx | pptx. extra: more entries. */
export function ooxml(kind = "docx", extra = [], { contentTypes } = {}) {
  const main = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[kind];
  const ct = contentTypes ?? `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${kind === "docx" ? "wordprocessingml.document.main" : kind === "xlsx" ? "spreadsheetml.sheet.main" : "presentationml.presentation.main"}+xml"/></Types>`;
  const body = kind === "docx" ? `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>` : kind === "xlsx" ? `<workbook/>` : `<p:presentation/>`;
  return zip([{ name: "[Content_Types].xml", data: ct }, { name: "_rels/.rels", data: `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>` }, { name: main, data: body }, ...extra]);
}

/** A PDF from object bodies. Options: header ("%PDF-1.7\n"), eof (true), trailer extras, startxref (auto, or a number), tail (bytes after %%EOF). */
export function pdf(objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"], { header = "%PDF-1.7\n", eof = true, trailer = "", tail = "", startxref, updates = 0, linearized = false } = {}) {
  let body = header + (linearized ? "1 0 obj << /Linearized 1 /L 0000000000 >> endobj\n" : "");
  let n = linearized ? 1 : 0;
  for (const o of objects) { n++; body += `${n} 0 obj\n${o}\nendobj\n`; }
  const xrefAt = header.length + (body.length - header.length);
  body += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${n + 1} /Root 1 0 R ${trailer} >>\n`;
  let out = body + `startxref\n${startxref ?? xrefAt}\n${eof ? "%%EOF\n" : ""}`;
  for (let i = 0; i < updates; i++) out += `${++n} 0 obj\n<< /Note ${i} >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${n + 1} /Prev 0 >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const full = out + tail;
  return enc(linearized ? full.replace("/L 0000000000", `/L ${String(enc(full).length).padStart(10, "0")}`) : full);   // /L is the file length: the one thing that makes a second %%EOF a linearized file's own
}

/** A PDF whose catalog hides `inner` (object text) inside a Flate object stream. */
export function pdfWithObjStm(inner, { filter = "/Filter /FlateDecode", encode = (b) => new Uint8Array(deflateSync(b)), extraObjects = [] } = {}) {
  const content = `10 0 ${inner}`;
  const stream = encode(enc(content));
  const head = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n3 0 obj\n<< /Type /ObjStm /N 1 /First 5 ${filter} /Length ${stream.length} >>\nstream\n`;
  const rest = `\nendstream\nendobj\n${extraObjects.map((o, i) => `${20 + i} 0 obj\n${o}\nendobj\n`).join("")}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${head.length + stream.length + 20}\n%%EOF\n`;
  const bytes = cat(head, stream, rest);
  // point startxref at the xref keyword
  const text = new TextDecoder("latin1").decode(bytes);
  const at = text.indexOf("\nxref\n") + 1;
  return cat(head, stream, rest.replace(/startxref\n\d+/, `startxref\n${at}`));
}

/** An OLE2 / CFB container whose directory has the given stream or storage names. */
export function ole(names = ["WordDocument"]) {
  const ENDOFCHAIN = 0xfffffffe, FREE = 0xffffffff;
  const entries = [{ name: "Root Entry", type: 5 }, ...names.map((name) => ({ name, type: 2 }))];
  const nDir = Math.ceil(entries.length / 4);
  const header = new Uint8Array(512).fill(0);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.set(le16(0x3e), 24); header.set(le16(3), 26); header.set(le16(0xfffe), 28); header.set(le16(9), 30); header.set(le16(6), 32);
  header.set(le32(1), 44); header.set(le32(1), 48); header.set(le32(4096), 56); header.set(le32(ENDOFCHAIN), 60); header.set(le32(0), 64); header.set(le32(ENDOFCHAIN), 68); header.set(le32(0), 72);
  header.set(le32(0), 76); for (let i = 1; i < 109; i++) header.set(le32(FREE), 76 + i * 4);
  const fat = new Uint8Array(512).fill(0xff);
  fat.set(le32(0xfffffffd), 0);   // sector 0 is the FAT itself
  for (let i = 0; i < nDir; i++) fat.set(le32(i === nDir - 1 ? ENDOFCHAIN : i + 2), (i + 1) * 4);
  const dir = new Uint8Array(512 * nDir).fill(0);
  entries.forEach((e, i) => {
    const o = i * 128;
    for (let k = 0; k < e.name.length && k < 31; k++) dir.set(le16(e.name.charCodeAt(k)), o + k * 2);
    dir.set(le16(Math.min(e.name.length, 31) * 2 + 2), o + 64); dir[o + 66] = e.type; dir[o + 67] = 1;
    dir.set(le32(FREE), o + 68); dir.set(le32(FREE), o + 72); dir.set(le32(FREE), o + 76); dir.set(le32(ENDOFCHAIN), o + 116);
  });
  return cat(header, fat, dir);
}

export function png({ w = 1, h = 1, trailing = new Uint8Array(0), text = false, noIend = false, noIhdr = false } = {}) {
  const chunk = (type, data) => cat(be32(data.length), type, data, be32(crc32(cat(type, data))));
  const ihdr = cat(be32(w), be32(h), Uint8Array.of(8, 2, 0, 0, 0));
  return cat("\x89PNG\r\n\x1a\n", noIhdr ? new Uint8Array(0) : chunk("IHDR", ihdr), text ? chunk("tEXt", enc("Comment\0hi")) : new Uint8Array(0), chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(4)))), noIend ? new Uint8Array(0) : chunk("IEND", new Uint8Array(0)), trailing);
}
export function jpeg({ w = 1, h = 1, exif = false, trailing = new Uint8Array(0), eoi = true } = {}) {
  const seg = (m, d) => cat(Uint8Array.of(0xff, m), Uint8Array.of((d.length + 2) >> 8, (d.length + 2) & 255), d);
  return cat(Uint8Array.of(0xff, 0xd8), exif ? seg(0xe1, cat("Exif\0\0", enc("MM\0*"))) : new Uint8Array(0), seg(0xc0, cat(Uint8Array.of(8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0))), seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), Uint8Array.of(0x12, 0x34), eoi ? Uint8Array.of(0xff, 0xd9) : new Uint8Array(0), trailing);
}
/** A GIF; `frames` adds image descriptors (each with its OWN width and height, 1x1 of LZW data) before the trailer. */
export const gif = ({ w = 1, h = 1, trailer = true, trailing = new Uint8Array(0), frames = [] } = {}) =>
  cat("GIF89a", le16(w), le16(h), Uint8Array.of(0, 0, 0), ...frames.map((f) => cat(Uint8Array.of(0x2c), le16(0), le16(0), le16(f.w), le16(f.h), Uint8Array.of(0, 2, 2, 0x4c, 0x01, 0))), trailer ? Uint8Array.of(0x3b) : new Uint8Array(0), trailing);
/**
 * A WebP. kind: "vp8" (lossy; frame tag, start code 9d 01 2a, 14-bit w/h), "vp8l" (lossless; signature 0x2f, 14-bit w-1/h-1), "vp8x" (extended;
 * 24-bit canvas w-1/h-1, then a 1x1 VP8 chunk). badStart / badSig corrupt the start code / signature; short cuts the image chunk's payload to 4 bytes.
 */
export function webp({ trailing = new Uint8Array(0), lieLen, kind = "vp8", w = 1, h = 1, badStart = false, badSig = false, short = false } = {}) {
  const chunk = (id, data) => cat(id, le32(data.length), data, data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0));
  const vp8 = (cw, ch) => cat(Uint8Array.of(0x10, 0, 0), badStart ? Uint8Array.of(0x9d, 0x01, 0x2b) : Uint8Array.of(0x9d, 0x01, 0x2a), le16(cw), le16(ch));
  const vp8l = (cw, ch) => { const v = ((cw - 1) & 0x3fff) | (((ch - 1) & 0x3fff) << 14); return cat(Uint8Array.of(badSig ? 0x2e : 0x2f), le32(v >>> 0)); };
  const le24 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255);
  let body;
  if (kind === "vp8l") body = chunk("VP8L", short ? vp8l(w, h).slice(0, 4) : vp8l(w, h));
  else if (kind === "vp8x") body = cat(chunk("VP8X", cat(Uint8Array.of(0, 0, 0, 0), le24(w - 1), le24(h - 1))), chunk("VP8 ", vp8(1, 1)));
  else body = chunk("VP8 ", short ? vp8(w, h).slice(0, 4) : vp8(w, h));
  const payload = cat("WEBP", body);
  return cat("RIFF", le32(lieLen ?? payload.length), payload, trailing);
}

/** The standard antivirus test string, assembled at run time so this file is not itself a detection. */
export const eicarLike = () => ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "!$H+H*"].join("");

export function stream(chunks) { let i = 0; return new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(typeof chunks[i] === "string" ? enc(chunks[i++]) : chunks[i++]); else c.close(); } }); }
export const req = (body, headers = {}, init = {}) => new Request("https://example.test/upload", { method: "POST", body, headers, duplex: "half", ...init });
export const withLength = (body, headers = {}) => { const len = typeof body === "string" ? enc(body).length : body.length; return req(body, { "content-length": String(len), ...headers }); };
