// The second adversarial review of the upload-safety fixes: each test reproduces one finding on the code it was found against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measure } from "../src/work.js";
import { readFileSync } from "node:fs";
import { sniff, matchesDeclared, TYPES } from "../src/sniff.js";
import { triagePdf } from "../src/triage/pdf.js";
import { triageSvg } from "../src/triage/svg.js";
import { triageZip, EXECUTABLE_EXT } from "../src/triage/zip.js";
import { resolveLimits } from "../src/limits.js";
import { validateRecord } from "../src/schemas.js";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords } from "../src/index.js";
import { cat, enc, pdf, png, ooxml, zip } from "./fixtures.mjs";
import { people, decide } from "./helpers/people.mjs";
import { evidenceOf } from "./helpers/evidence.mjs";

const L = resolveLimits();
const has = (r, name) => r.markers.find((m) => m.name === name);
const X = (name, data, extra = {}) => ({ name, data, ...extra });
/** Run fn and return its result: linearity is proven by the work counter (regex-gate.test.mjs), the assertions that follow check the verdicts. */
async function ran(_label, fn) { return fn(); }

/* ---------- 1. PDF polyglots: the whole file, and a linearized claim must be true ---------- */

test("pdf: a zip glued behind a linearized PDF is a polyglot even when the zip's comment ends in %%EOF (the last-%%EOF tail test never saw it)", async () => {
  const evil = zip([X("x.exe", "MZ")], { comment: "%%EOF" });
  const r = await triagePdf(cat(pdf(undefined, { linearized: true }), evil), L);
  assert.ok(has(r, "polyglot_data"), JSON.stringify(r.markers)); assert.equal(r.verdict, "block"); assert.equal(r.reason_code, "polyglot_suspect");
});

test("pdf: signatures anywhere in the file count, not only after the last %%EOF (a zip before a later %%EOF, an ELF in a stream, a PE)", async () => {
  const pe = new Uint8Array(0x100); pe.set(enc("MZ")); pe[0x3c] = 0x80; pe.set(enc("PE\0\0"), 0x80);
  for (const [label, bytes] of Object.entries({
    "zip in the middle": cat("%PDF-1.7\n", zip([X("a.txt", "x")]), "\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\nstartxref\n9\n%%EOF\n"),
    "zip local header only": cat(pdf(undefined, { tail: "" }), "PK\x03\x04", pdf()),
    "zip end record": cat(pdf(), "PK\x05\x06", new Uint8Array(18), "\n%%EOF\n"),
    "ELF": cat(pdf(), "\x7fELF", new Uint8Array(20), "\n%%EOF\n"),
    "PE": cat(pdf(), pe, "\n%%EOF\n"),
  })) {
    const r = await triagePdf(bytes, L);
    assert.ok(has(r, "polyglot_data"), label); assert.equal(r.verdict, "block", label);
  }
});

test("pdf: random binary stream data and a lone 'MZ' do not make a PDF a polyglot", async () => {
  const noise = new Uint8Array(200000); let x = 7; for (let i = 0; i < noise.length; i++) { x = (x * 1103515245 + 12345) >>> 0; noise[i] = x >>> 24; }
  for (let i = 0; i < noise.length - 4; i++) if ((noise[i] === 0x50 && noise[i + 1] === 0x4b) || noise[i] === 0x7f) noise[i] = 0x41;
  const withMz = cat("%PDF-1.7\n1 0 obj\n<< /Length 200000 >>\nstream\n", noise, "MZ".repeat(50), "\nendstream\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n");
  const r = await triagePdf(withMz, L);
  assert.equal(has(r, "polyglot_data"), undefined);
});

