// The lineage rule (docs/DIAGRAMS.md): every diagram carries a kit.diagram.v1 header (id, lineage, relationships, depicts).
// Must-pass: a repo whose headers are valid and whose generated files are fresh. Must-fail: one fixture per rule.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/index.js";
import { themeInit, loadTheme, stampPng, sourceHash, THEME_FILE } from "../src/diagrams.js";
import { readHeader, headerLine, withHeader } from "../src/diagram-header.js";
import {
  checkDiagrams, collectDiagrams, generateIndex, generateLineage, lineageProblems, proposeHeaders, projectCode, projectOf,
  EXTERNALS_FILE, INDEX_FILE, LINEAGE_FILE,
} from "../src/diagram-lineage.js";
import { bundled } from "../src/bundled.js";
import { footerHash } from "../src/diagram-gates.js";
import { png, header, syncGenerated } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const COLORS = { ink: "#0B0B0B", rail: "#B8B8B8", railDark: "#5A5A5A", bg: "#FAFAF7", sink: "#F3F2EE", accent: "#FF5A00", accentTint: "#FFF1E8", onAccent: "#FFFFFF", surface: "#FFFFFF" };
let n = 0;
const TMP = fileTempDir("kit-lineage-");

const io = (cwd) => { const out = [], err = []; return { cwd, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, o: out, e: err }; };
const mmd = (h, body = "flowchart TB\n  a(\"A\"):::accent --> b(\"B\")\n") => `${themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }).split("\n")[0]}\n${headerLine(h)}\n${body}`;

/** A repo of project kit with the given .mmd files ({ stem: header | string }) and extra files; everything generated is in sync. */
function repo(diagrams = {}, files = {}, { sync = true } = {}) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs/diagrams"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts/brand.ttf"), "x");
  writeFileSync(join(dir, THEME_FILE), themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }, [], { project: "kit" }));
  writeFileSync(join(dir, "kit.canon.json"), '{"project":"kit"}');
  for (const [stem, h] of Object.entries(diagrams)) writeFileSync(join(dir, `docs/diagrams/${stem}.mmd`), typeof h === "string" ? h : mmd(h));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  if (sync) syncGenerated(dir);
  return dir;
}
const problems = (dir, opts) => checkDiagrams(dir, opts).problems.map((p) => `${p.file}: ${p.problem}`);
const has = (list, re) => assert.ok(list.some((p) => re.test(p)), `${re} in\n${list.join("\n")}`);

test("must pass: valid headers, fresh PNG stamps, generated lineage and index", async () => {
  const dir = repo({
    base: header("kit.base", { kind: "architecture", depicts: [{ kind: "file", ref: "the theme", path: THEME_FILE }] }),
    zoom: header("kit.zoom", { lineage: { derives_from: ["kit.base"], supersedes: [], version: "2" }, relates_to: [{ id: "kit.base", relation: "zooms-into" }] }),
  });
  assert.deepEqual(problems(dir), []);
  const c = io(dir);
  assert.equal(await main(["diagrams", "check"], c), 0, c.e.join("\n"));
  assert.match(c.o.at(-1), /3 diagrams and 0 Markdown mermaid blocks .*3 unique ids/);
});

test("header parsing: one line of JSON after the init line; a Markdown block carries one too", () => {
  const h = header("kit.x");
  const src = mmd(h);
  assert.deepEqual(readHeader(src).header, h);
  assert.equal(readHeader(src).line, 1);
  assert.deepEqual(readHeader("flowchart TB\n"), { header: null });
  assert.match(readHeader("%% kit:diagram {nope}\nflowchart TB\n").error, /not valid JSON/);
  assert.match(readHeader(`${headerLine(h)}\n${headerLine(h)}\nflowchart TB\n`).error, /more than one/);
  assert.equal(withHeader(withHeader(src, header("kit.y")), h), src, "replaced in place, never duplicated");
  assert.equal(headerLine({ reviewed: "2026-10-06", id: "kit.a", title: "T" }).indexOf('"id"') < headerLine({ reviewed: "x", id: "kit.a" }).indexOf('"reviewed"'), true, "canonical key order");
  const md = repo({}, { "docs/A.md": `# A thing\n\n\`\`\`mermaid\n${themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }).split("\n")[0]}\n${headerLine(header("kit.docs.a.1"))}\nflowchart TB\n  a:::accent --> b\n\`\`\`\n` });
  assert.deepEqual(collectDiagrams(md).filter((e) => e.file === "docs/A.md").map((e) => e.header.id), ["kit.docs.a.1"]);
  assert.deepEqual(problems(md), []);
});

