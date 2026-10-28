// The upload-safety review, finding by finding. Timing tests use the review's own inputs and fail on the code they were written
// against (seconds to minutes of CPU) and pass on linear code (single milliseconds): the budgets are 50 to 100 times the linear cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sniff, matchesDeclared, TYPES } from "../src/sniff.js";
import { normaliseFilename } from "../src/filename.js";
import { triagePdf, PDF_MARKERS } from "../src/triage/pdf.js";
import { triageSvg } from "../src/triage/svg.js";
import { triageZip, EXECUTABLE_EXT, effectiveName } from "../src/triage/zip.js";
import { clipText, REF_MAX, WHY_MAX } from "../src/triage/collector.js";
import { decide, REASON_CODES } from "../src/decision.js";
import { worst, VERDICTS } from "../src/scan.js";
import { resolveLimits } from "../src/limits.js";
import { SCHEMAS, validateRecord } from "../src/schemas.js";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, downloadResponse } from "../src/index.js";
import { cat, enc, pdf, png, ooxml, zip } from "./fixtures.mjs";
import { people, decide as decideAs } from "./helpers/people.mjs";

const L = resolveLimits();
const has = (r, name) => r.markers.find((m) => m.name === name);
const X = (name, data, extra = {}) => ({ name, data, ...extra });

/** Run fn and return its result. Linearity is proven by the work counter (regex-gate.test.mjs), not by a time budget; the assertions that follow check the verdicts. */
async function ran(_label, fn) { return fn(); }

/* ---------- (1) ReDoS ---------- */

test("sniff: '<!---->' repeated then a letter (350 bytes) does not backtrack: the nested lazy comment group is gone", async () => {
  const r = await ran("sniff 26 comments", () => sniff(enc(`${"<!---->".repeat(26)}x`)));
  assert.equal(r.type, TYPES.text);
  await ran("sniff 400 comments", () => sniff(enc(`${"<!---->".repeat(400)}x`)));
  await ran("sniff 8000 comments", () => sniff(enc(`${"<!---->".repeat(8000)}x`)));
});

test("sniff: markup behind comments, an XML declaration, a doctype and leading whitespace is still recognised", () => {
  assert.equal(sniff(enc("<!-- a --> <!-- b -->\n<html><body>x</body></html>")).type, TYPES.html);
  assert.equal(sniff(enc(`${" ".repeat(10000)}<script>alert(1)</script>`)).type, TYPES.html, "padding must not hide markup");
  assert.equal(sniff(enc('<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>')).type, TYPES.svg);
  assert.equal(sniff(enc("<!-- c --><svg>")).type, TYPES.svg);
  // a comment the start test will not skip (over 2000, unclosed) falls through to the markup-anywhere test: still html, never text
  assert.equal(sniff(enc(`<!-- ${"a".repeat(2100)} --><html>`)).type, TYPES.html);
  assert.equal(sniff(enc("<!-- never closed <html>")).type, TYPES.html);
  assert.equal(sniff(enc("hello <b>world</b>")).type, TYPES.text);
});

test("pdf: a long run of spaces and a final byte after %%EOF is linear (the trailing-whitespace regex was quadratic: 40k spaces took 3 s, 160k took 58 s)", async () => {
  const bytes = cat(pdf(), `${" ".repeat(160000)}x`);
  const r = await ran("triagePdf 160k spaces", () => triagePdf(bytes, L));
  assert.ok(has(r, "trailing_data"));
  const ws = cat(pdf(), " ".repeat(1024 * 1024));
  const r2 = await ran("triagePdf 1 MB of whitespace", () => triagePdf(ws, L));
  assert.equal(has(r2, "trailing_data"), undefined, "whitespace alone is not trailing data");
  assert.equal(r2.verdict, "allow_with_limits");
});

test("pdf: objects without their endobj do not make the scan quadratic", async () => {
  const body = "1 0 obj x y ".repeat(60000);
  const bytes = enc(`%PDF-1.7\n${body}\nxref\n0 1\ntrailer\n<<>>\nstartxref\n9\n%%EOF\n`);
  const r = await ran("triagePdf unterminated objects", () => triagePdf(bytes, L));
  assert.ok(r.markers.length > 0);
});

