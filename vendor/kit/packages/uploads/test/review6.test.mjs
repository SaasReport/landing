// Review 6: WebP lossy/lossless dimensions, GIF per-frame dimensions, malformed headers never allow, the serve contract's content-type allowlist,
// download integrity, no inline serving of an image that needs a re-encode, and the Multi-Picture strip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triageImage, MAX_PIXELS, BOMB_PIXELS } from "../src/triage/image.js";
import { TYPES } from "../src/sniff.js";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, validateServeHeaders, downloadResponse, sha256Hex, SCHEMAS, INERT_TYPES, serveHeaders, INLINE_IMAGE_CSP } from "../src/index.js";
import { cat, enc, jpeg, png, gif, webp } from "./fixtures.mjs";

const has = (r, name) => r.markers.find((m) => m.name === name);

/* ---------- 1. WebP VP8 / VP8L / VP8X and GIF frames ---------- */
test("webp: the dimensions of every encoding are read and bounded (lossy VP8, lossless VP8L, extended VP8X)", () => {
  for (const kind of ["vp8", "vp8l", "vp8x"]) {
    const big = triageImage(webp({ kind, w: 12000, h: 12000 }), TYPES.webp);   // 144M pixels > MAX_PIXELS
    assert.ok(12000 * 12000 > MAX_PIXELS && 12000 * 12000 < BOMB_PIXELS);
    assert.equal(has(big, "huge_dimensions")?.severity, "needs_sandbox", `${kind}: ${JSON.stringify(big.markers)}`);
    assert.equal(big.verdict, "needs_sandbox", kind);
    const small = triageImage(webp({ kind, w: 640, h: 480 }), TYPES.webp);
    assert.equal(has(small, "huge_dimensions"), undefined, kind); assert.equal(small.verdict, "allow_with_limits", `${kind}: ${JSON.stringify(small)}`);
  }
  assert.equal(has(triageImage(webp({ kind: "vp8", w: 16383, h: 16383 }), TYPES.webp), "huge_dimensions")?.severity, "needs_sandbox", "the 14-bit maximum");
  assert.equal(has(triageImage(webp({ kind: "vp8x", w: 30000, h: 30000 }), TYPES.webp), "decompression_bomb")?.severity, "block", "24-bit canvas past the bomb bound");
});

test("webp: a malformed image header (truncated, bad start code, bad signature, unknown first chunk) is never allow", () => {
  const cases = {
    "VP8 truncated": webp({ kind: "vp8", short: true }), "VP8 bad start code": webp({ kind: "vp8", badStart: true, w: 12000, h: 12000 }),
    "VP8L truncated": webp({ kind: "vp8l", short: true }), "VP8L bad signature": webp({ kind: "vp8l", badSig: true, w: 12000, h: 12000 }),
    "unknown first chunk": cat("RIFF", Uint8Array.of(20, 0, 0, 0), "WEBPJUNK", Uint8Array.of(8, 0, 0, 0), new Uint8Array(8)),
    "no chunk at all": cat("RIFF", Uint8Array.of(4, 0, 0, 0), "WEBP"),
    "chunk past the end": cat("RIFF", Uint8Array.of(14, 0, 0, 0), "WEBPVP8 ", Uint8Array.of(0xff, 0xff, 0, 0), Uint8Array.of(0, 0)),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const r = triageImage(bytes, TYPES.webp);
    assert.notEqual(r.verdict, "allow_with_limits", name); assert.equal(r.verdict, "needs_sandbox", name); assert.equal(r.complete, false, name);
    assert.ok(has(r, "malformed") || has(r, "truncated"), `${name}: ${JSON.stringify(r.markers)}`);
  }
});

