import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseFilename } from "../src/filename.js";

const TABLE = [
  ["..\\..\\a.html", "a.html"], ["../../etc/passwd", "passwd"], ["/abs/path/file.PDF", "file.pdf"], ["C:\\Users\\x\\doc.docx", "doc.docx"], ["C:evil.txt", "evil.txt"],
  ["invoice\u202Efdp.exe", "invoicefdp.exe"],              // right-to-left override removed
  ["a\u200Bb\u200Dc.txt", "abc.txt"], ["a\u0000b\u0007c.txt", "abc.txt"], ["a\r\nb.txt", "ab.txt"], ["name\u2028x.txt", "namex.txt"],
  ["a..b...c.txt", "a.b.c.txt"], [".htaccess", "htaccess"], ["...hidden", "hidden"], ["trailing. . ", "trailing"], ["", "file"], ["   ", "file"], [null, "file"], [undefined, "file"],
  ["CON", "_CON"], ["nul.txt", "_nul.txt"], ["COM1.log", "_COM1.log"], ["lpt9", "_lpt9"],
  ['we<ir>d:"na|me?*.txt', "we_ir_d__na_me__.txt"], ["Résumé.PDF", "Résumé.pdf"], ["Re\u0301sume\u0301.pdf", "Résumé.pdf"],
  ["a".repeat(300) + ".pdf", "a".repeat(116) + ".pdf"], ["نامه اداری.pdf", "نامه اداری.pdf"], ["a   b.txt", "a b.txt"],
];
for (const [input, want] of TABLE) test(`filename ${JSON.stringify(String(input).slice(0, 30))} -> ${JSON.stringify(want.slice(0, 30))}`, () => {
  const r = normaliseFilename(input);
  assert.equal(r.name, want);
  assert.ok([...r.name].length <= 120);
  assert.ok(!/[\\\/\u0000-\u001F\u202A-\u202E<>:"|?*]/.test(r.name));
});
test("the result reports what changed and the lower-cased extension", () => {
  const r = normaliseFilename("..\\x\\Report.DOCX");
  assert.deepEqual([r.name, r.extension, r.changed], ["report.docx".replace("report", "Report"), "docx", true]);
  assert.ok(r.reasons.includes("path_removed") && r.reasons.includes("extension_lowercased"));
  assert.equal(normaliseFilename("clean.txt").changed, false);
});
test("maxLength is honoured and keeps the extension", () => {
  const r = normaliseFilename("x".repeat(50) + ".pdf", { maxLength: 20 });
  assert.equal(r.name.length, 20); assert.ok(r.name.endsWith(".pdf"));
});