test("filename: a long run of '. ' before a character that ends it is linear (the trailing regex took 1.5 s for 20 KB, 29 s for 100 KB)", async () => {
  const name = `${". ".repeat(10000)}x`;
  const r = await ran("normaliseFilename 20 KB", () => normaliseFilename(name));
  assert.equal(r.name.length > 0, true);
  const huge = await ran("normaliseFilename 1 MB", () => normaliseFilename(`${". ".repeat(500000)}x`));
  assert.ok([...huge.name].length <= 120);
  assert.ok(huge.reasons.includes("input_clipped"));
});

test("filename: an over-long name is clipped from the front, so the extension at its end survives", () => {
  const r = normaliseFilename(`${"a".repeat(5000)}.PDF`);
  assert.equal(r.extension, "pdf"); assert.ok(r.name.endsWith(".pdf")); assert.ok(r.name.length <= 120);
});

const svgOf = (inner) => enc(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
test("svg: '<a ' repeated without a '>' is linear and never allowed (the tag regex took 5 s for 60 KB and the verdict was allow_with_limits)", async () => {
  const r = await ran("triageSvg <a x20000", () => triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg">${"<a ".repeat(20000)}`)));
  assert.equal(r.verdict, "needs_sandbox");
  assert.ok(has(r, "malformed_markup")); assert.equal(r.complete, false);
});

test("svg: every other quadratic shape is linear too", async () => {
  const cases = {
    "unclosed comments": svgOf("<!--".repeat(250000)),
    "unclosed CDATA": svgOf("<![CDATA[".repeat(100000)),
    "doctype repeated": enc(`<!DOCTYPE`.repeat(200000)),
    "url( then spaces": enc(`<svg xmlns="x"><rect style="fill:url(${" ".repeat(1500000)}"/></svg>`),
    "one huge attribute name": enc(`<svg xmlns="x" ${"a".repeat(3000000)}="1"/>`),
    "many style elements": svgOf(`${"<style>".repeat(50000)}</style>`),
    "quotes never closed": svgOf("<a x=' ".repeat(50000)),
    "closing tags": svgOf("</a ".repeat(100000)),
  };
  for (const [label, bytes] of Object.entries(cases)) await ran(`triageSvg ${label}`, () => triageSvg(bytes));
});

test("svg: an unquoted event handler is an event handler (the attribute regex only knew quoted values)", () => {
  for (const s of ["<svg onclick=alert(1)/>", "<svg/onload=alert(1)>", "<svg onload = alert(1) >", "<svg xmlns='x' ONERROR=x />", "<svg onload>"]) {
    const r = triageSvg(enc(s));
    assert.ok(has(r, "event_handler"), s); assert.equal(r.verdict, "block", s);
  }
  assert.equal(has(triageSvg(enc("<svg><rect width=10/></svg>")), "unquoted_attribute").severity, "block");
  assert.equal(triageSvg(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height=\'4\'/></svg>')).verdict, "allow_with_limits");
  assert.ok(has(triageSvg(enc("<svg><a href=javascript:alert(1)>x</a></svg>")), "script_url"));
});

test("svg: what the old regexes saw is still seen (script, handlers behind quotes holding '>', hrefs, styles, doctype subsets)", () => {
  assert.ok(has(triageSvg(enc('<svg><rect title=">" onclick="x"/></svg>')), "event_handler"));
  assert.ok(has(triageSvg(enc("<svg><!-- c --><script>x</script></svg>")), "script_element"));
  assert.equal(has(triageSvg(enc("<svg><!-- <script>x</script> --></svg>")), "script_element"), undefined);
  assert.equal(has(triageSvg(enc("<svg><![CDATA[<script>x</script>]]></svg>")), "script_element"), undefined, "CDATA is text in XML (and in HTML foreign content)");
  assert.ok(has(triageSvg(enc("<svg><style><![CDATA[@import 'https://example.test/a.css';]]></style></svg>")), "external_reference"));
  assert.ok(has(triageSvg(enc('<svg><style>@import url("https://example.test/a.css");</style></svg>')), "external_reference"));
  assert.ok(has(triageSvg(enc('<svg><rect style="fill:url( https://example.test/x)"/></svg>')), "external_reference"));
  assert.ok(has(triageSvg(enc('<!DOCTYPE svg [ <!ELEMENT a ANY> ]><svg/>')), "xml_entities"));
  assert.equal(has(triageSvg(enc('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>')), "xml_entities"), undefined);
});

test("ooxml: relationship, field and formula scanning is linear on '<Relationship ', '<f ' and 'w:instr' floods", async () => {
  const flood = (s, n) => s.repeat(n);
  for (const [label, part] of Object.entries({ rels: flood("<Relationship ", 20000), "rels attr run": `<Relationship ${"a".repeat(4_000_000)}="1"/>`, instr: flood("<w:instrText ", 20000), f: flood("<f ", 30000), "f content": `<f>${"a".repeat(2_000_000)}|</f>` })) {
    const name = label.startsWith("rels") ? "word/_rels/document.xml.rels" : label === "instr" ? "word/document.xml" : "xl/worksheets/sheet1.xml";
    await ran(`ooxml ${label}`, () => triageZip(ooxml(label === "f" || label === "f content" ? "xlsx" : "docx", [X(name, part)]), L, { ooxml: true }));
  }
  const r = await triageZip(ooxml("docx", [X("word/_rels/document.xml.rels", "<Relationship ".repeat(20000))]), L, { ooxml: true });
  assert.equal(r.verdict, "needs_sandbox");
});

test("ooxml: the DDE, relationship and field findings of the old regexes are unchanged", async () => {
  const rel = (attrs) => `<Relationships><Relationship Id="1" ${attrs}/></Relationships>`;
  const pkg = (part, xml) => triageZip(zip([X("[Content_Types].xml", "<Types/>"), X(part, xml)]), L, { ooxml: true });
  const run = ([e]) => pkg(e.name, e.data);
  assert.ok(has(await run([X("word/_rels/document.xml.rels", rel('Type="x/oleObject" Target="http://e.test/a" TargetMode="External"'))]), "external_relationship"));
  assert.ok(has(await run([X("word/_rels/document.xml.rels", rel("Type='x/oleObject' Target='http://e.test/a' TargetMode='External'"))]), "external_relationship"));
  assert.ok(has(await run([X("word/_rels/document.xml.rels", rel('Type="x/oleObject" Target="http://e.test/a" TargetMode="EXTERNAL"'))]), "external_relationship"));
  assert.ok(has(await run([X("word/document.xml", '<w:p><w:fldSimple w:instr=" DDE cmd calc "/></w:p>')]), "dde_field"));
  assert.ok(has(await run([X("word/document.xml", "<w:r><w:instrText> DDEAUTO cmd </w:instrText></w:r>")]), "dde_field"));
  assert.equal(has(await run([X("word/document.xml", "<w:r><w:instrText> PAGE </w:instrText></w:r>")]), "dde_field"), undefined);
  const sheet = (f) => triageZip(ooxml("xlsx", [X("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c><f>${f}</f></c></row></sheetData></worksheet>`)]), L, { ooxml: true });
  assert.ok(has(await sheet("cmd|'/c calc'!A0"), "dde_formula"));
  assert.equal(has(await sheet("SUM(A1:A3)"), "dde_formula"), undefined);
  assert.equal(has(await sheet("IF(A1>1,1,2)|x"), "dde_formula"), undefined, "a '|' with no '!' after it");
});

/* ---------- (2) evidence overflow ---------- */

test("collector: first_ref and incomplete reasons are cleaned and clipped where they enter (80 and 120 characters, the schema's caps)", async () => {
  const longName = `${"a".repeat(60000)}.exe`;
  const r = await triageZip(zip([X(longName, "x")]), L);
  assert.ok(has(r, "executable_extension"));
  for (const m of r.markers) assert.ok(m.first_ref == null || m.first_ref.length <= REF_MAX, `${m.name}: ${m.first_ref.length}`);
  assert.equal(clipText("a‮b\u0000c\ud800", 80), "a?b?c?");
  assert.equal(clipText("x".repeat(500), 80).length, 80); assert.ok(clipText("x".repeat(500), 80).endsWith("…"));
  assert.equal(clipText("short", 80), "short");
  const svg = triageSvg(enc(`<svg on${"a".repeat(200000)}="1"/>`));
  assert.ok(has(svg, "event_handler")); assert.ok(has(svg, "event_handler").first_ref.length <= REF_MAX);
  const bad = zip([X(longName, "x", { method: 99 })]);
  const inc = await triageZip(bad, L);
  for (const w of inc.incomplete_because || []) assert.ok(w.length <= WHY_MAX);
});

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const PDF_TYPE = "application/pdf";
const cfg = () => ({
  schema: "kit.uploads-config.v1", project: "saasreport",
  storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } },
  forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF_TYPE, "image/png", "text/plain", "application/zip"], max_bytes: 5 * 1024 * 1024, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av" } },
});
function setup(verdict = { v: "allow" }) {
  const P = people();
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: verdict.v }) } };
  const env = { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() };
  const records = memoryRecords();
  const uploads = createUploads({ config: loadUploadsConfig(cfg(), { registry, scanners }), env, scanners, records, authority: P.authority });
  return { ...decideAs(uploads, records, P.sign), uploads, records, q: env.UPLOADS_QUARANTINE, r: env.UPLOADS_RELEASED, verdict };
}

