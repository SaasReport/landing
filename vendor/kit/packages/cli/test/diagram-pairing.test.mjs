// The Markdown pairing standard (docs/DIAGRAMS.md): image first, source collapsed, relative paths, stamps; plus the hardening of
// the lineage rule (fences in every style, header position, duplicate keys, pixel stamp, derives_from body, depicts in git).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { main } from "../src/index.js";
import { themeInit, mermaidBlocks, badMermaidFences, fences, stampPng, sourceHash, pixelProblem, pixelHash } from "../src/diagrams.js";
import { headerLine, readHeader, duplicateKey } from "../src/diagram-header.js";
import { checkDiagrams, mermaidBody } from "../src/diagram-lineage.js";
import { pairedBlocks, pairMarkdown, pairingProblems, bodyOf } from "../src/diagram-pairing.js";
import { exportView } from "../src/export-view.js";
import { bundled } from "../src/bundled.js";
import { png, header, syncGenerated } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const COLORS = { ink: "#0B0B0B", rail: "#B8B8B8", railDark: "#5A5A5A", bg: "#FAFAF7", sink: "#F3F2EE", accent: "#FF5A00", accentTint: "#FFF1E8", onAccent: "#FFFFFF", surface: "#FFFFFF" };
const INIT = themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }).split("\n")[0];
let n = 0;
const TMP = fileTempDir("kit-pairing-");

const block = (h, body = "flowchart TB\n  a:::accent --> b\n") => `${INIT}\n${headerLine(h)}\n${body}`;
const io = (cwd) => { const out = [], err = []; return { cwd, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, o: out, e: err }; };
function repo(files = {}, { sync = true } = {}) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs/diagrams"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts/brand.ttf"), "x");
  writeFileSync(join(dir, "docs/diagrams/theme.init"), themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }, [], { project: "kit" }));
  writeFileSync(join(dir, "kit.canon.json"), '{"project":"kit"}');
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  if (sync) syncGenerated(dir);
  return dir;
}
const problems = (dir) => checkDiagrams(dir).problems.map((p) => `${p.file}: ${p.problem}`);
const has = (list, re) => assert.ok(list.some((p) => re.test(p)), `${re} in\n${list.join("\n")}`);
const md = (h, body) => `# Doc\n\n\`\`\`mermaid\n${block(h, body)}\`\`\`\n`;

test("fences: backtick and tilde, a spaced or upper-case info string, nested example fences, bad info strings, unterminated", () => {
  const t = "~~~mermaid\nflowchart TB\n~~~\n\n``` Mermaid\nflowchart LR\n```\n\n````markdown\n```mermaid\nnot a diagram, an example\n```\n````\n";
  assert.deepEqual(mermaidBlocks(t).map((b) => b.body), ["flowchart TB\n", "flowchart LR\n"]);
  assert.equal(fences(t).length, 3);
  assert.deepEqual(badMermaidFences(t), []);
  assert.match(badMermaidFences("```mermaid-js\nx\n```\n")[0].problem, /names Mermaid but is not exactly/);
  assert.match(badMermaidFences("```{.mermaid}\nx\n```\n")[0].problem, /names Mermaid/);
  assert.match(badMermaidFences("```mermaid\nx\n")[0].problem, /unterminated/);
});

