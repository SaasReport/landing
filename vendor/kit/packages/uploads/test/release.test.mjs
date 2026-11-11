// The release and serve guarantee, structurally: the released bytes end at the container's own end, and a released object is only ever served
// with its sniffed content type, nosniff, an attachment unless the policy declares the kind inline-safe, and the image CSP when inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, validateRecord, validatePolicy, validateServeHeaders, serveHeaders, downloadResponse, containerEnd, sha256Hex, readObject, SERVE_CSP, INLINE_IMAGE_CSP, INLINE_TYPES, SCHEMAS } from "../src/index.js";
import { cat, enc, png, jpeg, gif, webp, pdf } from "./fixtures.mjs";

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const rawConfig = () => ({
  schema: "kit.uploads-config.v1", project: "saasreport",
  storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } },
  forms: {
    pics: { id: "pics-attachment", file_fields: [{ name: "attachment" }], allowed_types: [...IMAGES, "application/pdf"], max_bytes: 5 * 1024 * 1024, retention_days: 30, on_needs_sandbox: "release_download_only", scanner: "fake-av", serve: { inline_types: ["image/png", "image/jpeg"] } },
  },
});
const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: "allow", signature_db_version: "db" }) } };
function setup() {
  const env = { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() }, records = memoryRecords();
  const config = loadUploadsConfig(rawConfig(), { registry, scanners });
  const uploads = createUploads({ config, env, scanners, records, now: () => new Date("2026-10-07T12:00:00Z") });
  return { env, records, uploads, config };
}
const hex = (b) => sha256Hex(b);
const FORMATS = [["png", png, "image/png"], ["jpeg", jpeg, "image/jpeg"], ["gif", gif, "image/gif"], ["webp", webp, "image/webp"]];

test("containerEnd: the container's own end, whatever follows (a fake IEND, EOI or trailer after the end, an EOI inside a thumbnail, more than one scan)", () => {
  for (const [name, make, type] of FORMATS) {
    const clean = make();
    assert.equal(containerEnd(clean, type), clean.length, name);
    for (const tail of [enc("x"), enc("<script>alert(1)</script>"), cat(Uint8Array.of(0xff, 0xd9), Uint8Array.of(0x3b), enc("IEND\0\0\0\0")), new Uint8Array(100000)]) assert.equal(containerEnd(make({ trailing: tail }), type), clean.length, `${name} + ${tail.length} bytes`);
  }
  const seg = (m, d) => cat(Uint8Array.of(0xff, m, (d.length + 2) >> 8, (d.length + 2) & 255), d);
  // a progressive-style JPEG: an APP1 thumbnail that itself ends in FFD9, two scans (stuffed FF00 and a restart marker are data), then EOI, then a second image appended
  const thumb = seg(0xe1, cat("Exif\0\0", Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
  const sof = seg(0xc2, Uint8Array.of(8, 0, 1, 0, 1, 1, 1, 0x11, 0));
  const scan = (data) => cat(seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), data);
  const body = cat(Uint8Array.of(0xff, 0xd8), thumb, sof, scan(Uint8Array.of(1, 0xff, 0, 2, 0xff, 0xd0, 3)), seg(0xc4, Uint8Array.of(0, 1, 2)), scan(Uint8Array.of(4, 5, 0xff, 0xff)), Uint8Array.of(0xff, 0xd9));
  assert.equal(containerEnd(cat(body, jpeg()), "image/jpeg"), body.length, "the first EOI that is a marker, not the last one in the file");
  // a GIF with an extension, a local colour table and sub-blocks, then a trailer, then bytes that contain a trailer
  const g = cat("GIF89a", Uint8Array.of(1, 0, 1, 0, 0x80, 0, 0), new Uint8Array(6), Uint8Array.of(0x21, 0xf9, 4, 0, 0, 0, 0, 0), Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0), Uint8Array.of(2, 3, 0x3b, 0x3b, 0x3b, 0, 0x3b));
  assert.equal(containerEnd(cat(g, enc(";;;;")), "image/gif"), g.length);
  // structures that cannot be followed, and other types, have no end
  for (const [bytes, type] of [[png({ noIend: true }), "image/png"], [jpeg({ eoi: false }), "image/jpeg"], [gif({ trailer: false }), "image/gif"], [webp({ lieLen: 9999 }), "image/webp"], [pdf(), "application/pdf"], [enc("x"), "text/plain"]]) assert.equal(containerEnd(bytes, type), -1, type);
});