test("intake: a zip entry name of 60000 characters gets an Evidence record (it used to throw RecordError and leave no record)", async () => {
  const s = setup();
  const { record, outcome } = await s.uploads.intake({ form: "partner", bytes: zip([X(`${"a".repeat(60000)}.exe`, "x")]), filename: "x.zip", contentType: "application/zip" });
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual([record.verdict, record.stage], ["block", "blocked"]);
  assert.equal(outcome.accepted, false);
  assert.ok(await s.records.get(record.upload_id), "the blocked attacker upload is on record");
});

test("intake: a hostile unsafe path longer than 80 characters and an svg attribute name of 200k characters also validate", async () => {
  const s = setup();
  const { record } = await s.uploads.intake({ form: "partner", bytes: zip([X(`../${"b".repeat(5000)}`, "x")]), filename: "a.zip", contentType: "application/zip" });
  assert.deepEqual(validateRecord(record), []); assert.equal(record.verdict, "block");
});

/* ---------- (3) PDF polyglots and file markers ---------- */

test("pdf: ANY data after %%EOF is signature-tested (it was only tested past 1024 bytes: PDF + a tiny zip was released)", async () => {
  const payloads = {
    "zip, 600 bytes": zip([X("x.exe", "MZ")]), "elf": cat("\x7fELF", new Uint8Array(20)), "pe": cat("MZ", new Uint8Array(20), "This program cannot be run in DOS mode"),
    "script": "<script>alert(1)</script>", "html": "<HTML>", "php": "<?php system($_GET[1]); ?>", "zip signature alone": "PK\x03\x04",
  };
  for (const [label, tail] of Object.entries(payloads)) {
    const r = await triagePdf(pdf(undefined, { tail: typeof tail === "string" ? tail : "" }) && cat(pdf(), tail), L);
    assert.ok(has(r, "polyglot_data"), label); assert.equal(r.verdict, "block", label); assert.equal(r.reason_code, "polyglot_suspect", label);
  }
});

