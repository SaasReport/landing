// OLE2, SVG, raster images and text. Each marker of OLE_MARKERS, SVG_MARKERS, IMAGE_MARKERS and TEXT_MARKERS has a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { triageOle, OLE_MARKERS } from "../src/triage/ole.js";
import { triageSvg, SVG_MARKERS } from "../src/triage/svg.js";
import { triageImage, IMAGE_MARKERS, MAX_PIXELS, BOMB_PIXELS } from "../src/triage/image.js";
import { triageText, TEXT_MARKERS } from "../src/triage/text.js";
import { triage } from "../src/triage/index.js";
import { STATEMENTS } from "../src/triage/collector.js";
import { TYPES } from "../src/sniff.js";
import { cat, enc, ole, png, jpeg, gif, webp, zip } from "./fixtures.mjs";

const has = (r, name) => r.markers.find((m) => m.name === name);

/* ---------- OLE2 ---------- */
const OLE_FIXTURES = {
  ole_unreadable: () => cat(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), new Uint8Array(600)),
  vba_macros: () => ole(["WordDocument", "Macros", "VBA"]),
  embedded_object: () => ole(["WordDocument", "ObjectPool"]),
  equation_editor_object: () => ole(["WordDocument", "Equation Native"]),
  encrypted_content: () => ole(["EncryptionInfo", "EncryptedPackage"]),
  legacy_office_format: () => ole(["WordDocument"]),
  legacy_workbook_streams_not_parsed: () => ole(["Workbook"]),
};
for (const [name, severity] of Object.entries(OLE_MARKERS)) {
  test(`ole marker ${name} (${severity}): found in its fixture`, () => {
    assert.ok(OLE_FIXTURES[name], `no fixture for ole marker ${name}`);
    const r = triageOle(OLE_FIXTURES[name]());
    assert.equal(has(r, name)?.severity, severity, JSON.stringify(r.markers));
    if (severity === "block") assert.equal(r.verdict, "block");
  });
}
test("a legacy Office file is never better than needs_sandbox, even with no VBA", () => {
  const r = triageOle(ole(["WordDocument", "1Table", "SummaryInformation"]));
  assert.equal(r.verdict, "needs_sandbox"); assert.equal(has(r, "vba_macros"), undefined);
  assert.equal(r.statement, STATEMENTS.found);
});
test("OLE directory names with the control-character prefix Office uses are still recognised (Ole10Native)", () => {
  assert.equal(triageOle(ole(["\u0001Ole10Native"])).verdict, "block");
});