test("must fail: a missing header, in a .mmd and in a Markdown block", () => {
  const dir = repo({ bare: mmd(header("kit.x")).split("\n").filter((l) => !l.includes("kit:diagram")).join("\n") }, { "docs/B.md": "```mermaid\nflowchart TB\n  a:::accent --> b\n```\n" }, { sync: false });
  const p = problems(dir);
  has(p, /docs\/diagrams\/bare\.mmd: no `%% kit:diagram/);
  has(p, /docs\/B\.md \(mermaid block 1\): no `%% kit:diagram/);
});

test("must fail: schema violations (each field)", () => {
  const bad = (over) => problems(repo({ x: header("kit.x", over) }));
  has(bad({ id: "x" }), /header \/id: must match/);
  has(bad({ id: "kit.Upper" }), /header \/id/);
  has(bad({ kind: "mural" }), /header \/kind: must be one of/);
  has(bad({ project: "zzz" }), /header \/project: must be one of/);
  has(bad({ title: "" }), /header \/title/);
  has(bad({ lineage: { derives_from: [], supersedes: [] } }), /lineage.*version|\/lineage/);
  has(bad({ lineage: { derives_from: ["not an id"], supersedes: [], version: "1" } }), /derives_from/);
  has(bad({ lineage: { derives_from: [], supersedes: [], version: "one" } }), /version/);
  has(bad({ relates_to: [{ id: "kit.y", relation: "loves" }] }), /relation: must be one of/);
  has(bad({ depicts: [{ kind: "file", ref: "r" }] }), /path/);
  has(bad({ depicts: [{ kind: "file", ref: "r", path: "../outside" }] }), /path/);
  has(bad({ reviewed: "yesterday" }), /reviewed: must be a valid date/);
  has(bad({ extra: 1 }), /extra: unknown property/);
  has(bad({ reviewed: undefined }), /exactly one of 3 alternatives \(matches 0\)|header \/: must match/);
  has(bad({ needs_review: true }), /needs_review/);
});

test("must fail: the id must carry its project code; the header's project may be any registered project (its theme is the theme check's)", () => {
  has(problems(repo({ x: header("saasreport.x", { project: "kit" }) })), /id saasreport\.x must start with its project code "kit\."/);
  // a registered project without a vendored theme is the theme check's to refuse (never drawn in the kit's colours): see diagram-themes.test.mjs
  assert.throws(() => repo({ x: header("saasreport.x", { project: "saasreport" }) }), /registered but has no vendored theme/);
});

test("must fail: duplicate ids, across .mmd files and Markdown blocks", () => {
  const dir = repo({ a: header("kit.same"), b: header("kit.same") });
  has(problems(dir), /duplicate id kit\.same/);
  const md = repo({ a: header("kit.same") }, { "docs/A.md": `\`\`\`mermaid\n${headerLine(header("kit.same"))}\nflowchart TB\n\`\`\`\n` }, { sync: false });
  has(problems(md), /duplicate id kit\.same/);
});

test("must fail: dangling references in derives_from, supersedes and relates_to; a declared external id passes", () => {
  const dir = repo({
    x: header("kit.x", { lineage: { derives_from: ["kit.nope"], supersedes: ["kit.gone"], version: "1" }, relates_to: [{ id: "kit.missing", relation: "sibling" }] }),
  });
  const p = problems(dir);
  has(p, /derives_from: kit\.nope is not a diagram of this repository nor declared/);
  has(p, /supersedes: kit\.gone is not a diagram/);
  has(p, /relates_to: kit\.missing is not a diagram/);
  // another repository's id, declared in externals.json
  const ok = repo({ x: header("kit.x", { lineage: { derives_from: ["saasreport.far.away", "https://example.org/original"], supersedes: [], version: "1" } }) },
    { [EXTERNALS_FILE]: JSON.stringify({ $schema: "x", externals: [{ repo: "example/downstream-site", ids: ["saasreport.far.away"] }] }) });
  assert.deepEqual(problems(ok), []);
  // ... and an externals file off its schema is itself a problem
  const badExt = repo({ x: header("kit.x") }, { [EXTERNALS_FILE]: JSON.stringify({ $schema: "x", externals: [{ repo: "no-slash", ids: ["not an id"] }] }) });
  has(problems(badExt), /externals\.json: .*(repo|ids)/);
  // a diagram cannot refer to itself
  has(problems(repo({ x: header("kit.x", { relates_to: [{ id: "kit.x", relation: "sibling" }] }) })), /refers to the diagram itself/);
});