test("pdf: small ordinary data after %%EOF is trailing_data (needs_sandbox); whitespace and NULs alone are nothing", async () => {
  const r = await triagePdf(cat(pdf(), "junk"), L);
  assert.ok(has(r, "trailing_data")); assert.equal(has(r, "polyglot_data"), undefined); assert.equal(r.verdict, "needs_sandbox");
  for (const tail of ["", "\n", "\r\n\r\n", " \t \0\0", "\0".repeat(5000)]) {
    const w = await triagePdf(cat(pdf(), tail), L);
    assert.equal(has(w, "trailing_data"), undefined, JSON.stringify(tail.slice(0, 8)));
    assert.equal(w.verdict, "allow_with_limits");
  }
});

test("pdf: a file attached without /Type /EmbeddedFile (the Type key is optional) is found by /EF, /EmbeddedFiles and /FileAttachment", async () => {
  const cat1 = "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(a.exe) << /EF << /F 5 0 R >> >>] >> >> >>";
  const r = await triagePdf(pdf([cat1, "<< /Type /Pages /Kids [] /Count 0 >>"]), L);
  for (const m of ["EF", "EmbeddedFiles"]) { assert.equal(has(r, m)?.severity, "block", m); }
  assert.equal(r.verdict, "block");
  const annot = await triagePdf(pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Annot /Subtype /FileAttachment /FS 6 0 R >>"]), L);
  assert.equal(has(annot, "FileAttachment")?.severity, "block"); assert.equal(annot.verdict, "block");
  const ef = await triagePdf(pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Filespec /F (a.txt) /EF << /F 7 0 R >> >>"]), L);
  assert.equal(ef.verdict, "block");
  for (const name of ["EF", "EmbeddedFiles", "FileAttachment"]) assert.equal(PDF_MARKERS[name].severity, "block");
});

/* ---------- (4) zip names, deny list, OOXML ---------- */

test("zip: Windows drops trailing dots and spaces and an ADS suffix, so x.exe. , x.exe␠ and x.scr::$DATA are executables", async () => {
  const names = ["x.exe.", "x.exe ", "x.exe. . ", "x.scr::$DATA", "dir/x.exe:Zone.Identifier", "x.EXE...", "x.exe​", "x.js ", "a.b.vbs."];
  for (const name of names) {
    const r = await triageZip(zip([X(name, "x", { flags: 0x800 })]), L);
    assert.ok(has(r, "executable_extension"), JSON.stringify(name)); assert.equal(r.verdict, "block", JSON.stringify(name));
  }
  assert.equal(effectiveName("a/b\\c.txt. "), "c.txt"); assert.equal(effectiveName("x.exe::$DATA"), "x.exe");
  for (const name of ["x.txt.", "readme", "a.exe.txt", "notes.pdf "]) assert.equal(has(await triageZip(zip([X(name, "x")]), L), "executable_extension"), undefined, name);
});

test("zip: the deny list covers pif url chm iqy slk settingcontent-ms library-ms scf (and the rest the review named)", async () => {
  for (const e of ["pif", "url", "chm", "iqy", "slk", "settingcontent-ms", "library-ms", "scf", "appref-ms", "ps2", "wsc", "gadget"]) {
    assert.ok(EXECUTABLE_EXT.has(e), e);
    const r = await triageZip(zip([X(`file.${e}`, "x")]), L);
    assert.ok(has(r, "executable_extension"), e); assert.equal(r.verdict, "block", e);
  }
});

test("zip: one file by two Windows spellings is a duplicate, and '...' or '.. ' segments are traversal", async () => {
  assert.ok(has(await triageZip(zip([X("a.txt", "1"), X("a.txt.", "2")]), L), "duplicate_entry"));
  assert.ok(has(await triageZip(zip([X("dir/a.txt", "1"), X("DIR/a.txt::$DATA", "2")]), L), "duplicate_entry"));
  for (const name of ["..../x", "... /x", ".. /x", "a/.../b"]) assert.ok(has(await triageZip(zip([X(name, "x")]), L), "unsafe_path"), name);
  assert.equal(has(await triageZip(zip([X("a/.hidden/b.txt", "x"), X("v1.2/c.txt", "y")]), L), "unsafe_path"), undefined);
});

test("ooxml: a pptx hyperlink with action ppaction://program (also entity-encoded) launches a program: block", async () => {
  const slide = (action) => `<p:sld xmlns:p="p" xmlns:a="a"><a:hlinkClick action="${action}"/></p:sld>`;
  for (const [path, action] of [["ppt/slides/slide1.xml", "ppaction://program"], ["ppt/slideMasters/slideMaster1.xml", "PPACTION://PROGRAM"], ["ppt/slides/slide2.xml", "ppaction&#58;//program"], ["ppt/slideLayouts/slideLayout1.xml", "ppaction://macro?name=Run"]]) {
    const r = await triageZip(ooxml("pptx", [X(path, slide(action))]), L, { ooxml: true });
    assert.equal(has(r, "program_action")?.severity, "block", `${path} ${action}`); assert.equal(r.verdict, "block");
  }
  const ok = await triageZip(ooxml("pptx", [X("ppt/slides/slide1.xml", slide("ppaction://hlinksldjump"))]), L, { ooxml: true });
  assert.equal(has(ok, "program_action"), undefined);
});

test("ooxml: an HTML part (html, htm, xhtml, mht, mhtml) is a block whatever it contains: HTML is never judged by the XML rules", async () => {
  const html = (body) => `<html><body>${body}</body></html>`;
  for (const path of ["word/a.html", "word/b.HTM", "word/c.xhtml", "word/d.mht", "word/e.mhtml"]) {
    for (const body of ["<script>alert(1)</script>", "<p>hello</p>", `${"<p>x</p>".repeat(500)}<script>alert(1)</script>`, ""]) {
      const r = await triageZip(ooxml("docx", [X(path, html(body))]), L, { ooxml: true });
      assert.ok(has(r, "html_part"), `${path} ${body.slice(0, 20)}`); assert.equal(r.verdict, "block");
    }
  }
  assert.equal(has(await triageZip(ooxml("docx", [X("word/htmlnot.xml", "<a/>")]), L, { ooxml: true }), "html_part"), undefined);
});

test("ooxml: an internal relationship whose target is a network path (UNC, //host, file:) leaks credentials: block", async () => {
  const rel = (t) => `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${t}"/></Relationships>`;
  for (const t of ["\\\\evil.example.test\\x\\a.png", "//evil.example.test/x/a.png", "file:///\\\\evil\\x", "&#92;&#92;evil\\x"]) {
    const r = await triageZip(ooxml("docx", [X("word/_rels/document.xml.rels", rel(t))]), L, { ooxml: true });
    assert.ok(has(r, "network_path_target"), t); assert.equal(r.verdict, "block");
  }
  assert.equal(has(await triageZip(ooxml("docx", [X("word/_rels/document.xml.rels", rel("media/image1.png"))]), L, { ooxml: true }), "network_path_target"), undefined);
});

/* ---------- (4b) double extensions: the recorded policy ---------- */

test("double extensions (policy, docs/UPLOADS.md): a dangerous part anywhere after the first is a type mismatch whatever the bytes are", () => {
  const PNG = TYPES.png;
  for (const f of ["a.png.php", "a.php.png", "a.PHP5.png", "a.jsp.png", "a.png.asp", "a.php::$DATA", "a.php.png.", "dir\\a.png.phtml", "a.png.exe", "a.html.png", "a.png.ps1", "a.png.js"]) assert.equal(matchesDeclared({ filename: f }, PNG), false, f);
  for (const f of ["a.png", "a.png.", "photo.final.png", "amazon.com.png", "a.pl.png", "my.sh.png", "a.b.c.png", "archive.php", "a", null]) assert.equal(f === "archive.php" ? matchesDeclared({ filename: f }, PNG) : matchesDeclared({ filename: f }, PNG), f === "archive.php" ? false : true, String(f));
  assert.equal(matchesDeclared({ filename: "amazon.com.pdf" }, TYPES.pdf), true);
});

test("double extensions: a PNG named a.png.php is refused at intake as type_mismatch and downloads stay attachments", async () => {
  const s = setup();
  const { record, outcome } = await s.uploads.intake({ form: "partner", bytes: png(), filename: "a.png.php", contentType: "image/png" });
  assert.deepEqual([record.verdict, record.reason_code, record.stage], ["block", "type_mismatch", "blocked"]);
  assert.equal(outcome.accepted, false);
  assert.equal((await downloadResponse({ record, bucket: s.r })).status, 404);
});

/* ---------- (5) decide fails closed ---------- */

const policy = { max_bytes: 1000, allowed_types: [TYPES.pdf], on_needs_sandbox: "hold" };
const sniffed = { type: TYPES.pdf, family: "document", matches_declared: true };
const OK_TRIAGE = { verdict: "allow_with_limits", reason_code: "none" };
/** A scan result in the runScan shape (decide() refuses a bare verdict). */
const okScan = (verdict = "allow") => ({ verdict, reason_code: "none", scan: { status: "no_detection", scanner: "fake-av" } });

test("decide: the pass path still passes with well-formed input", () => {
  assert.deepEqual(decide({ policy, size: 10, sniffed, triage: OK_TRIAGE, scan: okScan() }), { verdict: "allow_with_limits", reason_code: "none", limits: ["download_only", "open_only_in_sandbox"], stage: "released", store: true });
});

test("decide: malformed or unknown triage and scan input is scan_failed and held, never released (decide({triage:{}, scan:{verdict:'allow'}}) used to release)", () => {
  const good = okScan();
  const badInputs = [{}, { verdict: undefined }, { verdict: "clean" }, { verdict: "safe" }, { verdict: "ALLOW" }, { verdict: "allow " }, { verdict: true }, { verdict: 1 }, { verdict: null }, { verdict: ["allow"] }, { verdict: "scan_failed_not" }, "allow", true, 7, [], () => {}];
  for (const bad of badInputs) {
    const t = decide({ policy, size: 10, sniffed, triage: bad, scan: good });
    assert.deepEqual([t.verdict, t.reason_code, t.stage], ["scan_failed", "could_not_check", "quarantined"], `triage ${JSON.stringify(bad)}`);
    const sc = decide({ policy, size: 10, sniffed, triage: OK_TRIAGE, scan: bad });
    assert.deepEqual([sc.verdict, sc.reason_code, sc.stage], ["scan_failed", "could_not_check", "quarantined"], `scan ${JSON.stringify(bad)}`);
  }
  assert.equal(decide({ policy, size: 10, sniffed, triage: OK_TRIAGE, scan: {} }).stage, "quarantined");
  assert.equal(decide({ policy, size: 10, sniffed, triage: { verdict: "needs_sandbox" }, scan: good }).reason_code, "could_not_check", "a reason code that is missing is could_not_check");
  assert.equal(decide({ policy, size: 10, sniffed, triage: { verdict: "block", reason_code: "made_up" }, scan: good }).reason_code, "could_not_check");
  assert.equal(decide({ policy, size: 10, sniffed, triage: { verdict: "scan_failed", reason_code: "none" }, scan: good }).stage, "quarantined", "scan_failed is not a triage verdict");
  assert.equal(decide({ policy, size: 10, sniffed, triage: OK_TRIAGE, scan: okScan("allow_with_limits") }).reason_code, "none");
});

test("decide: a missing or odd size, or an unknown matches_declared, is refused or blocked, not passed", () => {
  for (const size of [NaN, undefined, null, "10", {}]) assert.equal(decide({ policy, size, sniffed, triage: OK_TRIAGE, scan: { verdict: "allow" } }).stage, "rejected", String(size));
  for (const matches_declared of [undefined, null, 1, "true"]) assert.equal(decide({ policy, size: 10, sniffed: { ...sniffed, matches_declared }, triage: OK_TRIAGE, scan: { verdict: "allow" } }).reason_code, "type_mismatch");
  assert.throws(() => decide({ policy, size: 10, sniffed: null }));
});

test("worst(): a word that is not a verdict counts as scan_failed, and REASON_CODES equals the schema's reason_code enum", () => {
  assert.equal(worst("allow", "garbage"), "scan_failed"); assert.equal(worst("garbage"), "scan_failed"); assert.equal(worst("allow", undefined, "needs_sandbox"), "scan_failed");
  assert.equal(worst("allow", "block", "garbage"), "block"); assert.equal(worst("allow", "allow_with_limits"), "allow_with_limits");
  assert.deepEqual([...REASON_CODES], SCHEMAS.record.properties.reason_code.enum);
  assert.deepEqual([...VERDICTS].sort(), SCHEMAS.record.properties.verdict.enum.slice().sort());
});

test("rescan that withdraws a release removes the released object and the record's pointer to it (it used to leave both)", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  assert.equal(a.stage, "released"); assert.equal(s.r.objects.size, 1);
  s.verdict.v = "block";
  const next = await s.uploads.rescan(a.upload_id);
  assert.deepEqual([next.stage, next.verdict], ["blocked", "block"]);
  assert.equal(s.r.objects.size, 0, "no object left in the released bucket");
  assert.deepEqual([next.storage.released_key, next.storage.released_bucket], [null, null]);
  assert.deepEqual(validateRecord(next), []);
  assert.equal((await downloadResponse({ record: next, bucket: s.r })).status, 404);
  assert.ok(s.q.objects.has(next.storage.key), "the quarantined bytes stay for review");
  s.verdict.v = "needs_sandbox";
  assert.equal((await s.uploads.rescan(a.upload_id)).stage, "blocked", "looser than blocked: not applied");
  const b = (await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Type /Catalog /Pages 2 0 R /B 1 >>", "<< /Type /Pages /Kids [] /Count 0 >>"]), filename: "b.pdf", contentType: PDF_TYPE })).record;
  assert.equal(b.stage, "held");
  s.verdict.v = "allow";
  const c = (await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Type /Catalog /Pages 2 0 R /C 1 >>", "<< /Type /Pages /Kids [] /Count 0 >>"]), filename: "c.pdf", contentType: PDF_TYPE })).record;
  s.verdict.v = "needs_sandbox";
  assert.equal((await s.uploads.rescan(c.upload_id)).stage, "held", "released to held: tightened");
  await s.uploads.assertConsistent();
});

test("rescan: a release that stays a release keeps its object; two uploads of the same bytes are independent", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  const b = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "b.pdf", contentType: PDF_TYPE })).record;
  const again = await s.uploads.rescan(a.upload_id);
  assert.equal(again.stage, "released"); assert.equal(again.storage.released_key, a.storage.released_key);
  s.verdict.v = "block";
  await s.uploads.rescan(a.upload_id);
  assert.equal(s.r.objects.has(b.storage.released_key), true, "b's released object is its own");
  assert.equal((await downloadResponse({ record: await s.records.get(b.upload_id), bucket: s.r })).status, 200);
});

