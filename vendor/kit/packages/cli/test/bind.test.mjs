// wo-0016: a schema detector reads the values it needs from the repository through declared bindings (finding-class schema,
// `bind`), never from the engine and never silently: a value that cannot be resolved is a finding, not a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../src/canon/findings.js";
import { walk } from "../src/canon/files.js";
import { bundled } from "../src/bundled.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const kit = bundled();
const tree = (t, files) => {
  const root = tempDir(t, "kit-bind-");
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : JSON.stringify(body)); }
  return root;
};
const shipped = kit.findingClasses.registry;
const registry = (detector) => ({ v: 1, grammars: shipped.grammars, sets: shipped.sets, templates: shipped.templates, shell: shipped.shell, classes: [{ id: "bound", rule: "a rule long enough to read as one", level: "source", first_seen: ["a test"], cases: "findings/bound", detect: [{ kind: "schema", files: { include: ["ci.yml"] }, format: "yaml", problem: "the runner is not the declared one in kit.canon.json", ...detector }] }] });
const run = (t, files, detector, today) => { const root = tree(t, files); return runGate("bound", root, walk(root), registry(detector), { today }); };
const RUNNER = { bind: { runner: { pointer: "/workflows/runner" } }, schema: { type: "object", properties: { "runs-on": { enum: [{ $bind: "runner" }] } } } };
const CFG = { workflows: { runner: "ubuntu-24.04" } };

test("the registry schema accepts a declared binding and refuses an undeclared shape", () => {
  const v = (r) => kit.validator.validate(r, kit.byName("finding-class"));
  assert.deepEqual(v(registry(RUNNER)), []);
  assert.ok(v(registry({ ...RUNNER, bind: { runner: "/workflows/runner" } })).length, "a bare string is not a binding");
  assert.ok(v(registry({ ...RUNNER, bind: { runner: { pointer: "workflows/runner" } } })).length, "a pointer starts with /");
  assert.ok(v(registry({ ...RUNNER, bind: { runner: { builtin: "tomorrow" } } })).length, "only the declared builtins");
  assert.ok(v(registry({ ...RUNNER, bind: {} })).length, "an empty bind");
});

test("a bound value is substituted into the schema: the file passes on the declared value and fails on any other", async (t) => {
  assert.deepEqual(await run(t, { "kit.canon.json": CFG, "ci.yml": "runs-on: ubuntu-24.04\n" }, RUNNER), []);
  const bad = await run(t, { "kit.canon.json": CFG, "ci.yml": "name: x\nruns-on: ubuntu-latest\n" }, RUNNER);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].match, "/runs-on");
  assert.equal(bad[0].line, 2, "the line of the failing key, from the YAML parser");
  assert.equal(bad[0].context, "runs-on: ubuntu-latest");
  assert.deepEqual(await run(t, { "kit.canon.json": { workflows: { runner: "ubuntu-26.04" } }, "ci.yml": "runs-on: ubuntu-26.04\n" }, RUNNER), [], "the value comes from the config, not the registry");
});

test("fail closed: a missing config file, an unreadable one, a pointer to nothing and an undeclared name are findings, never passes", async (t) => {
  const pass = "runs-on: ubuntu-24.04\n";
  const cases = [
    [{ "ci.yml": pass }, /kit\.canon\.json cannot be read/],
    [{ "kit.canon.json": "{ not json", "ci.yml": pass }, /kit\.canon\.json cannot be read/],
    [{ "kit.canon.json": { workflows: {} }, "ci.yml": pass }, /\/workflows\/runner is not set/],
    [{ "kit.canon.json": CFG, "ci.yml": pass }, /references \{"\$bind": "ghost"\}.*does not declare/, { ...RUNNER, schema: { enum: [{ $bind: "ghost" }] } }],
    [{ "kit.canon.json": CFG, "ci.yml": pass }, /declares "spare" in bind but the schema never references it/, { ...RUNNER, bind: { ...RUNNER.bind, spare: { builtin: "today" } } }],
  ];
  for (const [files, re, det] of cases) {
    const found = await run(t, files, det || RUNNER);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0].problem, re);
    assert.match(found[0].match, /^(unbound|bad bind)/);
  }
});

test("a declared default stands for a pointer to nothing; without a file to check nothing is resolved", async (t) => {
  const det = { bind: { canary: { pointer: "/workflows/canary/runner", default: null } }, schema: { properties: { "runs-on": { enum: ["ubuntu-24.04", { $bind: "canary" }] } } } };
  assert.deepEqual(await run(t, { "kit.canon.json": CFG, "ci.yml": "runs-on: ubuntu-24.04\n" }, det), []);
  assert.equal((await run(t, { "kit.canon.json": CFG, "ci.yml": "runs-on: ubuntu-26.04\n" }, det)).length, 1);
  assert.deepEqual(await run(t, { "README.md": "no workflow here" }, RUNNER), [], "no file the detector checks: nothing to bind");
});

