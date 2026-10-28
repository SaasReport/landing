// The sniffer decides from bytes; declared type and extension are only compared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniff, scanPolyglot, matchesDeclared, ALLOWABLE_TYPES, TYPES } from "../src/sniff.js";
import { cat, enc, pdf, zip, ooxml, ole, png, jpeg, gif, webp } from "./fixtures.mjs";

const pe = () => { const b = new Uint8Array(0x100); b.set(enc("MZ"), 0); b[0x3c] = 0x80; b.set(enc("PE\0\0"), 0x80); return b; };

/** A minimal real ELF header: 64-bit little-endian x86-64 executable, or 32-bit big-endian PowerPC when `be32`. */
const elf = ({ be32 = false, cls, data, version, type, machine, phoff, shoff, size = 128 } = {}) => {
  const b = new Uint8Array(size), v = new DataView(b.buffer), le = !be32;
  b.set([0x7f, 0x45, 0x4c, 0x46, cls ?? (be32 ? 1 : 2), data ?? (be32 ? 2 : 1), version ?? 1], 0);
  v.setUint16(16, type ?? 2, le); v.setUint16(18, machine ?? (be32 ? 20 : 62), le); v.setUint32(20, 1, le);
  if (be32) { v.setUint32(28, phoff ?? 52, le); v.setUint32(32, shoff ?? 0, le); } else { v.setBigUint64(32, BigInt(phoff ?? 64), le); v.setBigUint64(40, BigInt(shoff ?? 0), le); }
  return b;
};

const TABLE = [
  ["pdf", pdf(), TYPES.pdf, "document"], ["png", png(), TYPES.png, "image"], ["jpeg", jpeg(), TYPES.jpeg, "image"], ["gif", gif(), TYPES.gif, "image"], ["webp", webp(), TYPES.webp, "image"],
  ["docx", ooxml("docx"), TYPES.docx, "document"], ["xlsx", ooxml("xlsx"), TYPES.xlsx, "document"], ["pptx", ooxml("pptx"), TYPES.pptx, "document"],
  ["zip", zip([{ name: "a.txt", data: "x" }]), TYPES.zip, "archive"], ["doc", ole(["WordDocument"]), TYPES.doc, "document"], ["xls", ole(["Workbook"]), TYPES.xls, "document"], ["ppt", ole(["PowerPoint Document"]), TYPES.ppt, "document"],
  ["ole other", ole(["Foo"]), TYPES.ole, "document"],
  ["svg", enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), TYPES.svg, "image"], ["svg with prolog", enc('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="x"/>'), TYPES.svg, "image"],
  ["html", enc("<!DOCTYPE html><html></html>"), TYPES.html, "script"], ["html fragment", enc("<script>alert(1)</script>"), TYPES.html, "script"], ["html in comment lead", enc("<!-- x --><html>"), TYPES.html, "script"],
  ["markup inside text", enc("hello\nsee <script>x</script>"), TYPES.html, "script"],
  ["js", enc('"use strict";\nfoo()'), "application/javascript", "script"], ["js function", enc("function f(){}"), "application/javascript", "script"],
  ["json", enc('{"a":[1,2]}'), TYPES.json, "text"], ["text", enc("just some words\n"), TYPES.text, "text"], ["csv", enc("a,b\n1,2\n"), TYPES.text, "text"],
  ["not json", enc("{ not json"), TYPES.text, "text"], ["utf-8 text", enc("سلام دنیا"), TYPES.text, "text"],
  ["xml", enc('<?xml version="1.0"?><a/>'), "application/xml", "text"],
  ["pe", pe(), "application/x-msdownload", "executable"], ["elf", cat("\x7fELF", new Uint8Array(20)), "application/x-elf", "executable"],
  ["macho", Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0, 0), "application/x-mach-binary", "executable"], ["lnk", Uint8Array.of(0x4c, 0, 0, 0, 1, 0x14, 2, 0, 0), "application/x-ms-shortcut", "executable"],
  ["shebang", enc("#!/bin/sh\necho 1"), "text/x-script", "script"], ["php", enc("<?php echo 1;"), "application/x-httpd-php", "script"],
  ["gzip", Uint8Array.of(0x1f, 0x8b, 8, 0, 0), "application/gzip", "archive"], ["7z", Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0), "application/x-7z-compressed", "archive"],
  ["rar", cat("Rar!\x1a\x07\x00"), "application/vnd.rar", "archive"], ["jar", zip([{ name: "META-INF/MANIFEST.MF", data: "x" }]), "application/java-archive", "archive"],
  ["binary noise", Uint8Array.of(1, 2, 3, 0, 4, 5), "application/octet-stream", "unknown"], ["empty", new Uint8Array(0), "application/octet-stream", "unknown"],
];
for (const [name, bytes, type, family] of TABLE) test(`sniff: ${name} is ${type}`, () => { const s = sniff(bytes); assert.equal(s.type, type); assert.equal(s.family, family); });