test("must fail: cycles in derives_from and in supersedes", () => {
  const L = (d, s = []) => ({ lineage: { derives_from: d, supersedes: s, version: "1" } });
  const a = problems(repo({ a: header("kit.a", L(["kit.c"])), b: header("kit.b", L(["kit.a"])), c: header("kit.c", L(["kit.b"])) }));
  has(a, /cycle in derives_from \/ supersedes: kit\.\w -> kit\.\w -> kit\.\w -> kit\.\w/);
  const s = problems(repo({ a: header("kit.a", L([], ["kit.b"])), b: header("kit.b", L([], ["kit.a"])) }));
  has(s, /cycle in derives_from \/ supersedes/);
  // one graph: A derives from B while B supersedes A is a cycle too
  has(problems(repo({ a: header("kit.a", L(["kit.b"])), b: header("kit.b", L([], ["kit.a"])) })), /cycle in derives_from \/ supersedes/);
  assert.deepEqual(problems(repo({ a: header("kit.a", L(["kit.b"])), b: header("kit.b"), c: header("kit.c", L(["kit.a", "kit.b"])) })), [], "a diamond is not a cycle");
});

test("must fail: a depicts path that does not exist; passes when it does", () => {
  const dep = (path) => ({ depicts: [{ kind: "worker", ref: "site worker", path }] });
  has(problems(repo({ x: header("kit.x", dep("src/worker.js")) })), /depicts worker site worker: path src\/worker\.js does not exist/);
  assert.deepEqual(problems(repo({ x: header("kit.x", dep("src/worker.js")) }, { "src/worker.js": "//" })), []);
});