test("gif: every frame's image descriptor is bounded, not only the logical screen", () => {
  const sneaky = triageImage(gif({ w: 1, h: 1, frames: [{ w: 20000, h: 6000 }] }), TYPES.gif);
  assert.equal(has(sneaky, "huge_dimensions")?.severity, "needs_sandbox", JSON.stringify(sneaky.markers)); assert.equal(sneaky.verdict, "needs_sandbox");
  assert.equal(has(triageImage(gif({ frames: [{ w: 65535, h: 65535 }] }), TYPES.gif), "decompression_bomb")?.severity, "block");
  assert.equal(has(triageImage(gif({ frames: [{ w: 1, h: 1 }, { w: 1, h: 1 }, { w: 20000, h: 6000 }] }), TYPES.gif), "huge_dimensions")?.severity, "needs_sandbox", "the third frame");
  const ok = triageImage(gif({ frames: [{ w: 100, h: 100 }, { w: 100, h: 100 }] }), TYPES.gif);
  assert.equal(ok.verdict, "allow_with_limits", JSON.stringify(ok));
});

/* ---------- 2. the serve contract's content-type allowlist ---------- */
test("upload-serve schema: content-type is exactly the INERT allowlist plus application/octet-stream (no denylist to drift)", () => {
  const prop = SCHEMAS.serve.properties["content-type"];
  assert.deepEqual([...prop.enum].sort(), [...INERT_TYPES, "application/octet-stream"].sort());
  assert.equal(prop.not, undefined, "no denylist");
  const ok = Object.fromEntries(serveHeaders({ filename: "a", type: "application/pdf", size: 1 }).entries());
  assert.deepEqual(validateServeHeaders(ok), []);
  for (const t of ["text/html", "image/svg+xml", "text/css", "weird/thing", "application/x-msdownload", "text/x-script", "application/octet-stream "]) assert.ok(validateServeHeaders({ ...ok, "content-type": t }).length > 0, t);
  assert.deepEqual(validateServeHeaders({ ...ok, "content-type": "application/octet-stream" }), []);
  for (const t of INERT_TYPES) assert.deepEqual(validateServeHeaders({ ...ok, "content-type": t }), [], t);
});

/* ---------- 3. downloadResponse verifies the body against the record ---------- */
test("download: a body whose size or sha256 differs from the record is an error response, never a serve", async () => {
  const body = enc("%PDF-hello"), sha256 = await sha256Hex(body);
  const bucket = memoryBucket(); await bucket.put("r/k", body);
  const rec = (o = {}) => ({ stage: "released", size_bytes: body.length, sha256, declared: { filename_normalised: "a.pdf" }, sniffed: { type: "application/pdf" }, storage: { released_key: "r/k" }, ...o });
  const ok = await downloadResponse({ record: rec(), bucket });
  assert.equal(ok.status, 200); assert.equal(await ok.text(), "%PDF-hello");
  assert.equal((await downloadResponse({ record: rec({ sha256: undefined }), bucket })).status, 500, "no sha256 on the record: not served (a record from intake always has one)");
  for (const [name, r] of [["wrong size", rec({ size_bytes: body.length + 1 })], ["wrong sha256", rec({ sha256: "0".repeat(64) })], ["no size", rec({ size_bytes: undefined })]]) {
    const res = await downloadResponse({ record: r, bucket });
    assert.equal(res.status, 500, name); assert.equal(res.headers.get("cache-control"), "no-store", name); assert.ok(!(await res.text()).includes("hello"), name);
  }
  await bucket.put("r/k", enc("%PDF-HELLO"));   // same size, tampered content
  const tampered = await downloadResponse({ record: rec(), bucket });
  assert.equal(tampered.status, 500); assert.ok(!(await tampered.text()).includes("HELLO"));
});

/* ---------- 4. inline serving honours the triage markers ---------- */
test("download: an image with metadata_present (or any marker, or no complete triage) is served as an attachment even when the policy says inline", async () => {
  const body = png(), sha256 = await sha256Hex(body);
  const bucket = memoryBucket(); await bucket.put("r/k", body);
  const policy = { serve: { inline_types: ["image/png"] } };
  const clean = { complete: true, markers: [] };
  const rec = (triage) => ({ stage: "released", size_bytes: body.length, sha256, declared: { filename_normalised: "a.png" }, sniffed: { type: "image/png" }, storage: { released_key: "r/k" }, ...(triage ? { triage } : {}) });
  const inline = await downloadResponse({ record: rec(clean), bucket, policy });
  assert.equal(inline.headers.get("content-disposition"), "inline"); assert.equal(inline.headers.get("content-security-policy"), INLINE_IMAGE_CSP);
  const marker = (name, severity = "info") => ({ complete: true, markers: [{ name, severity, count: 1, first_ref: null }] });
  for (const [name, triage] of [["metadata_present", marker("metadata_present")], ["huge_dimensions", marker("huge_dimensions", "needs_sandbox")], ["trailing_data", marker("trailing_data", "needs_sandbox")], ["incomplete", { complete: false, markers: [] }], ["no triage", undefined]]) {
    const res = await downloadResponse({ record: rec(triage), bucket, policy });
    assert.equal(res.status, 200, name); assert.match(res.headers.get("content-disposition"), /^attachment;/, name); assert.deepEqual(validateServeHeaders(res.headers), [], name);
  }
});