test("the builtin `today` and a date comparison: a date past today passes, one before it fails (today is injected for the test)", async (t) => {
  const det = { files: { include: ["kit.canon.json"] }, format: "json", bind: { today: { builtin: "today" } }, schema: { properties: { review_by: { type: "string", format: "date", formatMinimum: { $bind: "today" } } } } };
  assert.deepEqual(await run(t, { "kit.canon.json": { review_by: "2026-11-19" } }, det, "2026-10-07"), []);
  assert.deepEqual(await run(t, { "kit.canon.json": { review_by: "2026-10-07" } }, det, "2026-10-07"), [], "the day itself");
  assert.equal((await run(t, { "kit.canon.json": { review_by: "2026-11-19" } }, det, "2026-11-20")).length, 1);
  assert.equal((await run(t, { "kit.canon.json": { review_by: "soon" } }, det, "2026-10-07")).length >= 1, true);
});

test("`exists` binds a fact about the files as a boolean schema; a template builds a pattern from a bound list", async (t) => {
  const det = { files: { include: ["kit.canon.json"] }, format: "json", bind: { ci: { exists: [".github/workflows/*.yml"] } }, schema: { if: { required: ["workflows"] }, then: { $bind: "ci" } } };
  assert.equal((await run(t, { "kit.canon.json": CFG }, det)).length, 1);
  assert.deepEqual(await run(t, { "kit.canon.json": CFG, ".github/workflows/a.yml": "x: 1\n" }, det), []);
  const re = { bind: { refs: { pointer: "/refs" } }, schema: { properties: { uses: { not: { pattern: { $bind: "refs", as: "regex", template: "@(?:{})$" } } } } } };
  const cfg = { refs: ["main", "v1.x"] };
  assert.deepEqual(await run(t, { "kit.canon.json": cfg, "ci.yml": "uses: org/x@v2\n" }, re), []);
  assert.equal((await run(t, { "kit.canon.json": cfg, "ci.yml": "uses: org/x@main\n" }, re)).length, 1);
  assert.equal((await run(t, { "kit.canon.json": cfg, "ci.yml": "uses: org/x@v1.x\n" }, re)).length, 1);
  assert.deepEqual(await run(t, { "kit.canon.json": cfg, "ci.yml": "uses: org/x@v1ax\n" }, re), [], "the dot is escaped");
  assert.deepEqual(await run(t, { "kit.canon.json": { refs: [] }, "ci.yml": "uses: org/x@main\n" }, re), [], "no refs banned: nothing matches");
});

test("`pick` hands the schema one property of each object of a list (an allow-list keeps its reason beside the fact); another shape is a finding", async (t) => {
  const det = { bind: { crons: { pointer: "/allowed", pick: "cron", valid: { type: "array", items: { type: "object", required: ["cron", "reason"] } } } }, schema: { type: "object", properties: { cron: { enum: { $bind: "crons" } } } } };
  const allowed = { allowed: [{ cron: "7 * * * *", reason: "the watcher" }, { cron: "9 * * * *", reason: "the canary" }] };
  assert.deepEqual(await run(t, { "kit.canon.json": allowed, "ci.yml": "cron: '9 * * * *'\n" }, det), []);
  assert.equal((await run(t, { "kit.canon.json": allowed, "ci.yml": "cron: '1 * * * *'\n" }, det)).length, 1);
  assert.equal((await run(t, { "kit.canon.json": { allowed: [] }, "ci.yml": "cron: '9 * * * *'\n" }, det)).length, 1, "an empty list allows nothing");
  for (const bad of [{ allowed: ["7 * * * *"] }, { allowed: [{ cron: "7 * * * *" }] }, { allowed: "7 * * * *" }]) {
    const found = await run(t, { "kit.canon.json": bad, "ci.yml": "cron: '7 * * * *'\n" }, det);
    assert.equal(found.length, 1, JSON.stringify(bad));
    assert.match(found[0].match, /^(bad bind|unbound)/);
  }
  const noValid = await run(t, { "kit.canon.json": { allowed: "x" }, "ci.yml": "cron: 'x'\n" }, { ...det, bind: { crons: { pointer: "/allowed", pick: "cron" } } });
  assert.match(noValid[0].match, /^(bad bind|unbound)/, "a value that is not a list of objects carrying the property is refused even without a declared shape");
});