/* ---------- SVG ---------- */
const svg = (inner, attrs = "") => enc(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`);
const SVG_FIXTURES = {
  script_element: () => svg("<script>alert(1)</script>"),
  event_handler: () => svg("", 'onload="alert(1)"'),
  foreign_object: () => svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
  embedding_element: () => svg('<iframe src="x"/>'),
  external_reference: () => svg('<image href="https://example.test/track.png"/>'),
  script_url: () => svg('<a href="javascript:alert(1)"><rect/></a>'),
  animation_of_href: () => svg('<a><set attributeName="href" to="javascript:alert(1)"/></a>'),
  xml_entities: () => enc('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg">&b;</svg>'),
  external_dtd: () => enc('<?xml version="1.0"?><!DOCTYPE svg SYSTEM "http://evil.example/x.dtd"><svg xmlns="http://www.w3.org/2000/svg"/>'),
  xml_stylesheet: () => enc('<?xml version="1.0"?><?xml-stylesheet href="x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
  unquoted_attribute: () => svg("<rect width=10 height=\"4\"/>"),
  malformed_markup: () => enc(`<svg xmlns="http://www.w3.org/2000/svg">${"<a ".repeat(20000)}`),
  not_text: () => cat("<svg>", Uint8Array.of(0xff, 0xfe, 0x80), "</svg>"),
  too_large: () => enc(`<svg xmlns="x"><!-- ${"a".repeat(4 * 1024 * 1024)} --></svg>`),
};
for (const [name, severity] of Object.entries(SVG_MARKERS)) {
  test(`svg marker ${name} (${severity}): found in its fixture, absent from a plain drawing`, () => {
    assert.ok(SVG_FIXTURES[name], `no fixture for svg marker ${name}`);
    const r = triageSvg(SVG_FIXTURES[name]());
    assert.equal(has(r, name)?.severity, severity, JSON.stringify(r.markers));
    assert.equal(has(triageSvg(svg('<rect width="1" height="1" fill="red"/><a href="#local"><circle r="1"/></a>')), name), undefined);
  });
}
test("svg evasions: entity-encoded and case-varied script URLs, whitespace tricks, uppercase tags, CDATA, comments", () => {
  const evasions = [
    svg('<a href="&#106;avascript:alert(1)"/>'), svg('<a href="java&#x09;script:alert(1)"/>'), svg('<a xlink:href="JaVaScRiPt:alert(1)"/>'), svg("<SCRIPT>1</SCRIPT>"),
    svg('<style>@import url(https://example.test/x.css);</style>'), svg('<rect style="fill:url(https://example.test/a)"/>'), svg('<use href="https://example.test/a.svg#x"/>'),
    svg('<g onclick = "x()"/>'), svg('<![CDATA[<script>1</script>]]>'.replace(/^/, "") + "<script>2</script>"), svg('<a href="data:text/html;base64,PHNjcmlwdD4="/>'),
  ];
  for (const [i, e] of evasions.entries()) assert.equal(triageSvg(e).verdict, "block", `evasion ${i}: ${new TextDecoder().decode(e)}`);
  assert.equal(triageSvg(svg("<!-- <script>1</script> --><rect/>")).verdict, "allow_with_limits");   // a comment is not an element
  assert.equal(triageSvg(svg('<image href="data:image/png;base64,AAAA"/>')).verdict, "allow_with_limits");
});
test("an SVG with no marker is allow_with_limits at best and the statement says an opener still needs a sandbox", () => {
  const r = triageSvg(svg("<rect/>"));
  assert.equal(r.verdict, "allow_with_limits"); assert.equal(r.statement, STATEMENTS.none);
});

/* ---------- images ---------- */
const IMAGE_FIXTURES = {
  trailing_data: [[TYPES.png, () => png({ trailing: enc("extra") })], [TYPES.jpeg, () => jpeg({ trailing: enc("extra") })], [TYPES.gif, () => gif({ trailing: enc("extra") })], [TYPES.webp, () => webp({ trailing: enc("extra") })]],
  truncated: [[TYPES.png, () => png({ noIend: true })], [TYPES.jpeg, () => jpeg({ eoi: false })], [TYPES.gif, () => gif({ trailer: false })], [TYPES.webp, () => webp({ lieLen: 9999 })]],
  malformed: [[TYPES.png, () => png({ noIhdr: true })]],
  huge_dimensions: [[TYPES.png, () => png({ w: 20000, h: 6000 })], [TYPES.jpeg, () => jpeg({ w: 20000, h: 6000 })], [TYPES.gif, () => gif({ w: 20000, h: 6000 })]],
  decompression_bomb: [[TYPES.png, () => png({ w: 60000, h: 60000 })], [TYPES.jpeg, () => jpeg({ w: 65535, h: 65535 })]],
  metadata_present: [[TYPES.png, () => png({ text: true })], [TYPES.jpeg, () => jpeg({ exif: true })]],
};
for (const [name, severity] of Object.entries(IMAGE_MARKERS)) {
  test(`image marker ${name} (${severity}): found in each format's fixture, absent from a clean one`, () => {
    assert.ok(IMAGE_FIXTURES[name], `no fixture for image marker ${name}`);
    for (const [type, make] of IMAGE_FIXTURES[name]) {
      const r = triageImage(make(), type);
      assert.equal(has(r, name)?.severity, severity, `${type}: ${JSON.stringify(r.markers)}`);
    }
    for (const [type, make] of [[TYPES.png, png], [TYPES.jpeg, jpeg], [TYPES.gif, gif], [TYPES.webp, webp]]) assert.equal(has(triageImage(make(), type), name), undefined, `${type} clean`);
  });
}
test("image verdicts: a clean image is allow_with_limits; trailing data and huge dimensions need a sandbox; a bomb is blocked", () => {
  assert.equal(triageImage(png(), TYPES.png).verdict, "allow_with_limits");
  assert.equal(triageImage(png({ trailing: enc("x") }), TYPES.png).verdict, "needs_sandbox");
  assert.equal(triageImage(png({ w: 20000, h: 6000 }), TYPES.png).verdict, "needs_sandbox");
  const bomb = triageImage(png({ w: 60000, h: 60000 }), TYPES.png);
  assert.equal(bomb.verdict, "block"); assert.equal(bomb.reason_code, "archive_bomb");
  assert.ok(20000 * 6000 > MAX_PIXELS && 20000 * 6000 < BOMB_PIXELS && 60000 * 60000 > BOMB_PIXELS);
});

/* ---------- text ---------- */
test("text markers: formula-like CSV cells are noted; plain text and JSON are allowed by the triage (the scanner still decides)", () => {
  assert.ok(has(triageText(enc("name,total\nx,=HYPERLINK(\"http://example.test\")\n")), "formula_like_cells"));
  assert.ok(has(triageText(enc("a;@SUM(1+1)\n")), "formula_like_cells"));
  const plain = triageText(enc("hello\nworld\n"));
  assert.equal(plain.verdict, "allow"); assert.equal(plain.statement, STATEMENTS.none_text); assert.deepEqual(plain.markers, []);
  assert.equal(has(triageText(enc("-5,3\n+7,2\n")), "formula_like_cells"), undefined);   // numbers are not formulas
  assert.ok(Object.keys(TEXT_MARKERS).includes("formula_like_cells"));
});
/* ---------- dispatcher ---------- */
test("the dispatcher picks the triage by sniffed type and a type with no triage is needs_sandbox, never a pass", async () => {
  assert.equal((await triage(png(), TYPES.png)).verdict, "allow_with_limits");
  assert.equal((await triage(ole(["WordDocument"]), TYPES.doc)).verdict, "needs_sandbox");
  assert.equal((await triage(zip([{ name: "a", data: "b" }]), TYPES.zip)).verdict, "allow_with_limits");
  const none = await triage(enc("x"), "application/x-unknown");
  assert.equal(none.verdict, "needs_sandbox"); assert.equal(none.complete, false);
});