test("text that merely starts with MZ is text, not an executable", () => assert.equal(sniff(enc("MZ-123 quarterly report")).type, TYPES.text));
test("UTF-16 with a BOM is decoded before it is classified (markup cannot hide in UTF-16)", () => {
  const u16 = (s, le = true) => { const out = new Uint8Array(2 + s.length * 2); out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]); [...s].forEach((c, i) => { const v = c.charCodeAt(0); out.set(le ? [v & 255, v >> 8] : [v >> 8, v & 255], 2 + i * 2); }); return out; };
  assert.equal(sniff(u16("<html><script>1</script>")).type, TYPES.html);
  assert.equal(sniff(u16("<svg xmlns='x'/>", false)).type, TYPES.svg);
  assert.equal(sniff(u16("plain")).type, TYPES.text);
});
test("a PDF header after junk is a polyglot signal; beyond 1024 bytes it is not a PDF", () => {
  const s = sniff(cat("junk\n", pdf()));
  assert.equal(s.type, TYPES.pdf); assert.equal(s.polyglot_suspect, true); assert.ok(s.signals.includes("pdf_header_offset"));
  assert.notEqual(sniff(cat(new Uint8Array(2000).fill(0x20), pdf())).type, TYPES.pdf);
});
test("images with another format glued on are polyglot suspects", () => {
  for (const [what, tail] of [["zip", zip([{ name: "a", data: "x" }])], ["pdf", pdf()], ["script", enc("<script>alert(1)</script>")], ["html", enc("<html><body>")], ["php", enc("<?php system($_GET[0]);")], ["elf64", elf()], ["elf32 big-endian", elf({ be32: true })]]) {
    for (const [fmt, img] of [["png", png()], ["jpeg", jpeg()], ["gif", gif()], ["webp", webp()]]) {
      const s = sniff(cat(img, tail));
      assert.equal(s.polyglot_suspect, true, `${fmt}+${what}`);
    }
  }
  for (const img of [png(), jpeg(), gif(), webp()]) assert.equal(sniff(img).polyglot_suspect, false);
  // the signature alone, or an implausible identification behind it, is not an ELF
  const bad = [["zero bytes", cat("\x7fELF", new Uint8Array(60))], ["class 3", elf({ cls: 3 })], ["class 0", elf({ cls: 0 })], ["data 0", elf({ data: 0 })], ["data 3", elf({ data: 3 })], ["version 2", elf({ version: 2 })],
    ["type 0", elf({ type: 0 })], ["type 9", elf({ type: 9 })], ["machine 0", elf({ machine: 0 })], ["machine 0x7777", elf({ machine: 0x7777 })],
    ["phoff outside", elf({ phoff: 100000 })], ["shoff outside", elf({ shoff: 100000 })], ["no offsets", elf({ phoff: 0 })], ["truncated header", elf().subarray(0, 40)]];
  for (const [what, tail] of bad) assert.equal(sniff(cat(png(), tail)).polyglot_suspect, false, what);
  assert.equal(sniff(cat(png(), elf({ phoff: 0, shoff: 64, type: 1 }))).polyglot_suspect, true, "relocatable object: sections only");
});
test("the allowable types are exactly the ones a policy may list and never an executable, script or other archive", () => {
  for (const t of ALLOWABLE_TYPES) { assert.ok(!/x-msdownload|x-elf|javascript|text\/html|x-script|gzip|rar|7z/.test(t), t); }
  assert.ok(ALLOWABLE_TYPES.includes(TYPES.pdf) && !ALLOWABLE_TYPES.includes(TYPES.html) && !ALLOWABLE_TYPES.includes("application/x-msdownload"));
});