/* ---------- 5/6. intake: Multi-Picture strip, and trailing_data never reaches the record ---------- */
const rawConfig = () => ({
  schema: "kit.uploads-config.v1", project: "saasreport",
  storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } },
  forms: { pics: { id: "pics-attachment", file_fields: [{ name: "attachment" }], allowed_types: ["image/png", "image/jpeg", "image/gif", "image/webp"], max_bytes: 5 * 1024 * 1024, retention_days: 30, on_needs_sandbox: "release_download_only", scanner: "fake-av" } },
});
const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: "allow", signature_db_version: "db" }) } };
const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const setup = () => createUploads({ config: loadUploadsConfig(rawConfig(), { registry, scanners }), env: { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() }, scanners, records: memoryRecords(), now: () => new Date("2026-10-07T12:00:00Z") });

test("intake: JPEG Multi-Picture / gain-map data after the first EOI is stripped and recorded", async () => {
  const primary = jpeg(), gainMap = jpeg({ w: 4, h: 4 });
  const { record } = await setup().intake({ form: "pics", bytes: cat(primary, gainMap), filename: "a.jpg", contentType: "image/jpeg" });
  assert.equal(record.size_bytes, primary.length); assert.equal(record.sha256, await sha256Hex(primary));
  assert.equal(record.trailing_stripped.bytes, gainMap.length); assert.equal(record.trailing_stripped.original_size, primary.length + gainMap.length);
});

test("intake: trailing_data is stripped before triage, so no record from intake carries the marker (it only applies to triageImage called on unstripped bytes)", async () => {
  for (const [make, type] of [[png, "image/png"], [jpeg, "image/jpeg"], [gif, "image/gif"], [webp, "image/webp"]]) {
    const { record } = await setup().intake({ form: "pics", bytes: make({ trailing: enc("extra") }), filename: "a", contentType: type });
    assert.ok(record.trailing_stripped, type); assert.equal(record.triage.markers.find((m) => m.name === "trailing_data"), undefined, type);
  }
});

/* ---------- review 7 ---------- */
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const le24 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255);
const wchunk = (id, data) => cat(id, le32(data.length), data, data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0));
const riff = (...chunks) => { const body = cat("WEBP", ...chunks); return cat("RIFF", le32(body.length), body); };
const vp8 = (w, h) => cat(Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a), Uint8Array.of(w & 255, w >> 8, h & 255, h >> 8));
const vp8x = (w, h, flags = 0) => wchunk("VP8X", cat(Uint8Array.of(flags, 0, 0, 0), le24(w - 1), le24(h - 1)));
const anmf = (w, h, ...sub) => wchunk("ANMF", cat(le24(0), le24(0), le24(w - 1), le24(h - 1), le24(100), Uint8Array.of(0), ...sub));