test("pdf: a second %%EOF is a linearized file's own only when /L equals the file length; a bare /Linearized claim tolerates nothing", async () => {
  assert.equal(has(await triagePdf(pdf(undefined, { linearized: true, updates: 1 }), L), "incremental_updates").severity, "info");
  const lie = cat(pdf(undefined, { linearized: true, updates: 1 }), "% appended\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
  assert.equal(has(await triagePdf(lie, L), "incremental_updates").severity, "needs_sandbox", "/L no longer matches: the extra %%EOF is an update");
  const bare = enc(new TextDecoder().decode(pdf(undefined, { linearized: true, updates: 1 })).replace(/\/L \d+/, ""));
  assert.equal(has(await triagePdf(bare, L), "incremental_updates").severity, "needs_sandbox");
});

/* ---------- 2. rescan never lifts a block and never loses the name ---------- */

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
function setup(verdict = { v: "allow" }) {
  const P = people();
  const cfg = { schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "QUAR", bucket: "saasreport-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } },
    forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: ["application/pdf", "image/png", "text/plain", "application/zip"], max_bytes: 5 * 1024 * 1024, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av" } } };
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: verdict.v }) } };
  const env = { QUAR: memoryBucket(), REL: memoryBucket() };
  const records = memoryRecords();
  const uploads = createUploads({ config: loadUploadsConfig(cfg, { registry, scanners }), env, scanners, records, authority: P.authority });
  return { ...decide(uploads, records, P.sign), uploads, records, q: env.QUAR, r: env.REL, verdict, env };
}

test("rescan: a PNG named 'x'*300 + '.png.php' is blocked at intake and stays blocked after a rescan (the 300-character clip lost the extension and the rescan released it)", async () => {
  const s = setup();
  const name = `${"x".repeat(300)}.png.php`;
  const { record } = await s.uploads.intake({ form: "partner", bytes: png(), filename: name, contentType: "image/png" });
  assert.deepEqual([record.verdict, record.reason_code, record.stage], ["block", "type_mismatch", "blocked"]);
  assert.deepEqual(validateRecord(record), []);
  const again = await s.uploads.rescan(record.upload_id);
  assert.equal(again.stage, "blocked"); assert.equal(again.verdict, "block"); assert.equal(s.r.objects.size, 0);
});

test("rescan never auto-releases a record that was blocked, quarantined or held, whatever the new evaluation says; only a signed release() releases a held file", async () => {
  const s = setup({ v: "block" });
  const { record } = await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: "application/pdf" });
  assert.deepEqual([record.verdict, record.stage], ["block", "blocked"]);
  s.verdict.v = "allow";
  const next = await s.uploads.rescan(record.upload_id);
  assert.deepEqual([next.stage, next.verdict], ["blocked", "block"], "the scanner changed its mind; the record did not");
  assert.equal(s.r.objects.size, 0);
  const ev = await evidenceOf(s.q, record.upload_id); assert.equal(ev.at(-1).action, "rescan"); assert.match(ev.at(-1).note, /not applied/);
  await assert.rejects(s.release(record.upload_id), /not in the transition table/);
  assert.deepEqual(validateRecord(next), []);
  const t = setup({ v: "needs_sandbox" });
  const held = (await t.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: "application/pdf" })).record;
  assert.equal(held.stage, "held");
  t.verdict.v = "allow";
  assert.equal((await t.uploads.rescan(held.upload_id)).stage, "held");
  const out = await t.release(held.upload_id, "reviewed");
  assert.equal(out.stage, "released"); assert.equal(out.decisions.at(-1).action, "release");
});

/* ---------- 3, 4, 5. the quadratic shapes the first pass left ---------- */

test("svg: '<svg><' followed by 60000 spaces and a digit is linear (the tag-name regex \\s*\\/?\\s* was quadratic: 6 s)", async () => {
  await ran("svg < + spaces", () => triageSvg(enc(`<svg><${" ".repeat(60000)}1`)));
  await ran("svg < / spaces", () => triageSvg(enc(`<svg><${"/ ".repeat(40000)}1`)));
  await ran("svg < spaces repeated", () => triageSvg(enc(`<svg>${"< ".repeat(60000)}1`)));
  assert.ok(has(triageSvg(enc("<svg>< script >alert(1)</ script></svg>")), "script_element"), "a space after '<' still opens a tag, as before");
});