test("declared type and extension are compared with the bytes, never trusted", () => {
  const yes = [[{ contentType: "application/pdf", filename: "a.pdf" }, TYPES.pdf], [{ contentType: "image/jpg", filename: "a.JPG" }, TYPES.jpeg], [{ contentType: "text/csv", filename: "a.csv" }, TYPES.text],
    [{ contentType: "application/octet-stream", filename: "noext" }, TYPES.pdf], [{ contentType: null, filename: null }, TYPES.png], [{ contentType: "application/zip", filename: "a.zip" }, TYPES.docx],
    [{ contentType: "application/json", filename: "a.json" }, TYPES.text], [{ contentType: "application/pdf; charset=binary", filename: "x.pdf" }, TYPES.pdf]];
  const no = [[{ contentType: "application/pdf", filename: "a.pdf" }, "application/x-msdownload"], [{ contentType: "image/png", filename: "a.png" }, TYPES.html], [{ contentType: "application/pdf", filename: "a.exe" }, TYPES.pdf],
    [{ contentType: null, filename: "invoice.pdf.exe" }, TYPES.pdf], [{ contentType: null, filename: "a.png" }, TYPES.pdf], [{ contentType: "text/plain", filename: "a.txt" }, TYPES.pdf], [{ contentType: "application/pdf", filename: null }, TYPES.svg],
    [{ contentType: "image/png", filename: "a.png" }, "application/octet-stream"]];
  for (const [d, t] of yes) assert.equal(matchesDeclared(d, t), true, JSON.stringify([d, t]));
  for (const [d, t] of no) assert.equal(matchesDeclared(d, t), false, JSON.stringify([d, t]));
});
test("a PE file named x.pdf with media type application/pdf is a PE and does not match its claims", () => {
  const s = sniff(pe());
  assert.equal(s.type, "application/x-msdownload");
  assert.equal(matchesDeclared({ contentType: "application/pdf", filename: "x.pdf" }, s.type), false);
});

test("an image with a script, markup or a second format right after its magic is a polyglot suspect (the scan starts at the end of each signature)", () => {
  const enc8 = (x) => new TextEncoder().encode(x);
  const cases = [
    ["gif script", enc8("GIF89a<script>alert(1)</script>;")], ["gif php", enc8("GIF89a<?php system($_GET[0]); ?>;")], ["gif87a html", enc8("GIF87a<html><body>")],
    ["jpeg script", cat(Uint8Array.of(0xff, 0xd8, 0xff), enc8("<script>alert(1)</script>"), Uint8Array.of(0xff, 0xd9))], ["jpeg php", cat(Uint8Array.of(0xff, 0xd8, 0xff), enc8("<?php echo 1;"), Uint8Array.of(0xff, 0xd9))],
    ["png script", cat("\x89PNG\r\n\x1a\n", enc8("<script>alert(1)</script>"))], ["webp script", cat("RIFF", Uint8Array.of(0, 0, 0, 0), "WEBP", enc8("<script>alert(1)</script>"))],
    ["gif pdf", cat("GIF89a", pdf())], ["jpeg zip", cat(Uint8Array.of(0xff, 0xd8, 0xff), zip([{ name: "a", data: "x" }]))],
  ];
  for (const [name, b] of cases) assert.equal(sniff(b).polyglot_suspect, true, name);
});
test("a large image is scanned end to end: a payload in the middle of a 5 MiB image, or across a chunk seam, is found", () => {
  const big = (at, payload) => { const b = new Uint8Array(5 * 1024 * 1024); b.set(png(), 0); b.set(new TextEncoder().encode(payload), at); return b; };
  assert.equal(sniff(big(2 * 1024 * 1024 + 123, "<script>alert(1)</script>")).polyglot_suspect, true, "middle");
  assert.equal(sniff(big(1024 * 1024 - 5, "<script>alert(1)</script>")).polyglot_suspect, true, "seam");
  assert.equal(sniff(big(4 * 1024 * 1024, "<?php echo 1;")).polyglot_suspect, true, "php");
  assert.equal(sniff(big(3 * 1024 * 1024, "harmless")).polyglot_suspect, false);
});

/** A seeded generator (mulberry32): the same bytes on every run. */
const seeded = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const noisy = (type, size, seed, inject = []) => {
  const rnd = seeded(seed), b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (rnd() * 256) | 0;
  b.set(type, 0);
  for (const [at, bytes] of inject) b.set(bytes, at);
  return b;
};