test("webp: EXIF or XMP anywhere in the chunk list is metadata_present (a 50 KB file with EXIF at the end), and pixel bytes are not metadata", () => {
  const pixels = new Uint8Array(50_000).fill(0x41);
  const exifAtEnd = riff(vp8x(1, 1, 0x08), wchunk("VP8 ", cat(vp8(1, 1), pixels)), wchunk("EXIF", enc("MM\0*GPS")));
  assert.ok(exifAtEnd.length > 50_000);
  assert.equal(has(triageImage(exifAtEnd, TYPES.webp), "metadata_present")?.severity, "info");
  assert.equal(has(triageImage(riff(vp8x(1, 1), wchunk("VP8 ", cat(vp8(1, 1), pixels)), wchunk("XMP ", enc("<x/>"))), TYPES.webp), "metadata_present")?.severity, "info");
  const lookalike = riff(vp8x(1, 1), wchunk("VP8 ", cat(vp8(1, 1), enc("EXIF"), enc("XMP "), pixels)));
  assert.equal(has(triageImage(lookalike, TYPES.webp), "metadata_present"), undefined, "the words inside pixel data are not a chunk");
  assert.equal(triageImage(lookalike, TYPES.webp).verdict, "allow_with_limits");
});

test("webp: an animated lossy image with alpha (ANMF starts with ALPH) is not malformed", () => {
  const f = anmf(8, 8, wchunk("ALPH", Uint8Array.of(0, 1, 2, 3)), wchunk("VP8 ", vp8(8, 8)));
  const r = triageImage(riff(vp8x(8, 8, 0x12), wchunk("ANIM", new Uint8Array(6)), f), TYPES.webp);
  assert.equal(r.verdict, "allow_with_limits", JSON.stringify(r)); assert.equal(has(r, "malformed"), undefined);
  const noImage = triageImage(riff(vp8x(8, 8, 0x12), anmf(8, 8, wchunk("ALPH", Uint8Array.of(0, 1, 2, 3)))), TYPES.webp);
  assert.equal(noImage.verdict, "needs_sandbox"); assert.ok(has(noImage, "malformed"));
});

test("the total pixels across frames are bounded against BOMB_PIXELS (WebP ANMF, GIF)", () => {
  assert.ok(9000 * 9000 < MAX_PIXELS && 9000 * 9000 * 5 > BOMB_PIXELS && 9000 * 9000 * 4 < BOMB_PIXELS);
  const frames = (n) => Array.from({ length: n }, () => anmf(9000, 9000, wchunk("VP8 ", vp8(9000, 9000))));
  assert.equal(has(triageImage(riff(vp8x(9000, 9000, 0x02), ...frames(5)), TYPES.webp), "decompression_bomb")?.severity, "block");
  assert.equal(has(triageImage(riff(vp8x(9000, 9000, 0x02), ...frames(4)), TYPES.webp), "decompression_bomb"), undefined);
  const g = (n) => gif({ frames: Array.from({ length: n }, () => ({ w: 9000, h: 9000 })) });
  assert.equal(has(triageImage(g(5), TYPES.gif), "decompression_bomb")?.severity, "block");
  assert.equal(triageImage(g(5), TYPES.gif).verdict, "block");
  assert.equal(has(triageImage(g(4), TYPES.gif), "decompression_bomb"), undefined);
});

test("webp: a VP8L with a non-zero version (bits 29-31) is refused", () => {
  const good = webp({ kind: "vp8l", w: 10, h: 10 }), bad = Uint8Array.from(good);
  const at = 12 + 8 + 4;   // the fourth byte after the signature holds bits 24..31 of the header word
  bad[at] |= 0x20;
  assert.equal(triageImage(good, TYPES.webp).verdict, "allow_with_limits");
  const r = triageImage(bad, TYPES.webp);
  assert.equal(r.verdict, "needs_sandbox"); assert.ok(has(r, "malformed"), JSON.stringify(r.markers));
});

test("download: the object's own size is compared before the body is read, and the policy's max_bytes caps it", async () => {
  const body = enc("%PDF-hello"), sha256 = await sha256Hex(body);
  let reads = 0;
  const bucket = { async get() { return { size: 999_999_999, arrayBuffer: async () => { reads++; return body.buffer; } }; } };
  const rec = (o = {}) => ({ stage: "released", size_bytes: body.length, sha256, declared: { filename_normalised: "a.pdf" }, sniffed: { type: "application/pdf" }, storage: { released_key: "r/k" }, ...o });
  const res = await downloadResponse({ record: rec(), bucket });
  assert.equal(res.status, 500); assert.equal(reads, 0, "a size mismatch is refused before arrayBuffer()");
  const real = memoryBucket(); await real.put("r/k", body);
  assert.equal((await downloadResponse({ record: rec(), bucket: real, policy: { max_bytes: body.length } })).status, 200);
  let reads2 = 0;
  const counting = { async get() { return { size: body.length, arrayBuffer: async () => { reads2++; return body.buffer; } }; } };
  const capped = await downloadResponse({ record: rec(), bucket: counting, policy: { max_bytes: body.length - 1 } });
  assert.equal(capped.status, 500); assert.equal(reads2, 0, "over the policy cap: refused before the read");
});

