// The project codes in the diagram schemas are GENERATED from the registry (packages/core/scripts/project-codes.mjs), never hand-copied:
// the three schema files equal what the generator writes, a registry with another project makes them drift (the check fails), and
// the generated patterns accept every registry code and refuse a code nobody owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator } from "../src/schema.js";
import { projectCodes, render, FILES } from "../scripts/project-codes.mjs";

const here = (p) => new URL(p, import.meta.url);
const json = (p) => JSON.parse(readFileSync(here(p), "utf8"));
const reg = json("../registry/projects.json");
const read = (rel) => readFileSync(here(`../../../${rel}`), "utf8");

test("codes: the registry's shorts without the dash, the key when there is none, then kit", () => {
  const codes = projectCodes(reg);
  assert.deepEqual(codes.slice(-1), ["kit"]);
  for (const c of ["saasreport", "kit"]) assert.ok(codes.includes(c), c);
  for (const bad of ["sc", "swc", "nope"]) assert.ok(!codes.includes(bad), bad);
  assert.equal(new Set(codes).size, codes.length);
});

test("the schema files equal what the generator writes from the registry (no hand-copied code list)", () => {
  const out = render(reg, read);
  assert.deepEqual(Object.keys(out).sort(), [...FILES].sort());
  for (const [file, text] of Object.entries(out)) assert.equal(read(file), text, `${file} drifted from the registry (node packages/core/scripts/project-codes.mjs)`);
});

test("must fail: a registry with one more project makes every schema file drift; removing one drifts them too", () => {
  // a project the kit capability engine serves: every generated field names it (the capability pattern takes only flagged projects)
  const more = structuredClone(reg); more.projects.push({ key: "zzz1", name: "Zzz", domain: "zzz.example", prefix: "zzz1-", short: null, capabilityEngine: true });
  for (const [file, text] of Object.entries(render(more, read))) assert.notEqual(read(file), text, `${file} should drift when a project is added`);
  // a code with a digit is written and read back: rendering the rendered text again changes nothing (the generator finds its own output)
  const once = render(more, read);
  assert.ok(Object.values(once).every((t) => t.includes("zzz1|kit") || t.includes('"zzz1"') || t.includes("|zzz1)")));
  assert.deepEqual(render(more, (f) => once[f]), once);
  const fewer = structuredClone(reg); fewer.projects = fewer.projects.filter((p) => p.key !== "saasreport");
  for (const [file, text] of Object.entries(render(fewer, read))) assert.notEqual(read(file), text, `${file} should drift when a project is removed`);
});

test("must fail: a hand-edited code field drifts, whatever the edit (Codex on #136: an edited pattern no longer matched the marker and --check passed)", () => {
  const edit = (file, fn) => (f) => (f === file ? fn(read(f)) : read(f));
  const [diagram, externals] = FILES;
  const drifted = (file, fn) => { const r = edit(file, fn); assert.notEqual(render(reg, r)[file], r(file), `${file}: --check must report this edit`); };
  drifted(diagram, (t) => t.replace("|kit)\\\\.[a-z0-9]+(?:[.-][a-z0-9]+)*$", ")\\\\.[a-z0-9]+(?:[.-][a-z0-9]+)*$"));      // |kit removed from the first id pattern
  drifted(externals, (t) => t.replace("|kit)", ")"));
  drifted(diagram, (t) => t.replace("(saasreport|", "(saasreport|sc|"));                                                     // a hand-added code
  drifted(diagram, (t) => t.replace("|https://\\\\S+)$", "|http://\\\\S+)$"));                                    // the rest of a pattern is generated too
  drifted(diagram, (t) => t.replace('"kit"\n', '"kit",\n        "sc"\n'));                                     // the enum
});

test("must fail: a code field the generator does not declare, or a declared one that is gone, refuses to render", () => {
  const [diagram] = FILES;
  const withField = (f) => { const j = JSON.parse(read(f)); if (f === diagram) j.$defs.other = { pattern: "^(saasreport|kit)\\.x$" }; return `${JSON.stringify(j, null, 2)}\n`; };
  assert.throws(() => render(reg, withField), /\/\$defs\/other\/pattern.*not declared/);
  const without = (f) => { const j = JSON.parse(read(f)); if (f === diagram) delete j.$defs.ref; return `${JSON.stringify(j, null, 2)}\n`; };
  assert.throws(() => render(reg, without), /\/\$defs\/ref\/pattern.*missing/);
});

test("the generated id, ref and project patterns accept every registry code and refuse sc, swc and nope", () => {
  const diagram = json("../schemas/diagram.schema.json"), externals = json("../schemas/diagram-externals.schema.json");
  const v = createValidator([diagram, externals]);
  const idOk = (code) => v.validate(`${code}.thing`, { $ref: `${diagram.$id}#/$defs/id` }).length === 0;
  const refOk = (x) => v.validate(x, { $ref: `${diagram.$id}#/$defs/ref` }).length === 0;
  const extOk = (code) => v.validate(`${code}.thing`, { $ref: `${externals.$id}#/$defs/id` }).length === 0;
  for (const code of projectCodes(reg)) { assert.ok(idOk(code), `id ${code}`); assert.ok(refOk(`${code}.thing`), `ref ${code}`); assert.ok(extOk(code), `externals ${code}`); assert.ok(diagram.properties.project.enum.includes(code), `enum ${code}`); }
  for (const bad of ["sc", "swc", "nope"]) { assert.ok(!idOk(bad), `id ${bad}`); assert.ok(!refOk(`${bad}.thing`), `ref ${bad}`); assert.ok(!extOk(bad), `externals ${bad}`); assert.ok(!diagram.properties.project.enum.includes(bad), `enum ${bad}`); }
  assert.ok(refOk("https://example.org/x"));
});

test("must fail: the capability pattern names exactly the projects the registry flags capabilityEngine (no hand list)", () => {
  const file = "packages/core/registry/finding-classes.json";
  const pattern = (r) => JSON.parse(render(r, read)[file]).classes.find((c) => c.id === "capability-id-prefix").detect[0].schema.properties.id.pattern;
  assert.match(pattern(reg), /^\^\(saasreport\)\\\.capability/);
  const two = structuredClone(reg); two.projects.push({ key: "zzz1", name: "Zzz", domain: "zzz.example", prefix: "zzz1-", short: null, capabilityEngine: true });
  assert.match(pattern(two), /^\^\(saasreport\|zzz1\)\\\.capability/);
  delete two.projects.find((p) => p.key === "zzz1").capabilityEngine;
  assert.doesNotMatch(pattern(two), /zzz1/);
  const handEdited = (f) => (f === file ? read(f).replace("^(saasreport)", "^(saasreport|zzz1)") : read(f));
  assert.notEqual(render(reg, handEdited)[file], handEdited(file), "a hand-added code is drift");
  const gone = (f) => (f === file ? JSON.stringify({ ...JSON.parse(read(f)), classes: JSON.parse(read(f)).classes.filter((c) => c.id !== "capability-id-prefix") }, null, 2) + "\n" : read(f));
  assert.throws(() => render(reg, gone), /\[id=capability-id-prefix\].*missing/);
});