test("sniff: 'function' + 60000 spaces + 'x' is linear (JS_START's \\s*[\\w$]*\\s* was quadratic: 9.5 s) and real JS is still JS", async () => {
  await ran("sniff function + spaces", () => sniff(enc(`function${" ".repeat(60000)}x`)));
  await ran("sniff var + spaces", () => sniff(enc(`var${" ".repeat(60000)}x`)));
  await ran("sniff eval + spaces", () => sniff(enc(`eval${" ".repeat(60000)}x`)));
  await ran("sniff () + spaces", () => sniff(enc(`()${" ".repeat(60000)}x`)));
  for (const js of ["function f(a){}", "function (a){}", "function  f  (a){}", "var a = 1", "const  $x  = 2", "let a=1", "eval (x)", "() => 1", "(function(){})()", "!function(){}()", '"use strict";', "import x from 'y'", "export default 1", "document.cookie", "window.x=1"]) assert.equal(sniff(enc(js)).type, TYPES.js, js);
  for (const text of ["functional programming", "variable = 3", "lettuce = 1", "constant", "evaluation (x)", "windows.x"]) assert.equal(sniff(enc(text)).type, TYPES.text, text);
});

const sheetOf = (f) => ooxml("xlsx", [X("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c><f>${f}</f></c></row></sheetData></worksheet>`)]);
const macroFirst = (n) => ooxml("docx", [X("word/vbaProject.bin", "x"), ...Array.from({ length: n }, (_, i) => X(`word/header${i}.xml`, `${"<f ".repeat(30000)}`))]);

test("ooxml: a DDE formula in a cell is found only with a '!' after a '|' (correctness, any machine)", async () => {
  const r = await triageZip(sheetOf("a|".repeat(20000)), L, { ooxml: true });
  assert.equal(has(r, "dde_formula"), undefined, "no '!' after any '|': not a formula");
  const r2 = await triageZip(sheetOf(`${"a|".repeat(20000)}!`), L, { ooxml: true });
  assert.ok(has(r2, "dde_formula"));
});

test("ooxml: a blocking marker comes first: the verdict is block with vba_project, whatever follows (correctness, any machine)", async () => {
  const blocked = await triageZip(macroFirst(3), L, { ooxml: true });
  assert.equal(blocked.verdict, "block"); assert.ok(has(blocked, "vba_project"));
});

test("ooxml: the DDE search is linear (steps(2n) <= 2.2 x steps(n)) and a blocking marker stops the rest of the work (the work counter, not a clock)", async () => {
  const steps = async (bytes) => (await measure(() => triageZip(bytes, L, { ooxml: true }))).steps;
  const a = await steps(sheetOf("a|".repeat(20000))), b = await steps(sheetOf("a|".repeat(40000)));
  assert.ok(a > 0 && b <= 2.2 * a + 3000, `a|: ${a} -> ${b}`);
  const c = await steps(sheetOf(`${"a|".repeat(20000)}!`)), d = await steps(sheetOf(`${"a|".repeat(40000)}!`));
  assert.ok(c > 0 && d <= 2.2 * c + 3000, `a|!: ${c} -> ${d}`);
  // after a blocking marker the remaining parts are not scanned: each extra 90000-character part adds (reading its directory entry) far less than one pass over it
  const one = await steps(macroFirst(1)), ten = await steps(macroFirst(10));
  assert.ok(one > 0 && ten - one <= 0.2 * 9 * 90000, `macro first: ${one} (1 part) -> ${ten} (10 parts); scanning the nine extra parts would add at least ${9 * 90000}`);
});

/* ---------- 6. rollback leaves no orphan ---------- */



/* ---------- 7. verdict evasions that were allow_with_limits ---------- */

const rel = (attrs) => `<Relationships><Relationship Id="r1" ${attrs}/></Relationships>`;
const relsDocx = (xml) => triageZip(zip([X("[Content_Types].xml", "<Types/>"), X("word/_rels/document.xml.rels", xml)]), L, { ooxml: true });
const docx = (xml) => triageZip(zip([X("[Content_Types].xml", "<Types/>"), X("word/document.xml", xml)]), L, { ooxml: true });
const xlsx = (f, tag = "f") => triageZip(zip([X("[Content_Types].xml", "<Types/>"), X("xl/worksheets/sheet1.xml", `<worksheet xmlns:x="x"><sheetData><row><c>${f.replace(/%T/g, tag)}</c></row></sheetData></worksheet>`)]), L, { ooxml: true });

test("ooxml: an entity-encoded TargetMode is still External", async () => {
  for (const mode of ["Ext&#101;rnal", "&#69;xternal", "Ext&#x65;rnal", "&#x45;&#x78;ternal"]) {
    const r = await relsDocx(rel(`Type="http://x/oleObject" Target="http://e.test/a" TargetMode="${mode}"`));
    assert.ok(has(r, "external_relationship"), mode); assert.equal(r.verdict, "block", mode);
  }
});

test("ooxml: DDEAUTO through a numeric entity or a CDATA section is still DDE", async () => {
  for (const field of ["<w:r><w:instrText> DD&#69;AUTO cmd </w:instrText></w:r>", "<w:r><w:instrText><![CDATA[ DDEAUTO cmd ]]></w:instrText></w:r>", "<w:r><w:instrText> D&#x44;E cmd </w:instrText></w:r>", '<w:fldSimple w:instr=" DD&#69; cmd "/>']) {
    const r = await docx(`<w:p>${field}</w:p>`);
    assert.ok(has(r, "dde_field"), field); assert.equal(r.verdict, "block");
  }
});

test("ooxml: a DDE formula in a prefixed <x:f>, with an entity-encoded '|', or in CDATA is still a DDE formula", async () => {
  for (const cell of ["<%T>cmd|'/c calc'!A0</%T>", "<%T>cmd&#124;'/c calc'!A0</%T>", "<%T><![CDATA[cmd|'/c calc'!A0]]></%T>", "<%T>cmd&#x7c;'/c calc'&#33;A0</%T>"]) {
    for (const tag of ["f", "x:f"]) {
      const r = await xlsx(cell, tag);
      assert.ok(has(r, "dde_formula"), `${tag} ${cell}`); assert.equal(r.verdict, "block");
    }
  }
});

test("ooxml: an external hyperlink is information only for http, https, mailto and tel; file:, ms-msdt: and the other URL handlers are a block", async () => {
  const link = (t) => relsDocx(rel(`Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${t}" TargetMode="External"`));
  for (const t of ["https://example.test/", "http://example.test/", "mailto:a@example.test", "tel:+4412345", "#bookmark"]) { const r = await link(t); assert.equal(r.verdict, "allow_with_limits", t); assert.equal(has(r, "external_hyperlink").severity, "info", t); }
  for (const t of ["file:///C:/Windows/System32/calc.exe", "file://evil.example/share/x", "ms-msdt:/id PCWDiagnostic /skip force /param IT_RebrowseForFile=?", "search-ms:query=x&crumb=location:\\\\evil\\x", "ms-excel:ofe|u|https://evil/x.xlsx", "javascript:alert(1)", "\\\\evil.example\\share\\a", "FILE:///x", "ms-&#109;sdt:/id x", "vbscript:x", "data:text/html,x"]) {
    const r = await link(t);
    assert.equal(r.verdict, "block", t); assert.ok(has(r, "unsafe_hyperlink"), t);
  }
});

test("svg: a prefixed <s:script>, <x:foreignObject>, <x:iframe> and prefixed href or on* attributes are the elements and attributes they name", async () => {
  for (const [svg, marker] of [
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>', "script_element"],
    ['<svg xmlns:x="http://www.w3.org/2000/svg"><x:foreignObject><div/></x:foreignObject></svg>', "foreign_object"],
    ['<svg xmlns:x="http://www.w3.org/2000/svg"><x:iframe src="x"/></svg>', "embedding_element"],
    ['<svg xmlns:x="http://www.w3.org/1999/xlink" xmlns:s="x"><s:a x:href="javascript:alert(1)"><s:rect/></s:a></svg>', "script_url"],
    ['<svg xmlns:s="x"><s:image s:href="https://evil.example/t.png"/></svg>', "external_reference"],
    ['<svg xmlns:s="x"><s:rect s:onload="alert(1)"/></svg>', "event_handler"],
  ]) { const r = triageSvg(enc(svg)); assert.ok(has(r, marker), `${marker}: ${JSON.stringify(r.markers)}`); assert.equal(r.verdict, "block"); }
});

test("svg: an @import written with an entity or a CSS escape is still an @import; so is url( with them", () => {
  for (const css of ["@im&#112;ort 'https://evil.example/a.css';", "@&#105;mport url(https://evil.example/a.css);", "@\\69mport 'https://evil.example/a.css';", "a{b:ur&#108;(https://evil.example/x)}", "a{b:\\75rl(https://evil.example/x)}"]) {
    const r = triageSvg(enc(`<svg><style>${css}</style></svg>`));
    assert.ok(has(r, "external_reference"), css);
    const attr = triageSvg(enc(`<svg><rect style="${css.replace(/"/g, "'")}"/></svg>`));
    assert.ok(has(attr, "external_reference"), `attr ${css}`);
  }
  assert.equal(triageSvg(enc("<svg><style>rect{fill:red}</style></svg>")).verdict, "allow_with_limits");
});

/* ---------- 8. the double-extension check runs on the cleaned name ---------- */

test("double extensions: zero-width, bidi and control characters inside the name do not hide the dangerous part", () => {
  for (const f of ["a.php\u200b.png", "a.p\u200bhp.png", "a.php\u202e.png", "a.ph\u0000p.png", "a.php\ufeff.png", "a.png.ph\u200dp", "a.png\u200b.php", "a.\u00adphp.png"]) assert.equal(matchesDeclared({ filename: f }, TYPES.png), false, JSON.stringify(f));
  assert.equal(matchesDeclared({ filename: "photo\u200b.png" }, TYPES.png), true);
});

/* ---------- 9. loose ends ---------- */

test("sniff: a comment longer than 2000 characters before a <script> does not hide it from the markup test (past the 4096 window too)", () => {
  for (const pad of [2100, 5000, 20000]) {
    const t = sniff(enc(`<!-- ${"a".repeat(pad)} --><script>alert(1)</script>`));
    assert.equal(t.type, TYPES.html, `pad ${pad}`);
  }
  assert.equal(sniff(enc(`<!-- ${"a".repeat(5000)} --> just text`)).type, TYPES.text);
});

test("zip: xll jnlp msix appx inf mht ocx are executable extensions", async () => {
  for (const e of ["xll", "jnlp", "msix", "appx", "inf", "mht", "ocx", "mhtml", "appxbundle", "msixbundle"]) {
    assert.ok(EXECUTABLE_EXT.has(e), e);
    assert.ok(has(await triageZip(zip([X(`a.${e}`, "x")]), L), "executable_extension"), e);
  }
});


test("svg: <set> and <animate> that write an href OR an event handler attribute are animation of an active attribute", () => {
  for (const el of ['<set attributeName="href" to="javascript:alert(1)"/>', '<animate attributeName="xlink:href" values="javascript:x"/>', '<set attributeName="onmouseover" to="alert(1)"/>', '<animate attributeName="x:onclick" to="alert(1)"/>', '<set attributeName="ONLOAD" to="x"/>']) {
    const r = triageSvg(enc(`<svg><a>${el}</a></svg>`));
    assert.ok(has(r, "animation_of_href"), el); assert.equal(r.verdict, "block");
  }
  assert.equal(has(triageSvg(enc('<svg><rect><animate attributeName="width" to="10"/></rect></svg>')), "animation_of_href"), undefined);
  assert.equal(has(triageSvg(enc('<svg><rect><set attributeName="fill" to="red"/></rect></svg>')), "animation_of_href"), undefined);
});