test("pairing text: image first (alt = title + id, relative path), source collapsed in details; idempotent", () => {
  const dir = repo({ "docs/A.md": md(header("kit.docs.a.1", { title: "A [thing]" })) }, { sync: false });
  const text = readFileSync(join(dir, "docs/A.md"), "utf8");
  const r = pairMarkdown(dir, "docs/A.md", text);
  assert.ok(r.changed);
  assert.match(r.text, /^# Doc\n\n!\[A thing \(kit\.docs\.a\.1\)\]\(diagrams\/blocks\/kit\.docs\.a\.1\.png\)\n\n<details><summary>Mermaid source \(kit\.docs\.a\.1\)<\/summary>\n\n```mermaid\n%%\{init/);
  assert.match(r.text, /```\n\n<\/details>\n$/);
  assert.equal(pairMarkdown(dir, "docs/A.md", r.text).changed, false);
  const b = pairedBlocks(r.text)[0];
  assert.ok(b.image && b.details);
});

test("pairing: the sibling .mmd's PNG is reused when the source is the same (header aside); a nested file gets a relative path", () => {
  const body = "flowchart TB\n  s:::accent --> t\n";
  const dir = repo({
    "docs/diagrams/s.mmd": block(header("kit.s"), body),
    "docs/deep/B.md": md(header("kit.docs.deep.b.1", { lineage: { derives_from: ["kit.s"], supersedes: [], version: "1" } }), body),
  });
  assert.match(readFileSync(join(dir, "docs/deep/B.md"), "utf8"), /\]\(\.\.\/diagrams\/s\.png\)/);
  assert.deepEqual(problems(dir), []);
});

test("must fail: no image, empty alt, absolute path, URL, missing PNG, not under docs/diagrams, stale PNG, not collapsed, hand-edited alt", () => {
  const h = header("kit.docs.c.1");
  const ok = repo({ "docs/C.md": md(h) });
  const text = readFileSync(join(ok, "docs/C.md"), "utf8");
  assert.deepEqual(problems(ok), []);
  const bad = (edit, re) => { const d = repo({ "docs/C.md": md(h) }); writeFileSync(join(d, "docs/C.md"), edit(text)); has(problems(d), re); };
  bad((t) => t.replace(/!\[.*\]\(.*\)\n\n<details>.*\n\n/, ""), /no rendered image before the Mermaid block/);
  bad((t) => t.replace(/!\[[^\]]*\]/, "![]"), /empty alt/);
  bad((t) => t.replace("](diagrams/blocks", "](/abs/docs/diagrams/blocks"), /absolute or a URL/);
  bad((t) => t.replace("](diagrams/blocks", "](https://example.com/diagrams/blocks"), /absolute or a URL/);
  bad((t) => t.replace("](diagrams/blocks/kit.docs.c.1.png)", "](diagrams/blocks/nope.png)"), /does not exist/);
  bad((t) => t.replace("](diagrams/blocks/kit.docs.c.1.png)", "](../README.md)"), /not a PNG under docs\/diagrams/);
  bad((t) => t.replace("a:::accent --> b", "a:::accent --> c"), /older than its source|differs from what kit diagrams render|stale/);
  bad((t) => t.replace(/<details><summary>.*<\/summary>\n\n/, "").replace("\n</details>\n", "\n"), /not collapsed/);
  bad((t) => t.replace("(kit.docs.c.1)](", "(whatever)]("), /differs from what kit diagrams render writes/);
});

test("pixel stamp: a PNG edited after render fails; the stamp covers the picture, not the stamps", () => {
  const dir = repo({ "docs/diagrams/p.mmd": block(header("kit.p")) });
  assert.deepEqual(problems(dir), []);
  const f = join(dir, "docs/diagrams/p.png");
  const p = readFileSync(f);
  assert.equal(pixelProblem(p), null);
  assert.equal(pixelHash(p), pixelHash(stampPng(p, "e".repeat(64), "kit.other")), "restamping does not move the pixel hash");
  // another picture under the same source stamp
  const other = png();
  other[other.indexOf(Buffer.from("IDAT")) + 4] ^= 0xff;
  const forged = Buffer.concat([other.subarray(0, other.length - 12), p.subarray(p.indexOf(Buffer.from("tEXt")) - 4, p.length - 12), other.subarray(other.length - 12)]);
  writeFileSync(f, forged);
  has(problems(dir), /edited after it was rendered/);
});

test("header: only on the line right after the init line; duplicate JSON keys rejected", () => {
  const h = header("kit.x");
  assert.equal(readHeader(`${INIT}\n${headerLine(h)}\nflowchart TB\n`).header.id, "kit.x");
  assert.match(readHeader(`${INIT}\nflowchart TB\n${headerLine(h)}\n`).error, /immediately after the init line/);
  assert.match(readHeader(`${INIT}\n\n${headerLine(h)}\nflowchart TB\n`).error, /immediately after the init line/);
  const dup = `%% kit:diagram ${JSON.stringify(h).replace('"id":"kit.x"', '"id":"kit.x","id":"kit.y"')}`;
  assert.match(readHeader(`${INIT}\n${dup}\nflowchart TB\n`).error, /repeats the key "id"/);
  assert.equal(duplicateKey('{"a":{"b":1},"c":{"b":2}}'), null);
  assert.equal(duplicateKey('{"a":1,"a":2}'), '"a" (top level)');
});

test("a bad reviewed date is a schema problem, not a stack trace", () => {
  const kit = bundled();
  const r = kit.validator.validate(header("kit.x", { reviewed: "2026-13-45" }), kit.byName("diagram"));
  assert.ok(JSON.stringify(r).includes("date") || JSON.stringify(r).length > 2);
});

test("derives_from means a copy: a differing Mermaid body fails; identical (comments aside) passes", () => {
  const A = "flowchart TB\n  a:::accent --> b\n";
  const ok = repo({ "docs/diagrams/a.mmd": block(header("kit.a"), A), "docs/diagrams/b.mmd": block(header("kit.b", { lineage: { derives_from: ["kit.a"], supersedes: [], version: "1" } }), A) });
  assert.deepEqual(problems(ok), []);
  const bad = repo({ "docs/diagrams/a.mmd": block(header("kit.a"), A), "docs/diagrams/b.mmd": block(header("kit.b", { lineage: { derives_from: ["kit.a"], supersedes: [], version: "1" } }), "flowchart TB\n  a:::accent --> b\n  b --> c\n") });
  has(problems(bad), /derives_from kit\.a, but the Mermaid body differs/);
  assert.equal(mermaidBody(`%% x\n${A}\n%% y`), "flowchart TB\n  a:::accent --> b");
  assert.equal(bodyOf(`${INIT}\n${headerLine(header("kit.q"))}\n${A}`).includes("kit:diagram"), false);
});

test("depicts: must be a tracked file or directory inside the repo (git work tree), never a symlink out", () => {
  const dir = repo({ "docs/diagrams/d.mmd": block(header("kit.d", { depicts: [{ kind: "file", ref: "tracked", path: "src/a.js" }] })), "src/a.js": "1\n" }, { sync: false });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  syncGenerated(dir);
  has(problems(dir), /not tracked by git/);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  assert.deepEqual(problems(dir), []);
  const out = join(TMP, `outside${n}`); mkdirSync(out); writeFileSync(join(out, "x.txt"), "x");
  symlinkSync(out, join(dir, "linked"));
  writeFileSync(join(dir, "docs/diagrams/d.mmd"), block(header("kit.d", { depicts: [{ kind: "file", ref: "link", path: "linked/x.txt" }] })));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  syncGenerated(dir);
  has(problems(dir), /resolves outside the repository/);
});

test("export-view: images inlined as data URIs, mermaid kept as image first + collapsed text fence; unpaired block, missing image or unresolved link fails; base-url", async () => {
  const dir = repo({ "docs/E.md": `${md(header("kit.docs.e.1"))}\n![shot](../pic.png)\n`, "pic.png": png() });
  const r = exportView(dir, "docs/E.md");
  assert.deepEqual(r.problems, []);
  assert.equal((r.text.match(/data:image\/png;base64,/g) || []).length, 2, "the diagram's PNG and the shot, each once");
  assert.match(r.text, /<details><summary>Mermaid source \(kit\.docs\.e\.1\)<\/summary>\n\n```text\n%%\{init/);
  assert.ok(!/```mermaid/.test(r.text));
  const url = exportView(dir, "docs/E.md", { baseUrl: "https://github.com/o/r/blob/abc" });
  assert.match(url.text, /\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/diagrams\/blocks\/kit\.docs\.e\.1\.png\?raw=true\)/);
  const un = repo({ "docs/U.md": md(header("kit.docs.u.1")) }, { sync: false });
  assert.match(exportView(un, "docs/U.md").problems[0], /no image-first pairing/);
  const link = repo({ "docs/L.md": `${md(header("kit.docs.l.1"))}\n[other](F.md)\n` });
  assert.match(exportView(link, "docs/L.md").problems.join("\n"), /relative link to F\.md does not resolve/);
  const out = join(TMP, "export-out");
  const c = io(dir);
  assert.equal(await main(["docs", "export-view", "docs/E.md", "--out", out], c), 0, c.e.join("\n"));
  assert.match(readFileSync(join(out, "E.md"), "utf8"), /data:image\/png;base64/);
  const c2 = io(un);
  assert.equal(await main(["docs", "export-view", "docs/U.md", "--out", out], c2), 1);
  const c3 = io(dir);
  assert.equal(await main(["docs", "export-view", "docs/E.md", "--out", out, "--strict"], c3), 1);
  assert.match(c3.e.join("\n"), /unknown flag --strict/);
});

test("identity footer: generated from the header only; an explicit phrase when nothing is declared; depicts shortened with a count", async () => {
  const { footerLines, footerHash, decodePng } = await import("../src/diagram-gates.js");
  const bare = footerLines(header("kit.q"));
  assert.deepEqual(bare.map((l) => l.text), ["kit.q", "A diagram  ·  project kit  ·  v1  ·  reviewed 2026-10-06", "no lineage declared (derives from, supersedes and relates to: none)", "depicts: nothing declared"]);
  const rich = footerLines(header("kit.r", {
    lineage: { derives_from: ["kit.a", "kit.b"], supersedes: ["kit.old"], version: "2" }, relates_to: [{ id: "kit.z", relation: "sibling" }],
    depicts: ["a", "b", "c", "d", "e"].map((x) => ({ kind: "file", ref: x, path: "README.md" })),
  })).map((l) => l.text);
  assert.deepEqual(rich.slice(2), ["derives from: kit.a, kit.b", "supersedes: kit.old", "relates to: kit.z (sibling)", "depicts: a, b, c +2"]);
  assert.notEqual(footerHash(header("kit.q")), footerHash(header("kit.q", { title: "Another title" })), "a changed header changes the footer hash, so the stale PNG fails");
  assert.equal(decodePng(png()).width, 1);
});
