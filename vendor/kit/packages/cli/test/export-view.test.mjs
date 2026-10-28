// kit docs export-view edge cases (docs/DIAGRAMS.md): code is never rewritten, every image syntax is handled or refused,
// nothing outside the repository is read, an image used twice is written once, and sizes are errors that read correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { exportView, fmtBytes } from "../src/export-view.js";
import { png } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

let n = 0;
const TMP = fileTempDir("kit-export-");

function repo(files) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "pic.png"), png());
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  return dir;
}
const run = (md, opts, extra = {}) => { const dir = repo({ "docs/A.md": md, ...extra }); return { dir, ...exportView(dir, "docs/A.md", opts) }; };
const DATA = /data:image\/png;base64,/g;

test("images inside code fences, inline code and HTML comments are not rewritten", () => {
  const r = run("```md\n![a](../pic.png)\n```\n\n~~~\n![b](../pic.png)\n~~~\n\nuse `![c](../pic.png)` like that, or ``![d](../pic.png)``\n\n<!-- ![e](../pic.png) -->\n\n![real](../pic.png)\n");
  assert.deepEqual(r.problems, []);
  assert.equal((r.text.match(DATA) || []).length, 1, "only the real image");
  for (const s of ["![a](../pic.png)", "![b](../pic.png)", "`![c](../pic.png)`", "``![d](../pic.png)``", "<!-- ![e](../pic.png) -->"]) assert.ok(r.text.includes(s), s);
});

test("a missing image inside a code fence is not an error either", () => {
  assert.deepEqual(run("```\n![x](nope.png)\n```\n").problems, []);
});

test("titled, angle-bracket and parenthesised destinations are rewritten and keep the title", () => {
  const r = run('![a](../pic.png "A title")\n\n![b](<../pic.png> \'T2\')\n\n![c](../pic.png#frag)\n');
  assert.deepEqual(r.problems, []);
  assert.match(r.text, /!\[a\]\(data:image\/png;base64,[^ )]+ "A title"\)/);
  assert.match(r.text, /!\[b\]\(data:image\/png;base64,[^ )]+ 'T2'\)/);
  assert.equal((r.text.match(DATA) || []).length, 3, "three different (path, title) uses, each used once: inline");
});

test("reference-style images: the definition is rewritten once, however many images use it", () => {
  const r = run("![a][pic]\n\n![b][pic]\n\n![pic][]\n\n[pic]: ../pic.png \"Pic\"\n");
  assert.deepEqual(r.problems, []);
  assert.equal((r.text.match(DATA) || []).length, 1);
  assert.match(r.text, /\[pic\]: data:image\/png;base64,\S+ "Pic"/);
  assert.match(run("![a][nope]\n").problems.join("\n"), /image reference \[nope\] has no definition/);
});

test("a definition used by an image and a link is refused", () => {
  assert.match(run("![a][x] and [t][x]\n\n[x]: ../pic.png\n").problems.join("\n"), /used by an image and by a link/);
});

test("an image used more than once is written once, as a reference definition", () => {
  const r = run("![a](../pic.png)\n\n![b](../pic.png)\n\n![c](../pic.png)\n");
  assert.deepEqual(r.problems, []);
  assert.equal((r.text.match(DATA) || []).length, 1, "one copy of the bytes");
  assert.match(r.text, /!\[a\]\[kit-image-1\]/);
  assert.match(r.text, /\n\[kit-image-1\]: data:image\/png;base64,/);
  assert.equal(r.images.length, 1);
});

test("<img> tags are rewritten (each with its own copy); srcset and <picture> are refused", () => {
  const r = run('<img src="../pic.png" width="10"> and <img alt=x src=\'../pic.png\'>\n');
  assert.deepEqual(r.problems, []);
  assert.equal((r.text.match(DATA) || []).length, 2);
  assert.match(run('<img src="../pic.png" srcset="../pic.png 2x">\n').problems.join("\n"), /<img srcset> is not exportable/);
  assert.match(run('<picture><source srcset="../pic.png"><img src="../pic.png"></picture>\n').problems.join("\n"), /srcset|picture/);
  assert.deepEqual(run("```html\n<img src=\"../nope.png\" srcset=\"x\">\n```\n").problems, [], "in a fence it is text");
});

test("images outside the repository are refused: .., absolute paths, file: URLs, symlinks, with and without --base-url", () => {
  const dir = repo({ "docs/A.md": "![a](../../outside.png)\n\n![b](/etc/hostname.png)\n\n![c](file:///etc/passwd)\n\n![d](docs-link/x.png)\n" });
  const out = join(TMP, `out${n}`); mkdirSync(out); writeFileSync(join(out, "x.png"), png());
  symlinkSync(out, join(dir, "docs/docs-link"));
  writeFileSync(join(TMP, "outside.png"), png());
  for (const opts of [{}, { baseUrl: "https://github.com/o/r/blob/abc" }]) {
    const p = exportView(dir, "docs/A.md", opts).problems.join("\n");
    assert.match(p, /image \.\.\/\.\.\/outside\.png is outside the repository/);
    assert.match(p, /absolute path is not exportable/);
    assert.match(p, /file: scheme is not exportable/);
    assert.match(p, /symlink that leaves the repository/);
  }
  assert.match(exportView(dir, "../outside.png").problems[0] || "", /does not exist|outside the repository/);
});

test("unsupported types and missing files are errors", () => {
  const r = run("![a](../notes.txt)\n\n![b](../gone.png)\n", {}, { "notes.txt": "x" });
  assert.match(r.problems.join("\n"), /unsupported type \.txt/);
  assert.match(r.problems.join("\n"), /image \.\.\/gone\.png does not exist/);
});

test("sizes are errors, and the message never reads 0.0 MB", () => {
  const r = run("![a](../pic.png)\n", { maxImageBytes: 10 });
  assert.match(r.problems.join("\n"), /image \.\.\/pic\.png is \d+(\.\d+)? (B|KB), over the limit of 10 B per image/);
  assert.ok(!/0\.0 MB/.test(r.problems.join("\n")));
  const t = run("![a](../pic.png)\n", { maxTotalBytes: 10 });
  assert.match(t.problems.join("\n"), /carries \d+(\.\d+)? (B|KB) of images, over the limit of 10 B in all/);
  assert.equal(fmtBytes(0), "0 B"); assert.equal(fmtBytes(999), "999 B"); assert.equal(fmtBytes(1500), "1.5 KB"); assert.equal(fmtBytes(1_200_000), "1.20 MB");
});

test("relative links to Markdown files are errors, in text but not in code", () => {
  assert.match(run("[x](B.md#top) and [y](https://e.org/c.md)\n").problems.join("\n"), /relative link to B\.md#top does not resolve/);
  assert.deepEqual(run("`[x](B.md)`\n\n```\n[y](C.md)\n```\n").problems, []);
});

test("a file outside the repository cannot be exported", () => {
  const dir = repo({});
  writeFileSync(join(TMP, "elsewhere.md"), "x\n");
  assert.match(exportView(dir, "../elsewhere.md").problems[0], /outside the repository/);
});