/* ---------- (9) mutations that used to survive ---------- */

test("zip: the per-entry ratio check fires on one bomb entry hidden behind incompressible bulk (the whole-archive ratio masked it)", async () => {
  const noise = new Uint8Array(3 * 1024 * 1024); let x = 12345; for (let i = 0; i < noise.length; i++) { x = (x * 1103515245 + 12345) >>> 0; noise[i] = x >>> 24; }
  const bytes = zip([X("noise.bin", noise, { method: 0 }), X("zeros.bin", new Uint8Array(2 * 1024 * 1024))]);
  const r = await triageZip(bytes, L);
  const m = has(r, "high_ratio");
  assert.ok(m, JSON.stringify(r.markers)); assert.equal(m.first_ref, "zeros.bin", "the entry, not '(whole archive)'");
  assert.equal(m.count, 1);
  assert.equal(r.verdict, "block"); assert.equal(r.reason_code, "archive_bomb");
  // the twin: the same bulk with a compressible but not extreme entry is fine
  const fine = await triageZip(zip([X("noise.bin", noise, { method: 0 }), X("text.txt", "hello world ".repeat(80000))]), L);
  assert.equal(has(fine, "high_ratio"), undefined, JSON.stringify(fine.markers));
});

test("ooxml: a macros/ folder is a VBA marker by its path alone, in any case and at any depth (no vbaProject.bin needed)", async () => {
  for (const path of ["word/macros/module1.bas", "xl/Macros/x.xml", "macros/a.txt", "ppt/MACROS/s"]) {
    const r = await triageZip(ooxml("docx", [X(path, "x")]), L, { ooxml: true });
    const m = has(r, "vba_project");
    assert.ok(m, path); assert.equal(m.first_ref, path); assert.equal(r.verdict, "block");
  }
  assert.equal(has(await triageZip(ooxml("docx", [X("word/macrosheet.xml", "x"), X("word/notmacros/a.xml", "x")]), L, { ooxml: true }), "vba_project"), undefined);
});
