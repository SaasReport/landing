// The three ways a schema detector reads beyond one config file (finding-class schema): a `bind` that reads a JSON Pointer from
// another file, the `markdown-front-matter` format, and the `module` format that reads one named export of a JavaScript module
// without running it. Each has a must-pass, and every way it can fail is a finding, never a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../src/canon/findings.js";
import { walk } from "../src/canon/files.js";
import { bundled } from "../src/bundled.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const kit = bundled();
const shipped = kit.findingClasses.registry;
const tree = (t, files) => {
  const root = tempDir(t, "kit-sources-");
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : JSON.stringify(body)); }
  return root;
};
const registry = (detector) => ({ v: 1, grammars: shipped.grammars, sets: shipped.sets, templates: shipped.templates, shell: shipped.shell, classes: [{ id: "src", rule: "a rule long enough to read as one", level: "source", first_seen: ["a test"], cases: "findings/src", detect: [{ kind: "schema", problem: "a value is not what the declared source says it must be", ...detector }] }] });
const run = (t, files, detector) => { const root = tree(t, files); return runGate("src", root, walk(root), registry(detector)); };
const valid = (r) => kit.validator.validate(r, kit.byName("finding-class"));

// ---- bind: file ----------------------------------------------------------------------------------------------------
const IDS = { type: "array", minItems: 1, items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } };
const FROM_FILE = (file, extra = {}) => ({ files: { include: ["post.json"] }, format: "json", bind: { ids: { file, pointer: "/tags", pick: "id", valid: IDS, ...extra } }, schema: { properties: { tag: { enum: { $bind: "ids" } } } } });
const VOCAB = { tags: [{ id: "a" }, { id: "b" }] };

test("bind file: the registry schema accepts a path or a pointer to a path, and refuses other shapes", () => {
  assert.deepEqual(valid(registry(FROM_FILE("tags.json"))), []);
  assert.deepEqual(valid(registry(FROM_FILE({ pointer: "/tags/vocabulary" }))), []);
  assert.deepEqual(valid(registry(FROM_FILE("tags.json", { format: "yaml" }))), []);
  assert.ok(valid(registry(FROM_FILE({ path: "x" }))).length, "an object needs a pointer");
  assert.ok(valid(registry(FROM_FILE(""))).length, "an empty path");
  assert.ok(valid(registry(FROM_FILE("tags.json", { format: "csv" }))).length, "only the config formats");
});

test("bind file: the pointer is read from the named file (a path, or the path kit.canon.json holds), picked, and substituted", async (t) => {
  assert.deepEqual(await run(t, { "tags.json": VOCAB, "post.json": { tag: "a" } }, FROM_FILE("tags.json")), []);
  const bad = await run(t, { "tags.json": VOCAB, "post.json": { tag: "zzz" } }, FROM_FILE("tags.json"));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].match, "/tag");
  assert.deepEqual(await run(t, { "kit.canon.json": { tags: { vocabulary: "vocab/v.json" } }, "vocab/v.json": VOCAB, "post.json": { tag: "b" } }, FROM_FILE({ pointer: "/tags/vocabulary" })), [], "the path comes from kit.canon.json");
  assert.equal((await run(t, { "kit.canon.json": { tags: { vocabulary: "vocab/v.json" } }, "vocab/v.json": VOCAB, "post.json": { tag: "c" } }, FROM_FILE({ pointer: "/tags/vocabulary" }))).length, 1);
  assert.deepEqual(await run(t, { "v.yaml": "tags:\n  - id: a\n", "post.json": { tag: "a" } }, FROM_FILE("v.yaml", { format: "yaml" })), [], "another format");
});

test("bind file: a missing file, a file that does not parse, a missing pointer, a path nobody set and a wrong shape are findings, never passes", async (t) => {
  const ok = { tag: "a" };
  const cases = [
    [{ "post.json": ok }, FROM_FILE("tags.json"), /tags\.json cannot be read \(the file does not exist\)/],
    [{ "tags.json": "{ nope", "post.json": ok }, FROM_FILE("tags.json"), /tags\.json cannot be read/],
    [{ "tags.json": { other: [] }, "post.json": ok }, FROM_FILE("tags.json"), /tags\.json \/tags is not set/],
    [{ "tags.json": { tags: [] }, "post.json": ok }, FROM_FILE("tags.json"), /tags\.json \/tags is not the declared shape/],
    [{ "tags.json": { tags: "a" }, "post.json": ok }, FROM_FILE("tags.json"), /not the declared shape/],
    [{ "kit.canon.json": { tags: {} }, "post.json": ok }, FROM_FILE({ pointer: "/tags/vocabulary" }), /\/tags\/vocabulary is not set to a file path/],
    [{ "post.json": ok }, FROM_FILE({ pointer: "/tags/vocabulary" }), /kit\.canon\.json cannot be read/],
  ];
  for (const [files, det, re] of cases) {
    const found = await run(t, files, det);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0].problem, re);
    assert.match(found[0].match, /^unbound/);
  }
  assert.deepEqual((await run(t, { "tags.json": { other: [] }, "post.json": ok }, FROM_FILE("tags.json", { default: [{ id: "a" }] }))), [], "a declared default stands for a pointer to nothing");
});