test("a large image of random benign data is not flagged, even when PK\\x03\\x04, MZ\\x90\\x00 and \\x7fELF occurs in it by chance", () => {
  const PK = Uint8Array.of(0x50, 0x4b, 3, 4), MZ = Uint8Array.of(0x4d, 0x5a, 0x90, 0), ELF = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
  // the signatures planted where random compressed data would carry them, followed by noise: no zip, PE or ELF header behind them
  const inject = [[100000, PK], [2_000_000, PK], [3_000_001, MZ], [5_000_000, MZ], [7_000_000, PK], [1_500_000, ELF], [4_000_000, ELF], [8_000_000, ELF]];
  for (const [name, magic] of [["png", png()], ["jpeg", jpeg()], ["gif", gif()]]) {
    const s = sniff(noisy(magic.subarray(0, Math.min(magic.length, 8)), 10 * 1024 * 1024, 20261007, inject));
    assert.equal(s.polyglot_suspect, false, `${name}: ${s.signals.join(",")}`);
  }
  // with real structure behind the signature it is flagged
  const withZip = noisy(png().subarray(0, 8), 2 * 1024 * 1024, 7, [[1_000_000, zip([{ name: "a.txt", data: "x" }])]]);
  assert.equal(sniff(withZip).polyglot_suspect, true);
  assert.equal(sniff(noisy(png().subarray(0, 8), 2 * 1024 * 1024, 7, [[1_000_000, elf({ size: 256 })]])).polyglot_suspect, true, "a real ELF header is flagged");
});

test("glued markup is caught for every classifier tag, javascript:, and UTF-16 (LE and BE, either alignment)", () => {
  const t8 = (x) => new TextEncoder().encode(x);
  const le = (x) => Uint8Array.from([...x].flatMap((c) => [c.charCodeAt(0), 0]));
  const be = (x) => Uint8Array.from([...x].flatMap((c) => [0, c.charCodeAt(0)]));
  const payloads = ["<img src=x onerror=alert(1)>", "<body onload=alert(1)>", '<meta http-equiv="refresh" content="0;url=//x">', "<style>@import 'x'</style>", '<form action="//x">', "<math><mi>x</mi></math>", '<link rel="stylesheet" href="//x">', "<IMG SRC=x>", '<a href="javascript:alert(1)">', "< script>alert(1)</script>", "<svg onload=alert(1)>", "<iframe src=//x>", "<base href=//x>", "<title>x</title>", "<div>", "<table>", "<head>", "<frameset>", "<object data=x>", "<embed src=x>"];
  for (const p of payloads) {
    for (const [fmt, img] of [["png", png()], ["jpeg", jpeg()], ["gif", gif()], ["webp", webp()]]) {
      assert.equal(sniff(cat(img, t8(p))).polyglot_suspect, true, `${fmt} ${p}`);
    }
  }
  for (const p of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<a href=javascript:alert(1)>", "<details open ontoggle=alert(1)>", "<?php echo 1;"]) {
    for (const [name, enc16] of [["LE", le], ["BE", be]]) for (const pad of [0, 1]) {
      assert.equal(sniff(cat(png(), new Uint8Array(pad), enc16(p))).polyglot_suspect, true, `utf-16${name} pad ${pad} ${p}`);
    }
  }
  // text that merely contains a tag-like word without a tag is not markup
  assert.equal(sniff(cat(png(), t8("a < b and c > d, 3 <= 4, divide, image, x<y"))).polyglot_suspect, false);
  // "javascript:" outside a tag's URL attribute is only text (it is a false block, not a signal): the scan is narrowed to tag context
  for (const text of ["see javascript:void(0) in the docs", "javascript:alert(1)", "<p>javascript:alert(1)</p>", '<a title="javascript:x">', "<a href=\"https://x/?u=javascript:x\">"]) assert.equal(sniff(cat(png(), t8(text))).polyglot_suspect, false, text);
});

const polyglotOf = (text, img = png) => sniff(cat(img(), typeof text === "string" ? new TextEncoder().encode(text) : text)).polyglot_suspect;

test("control bytes and NUL inside a tag do not hide it: form feed is HTML whitespace, NUL is an ordinary character", () => {
  for (const text of ["<img src=x\x0conerror=alert(1)>", "<script\x0c src=x>", "<svg\x0conload=alert(1)>", "<img src=x onerror=alert(1)\0>", "<script data-cfasync="false" src=x\0>", "<details\x0copen\x0contoggle=alert(1)>", "<input\tautofocus\nonfocus=alert(1)>", "<zz\x0conclick=alert(1)\0>", "<a\x0chref=javascript:alert(1)\0>", "<img/onerror=alert(1)>", "<svg/onload=alert(1)>"]) {
    for (const img of [png, jpeg, gif, webp]) assert.equal(polyglotOf(text, img), true, JSON.stringify(text));
  }
});