test("release: what follows the container is cut off before anything is stored or released, and recorded", async () => {
  for (const [name, make, type] of FORMATS) {
    for (const tail of [enc("trailing camera junk"), cat(Uint8Array.of(0xff, 0xd9), enc("IEND")), new Uint8Array(300)]) {
      const { uploads, env } = setup();
      const clean = make(), received = make({ trailing: tail });
      const { record } = await uploads.intake({ form: "pics", bytes: received, filename: `a.${name}`, contentType: type });
      assert.equal(record.sniffed.type, type, name);
      assert.equal(record.size_bytes, clean.length, `${name}: the stored size`); assert.equal(record.sha256, await hex(clean), `${name}: the hash of the stored bytes`);
      assert.deepEqual(record.trailing_stripped, { bytes: tail.length, original_size: received.length, original_sha256: await hex(received) }, name);
      assert.deepEqual(validateRecord(record), [], name);
      assert.equal(record.stage, "released", `${name}: ${record.stage} ${record.verdict} ${record.reason_code}`);
      for (const bucket of [env.UPLOADS_QUARANTINE, env.UPLOADS_RELEASED]) {
        const keys = (await bucket.list({ prefix: "" })).objects.map((o) => o.key).filter((k) => !k.startsWith("evidence/"));
        assert.equal(keys.length, 1, name);
        assert.deepEqual(await readObject(bucket, keys[0]), clean, `${name}: the object ends at the container's end`);
      }
    }
    const { uploads } = setup();
    const { record } = await uploads.intake({ form: "pics", bytes: make(), filename: `a.${name}`, contentType: type });
    assert.equal(record.trailing_stripped, undefined, `${name}: nothing to strip`); assert.equal(record.size_bytes, make().length);
  }
});

test("release: a script or a second format glued after the image is still blocked (the scan stays as defence in depth), and no byte of it is stored", async () => {
  for (const [name, make, type] of FORMATS) {
    const { uploads, env } = setup();
    const received = make({ trailing: enc("<script>alert(1)</script>") });
    const { record } = await uploads.intake({ form: "pics", bytes: received, filename: `a.${name}`, contentType: type });
    assert.notEqual(record.stage, "released", name); assert.equal(record.trailing_stripped.bytes, 25, name);
    for (const bucket of [env.UPLOADS_QUARANTINE, env.UPLOADS_RELEASED]) for (const o of (await bucket.list({ prefix: "" })).objects) { const b = await readObject(bucket, o.key); assert.ok(!new TextDecoder("latin1").decode(b).includes("<script"), `${name} ${o.key}`); }
  }
});