test("must fail: a PNG with a missing or wrong stamp: source hash, id, theme hash, footer hash; a PNG of another renderer never passes", () => {
  const h = header("kit.x");
  const dir = repo({ x: h });
  const f = join(dir, "docs/diagrams/x.mmd"), p = join(dir, "docs/diagrams/x.png");
  const src = readFileSync(f, "utf8"), th = loadTheme(dir);
  const ex = { theme: th.hash, footer: footerHash(h) };
  writeFileSync(p, stampPng(png(), sourceHash(src), "kit.other", ex));
  has(problems(dir), /x\.png: PNG is stamped with id kit\.other, the header says kit\.x/);
  writeFileSync(p, stampPng(png(), sourceHash(src), undefined, ex));
  has(problems(dir), /x\.png: PNG has no kit stamp \(id\)/);
  writeFileSync(p, stampPng(png(), "0".repeat(64), "kit.x", ex));
  has(problems(dir), /x\.png: PNG is older than its source/);
  writeFileSync(p, stampPng(png(), sourceHash(src), "kit.x"));
  has(problems(dir), /x\.png: PNG has no kit stamp \(theme hash, footer hash\)/);
  writeFileSync(p, png());
  has(problems(dir), /x\.png: PNG has no kit stamp \(source hash, id, pixel hash, theme hash, footer hash\)/);
  writeFileSync(p, stampPng(png(), sourceHash(src), "kit.x", { theme: "1".repeat(64), footer: footerHash(h) }));
  has(problems(dir), /x\.png: PNG was rendered with another theme/);
  writeFileSync(p, stampPng(png(), sourceHash(src), "kit.x", { theme: th.hash, footer: "2".repeat(64) }));
  has(problems(dir), /x\.png: PNG's identity footer differs from its header/);
  writeFileSync(p, stampPng(png(), sourceHash(src), "kit.x", ex));
  assert.deepEqual(problems(dir), []);
  writeFileSync(f, src.replace('"title":"A diagram"', '"title":"Renamed"'));
  has(problems(dir), /x\.png: PNG is older than its source/);
  // a PNG nobody owns, in docs/diagrams or below it
  const orphan = repo({ x: h });
  writeFileSync(join(orphan, "docs/diagrams/other.png"), png());
  has(problems(orphan), /other\.png: a PNG under docs\/diagrams that no diagram owns/);
});

test("no stub state: a placeholder-style header fails (a leftover needs_review key, empty relations without reviewed, any missing field)", async () => {
  // a leftover `needs_review` key (the old stub marker) is an unknown property, with or without `reviewed`
  const stub = repo({ x: header("kit.x", { reviewed: undefined, needs_review: true }) });
  has(problems(stub), /needs_review/);
  has(problems(repo({ x: header("kit.x", { needs_review: true }) })), /needs_review/);
  // empty relations and no `reviewed`: neither reviewed nor generated, so the header is not complete
  const noReview = repo({ x: header("kit.x", { reviewed: undefined }) });
  has(problems(noReview), /exactly one of|reviewed/);
  // a missing required field
  const half = header("kit.x"); delete half.depicts;
  has(problems(repo({ x: half })), /depicts/);
  const c = io(stub);
  assert.equal(await main(["diagrams", "check"], c), 1);
  assert.equal(checkDiagrams(stub).warnings, undefined, "there is no warning level to return");
});

test("generated files: the lineage graph and the index are checked against the headers and never hand-edited", () => {
  const dir = repo({ a: header("kit.a"), b: header("kit.b", { lineage: { derives_from: ["kit.a"], supersedes: [], version: "1" } }) });
  assert.deepEqual(problems(dir), []);
  writeFileSync(join(dir, INDEX_FILE), `${readFileSync(join(dir, INDEX_FILE), "utf8")}\nhand edit\n`);
  has(problems(dir), /README\.md: stale, missing or hand-edited/);
  syncGenerated(dir);
  writeFileSync(join(dir, LINEAGE_FILE), readFileSync(join(dir, LINEAGE_FILE), "utf8").replace("flowchart TB", "flowchart LR"));
  has(problems(dir), /lineage\.mmd: stale or missing/);
  // a header change makes both stale until `kit diagrams render` regenerates them
  syncGenerated(dir);
  const f = join(dir, "docs/diagrams/b.mmd");
  writeFileSync(f, readFileSync(f, "utf8").replace('"derives_from":["kit.a"]', '"derives_from":[]'));
  const p = problems(dir);
  has(p, /lineage\.mmd: stale or missing/);
  has(p, /README\.md: stale/);
  // only the lineage graph may say generated
  const g = repo({ a: header("kit.a", { reviewed: undefined, generated: true }) });
  has(problems(g), /`generated` belongs only to docs\/diagrams\/lineage\.mmd/);
});

test("generateLineage: edges, folded copies, external ids dashed, a column group for unrelated diagrams, its own id, the theme", () => {
  const dir = repo({
    a: header("kit.a"), b: header("kit.b", { lineage: { derives_from: ["kit.a"], supersedes: [], version: "1" }, relates_to: [{ id: "kit.a", relation: "zooms-into" }] }),
    c: header("kit.c", { lineage: { derives_from: [], supersedes: ["kit.b"], version: "1" } }), d: header("kit.d"),
  });
  const entries = collectDiagrams(dir).filter((e) => e.header && !e.header.generated);
  const text = generateLineage(entries, loadTheme(dir), "kit");
  const lines = text.split("\n");
  assert.equal(lines[0], loadTheme(dir).init);
  assert.equal(readHeader(text).header.id, "kit.diagrams.lineage");
  assert.equal(readHeader(text).header.generated, true);
  assert.match(text, /n1\("kit\.a"\)/);
  assert.doesNotMatch(text, /zooms-into/, "relationships are in the index table, not drawn (the graph stays narrow)");
  assert.match(text, /-\.->\|supersedes\|/);
  assert.match(text, /alone\("1 diagram with no lineage edges: listed in the index below"\)/);
  assert.doesNotMatch(text, /class n\d+ muted/, "no stub state to dash: only ids declared outside the repository are muted");
  assert.equal(generateLineage(entries, loadTheme(dir), "kit"), text, "deterministic");
  // islands (a-b-c-d here: one island; plus e-f) are stacked top to bottom by invisible links so the graph stays narrow
  const two = collectDiagrams(repo({ p: header("kit.p"), q: header("kit.q", { lineage: { derives_from: [], supersedes: ["kit.p"], version: "1" } }), r: header("kit.r"), s: header("kit.s", { lineage: { derives_from: [], supersedes: ["kit.r"], version: "1" } }) })).filter((e) => e.header && !e.header.generated);
  assert.match(generateLineage(two, loadTheme(dir), "kit"), /n\d+ ~~~ n\d+/);
  // diagrams without lineage are counted in one node, never drawn as a column of boxes (kit 2026-10-07: 90 such boxes made a
  // 17718 px picture no one could read on a phone)
  const many = Array.from({ length: 90 }, (_, i) => ({ header: header(`kit.m${i}`) }));
  const summary = generateLineage(many, loadTheme(dir), "kit");
  assert.match(summary, /alone\("90 diagrams with no lineage edges: listed in the index below"\)/);
  assert.doesNotMatch(summary, /kit\.m\d/, "no box per diagram without lineage");
  assert.match(summary, /class alone accent/);
});

test("generateIndex: a table of id, title, kind, derives from, relates to, depicts; one section per .mmd", () => {
  const dir = repo({
    a: header("kit.a", { kind: "architecture", summary: "The A.", depicts: [{ kind: "file", ref: "theme", path: THEME_FILE }] }),
    b: header("kit.b", { lineage: { derives_from: ["kit.a"], supersedes: [], version: "3" }, relates_to: [{ id: "kit.a", relation: "implemented-by" }] }),
  });
  const text = readFileSync(join(dir, INDEX_FILE), "utf8");
  assert.match(text, /^<!-- Generated by `kit diagrams render`/);
  assert.match(text, /\| id \| title \| kind \| derives from \| relates to \| depicts \| source \|/);
  assert.match(text, /\| `kit\.b` v3 \| A diagram \| other \| `kit\.a` \| implemented-by `kit\.a` \| none \| \[b\.mmd\]\(b\.mmd\) \|/);
  assert.match(text, /\| `kit\.a` v1 \| A diagram \| architecture \| none \| none \| file: \[theme\]\(theme\.init\) \|/);
  assert.doesNotMatch(text, /Needs review/, "there is no needs-review state");
  assert.match(text, /## kit\.a\n\nA diagram\. The A\.\n\n!\[A diagram\]\(a\.png\)/);
  assert.match(text, /!\[Lineage of every diagram\]\(lineage\.png\)/);
  assert.equal(generateIndex(collectDiagrams(dir).map((e) => (e.header?.generated ? e : e)), { projectName: "kit" }), text);
});

test("migrate PROPOSES only: a worklist (suggested id, project, identical bodies, mentioned paths), no header and no file written in the repository", async () => {
  const body = "flowchart TB\n  a:::accent --> b\n";
  const dir = repo({ "site-registry": `${themeInit(COLORS, { family: "Brand Sans", path: "fonts/brand.ttf" }).split("\n")[0]}\n${body}`, flow: header("kit.flow", { summary: "kept" }), seq: "sequenceDiagram\n  A->>B: hi\n" },
    { "docs/ARCH.md": "# Top\n\n## The worker\n\n```mermaid\nflowchart TB\n  a:::accent --> b\n```\n\ntext\n\n```mermaid\nerDiagram\n  A ||--o{ B : has\n```\n", "src/a.js": "x\n" }, { sync: false });
  const before = new Map(["docs/diagrams/site-registry.mmd", "docs/diagrams/flow.mmd", "docs/diagrams/seq.mmd", "docs/ARCH.md"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const listing = (d) => readdirSync(d, { recursive: true }).sort().join("\n");
  const tree = listing(dir);
  const run = io(dir);
  assert.equal(await main(["diagrams", "migrate"], run), 0, run.e.join("\n"));
  const text = run.o.join("\n");
  assert.match(text, /4 diagrams without a `%% kit:diagram` header\. Nothing was written to the repository/);
  assert.match(text, /## docs\/diagrams\/site-registry\.mmd\n- suggested id: `kit\.site\.registry`  project: `kit`/);
  assert.match(text, /## docs\/diagrams\/seq\.mmd\n- suggested id: `kit\.seq`  project: `kit`  kind: `sequence` \(the syntax says it\)/);
  assert.match(text, /## docs\/ARCH\.md \(mermaid block 1\)\n- suggested id: `kit\.docs\.arch\.1`/);
  assert.match(text, /identical Mermaid body: docs\/ARCH\.md \(mermaid block 1\)/, "the registry diagram and the block share a body: a candidate derives_from");
  assert.doesNotMatch(text, /needs_review/);
  for (const [f, t] of before) assert.equal(readFileSync(join(dir, f), "utf8"), t, `${f} untouched`);
  assert.equal(listing(dir), tree, "no file written in the repository");
  // --out writes outside the repository only
  const inside = io(dir);
  assert.equal(await main(["diagrams", "migrate", "--out", join(dir, "worklist.md")], inside), 1);
  assert.match(inside.e.join("\n"), /inside the repository/);
  const out = join(TMP, `worklist${n++}.md`);
  assert.equal(await main(["diagrams", "migrate", "--out", out], io(dir)), 0);
  assert.match(readFileSync(out, "utf8"), /# Headers to write/);
  // and the repository fails npm test at the first headerless diagram
  syncGenerated(dir);
  const chk = io(dir);
  assert.equal(await main(["diagrams", "check"], chk), 1);
  assert.match(chk.e.join("\n"), /no `%% kit:diagram \{…\}` header/);
});

test("migrate proposes distinct ids when the suggestions collide, and still writes nothing", async () => {
  const dir = repo({ "a-b": "flowchart TB\n  a:::accent --> b\n", "a.b": "flowchart TB\n  a --> c\n" }, {}, { sync: false });
  const c = io(dir);
  assert.equal(await main(["diagrams", "migrate"], c), 0);
  assert.match(c.o.join("\n"), /suggested id: `kit\.a\.b`[\s\S]*suggested id: `kit\.a\.b\.2`/);
  assert.equal(readHeader(readFileSync(join(dir, "docs/diagrams/a-b.mmd"), "utf8")).header, null);
});

test("project codes come from the registry: short without its dash, key when none, kit", () => {
  const reg = bundled().registry;
  assert.equal(projectCode("saasreport", reg), "saasreport", "no short form: the code is the key itself");
  // a registry with a short form: the code is the short without its dash
  const many = { projects: [...reg.projects, { key: "alpha", name: "Alpha", domain: "alpha.example", prefix: "alpha-", short: "al-" }] };
  assert.equal(projectCode("alpha", many), "al");
  assert.deepEqual(projectOf("/nonexistent", "al", many), { key: "alpha", code: "al" });
  // must fail: a code nobody owns is no project (no hand-copied list of codes decides this: the registry does)
  for (const bad of ["sc", "sr", "nope"]) assert.equal(projectOf("/nonexistent", bad, reg), null, bad);
  assert.deepEqual(projectOf("/nonexistent", "kit", reg), { key: "kit", code: "kit" });
  // must pass: every registry project, by key or by code
  for (const r of [reg, many]) for (const p of r.projects) for (const k of [p.key, projectCode(p.key, r)]) assert.equal(projectOf("/nonexistent", k, r).key, p.key, k);
  assert.equal(projectCode("kit", reg), "kit");
  assert.equal(projectCode("nope", reg), null);
  assert.deepEqual(projectOf("/nonexistent", "saasreport"), { key: "saasreport", code: "saasreport" });
  assert.equal(projectOf("/nonexistent"), null);
});

test("the schema's project enum is the registry's codes plus kit (one source per fact)", () => {
  const kit = bundled();
  const codes = new Set(kit.registry.projects.map((p) => projectCode(p.key, kit.registry)).concat("kit"));
  assert.deepEqual([...kit.byName("diagram").properties.project.enum].sort(), [...codes].sort());
  const idPattern = kit.byName("diagram").properties.id.pattern;
  for (const c of codes) assert.ok(new RegExp(idPattern).test(`${c}.terminal.arch`), c);
  assert.ok(!new RegExp(idPattern).test("nope.terminal.arch"), "a code nobody owns is refused");
});

test("lineageProblems is a pure function of the entries and the files they name", () => {
  const dir = repo({ a: header("kit.a") });
  const r = lineageProblems(dir, collectDiagrams(dir), { code: "kit" });
  assert.deepEqual(r.problems, []);
  assert.ok(r.ids.has("kit.a") && r.ids.has("kit.diagrams.lineage"));
  assert.ok(existsSync(join(dir, LINEAGE_FILE)));
});
