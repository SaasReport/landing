// @saasreport/plugins: frontmatter, the scaffolder (kit plugin new), the plugin validator, the compile-report checks and
// schema, and the scaffolded plugin run end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, scaffoldPlugin, validatePlugin, validateReport, validateLearnings, runtimeSource, checkSource, SCHEMA_PATH, LEARNINGS_SCHEMA_PATH, STATUSES, LEARNING_KINDS, PREFIXES, FULL_PREFIXES } from "../src/index.js";
import { createRun, engineStatus, worst, runId } from "../runtime/kit-plugin-runtime.mjs";
import { main as kit } from "../../cli/src/index.js";
import { tempDir, fileTempDir } from "../../core/test/support/temp.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TMP = fileTempDir("kit-plugins-");

const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); } return dir; };
const node = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
};
const report = (dir) => JSON.parse(readFileSync(join(dir, "compile-report.json"), "utf8"));
const json = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

test("parseFrontmatter: scalars, quotes, nested map and list; no frontmatter is an error", () => {
  const r = parseFrontmatter(`---\nname: saasreport-x\ndescription: "a: b # c"\nflag: true\nmetadata:\n  prefix: saasreport\n  output: ./saasreport-out/x/\ntools:\n  - Read\n  - 'Bash(node *)'\n---\n# Body\n`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { name: "saasreport-x", description: "a: b # c", flag: true, metadata: { prefix: "saasreport", output: "./saasreport-out/x/" }, tools: ["Read", "Bash(node *)"] });
  assert.equal(r.body, "# Body\n");
  assert.equal(parseFrontmatter("# no frontmatter").ok, false);
});

test("runtime: run ids, statuses, the run folder and a valid compile report", () => {
  assert.match(runId({ a: 1 }, new Date("2026-10-01T12:00:00Z")), /^20261001T120000Z-[0-9a-f]{8}$/);
  assert.equal(runId({ a: 1, b: 2 }, new Date(0)), runId({ b: 2, a: 1 }, new Date(0)), "inputs hash ignores key order");
  assert.equal(worst(["confirmed", "flagged", "not_confirmed"]), "flagged");
  assert.equal(engineStatus({}), "confirmed");
  assert.equal(engineStatus({ uncertain: true }), "not_confirmed");
  assert.equal(engineStatus({ packStatus: "unverified" }), "not_confirmed");
  assert.equal(engineStatus({ packStatus: "partial" }), "flagged");
  const run = createRun({ prefix: "saasreport", skill: "saasreport-demo", inputs: { x: 1 }, engine: { name: "e", via: "engine" }, cwd: TMP, now: new Date("2026-10-01T12:00:00Z") });
  assert.ok(run.dir.startsWith(join(TMP, "saasreport-out", "saasreport-demo", "20261001T120000Z-")));
  assert.throws(() => run.item({ id: "a", status: "confirmed", sources: [] }), /confirmed needs at least one source/);
  assert.throws(() => run.item({ id: "a", status: "flagged", sources: [] }), /needs a note/);
  assert.throws(() => run.item({ id: "a", status: "maybe", sources: [] }), /status must be one of/);
  run.item({ id: "a", label: "A", value: 1, status: "confirmed", sources: [{ title: "engine" }] });
  run.item({ id: "b", label: "B", value: 2, status: "not_confirmed", sources: [], note: "predicted" });
  run.file("out.json", { a: 1 });
  const r = run.finish();
  assert.deepEqual(validateReport(r), []);
  assert.deepEqual(report(run.dir), r);
  assert.equal(r.status, "not_confirmed");
  assert.deepEqual(r.summary, { confirmed: 1, not_confirmed: 1, flagged: 0 });
  assert.throws(() => createRun({ prefix: "saasreport", skill: "nope-x", cwd: TMP }), /must start with the plugin prefix/);
});