/* ---------- serving ---------- */
const headersOf = (o) => serveHeaders({ filename: "a", size: 3, ...o });
const record = (type, over = {}) => ({ stage: "released", size_bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", declared: { filename_normalised: "a.bin" }, sniffed: { type }, storage: { released_key: "r/k" }, triage: { complete: true, markers: [] }, ...over });

test("serve: every kind is served with its sniffed content type, nosniff and an attachment, and the response validates against kit.upload-serve.v1", () => {
  assert.equal(SCHEMAS.serve.title, "kit.upload-serve.v1");
  for (const type of ["application/pdf", ...IMAGES, "text/plain", "application/json", "application/zip", "image/svg+xml", "text/html", "application/xml", "application/javascript", "weird/thing", undefined]) {
    const h = headersOf({ type });
    assert.deepEqual(validateServeHeaders(h), [], String(type));
    assert.equal(h.get("x-content-type-options"), "nosniff"); assert.match(h.get("content-disposition"), /^attachment;/, String(type)); assert.equal(h.get("content-security-policy"), SERVE_CSP);
    assert.ok(!/html|svg|xml|javascript/.test(h.get("content-type")), String(type));
  }
  assert.equal(headersOf({ type: "image/png" }).get("content-type"), "image/png");
});

test("serve: inline only for a raster image the policy declares, under the restrictive image CSP; never for anything else, whatever is asked", () => {
  assert.equal(INLINE_IMAGE_CSP, "default-src 'none'; img-src 'self'; style-src 'none'; sandbox");
  for (const type of IMAGES) {
    const h = headersOf({ type, inline: true });
    assert.deepEqual(validateServeHeaders(h), [], type); assert.equal(h.get("content-disposition"), "inline"); assert.equal(h.get("content-security-policy"), INLINE_IMAGE_CSP); assert.equal(h.get("x-content-type-options"), "nosniff"); assert.equal(h.get("content-type"), type);
  }
  for (const type of ["image/svg+xml", "text/html", "application/pdf", "text/plain", "application/xml", "application/zip", undefined]) {
    const h = headersOf({ type, inline: true });
    assert.match(h.get("content-disposition"), /^attachment;/, String(type)); assert.equal(h.get("content-security-policy"), SERVE_CSP); assert.deepEqual(validateServeHeaders(h), [], String(type));
  }
  assert.match(headersOf({ type: "image/png", inline: "yes" }).get("content-disposition"), /^attachment;/, "only inline === true");
  assert.deepEqual([...INLINE_TYPES], [...SCHEMAS.policy.properties.serve.properties.inline_types.items.enum]);
});

test("serve: the policy declares what is inline-safe (schema), svg and documents cannot be declared, and downloadResponse follows the policy", async () => {
  const base = { id: "pics-attachment", file_fields: [{ name: "a" }], allowed_types: ["image/png"], max_bytes: 10, retention_days: 1, on_needs_sandbox: "hold" };
  assert.deepEqual(validatePolicy({ ...base, serve: { inline_types: ["image/png", "image/webp"] } }), []);
  for (const bad of [["image/svg+xml"], ["text/html"], ["application/pdf"], ["image/png", "image/png"], ["*"]]) assert.ok(validatePolicy({ ...base, serve: { inline_types: bad } }).length > 0, JSON.stringify(bad));
  const bucket = memoryBucket(); await bucket.put("r/k", enc("abc"));
  const inline = { serve: { inline_types: ["image/png"] } };
  const res = await downloadResponse({ record: record("image/png"), bucket, policy: inline });
  assert.equal(res.status, 200); assert.deepEqual(validateServeHeaders(res.headers), []); assert.equal(res.headers.get("content-disposition"), "inline"); assert.equal(res.headers.get("content-security-policy"), INLINE_IMAGE_CSP);
  for (const [rec, policy] of [[record("image/png"), null], [record("image/png"), {}], [record("image/png"), { serve: {} }], [record("image/jpeg"), inline], [record("application/pdf"), inline], [record("image/svg+xml"), { serve: { inline_types: ["image/svg+xml"] } }]]) {
    const r = await downloadResponse({ record: rec, bucket, policy });
    assert.match(r.headers.get("content-disposition"), /^attachment;/, rec.sniffed.type); assert.deepEqual(validateServeHeaders(r.headers), []);
  }
});

test("serve contract: a response without nosniff, with a runnable content type, an inline non-image, or the wrong CSP fails validation", () => {
  const good = Object.fromEntries(headersOf({ type: "application/pdf" }).entries());
  assert.deepEqual(validateServeHeaders(good), []);
  const bad = (mut, re) => { const h = { ...good }; mut(h); const p = validateServeHeaders(h); assert.ok(p.length > 0 && (!re || p.some((x) => re.test(x))), `${JSON.stringify(re)}: ${p.join(" | ")}`); };
  bad((h) => { delete h["x-content-type-options"]; }, /x-content-type-options/);
  bad((h) => { h["x-content-type-options"] = "sniff"; }, /x-content-type-options/);
  bad((h) => { delete h["content-disposition"]; }, /content-disposition/);
  bad((h) => { h["content-disposition"] = "inline"; });          // inline needs an image type and the image CSP
  bad((h) => { delete h["content-security-policy"]; }, /content-security-policy/);
  bad((h) => { h["content-type"] = "text/html"; });
  bad((h) => { h["content-type"] = "image/svg+xml"; });
  bad((h) => { h["content-security-policy"] = "default-src 'none'"; });
  bad((h) => { delete h["content-type"]; }, /content-type/);
  const inline = Object.fromEntries(headersOf({ type: "image/png", inline: true }).entries());
  assert.deepEqual(validateServeHeaders(inline), []);
  const badInline = (mut) => { const h = { ...inline }; mut(h); assert.ok(validateServeHeaders(h).length > 0, JSON.stringify(h)); };
  badInline((h) => { h["content-security-policy"] = SERVE_CSP; });
  badInline((h) => { h["content-security-policy"] = "default-src 'none'; img-src *; sandbox"; });
  badInline((h) => { h["content-type"] = "application/pdf"; });
  badInline((h) => { delete h["x-content-type-options"]; });
});