/* ---------- review 8 ---------- */
const vp8lPayload = (w, h) => { const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14); return cat(Uint8Array.of(0x2f), le32(v >>> 0)); };

test("webp: the inner frame's own size counts (5000 frames with a 1x1 ANMF header and a 10000x10000 VP8L inside are a bomb), and an inner frame larger than its header is malformed", () => {
  const lie = anmf(1, 1, wchunk("VP8L", vp8lPayload(10000, 10000)));
  const r = triageImage(riff(vp8x(1, 1, 0x02), ...Array.from({ length: 5000 }, () => lie)), TYPES.webp);
  assert.equal(has(r, "decompression_bomb")?.severity, "block", JSON.stringify(r.markers)); assert.equal(r.verdict, "block");
  assert.ok(has(r, "malformed"), "the header/inner mismatch");
  const one = triageImage(riff(vp8x(1, 1, 0x02), anmf(1, 1, wchunk("VP8L", vp8lPayload(12000, 12000)))), TYPES.webp);
  assert.equal(has(one, "huge_dimensions")?.severity, "needs_sandbox", "the inner size gets the per-frame check"); assert.ok(has(one, "malformed"));
  const honest = triageImage(riff(vp8x(64, 64, 0x02), anmf(64, 64, wchunk("VP8L", vp8lPayload(64, 64)))), TYPES.webp);
  assert.equal(honest.verdict, "allow_with_limits", JSON.stringify(honest));
  const smaller = triageImage(riff(vp8x(64, 64, 0x02), anmf(64, 64, wchunk("VP8L", vp8lPayload(32, 32)))), TYPES.webp);
  assert.equal(smaller.verdict, "allow_with_limits", "an inner frame smaller than its header is not larger than it");
});

test("webp: 1-7 bytes after the last chunk, or an odd last chunk whose pad byte lies beyond the end, are malformed, never clean", () => {
  const sized = (body) => cat("RIFF", le32(body.length + 4), "WEBP", body);   // the RIFF size covers exactly this body
  const image = wchunk("VP8 ", vp8(1, 1));
  assert.equal(triageImage(sized(image), TYPES.webp).verdict, "allow_with_limits");
  for (const extra of [1, 3, 7]) {
    const r = triageImage(sized(cat(image, new Uint8Array(extra))), TYPES.webp);
    assert.equal(r.verdict, "needs_sandbox", `${extra} stray bytes`); assert.ok(has(r, "malformed"), `${extra}: ${JSON.stringify(r.markers)}`);
  }
  const unpadded = cat(image, "EXIF", le32(3), enc("abc"));   // odd length, its pad byte is not there
  const r = triageImage(sized(unpadded), TYPES.webp);
  assert.equal(r.verdict, "needs_sandbox"); assert.ok(has(r, "malformed"), JSON.stringify(r.markers));
  assert.equal(triageImage(sized(cat(image, wchunk("EXIF", enc("abc")))), TYPES.webp).verdict, "allow_with_limits", "padded: fine (metadata is info)");
});

/* ---------- review 9 ---------- */
const anmfRaw = (x, y, w, h, subs) => wchunk("ANMF", cat(le24(x), le24(y), le24(w - 1), le24(h - 1), le24(100), Uint8Array.of(0), subs));
const okImage = (w, h) => wchunk("VP8 ", vp8(w, h));