test("validateReport rejects dishonest or inconsistent reports", () => {
  const ok = { schema: "kit.compile-report.v1", plugin: "saasreport", skill: "saasreport-x", run_id: "20261001T120000Z-0123abcd", generated_at: "2026-10-01T12:00:00Z", inputs: {}, engine: { name: "e", via: "api" }, outputs: [],
    items: [{ id: "a", label: "A", value: 1, status: "confirmed", sources: [{ title: "s" }] }], summary: { confirmed: 1, not_confirmed: 0, flagged: 0 }, status: "confirmed" };
  assert.deepEqual(validateReport(ok), []);
  const bad = (patch) => validateReport({ ...ok, ...patch }).join("\n");
  assert.match(bad({ items: [{ id: "a", label: "A", value: 1, status: "confirmed", sources: [] }] }), /confirmed needs at least one source/);
  assert.match(bad({ items: [{ id: "a", label: "A", value: 1, status: "flagged", sources: [] }], summary: { confirmed: 0, not_confirmed: 0, flagged: 1 }, status: "flagged" }), /flagged needs a note/);
  assert.match(bad({ status: "flagged" }), /worst item status/);
  assert.match(bad({ summary: { confirmed: 0, not_confirmed: 0, flagged: 0 } }), /summary/);
  assert.match(bad({ skill: "nope-x" }), /must start with "saasreport-"/);
  assert.match(bad({ engine: { name: "e", via: "guess" } }), /engine/);
});

test("compile-report.schema.json is the contract validateReport enforces", () => {
  const s = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assert.equal(s.properties.schema.const, "kit.compile-report.v1");
  assert.deepEqual(s.properties.status.enum, STATUSES);
  assert.deepEqual(s.properties.items.items.properties.status.enum, STATUSES);
  assert.deepEqual(s.properties.engine.properties.via.enum, ["engine", "mcp", "api", "content"]);
  for (const k of ["schema", "plugin", "skill", "run_id", "inputs", "engine", "outputs", "items", "summary", "status"]) assert.ok(s.required.includes(k), k);
});

test("scaffoldPlugin: a plugin that validates, whose stub helper reports not_confirmed (never a guess)", () => {
  const dir = write(join(TMP, "s1"), scaffoldPlugin({ prefix: "saasreport", displayName: "SaasReport", author: "SaasReport", skills: ["saasreport-demo"], mcp: { name: "saasreport-calendar", url: "https://saasreport.ai/mcp" } }));
  assert.deepEqual(validatePlugin(dir, { prefix: "saasreport", servers: { "saasreport-calendar": "https://saasreport.ai/mcp" } }), []);
  assert.equal(readFileSync(join(dir, "scripts/lib/kit-plugin-runtime.mjs"), "utf8"), runtimeSource());
  const out = join(TMP, "s1-run");
  const r = node(join(dir, "scripts/saasreport-demo.mjs"), ["--out", out]);
  assert.equal(r.status, "not_confirmed");
  assert.deepEqual(validateReport(report(out)), []);
  assert.throws(() => scaffoldPlugin({ prefix: "nope", skills: ["nope-x"] }), /naming constitution/);
  assert.throws(() => scaffoldPlugin({ prefix: "saasreport", skills: ["saasreport-a"] }), /give the author/);
  assert.throws(() => scaffoldPlugin({ prefix: "saasreport", skills: ["settlement"] }), /start with "saasreport-"/);
  assert.throws(() => scaffoldPlugin({ prefix: "saasreport", skills: ["saasreport-a"], mcp: { name: "calendar", url: "https://x.example/mcp" } }), /carry the prefix/);
  const full = write(join(TMP, "s-full"), scaffoldPlugin({ prefix: "saasreport", author: "SaasReport", skills: ["saasreport-a"], mcp: { name: "saasreport-calendar", url: "https://saasreport.ai/mcp" } }));
  assert.deepEqual(validatePlugin(full, { prefix: "saasreport", servers: { "saasreport-calendar": "https://saasreport.ai/mcp" } }), [], "the full project prefix also names a server");
  const api = scaffoldPlugin({ prefix: "saasreport", author: "SaasReport", skills: ["saasreport-a"], api: "https://saasreport.ai/api/calendar" });
  assert.equal(api[".mcp.json"], undefined);
  assert.equal(JSON.parse(api[".claude-plugin/plugin.json"]).metadata.kit.backend.kind, "api");
});