// ---- format: markdown-front-matter ----------------------------------------------------------------------------------
const FM = (schema) => ({ files: { include: ["*.md"] }, format: "markdown-front-matter", schema });
const NEEDS_TAGS = { type: "object", required: ["tags"], properties: { tags: { type: "array", minItems: 1, items: { type: "string", pattern: "^[a-z]+$" } } } };

test("markdown-front-matter: the YAML between the first two --- lines is the value, at the file's own lines", async (t) => {
  assert.deepEqual(await run(t, { "a.md": "---\ntitle: A\ntags: [x, y]\n---\nBody\n" }, FM(NEEDS_TAGS)), []);
  assert.deepEqual(await run(t, { "a.md": "---\r\ntags: [x]\r\n---\r\nBody\r\n" }, FM(NEEDS_TAGS)), [], "CRLF");
  const bad = await run(t, { "a.md": "---\ntitle: A\ntags: [x, Y]\n---\nBody\n" }, FM(NEEDS_TAGS));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].match, "/tags/1");
  assert.equal(bad[0].line, 3, "the file's line, not the block's");
  assert.equal(bad[0].file, "a.md");
});

test("markdown-front-matter: a file with none is an empty object (a required key is reported), a body --- is not front matter, and unreadable front matter is a finding", async (t) => {
  const none = await run(t, { "a.md": "# Just a body\n" }, FM(NEEDS_TAGS));
  assert.equal(none.length, 1);
  assert.match(none[0].problem, /required|tags/i);
  assert.equal((await run(t, { "a.md": "# Body\n\n---\ntags: [x]\n---\n" }, FM(NEEDS_TAGS))).length, 1, "a --- after the first line is a rule, not front matter");
  for (const body of ["---\ntags: [x\n---\nB\n", "---\n- a\n- b\n---\nB\n"]) {
    const f = await run(t, { "a.md": body }, FM(NEEDS_TAGS));
    assert.equal(f.length, 1);
    assert.equal(f[0].match, "parse error");
    assert.match(f[0].problem, /markdown-front-matter cannot read this file/);
  }
});

// ---- format: module -------------------------------------------------------------------------------------------------
const MOD = (schema, exp = "SERIES") => ({ files: { include: ["series.js"] }, format: "module", export: exp, schema });
const LIST = { type: "array", minItems: 1, items: { type: "object", required: ["tags"], properties: { tags: { type: "array", items: { enum: ["a", "b"] } } } } };

test("module: the registry schema needs `export` exactly when the format is module", () => {
  assert.deepEqual(valid(registry(MOD(LIST))), []);
  assert.ok(valid(registry({ ...MOD(LIST), export: undefined })).length, "module without an export name");
  assert.ok(valid(registry({ ...MOD(LIST), export: "not an id" })).length, "an identifier");
  assert.ok(valid(registry({ files: { include: ["a.json"] }, format: "json", export: "X", schema: {} })).length, "an export with another format");
});

test("module: the named export is read as a literal and validated (strings with escapes, numbers, negatives, comments, quoted keys)", async (t) => {
  const src = '// a comment\nexport const OTHER = helper();\nexport const SERIES = [\n  /* c */ { "id": \'s\', n: -1.5e1, ok: true, no: null, tags: ["a", `b`], text: "q\\"x\\n\\u00e9", 7: [] },\n];\n';
  assert.deepEqual(await run(t, { "series.js": src }, MOD(LIST)), []);
  const bad = await run(t, { "series.js": 'export const SERIES = [{ tags: ["z"] }];\n' }, MOD(LIST));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].match, "/0/tags/0");
  assert.deepEqual(await run(t, { "series.js": 'export default [{ tags: ["b"] }];\n' }, MOD(LIST, "default")), [], "the default export");
  const values = await run(t, { "series.js": 'export const SERIES = [{ tags: ["a"], n: -1.5e1, s: "q\\"x\\n\\u00e9", t: `b` }];\n' }, MOD({ type: "array", items: { properties: { n: { const: -15 }, s: { const: "q\"x\n\u00e9" }, t: { const: "b" } } } }));
  assert.deepEqual(values, [], "the values are decoded as JavaScript decodes them");
});

