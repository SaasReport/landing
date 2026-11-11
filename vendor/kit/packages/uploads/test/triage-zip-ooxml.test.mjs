// ZIP and OOXML triage. Every marker of ZIP_MARKERS and OOXML_MARKERS has a fixture below (the last test fails when one has not),
// and each fixture has a twin without the marker that must not report it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { triageZip, ZIP_MARKERS, OOXML_MARKERS } from "../src/triage/zip.js";
import { resolveLimits } from "../src/limits.js";
import { STATEMENTS } from "../src/triage/collector.js";
import { cat, enc, ooxml, zip, ole, png } from "./fixtures.mjs";

const L = resolveLimits();
const run = (b, o = {}, limits = L) => triageZip(b, limits, o);
const has = (r, name) => r.markers.find((m) => m.name === name);
const benignZip = () => zip([{ name: "readme.txt", data: "hello" }, { name: "dir/", data: "", method: 0 }, { name: "dir/data.csv", data: "a,b\n1,2\n" }]);

test("a benign zip and a benign docx, xlsx, pptx: complete, no markers, never 'safe'", async () => {
  for (const [name, bytes, o] of [["zip", benignZip(), {}], ["docx", ooxml("docx"), { ooxml: true }], ["xlsx", ooxml("xlsx"), { ooxml: true }], ["pptx", ooxml("pptx"), { ooxml: true }]]) {
    const r = await run(bytes, o);
    assert.deepEqual(r.markers.filter((m) => m.severity !== "info"), [], name);
    assert.equal(r.complete, true, name); assert.equal(r.verdict, "allow_with_limits", name); assert.equal(r.statement, STATEMENTS.none, name);
    assert.ok(!/\b(safe|clean)\b/i.test(JSON.stringify(r)), name);
  }
});