test("a glued PE is recognised by its e_lfanew structure, whatever the DOS stub bytes are; bare MZ is nothing", () => {
  const dos = (stub) => { const b = new Uint8Array(0x100); b.set(enc("MZ"), 0); b.set(stub, 2); b[0x3c] = 0x80; b.set(enc("PE\0\0"), 0x80); return b; };
  for (const [what, stub] of [["no \\x90", Uint8Array.of(0x00, 0x00)], ["other bytes", Uint8Array.of(0x50, 0x01)], ["stub text", enc("\x90\0This program cannot be run in DOS mode")], ["all 0xff", new Uint8Array(0x38).fill(0xff)]]) {
    for (const img of [png, jpeg, gif, webp]) assert.equal(polyglotOf(dos(stub), img), true, what);
  }
  const noPe = dos(Uint8Array.of(0x90, 0)); noPe.set(enc("XXXX"), 0x80);
  assert.equal(polyglotOf(noPe), false, "e_lfanew points at nothing");
  const outside = dos(Uint8Array.of(0x90, 0)); outside[0x3c] = 0xff; outside[0x3d] = 0xff;
  assert.equal(polyglotOf(outside), false, "e_lfanew outside the bytes");
  assert.equal(polyglotOf(enc("MZ\x90\0 and more text")), false, "MZ with the old stub bytes but no structure");
});

test("any tag with an event handler, or a script URL in a URL attribute, is a polyglot, known name or not", () => {
  for (const text of ["<details open ontoggle=alert(1)>", "<video><source onerror=alert(1)></video>", "<audio src=x onerror=alert(1)>", "<input autofocus onfocus=alert(1)>", "<marquee onstart=alert(1)>", "<a href=javascript:alert(1)>", '<a href="javascript:alert(1)">', "<a href=' JavaScript:alert(1)'>", "<a href=\"java\tscript:alert(1)\">", "<frame src=javascript:alert(1)>", '<zz xlink:href="javascript:alert(1)">', "<button formaction=javascript:alert(1)>", "<body\nONLOAD = alert(1)>"]) {
    assert.equal(polyglotOf(text), true, text);
  }
  for (const text of ["<a href=https://example.test/>", "<span class=one title=\"onclick=x\">", "<p data-on=1>", "<b one two>", "<u onx>", "<x on=1>", '<a title="a > b" id=1>', "<q cite=\"javascript\">"]) assert.equal(polyglotOf(text), false, text);
});

test("the markup scan is linear: it remembers where it stopped and never rescans a tag's window (a step count, not wall time)", () => {
  const size = 10 * 1024 * 1024, buf = (unit) => { const u = new TextEncoder().encode(unit), b = new Uint8Array(size); b.set(png().subarray(0, 8), 0); for (let i = 8; i < size; i++) b[i] = u[(i - 8) % u.length]; return b; };
  for (const unit of ["<zz ", '<zz a="', "<zz a=<zz ", "<  <  ", "<a ", "<zz onx ", "<a href=\" "]) {
    const stats = { steps: 0 }, img = buf(unit);
    assert.equal(scanPolyglot(img, [], 8, { stats }), false, unit);
    assert.ok(stats.steps > size / 4 && stats.steps < 12 * size, `${JSON.stringify(unit)}: ${stats.steps} steps for ${size} bytes`);
  }
  const stats = { steps: 0 }, img = buf("<script ");   // the first known tag ends the scan at once
  assert.equal(scanPolyglot(img, [], 8, { stats }), true); assert.ok(stats.steps < 5000, String(stats.steps));
});

test("the space allowed after \"<\" is bounded", () => {
  assert.equal(sniff(cat(png(), new TextEncoder().encode("<   script>alert(1)</script>"))).polyglot_suspect, true);
  assert.equal(sniff(cat(png(), new TextEncoder().encode(`<${" ".repeat(200000)}script>`))).polyglot_suspect, false);
});

test("a tag or a zip header straddling a chunk boundary is found because the chunks overlap, and is missed with overlap 0", () => {
  const CHUNK = 1024 * 1024, start = 8;
  const at = (offset, bytes) => { const b = new Uint8Array(3 * CHUNK); b.set(png().subarray(0, 8), 0); b.set(bytes, offset); return b; };
  const script = new TextEncoder().encode("<script>alert(1)</script>");
  const pk = zip([{ name: "a.txt", data: "x" }]);
  const utf16 = Uint8Array.from([..."<script>"].flatMap((c) => [c.charCodeAt(0), 0]));
  for (const [name, bytes, off] of [["script", script, start + CHUNK - 3], ["zip", pk, start + CHUNK - 2], ["utf-16 script", utf16, start + CHUNK - 6]]) {
    const img = at(off, bytes);
    assert.equal(scanPolyglot(img, [], start), true, `${name} with the default overlap`);
    assert.equal(scanPolyglot(img, [], start, { overlap: 0 }), false, `${name} with overlap 0`);
    assert.equal(sniff(img).polyglot_suspect, true, name);
  }
});