test("webp: an ANMF holds exactly one image sub-chunk and its sub-chunks tile the payload exactly", () => {
  const file = (frame) => riff(vp8x(64, 64, 0x12), frame);
  assert.equal(triageImage(file(anmfRaw(0, 0, 8, 8, cat(wchunk("ALPH", Uint8Array.of(0, 1, 2, 3)), okImage(8, 8)))), TYPES.webp).verdict, "allow_with_limits");
  const cases = {
    "two image sub-chunks": anmfRaw(0, 0, 8, 8, cat(okImage(8, 8), wchunk("VP8L", vp8lPayload(8, 8)))),
    "a second, really larger image sub-chunk": anmfRaw(0, 0, 8, 8, cat(okImage(8, 8), okImage(40, 40))),
    "trailing bytes after the sub-chunks": anmfRaw(0, 0, 8, 8, cat(okImage(8, 8), Uint8Array.of(1, 2, 3))),
    "a sub-chunk header cut short": anmfRaw(0, 0, 8, 8, cat(okImage(8, 8), enc("EXIF"))),
    "an odd sub-chunk whose pad byte lies past the ANMF payload": wchunk("ANMF", cat(le24(0), le24(0), le24(7), le24(7), le24(100), Uint8Array.of(0), "VP8L", le32(5), vp8lPayload(8, 8))),
    "no image sub-chunk": anmfRaw(0, 0, 8, 8, wchunk("ALPH", Uint8Array.of(0, 1, 2, 3))),
  };
  for (const [name, frame] of Object.entries(cases)) {
    const r = triageImage(file(frame), TYPES.webp);
    assert.equal(r.verdict, "needs_sandbox", name); assert.ok(has(r, "malformed"), `${name}: ${JSON.stringify(r.markers)}`);
  }
  const extra = triageImage(file(anmfRaw(0, 0, 8, 8, cat(okImage(8, 8), wchunk("VP8L", vp8lPayload(12000, 12000))))), TYPES.webp);
  assert.ok(has(extra, "malformed") && has(extra, "huge_dimensions"), "the extra image sub-chunk is still bounded"); assert.equal(extra.verdict, "needs_sandbox");
});

test("webp: a frame (offset plus size) beyond the VP8X canvas is malformed", () => {
  const f = (x, y, w, h) => triageImage(riff(vp8x(64, 64, 0x12), anmfRaw(x, y, w, h, okImage(w, h))), TYPES.webp);
  assert.equal(f(0, 0, 64, 64).verdict, "allow_with_limits");
  assert.equal(f(16, 16, 32, 32).verdict, "allow_with_limits", "offset 32 + 32 = 64: exactly the canvas");
  for (const [name, r] of [["offset past the edge", f(17, 0, 32, 32)], ["y offset", f(0, 17, 32, 32)], ["larger than the canvas", f(0, 0, 65, 8)], ["far away", f(5000, 5000, 8, 8)]]) {
    assert.equal(r.verdict, "needs_sandbox", name); assert.ok(has(r, "malformed"), name);
  }
  const noCanvas = triageImage(cat("RIFF", le32(4 + okImage(1, 1).length + anmfRaw(0, 0, 8, 8, okImage(8, 8)).length), "WEBP", okImage(1, 1), anmfRaw(0, 0, 8, 8, okImage(8, 8))), TYPES.webp);
  assert.ok(has(noCanvas, "malformed"), "an ANMF with no VP8X canvas to be inside"); assert.equal(noCanvas.verdict, "needs_sandbox");
});

test("webp: a second VP8X chunk is malformed: it must not replace the canvas an animation frame is checked against", () => {
  // VP8X 64x64, then VP8X 10000x10000, then a frame at 9000,9000 (the ANMF offset field is in units of 2 pixels): inside the second canvas, outside the first
  const r = triageImage(riff(vp8x(64, 64, 0x12), vp8x(10000, 10000, 0x12), anmfRaw(4500, 4500, 8, 8, okImage(8, 8))), TYPES.webp);
  assert.equal(r.verdict, "needs_sandbox"); assert.ok(has(r, "malformed"), JSON.stringify(r.markers));
  assert.match(has(r, "malformed").first_ref, /VP8X/);
  assert.equal(triageImage(riff(vp8x(64, 64, 0x12), anmfRaw(4, 4, 8, 8, okImage(8, 8))), TYPES.webp).verdict, "allow_with_limits", "one canvas, a frame inside it: clean");
});