const big = (n, fill = 0) => new Uint8Array(n).fill(fill);
const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.txt`, data: "x", method: 0 }));
const ZIP_FIXTURES = {
  zip_unreadable: () => cat("PK\x03\x04", new Uint8Array(100)),
  too_many_entries: () => zip(many),
  zip_prefix_data: () => zip([{ name: "a.txt", data: "x" }], { prefix: enc("MZ polyglot prefix") }),
  unsafe_path: () => zip([{ name: "../../evil.txt", data: "x" }]),
  symlink_entry: () => zip([{ name: "link", data: "/etc/passwd", method: 0, symlink: true }]),
  encrypted_entry: () => zip([{ name: "secret.txt", data: "x", flags: 1 }]),
  duplicate_entry: () => zip([{ name: "a.txt", data: "1" }, { name: "A.TXT", data: "2" }]),
  local_header_mismatch: () => zip([{ name: "shown.txt", data: "x", localName: "other.txt" }]),
  unsupported_compression: () => zip([{ name: "a.txt", data: "x", method: 99 }]),
  size_lie: () => zip([{ name: "bomb.bin", data: big(2 * 1024 * 1024), lieSize: 100 }]),
  high_ratio: () => zip([{ name: "zeros.bin", data: big(20 * 1024 * 1024) }]),
  total_size_limit: () => zip([{ name: "zeros.bin", data: big(6 * 1024 * 1024) }]),
  nested_archive: () => zip([{ name: "inner.zip", data: zip([{ name: "a", data: "x" }]), method: 0 }]),
  executable_in_archive: () => zip([{ name: "tool.dat", data: cat("\x7fELF", new Uint8Array(30)), method: 0 }]),
  script_in_archive: () => zip([{ name: "page.dat", data: "<html><script>1</script></html>", method: 0 }]),
  executable_extension: () => zip([{ name: "setup.exe", data: "x" }]),
  directory_problem: () => { const z = zip([{ name: "a.txt", data: "x" }]); z[z.length - 12] = 9; return z; },   // entry count says 9
};
const ZIP_LIMITS = { total_size_limit: resolveLimits({ max_uncompressed_bytes: 5 * 1024 * 1024 }) };

for (const [name, severity] of Object.entries(ZIP_MARKERS)) {
  test(`zip marker ${name} (${severity}): found in its fixture, absent from a benign zip`, async () => {
    assert.ok(ZIP_FIXTURES[name], `no fixture for zip marker ${name}`);
    const r = await run(ZIP_FIXTURES[name](), {}, ZIP_LIMITS[name] || L);
    const m = has(r, name);
    assert.ok(m, `${name}: ${JSON.stringify(r.markers)} ${JSON.stringify(r.incomplete_because || [])}`);
    assert.equal(m.severity, severity);
    if (severity === "block") assert.equal(r.verdict, "block");
    assert.equal(has(await run(benignZip()), name), undefined);
  });
}

test("zip bombs: 20 MB of zeros in a 20 KB file, a lying header, 1001 entries, and a total over the limit are all stopped with archive_bomb", async () => {
  for (const name of ["high_ratio", "size_lie", "too_many_entries", "total_size_limit"]) {
    const r = await run(ZIP_FIXTURES[name](), {}, ZIP_LIMITS[name] || L);
    assert.equal(r.verdict, "block", name); assert.equal(r.reason_code, "archive_bomb", name);
  }
});

test("nested archives are blocked at depth 1 (never opened): an OOXML inside a zip too", async () => {
  const r = await run(zip([{ name: "report.docx", data: ooxml("docx"), method: 0 }]));
  assert.ok(has(r, "nested_archive")); assert.equal(r.verdict, "block"); assert.equal(r.reason_code, "archive_not_allowed");
  const byName = await run(zip([{ name: "backup.tar", data: "x" }]));
  assert.ok(has(byName, "nested_archive"));
});

test("path traversal forms are all unsafe", async () => {
  for (const name of ["../a", "a/../../b", "/etc/passwd", "\\windows\\x", "C:\\x.txt", "a\\..\\b", "dir/../../x"]) assert.ok(has(await run(zip([{ name, data: "x" }])), "unsafe_path"), name);
  for (const name of ["a/b/c.txt", "a..b.txt", "..hidden"]) assert.equal(has(await run(zip([{ name, data: "x" }])), "unsafe_path"), undefined, name);
});

/* ---------- OOXML ---------- */
const X = (name, data) => ({ name, data });
const rel = (type, target, mode) => `<Relationships><Relationship Id="x1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/></Relationships>`;
const OOXML_FIXTURES = {
  macro_enabled_content_type: () => ooxml("docx", [], { contentTypes: `<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>` }),
  vba_project: () => ooxml("docx", [X("word/vbaProject.bin", ole(["VBA"]))]),
  activex_control: () => ooxml("docx", [X("word/activeX/activeX1.xml", "<ax:ocx/>")]),
  embedded_object: () => ooxml("docx", [X("word/embeddings/oleObject1.bin", "x")]),
  external_link: () => ooxml("xlsx", [X("xl/externalLinks/externalLink1.xml", "<externalLink/>")]),
  dde_link: () => ooxml("xlsx", [X("xl/externalLinks/externalLink1.xml", `<externalLink><externalBook><ddeLinks><ddeLink ddeService="cmd" ddeTopic="/c calc"/></ddeLinks></externalBook></externalLink>`)]),
  dde_field: () => ooxml("docx", [], {}) && zip([X("[Content_Types].xml", "<Types/>"), X("word/document.xml", `<w:document xmlns:w="w"><w:body><w:p><w:r><w:instrText xml:space="preserve"> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc" </w:instrText></w:r></w:p></w:body></w:document>`)]),
  dde_formula: () => zip([X("[Content_Types].xml", "<Types/>"), X("xl/workbook.xml", "<workbook/>"), X("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c><f>cmd|' /C calc'!A0</f></c></row></sheetData></worksheet>`)]),
  program_action: () => ooxml("pptx", [X("ppt/slides/slide1.xml", `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="x"><a:hlinkClick r:id="rId2" action="ppaction://program"/></p:cNvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>`)]),
  network_path_target: () => ooxml("docx", [X("word/_rels/document.xml.rels", rel("image", "\\\\evil.example.test\\share\\x.png"))]),
  html_part: () => ooxml("docx", [X("word/afchunk.html", "<html><body>hi</body></html>")]),
  malformed_markup: () => ooxml("docx", [X("word/_rels/document.xml.rels", "<a ".repeat(30000))]),
  unsafe_hyperlink: () => ooxml("docx", [X("word/_rels/document.xml.rels", rel("hyperlink", "file:///C:/Windows/System32/calc.exe", "External"))]),
  xlm_macro_sheet: () => ooxml("xlsx", [X("xl/macrosheets/sheet1.xml", "<xm:macrosheet/>")]),
  external_relationship: () => ooxml("docx", [X("word/_rels/document.xml.rels", rel("attachedTemplate", "https://example.test/t.dotm", "External"))]),
  external_hyperlink: () => ooxml("docx", [X("word/_rels/document.xml.rels", rel("hyperlink", "https://example.test/", "External"))]),
  alt_chunk: () => ooxml("docx", [X("word/_rels/document.xml.rels", rel("aFChunk", "afchunk.html"))]),
  missing_content_types: () => zip([X("word/document.xml", "<w:document/>")]),
  part_too_large: () => ooxml("docx", [X("word/document.xml", "x".repeat(2 * 1024 * 1024))]),
};
for (const [name, severity] of Object.entries(OOXML_MARKERS)) {
  test(`ooxml marker ${name} (${severity}): found in its fixture, absent from a benign document`, async () => {
    assert.ok(OOXML_FIXTURES[name], `no fixture for OOXML marker ${name}`);
    const limits = name === "part_too_large" ? resolveLimits() : L;
    const bytes = OOXML_FIXTURES[name]();
    const r = await triageZip(bytes, name === "part_too_large" ? { ...limits, max_xml_part_bytes: 1024 } : limits, { ooxml: true });
    const m = has(r, name);
    assert.ok(m, `${name}: ${JSON.stringify(r.markers)}`);
    assert.equal(m.severity, severity);
    if (severity === "block") assert.equal(r.verdict, "block");
    assert.equal(has(await run(ooxml("docx"), { ooxml: true }), name), undefined);
  });
}

test("a hyperlink alone is information, not a finding; every other external relationship is a block", async () => {
  const r = await run(OOXML_FIXTURES.external_hyperlink(), { ooxml: true });
  assert.equal(r.verdict, "allow_with_limits"); assert.equal(has(r, "external_hyperlink").severity, "info");
  for (const type of ["oleObject", "image", "frame", "subDocument", "externalLinkPath", "attachedTemplate"]) {
    const x = await run(ooxml("docx", [X("word/_rels/document.xml.rels", rel(type, "http://example.test/x", "External"))]), { ooxml: true });
    assert.ok(has(x, "external_relationship"), type); assert.equal(x.verdict, "block", type);
  }
});

test("macro-enabled content, xlsm and docm style packages are blocked even though the sniffed type is docx/xlsx", async () => {
  const docm = ooxml("docx", [X("word/vbaProject.bin", "x")], { contentTypes: `<Types><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>` });
  const r = await run(docm, { ooxml: true });
  assert.ok(has(r, "vba_project") && has(r, "macro_enabled_content_type")); assert.equal(r.verdict, "block");
});

test("an OOXML whose parts are fine but one image is a PNG with a script after IEND is not an OOXML finding (media is not opened)", async () => {
  const r = await run(ooxml("docx", [{ name: "word/media/image1.png", data: png(), method: 0 }]), { ooxml: true });
  assert.equal(r.verdict, "allow_with_limits");
});