test("module: it is read, never imported: only a literal export is data, and anything else in the export is a finding that names the construct", async (t) => {
  const cases = [
    ["export const SERIES = [{ get tags() { return []; } }];\n", /getter|method definition/],
    ["export const SERIES = [{ tags: [], toJSON() { return []; } }];\n", /method definition/],
    ["export const SERIES = [{ tags: [], toJSON: () => [] }];\n", /arrow function/],
    ["const base = { tags: [] };\nexport const SERIES = [{ ...base }];\n", /spread element/],
    ["const t = [];\nexport const SERIES = [{ tags: t }];\n", /identifier/],
    ["export const SERIES = [{ tags: [] }, ...[]];\n", /spread element/],
    ["export const SERIES = [{ tags: [] }].map((x) => x);\n", /call expression/],
    ["export const SERIES = [new Date()];\n", /new expression/],
    ["export const SERIES = [{ [k]: 1 }];\n", /computed property name/],
    ["export const SERIES = [{ tags }];\n", /shorthand property identifier/],
    ["export const SERIES = [{ tags: `a${1}` }];\n", /template string with a substitution/],
    ["export const SERIES = [{ tags: [1,,2] }];\n", /hole/],
    ["export const SERIES = [{ n: 1n }];\n", /bigint/],
    ["export const SERIES = [{ __proto__: [] }];\n", /__proto__/],
    ["export const SERIES = (await load());\n", /parenthesized expression/],
    ["export const SERIES = 1 + 2;\n", /binary expression/],
    ["export const OTHER = [];\n", /has no `export const SERIES = <literal>`/],
    ["const SERIES = [];\nexport { SERIES };\n", /has no `export const SERIES = <literal>`/],
    ["export * from './other.js';\n", /has no `export const SERIES = <literal>`/],
    ["export { SERIES } from './other.js';\n", /has no `export const SERIES = <literal>`/],
    ["export const SERIES = [;\n", /not valid JavaScript/],
  ];
  for (const [src, re] of cases) {
    const f = await run(t, { "series.js": src }, MOD(LIST));
    assert.equal(f.length >= 1, true, src);
    assert.equal(f[0].match, "parse error", src);
    assert.match(f[0].problem, re, src);
  }
});

test("module: nothing of the file is run or loaded: a side-effect import, a re-export, a class static block, a getter and toJSON outside the export are inert", async (t) => {
  const dir = tempDir(t, "kit-ran-");
  const marker = join(dir, "ran");
  const write = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`;
  const src = [
    'import "./evil.js";', 'export * from "./evil.js";', 'export { a } from "./evil.js";',
    `class Boom { static { ${write} } get x() { ${write} } toJSON() { ${write} } }`,
    `for (;;) { ${write} break; }`, `${write}`,
    'export const SERIES = [{ tags: ["a"] }];',
  ].join("\n") + "\n";
  assert.deepEqual(await run(t, { "series.js": src, "evil.js": `${write}\nexport const a = 1;\n` }, MOD(LIST)), []);
  assert.equal((await import("node:fs")).existsSync(marker), false, "no statement of the module or of anything it imports ran");
});

// ---- bind: confinement and pointers ---------------------------------------------------------------------------------
test("bind file: a path that is absolute, leaves the repository by .. or by a link, and a pointer that does not start with / are findings", async (t) => {
  const outside = tempDir(t, "kit-outside-");
  writeFileSync(join(outside, "tags.json"), JSON.stringify(VOCAB));
  const root = tree(t, { "post.json": { tag: "a" } });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(outside, join(root, "link"));
  const cases = [
    ["../x/tags.json", /leaves the repository/], [join(outside, "tags.json"), /absolute path/], ["a/../../tags.json", /leaves the repository/],
    ["link/tags.json", /leaves the repository through a link/], ["C:/tags.json", /absolute path/], ["/etc/passwd", /absolute path/],
  ];
  for (const [file, re] of cases) {
    const found = await runGate("src", root, walk(root), registry(FROM_FILE(file)));
    assert.equal(found.length, 1, file);
    assert.match(found[0].problem, re, file);
    assert.match(found[0].match, /^unbound/);
  }
  for (const [det, re] of [[FROM_FILE("tags.json", { pointer: "tags" }), /does not start with \//], [FROM_FILE({ pointer: "tags/vocabulary" }), /does not start with \//]]) {
    const found = await run(t, { "kit.canon.json": { tags: { vocabulary: "tags.json" } }, "tags.json": VOCAB, "post.json": { tag: "a" } }, det);
    assert.equal(found.length, 1);
    assert.match(found[0].problem, re);
  }
  const pick = await run(t, { "tags.json": { tags: [{ name: "a" }] }, "post.json": { tag: "a" } }, FROM_FILE("tags.json", { valid: { type: "array" } }));
  assert.match(pick[0].problem, /tags\.json \/tags is not a list of objects that each carry "id"/, "the message names the file it read");
});