test("validatePlugin catches names without the prefix, missing sections, unknown servers, literal tokens and a stale runtime", () => {
  const base = scaffoldPlugin({ prefix: "saasreport", author: "SaasReport", skills: ["saasreport-glossary"], mcp: { name: "saasreport-cal", url: "https://saasreport.ai/mcp" } });
  const check = (mut, opts = {}) => { const dir = join(TMP, `v${Math.random().toString(36).slice(2)}`); const files = { ...base }; mut(files); write(dir, files); return validatePlugin(dir, { prefix: "saasreport", ...opts }).join("\n"); };
  assert.match(check((f) => { f["skills/glossary/SKILL.md"] = f["skills/saasreport-glossary/SKILL.md"].replace("name: saasreport-glossary", "name: glossary"); }), /must start with "saasreport-"/);
  assert.match(check((f) => { f["skills/saasreport-glossary/SKILL.md"] = f["skills/saasreport-glossary/SKILL.md"].replace("## Inputs", "## Arguments"); }), /needs an "## Inputs" section/);
  assert.match(check((f) => { f["skills/saasreport-glossary/SKILL.md"] = f["skills/saasreport-glossary/SKILL.md"].replaceAll("saasreport-out/saasreport-glossary/", "out/"); }), /writes to \.\/saasreport-out\/saasreport-glossary/);
  assert.match(check((f) => { f["skills/saasreport-glossary/SKILL.md"] = f["skills/saasreport-glossary/SKILL.md"].replace(/^description: .*$/m, "description: Glossary: terms and # tags"); }), /quote the description/);
  assert.match(check((f) => { f["commands/glossary.md"] = "---\ndescription: x\n---\nbody"; }), /command names start with "saasreport-"/);
  assert.match(check(() => {}, { servers: { "saasreport-calendar": "https://saasreport.ai/mcp" } }), /not a server the project runs/);
  assert.match(check((f) => { f[".mcp.json"] = JSON.stringify({ mcpServers: { "saasreport-cal": { type: "http", url: "https://saasreport.ai/mcp", headers: { Authorization: "Bearer sk-live-123" } } } }); }), /never a literal credential/);
  assert.match(check((f) => { f[".mcp.json"] = JSON.stringify({ mcpServers: { calendar: { type: "http", url: "http://saasreport.ai/mcp" } } }); }), /carry the prefix[\s\S]*use https/);
  assert.match(check((f) => { f["scripts/lib/kit-plugin-runtime.mjs"] += "\n// edited\n"; }), /kit-plugin-runtime\.mjs: differs from the kit's copy/);
  assert.match(check((f) => { f["scripts/lib/kit-plugin-check.mjs"] += "\n// edited\n"; }), /kit-plugin-check\.mjs: differs from the kit's copy/);
  assert.match(check((f) => { const m = JSON.parse(f[".claude-plugin/plugin.json"]); m.name = "saasreport-tools"; f[".claude-plugin/plugin.json"] = JSON.stringify(m); }), /must be the project prefix "saasreport"/);
  assert.match(check((f) => { const m = JSON.parse(f[".claude-plugin/plugin.json"]); delete m.metadata; f[".claude-plugin/plugin.json"] = JSON.stringify(m); }), /metadata\.kit: missing/);
  assert.match(check((f) => { f["skills/saasreport-glossary/SKILL.md"] = f["skills/saasreport-glossary/SKILL.md"].replace("scripts/saasreport-glossary.mjs", "scripts/nope.mjs"); }), /references scripts\/nope\.mjs, which does not exist/);
  assert.ok(!PREFIXES.includes("nope"));
});

test("naming: the project has no short form: a plugin is named saasreport, and any other code is refused by the checker, the scaffolder and the CLI", async () => {
  const mk = (prefix) => { const dir = join(TMP, `n${Math.random().toString(36).slice(2)}`); write(dir, scaffoldPlugin({ prefix, author: "SaasReport", skills: [`${prefix}-glossary`], api: "https://saasreport.ai/api/x" })); return dir; };
  assert.deepEqual(validatePlugin(mk("saasreport"), { prefix: "saasreport" }), []);
  for (const bad of ["sc", "sr", "srp"]) assert.match(validatePlugin(mk("saasreport"), { prefix: bad }).join("\n"), new RegExp(`prefix "${bad}" is not in the naming constitution`));
  assert.ok(PREFIXES.includes("saasreport") && FULL_PREFIXES.saasreport === "saasreport");
  assert.throws(() => scaffoldPlugin({ prefix: "sr", author: "x", skills: ["sr-a"], api: "https://saasreport.ai/api/x" }), /prefix/i);
  const io = () => ({ cwd: TMP, env: {}, out: () => {}, err: () => {}, fetch: () => { throw new Error("no network"); }, spawn: () => { throw new Error("no spawn"); } });
  assert.equal(await kit(["plugin", "new", "sr", "--skills", "sr-x", "--dir", "p-sr"], io()), 1);
  assert.equal(await kit(["plugin", "new", "saasreport", "--skills", "saasreport-x", "--api", "https://saasreport.ai/api/x", "--dir", "p-sr-ok"], io()), 0);
  assert.equal(await kit(["plugin", "check", "p-sr-ok", "--prefix", "saasreport"], io()), 0);
  assert.equal(await kit(["plugin", "check", "p-sr-ok", "--prefix", "sr"], io()), 1);
  // a server named with the prefix is accepted, one named with another code is not
  const full = mk("saasreport");
  write(full, { ".mcp.json": JSON.stringify({ mcpServers: { "saasreport-spec": { type: "http", url: "https://saasreport.ai/mcp" } } }) });
  assert.doesNotMatch(validatePlugin(full, { prefix: "saasreport" }).join("\n"), /server names carry the prefix/);
  write(full, { ".mcp.json": JSON.stringify({ mcpServers: { "sr-spec": { type: "http", url: "https://saasreport.ai/mcp" } } }) });
  assert.match(validatePlugin(full, { prefix: "saasreport" }).join("\n"), /server names carry the prefix/);
});

test("kit plugin new / kit plugin check", async () => {
  const io = (out, err) => ({ cwd: TMP, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), fetch: () => { throw new Error("no network"); }, spawn: () => { throw new Error("no spawn"); } });
  const out = [], err = [];
  assert.equal(await kit(["plugin", "new", "saasreport", "--skills", "saasreport-holidays,saasreport-glossary", "--api", "https://saasreport.ai/api/calendar", "--dir", "p-saasreport"], io(out, err)), 0, err.join("\n"));
  assert.ok(existsSync(join(TMP, "p-saasreport/skills/saasreport-holidays/SKILL.md")));
  assert.equal(await kit(["plugin", "check", "p-saasreport", "--prefix", "saasreport"], io(out, err)), 0, err.join("\n"));
  assert.equal(await kit(["plugin", "new", "saasreport", "--skills", "saasreport-x", "--dir", "p-saasreport"], io(out, err)), 1, "refuses to overwrite without --force");
  assert.equal(await kit(["plugin", "new", "nope", "--skills", "nope-x"], io(out, err)), 1);
  assert.equal(await kit(["plugin", "check", "p-saasreport", "--prefix", "nope"], io(out, err)), 1);
});

test("the scaffolded checker runs standalone and takes the project's servers", (t) => {
  const dir = write(tempDir(t, "standalone-", TMP), scaffoldPlugin({ prefix: "saasreport", author: "SaasReport", skills: ["saasreport-demo"], mcp: { name: "saasreport-calendar", url: "https://saasreport.ai/mcp" } }));
  assert.equal(readFileSync(join(dir, "scripts/lib/kit-plugin-runtime.mjs"), "utf8"), runtimeSource());
  assert.equal(readFileSync(join(dir, "scripts/lib/kit-plugin-check.mjs"), "utf8"), checkSource());
  const r = spawnSync(process.execPath, [join(dir, "scripts/lib/kit-plugin-check.mjs"), dir, "--prefix", "saasreport", "--server", "saasreport-calendar=https://saasreport.ai/mcp"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bad = spawnSync(process.execPath, [join(dir, "scripts/lib/kit-plugin-check.mjs"), dir, "--prefix", "saasreport", "--server", "saasreport-calendar=https://elsewhere.example/mcp"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not the project's server/);
});

test("critic stage: verdicts only lower statuses; unchecked confirmed items end not_confirmed; the report counts them", async () => {
  const run = createRun({ prefix: "saasreport", skill: "saasreport-critic", inputs: { a: 1 }, engine: { name: "e", via: "engine" }, cwd: TMP, now: new Date("2026-10-01T12:00:00Z"), critic: true });
  const src = [{ title: "engine", ref: "x" }];
  for (const id of ["a", "b", "c", "d"]) run.item({ id, label: id, value: 1, status: "confirmed", sources: src });
  run.item({ id: "e", label: "e", value: 1, status: "not_confirmed", sources: [], note: "predicted" });
  run.critique("a", { verdict: "upheld" });
  run.critique("b", { verdict: "refuted", note: "the official list moved the holiday", risk: 8 });
  run.critique("c", { verdict: "inconclusive", note: "no second source" });
  assert.throws(() => run.critique("e", { verdict: "refuted" }), /needs a note/);
  run.critique("e", { verdict: "upheld" });
  assert.throws(() => run.critique("zz", { verdict: "upheld" }), /no item/);
  const r = run.finish();
  const by = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.equal(by.a.status, "confirmed");
  assert.deepEqual([by.b.status, by.b.risk, by.b.critic.previous_status], ["flagged", 8, "confirmed"]);
  assert.match(by.b.note, /Critic \(refuted\): the official list moved the holiday/);
  assert.deepEqual([by.c.status, by.c.critic.previous_status], ["not_confirmed", "confirmed"]);
  assert.deepEqual([by.d.status, by.d.critic.verdict], ["not_confirmed", "unchecked"], "never checked: not confirmed");
  assert.equal(by.e.status, "not_confirmed", "upheld never raises a status");
  assert.deepEqual(r.critic, { enabled: true, by: "saasreport-critic critic", checked: 4, upheld: 2, refuted: 1, inconclusive: 1, unchecked: 1 });
  assert.equal(r.summary.max_risk, 8);
  assert.deepEqual(validateReport(r), []);
  // criticPass runs the falsifier on every confirmed item still unchecked
  const run2 = createRun({ prefix: "saasreport", skill: "saasreport-critic", inputs: { a: 2 }, engine: { name: "e", via: "engine" }, cwd: TMP, critic: { by: "second model" } });
  run2.item({ id: "x", label: "x", value: 1, status: "confirmed", sources: src });
  run2.item({ id: "y", label: "y", value: 2, status: "confirmed", sources: src });
  await run2.criticPass(async (it) => (it.value === 2 ? { verdict: "refuted", note: "counter-example found", risk: 6 } : { verdict: "upheld" }));
  const r2 = run2.finish();
  assert.deepEqual(r2.items.map((x) => x.status), ["confirmed", "flagged"]);
  assert.equal(r2.critic.by, "second model");
  assert.deepEqual(validateReport(r2), []);
  assert.throws(() => createRun({ prefix: "saasreport", skill: "saasreport-critic", cwd: TMP }).critique("x", { verdict: "upheld" }), /critic stage is off/);
});

test("validateReport: dishonest critic results and bad risks are caught", () => {
  const base = () => ({ schema: "kit.compile-report.v1", plugin: "saasreport", skill: "saasreport-x", run_id: "20261001T120000Z-1a2b3c4d", generated_at: "2026-10-01T12:00:00Z", inputs: {}, engine: { name: "e", via: "engine" }, outputs: [],
    items: [{ id: "a", label: "a", value: 1, status: "confirmed", sources: [{ title: "s" }], critic: { verdict: "upheld", by: "c" } }],
    summary: { confirmed: 1, not_confirmed: 0, flagged: 0 }, status: "confirmed", critic: { enabled: true, by: "c", checked: 1, upheld: 1, refuted: 0, inconclusive: 0, unchecked: 0 } });
  assert.deepEqual(validateReport(base()), []);
  let r = base(); r.items[0].critic = { verdict: "refuted", by: "c", note: "wrong" }; r.critic = { ...r.critic, upheld: 0, refuted: 1 };
  assert.ok(validateReport(r).some((x) => /status must be flagged/.test(x)), "refuted but still confirmed");
  r = base(); r.items[0].critic = { verdict: "inconclusive", by: "c" }; r.critic = { ...r.critic, upheld: 0, inconclusive: 1 };
  assert.ok(validateReport(r).some((x) => /needs a note/.test(x)) && validateReport(r).some((x) => /cannot be confirmed/.test(x)));
  r = base(); r.items[0].status = "flagged"; r.items[0].note = "n"; r.items[0].critic = { verdict: "refuted", by: "c", note: "x", previous_status: "not_confirmed" }; r.summary = { confirmed: 0, not_confirmed: 0, flagged: 1 }; r.status = "flagged"; r.critic = { ...r.critic, upheld: 0, refuted: 1 };
  assert.deepEqual(validateReport(r), [], "lowered from not_confirmed to flagged is fine");
  r.items[0].critic.previous_status = "flagged";
  assert.ok(validateReport(r).some((x) => /only lowers/.test(x)));
  r = base(); delete r.items[0].critic; r.critic = { ...r.critic, checked: 0, upheld: 0 };
  assert.ok(validateReport(r).some((x) => /needs an upheld verdict/.test(x)), "critic on, confirmed item never checked");
  r = base(); r.items[0].risk = 5;
  assert.ok(validateReport(r).some((x) => /flagged items only/.test(x)));
  r = base(); r.items[0] = { ...r.items[0], status: "flagged", note: "n", risk: 11, critic: { verdict: "upheld", by: "c" } }; r.summary = { confirmed: 0, not_confirmed: 0, flagged: 1, max_risk: 11 }; r.status = "flagged"; r.critic = { ...r.critic };
  assert.ok(validateReport(r).some((x) => /integer from 1 to 10/.test(x)));
  r = base(); r.summary.max_risk = 3;
  assert.ok(validateReport(r).some((x) => /max_risk/.test(x)), "max_risk without risky items");
});

test("learnings.jsonl: run.learn appends kit.plugin-learning.v1 lines; validateLearnings and the standalone checker read them", (t) => {
  const cwd = tempDir(t, "learn-", TMP);
  for (const n of [1, 2]) {
    const run = createRun({ prefix: "saasreport", skill: "saasreport-holidays", inputs: { n }, engine: { name: "e", via: "engine" }, cwd, now: new Date("2026-10-01T12:00:00Z") });
    run.item({ id: "a", label: "a", value: 1, status: "flagged", sources: [], note: "pack partial", risk: 4 });
    run.learn({ kind: "gap", text: "The 1406 pack has no official Arbaeen date yet.", item_id: "a", tags: ["hijri"], evidence: [{ title: "pack status", ref: "iran-2026.10.01" }] });
    if (n === 2) run.learn({ kind: "false_positive", text: "A predicted date matching the official one is not a conflict." });
    const r = run.finish();
    assert.deepEqual(r.learnings, { file: join("saasreport-out", "learnings.jsonl"), added: n });
    assert.deepEqual(validateReport(r), []);
  }
  const file = join(cwd, "saasreport-out", "learnings.jsonl");
  const text = readFileSync(file, "utf8");
  assert.equal(text.trim().split("\n").length, 3, "append-only across runs");
  assert.deepEqual(validateLearnings(text), []);
  assert.deepEqual(JSON.parse(text.split("\n")[0]), { schema: "kit.plugin-learning.v1", at: "2026-10-01T12:00:00.000Z", plugin: "saasreport", skill: "saasreport-holidays", run_id: JSON.parse(text.split("\n")[0]).run_id, kind: "gap", text: "The 1406 pack has no official Arbaeen date yet.", item_id: "a", tags: ["hijri"], evidence: [{ title: "pack status", ref: "iran-2026.10.01" }] });
  assert.ok(validateLearnings('{"schema":"x"}\nnot json\n').length >= 3);
  assert.throws(() => createRun({ prefix: "saasreport", skill: "saasreport-x", cwd }).learn({ kind: "musing", text: "x" }), /kind must be one of/);
  const schema = JSON.parse(readFileSync(LEARNINGS_SCHEMA_PATH, "utf8"));
  assert.equal(schema.title, "kit.plugin-learning.v1");
  assert.deepEqual(schema.properties.kind.enum, LEARNING_KINDS);
  // the standalone checker validates a report or a learnings file by its extension
  const check = join(ROOT, "packages/plugins/runtime/kit-plugin-check.mjs");
  const ok = spawnSync(process.execPath, [check, file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = join(cwd, "bad.jsonl"); writeFileSync(bad, '{"schema":"kit.plugin-learning.v1"}\n');
  assert.equal(spawnSync(process.execPath, [check, bad], { encoding: "utf8" }).status, 1);
});

test("runtime: risk is 1-10 and only on flagged items", () => {
  const run = createRun({ prefix: "saasreport", skill: "saasreport-x", cwd: TMP });
  assert.throws(() => run.item({ id: "a", status: "confirmed", sources: [{ title: "s" }], risk: 3 }), /flagged items only/);
  assert.throws(() => run.item({ id: "b", status: "flagged", note: "n", risk: 0 }), /1-10/);
  run.item({ id: "c", status: "flagged", note: "n", risk: 10 });
  assert.equal(run.finish().summary.max_risk, 10);
});

test("canonical: the standalone checker's PREFIXES and FULL_PREFIXES are the project registry's (packages/core/registry/projects.json)", async () => {
  const { readFileSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
  const short = (p) => (p.short || p.prefix).replace(/-$/, "");
  assert.deepEqual([...PREFIXES].sort(), reg.projects.map(short).sort(), "kit-plugin-check.mjs PREFIXES drifted from the registry");
  assert.deepEqual(FULL_PREFIXES, Object.fromEntries(reg.projects.map((p) => [short(p), p.prefix.replace(/-$/, "")])), "FULL_PREFIXES drifted from the registry");
});
