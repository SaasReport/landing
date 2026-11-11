// PDF triage: every marker is a mutation test. Each name token of PDF_MARKERS is built into a PDF three ways (plain, with a #xx
// escape, inside a Flate object stream) and must be found each time; the same PDF without the token must not report it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { triagePdf, PDF_MARKERS, PDF_STRUCTURAL } from "../src/triage/pdf.js";
import { resolveLimits } from "../src/limits.js";
import { STATEMENTS } from "../src/triage/collector.js";
import { cat, enc, pdf, pdfWithObjStm, zip } from "./fixtures.mjs";

const L = resolveLimits();
const run = (b, limits = L) => triagePdf(b, limits);
const has = (r, name) => r.markers.find((m) => m.name === name);
const obf = (name) => name.replace(/[A-Za-z0-9]/, (c) => `#${c.charCodeAt(0).toString(16).toUpperCase()}`);   // first letter as #xx
const entry = (name) => `<< /Type /Catalog /Pages 2 0 R /${name} 3 0 R >>`;
const ascii85 = (bytes) => { let out = "<~"; for (let i = 0; i < bytes.length; i += 4) { const chunk = bytes.subarray(i, i + 4); const n = chunk.length; let v = 0; for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0); if (n === 4 && v === 0) { out += "z"; continue; } const d = []; for (let k = 0; k < 5; k++) { d.unshift(v % 85); v = Math.floor(v / 85); } out += d.slice(0, n + 1).map((x) => String.fromCharCode(x + 33)).join(""); } return enc(`${out}~>`); };
const asciiHex = (bytes) => enc([...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") + ">");

test("a plain PDF with nothing in it: no markers, complete, and the statement never says safe", async () => {
  const r = await run(pdf());
  assert.deepEqual(r.markers, []);
  assert.equal(r.complete, true);
  assert.equal(r.verdict, "allow_with_limits");
  assert.equal(r.statement, STATEMENTS.none);
  assert.ok(!/\b(safe|clean)\b/i.test(JSON.stringify(r)));
});

for (const [name, def] of Object.entries(PDF_MARKERS)) {
  test(`marker /${name} (${def.severity}): found plain, obfuscated with #xx, and inside a compressed object stream; absent when not there`, async () => {
    const forms = {
      plain: pdf([entry(name), "<< /Type /Pages /Kids [] /Count 0 >>"]),
      obfuscated: pdf([entry(obf(name)), "<< /Type /Pages /Kids [] /Count 0 >>"]),
      objstm: pdfWithObjStm(`<< /${name} 1 0 R >>`),
      objstmObfuscated: pdfWithObjStm(`<< /${obf(name)} 1 0 R >>`),
    };
    for (const [how, bytes] of Object.entries(forms)) {
      const r = await run(bytes);
      const m = has(r, name);
      assert.ok(m, `${name} not found (${how}): ${JSON.stringify(r.markers)}`);
      assert.equal(m.severity, def.severity, `${name} severity (${how})`);
      assert.ok(m.count >= 1 && m.first_ref, `${name} count/ref (${how})`);
      if (def.severity === "block") assert.equal(r.verdict, "block", `${name} (${how})`);
      if (def.severity === "needs_sandbox") assert.ok(["needs_sandbox", "block"].includes(r.verdict), `${name} (${how})`);
    }
    assert.equal(has(await run(pdf()), name), undefined);
    assert.equal(Boolean(has(await run(pdfWithObjStm("<< /Harmless 1 >>")), name)), name === "ObjStm");   // the carrier object stream is itself an ObjStm
  });
}

test("the markers inside an object stream are found whatever the filter chain (ASCIIHex, ASCII85, chains, abbreviations)", async () => {
  const inner = "<< /JavaScript 1 0 R >>";
  const z = (b) => new Uint8Array(deflateSync(b));
  const cases = {
    "AHx": pdfWithObjStm(inner, { filter: "/Filter /ASCIIHexDecode", encode: asciiHex }),
    "A85": pdfWithObjStm(inner, { filter: "/Filter /ASCII85Decode", encode: ascii85 }),
    "A85 then Flate": pdfWithObjStm(inner, { filter: "/Filter [/ASCII85Decode /FlateDecode]", encode: (b) => ascii85(z(b)) }),
    "AHx then Flate abbreviated": pdfWithObjStm(inner, { filter: "/Filter [/AHx /Fl]", encode: (b) => asciiHex(z(b)) }),
    "Fl abbreviated": pdfWithObjStm(inner, { filter: "/Filter /Fl", encode: z }),
  };
  for (const [name, bytes] of Object.entries(cases)) { const r = await run(bytes); assert.ok(has(r, "JavaScript"), `${name}: ${JSON.stringify(r.markers)}`); assert.equal(r.verdict, "block"); }
});

test("an object stream with an unknown filter or a chain over the limit is incomplete (needs_sandbox), never a pass", async () => {
  const r = await run(pdfWithObjStm("<< /Harmless 1 >>", { filter: "/Filter /JBIG2Decode", encode: (b) => b }));
  assert.equal(r.complete, false); assert.ok(has(r, "unknown_filter")); assert.equal(r.verdict, "needs_sandbox");
  const deep = await run(pdfWithObjStm("<< /Harmless 1 >>", { filter: "/Filter [/Fl /Fl /Fl /Fl]", encode: (b) => b }));
  assert.equal(deep.complete, false); assert.ok(has(deep, "filter_chain_too_deep")); assert.equal(deep.verdict, "needs_sandbox");
  const bad = await run(pdfWithObjStm("<< /Harmless 1 >>", { encode: () => enc("this is not flate data at all") }));
  assert.equal(bad.complete, false); assert.ok(has(bad, "objstm_undecodable")); assert.equal(bad.verdict, "needs_sandbox");
});

test("a decompression bomb in an object stream is blocked, by the output cap and by the ratio", async () => {
  const zeros = new Uint8Array(30 * 1024 * 1024);
  const bomb = pdfWithObjStm("<< /A 1 >>", { encode: () => new Uint8Array(deflateSync(zeros)) });
  const r = await run(bomb);
  assert.ok(has(r, "decompression_bomb"), JSON.stringify(r.markers)); assert.equal(r.verdict, "block"); assert.equal(r.reason_code, "archive_bomb");
  const capped = await run(bomb, resolveLimits({ max_pdf_decoded_bytes: 1024 * 1024 }));
  assert.ok(has(capped, "decompression_bomb"));
});

test("structural markers: every one has a fixture", async () => {
  const fixtures = {
    pdf_header_offset: pdf(undefined, { header: "junk line\n%PDF-1.7\n" }),
    polyglot_data: pdf(undefined, { tail: `${" ".repeat(2000)}PK\x03\x04 zip glued after the end` }),
    trailing_data: pdf(undefined, { tail: "x".repeat(2000) }),
    incremental_updates: pdf(undefined, { updates: 2 }),
    malformed_xref: pdf(undefined, { startxref: 3 }),
    truncated: pdf(undefined, { eof: false }),
    unterminated_stream: enc("%PDF-1.7\n1 0 obj\n<< /Length 10 >>\nstream\nabcdef"),
    unterminated_object: enc("%PDF-1.7\n1 0 obj\n<< /A 1 >>\n" + "x".repeat(40) + "\n%%EOF\n"),
    nesting_too_deep: pdf([`${"[".repeat(80)}${"]".repeat(80)}`]),
    unknown_filter: pdfWithObjStm("<< /A 1 >>", { filter: "/Filter /CCITTFaxDecode", encode: (b) => b }),
    filter_chain_too_deep: pdfWithObjStm("<< /A 1 >>", { filter: "/Filter [/Fl /Fl /Fl /Fl]", encode: (b) => b }),
    objstm_undecodable: pdfWithObjStm("<< /A 1 >>", { encode: () => enc("not flate") }),
    decompression_bomb: pdfWithObjStm("<< /A 1 >>", { encode: () => new Uint8Array(deflateSync(new Uint8Array(30 * 1024 * 1024))) }),
  };
  const objectLimit = await run(pdf(Array.from({ length: 20 }, () => "<< /A 1 >>")), resolveLimits({ max_pdf_objects: 5 }));
  assert.ok(has(objectLimit, "object_limit")); assert.equal(objectLimit.complete, false);
  for (const name of Object.keys(PDF_STRUCTURAL)) {
    if (name === "object_limit") continue;
    assert.ok(fixtures[name], `no fixture for structural marker ${name}`);
    const r = await run(fixtures[name]);
    const m = has(r, name);
    assert.ok(m, `${name}: ${JSON.stringify(r.markers)}`);
    assert.equal(m.severity, PDF_STRUCTURAL[name], name);
  }
});

test("a linearized PDF's second %%EOF is not an alarm; an ordinary incremental update is", async () => {
  assert.equal(has(await run(pdf(undefined, { linearized: true, updates: 1 })), "incremental_updates").severity, "info");
  assert.equal(has(await run(pdf(undefined, { updates: 1 })), "incremental_updates").severity, "needs_sandbox");
  assert.equal(has(await run(pdf()), "incremental_updates"), undefined);
});

test("strings and content streams do not count as markers (a name inside a string, page text mentioning /JS)", async () => {
  const r = await run(pdf(["<< /Type /Catalog /Pages 2 0 R /Title (the /JS and /Launch actions are described here) >>", "<< /Length 25 >>\nstream\nBT /F1 12 Tf (/JavaScript) Tj ET\nendstream"]));
  assert.deepEqual(r.markers, []);
});

test("an incomplete analysis is never reported as 'no markers found'", async () => {
  const r = await run(pdf(undefined, { eof: false }));
  assert.equal(r.complete, false); assert.equal(r.verdict, "needs_sandbox"); assert.notEqual(r.statement, STATEMENTS.none);
});

test("not a PDF at all is incomplete", async () => {
  const r = await run(enc("hello"));
  assert.equal(r.complete, false); assert.equal(r.verdict, "needs_sandbox");
});

test("garbage and truncated bytes never throw", async () => {
  const good = pdf(["<< /OpenAction 1 0 R /JS (x) >>"]);
  for (let cut = 8; cut < good.length; cut += 7) await run(good.subarray(0, cut));
  const noise = new Uint8Array(5000).map((_, i) => (i * 131 + 7) & 255);
  await run(cat("%PDF-1.4\n", noise));
  await run(zip([{ name: "x", data: "y" }]));
});
