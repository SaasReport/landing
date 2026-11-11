// Zero post-facto (docs/CONSTITUTION.md §10): every finding class has a gate, every gate refuses its real case and passes its
// clean one, and a repository's findings fail unless one reviewed instance is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
const require_path = () => nodePath;
import { checkFindings, runGate } from "../src/canon/findings.js";
import { bundled } from "../src/bundled.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const KIT = fileURLToPath(new URL("../../../", import.meta.url));
const REG = "packages/core/registry/finding-classes.json";
const registry = JSON.parse(readFileSync(join(KIT, REG), "utf8"));
const kit = bundled();

function tree(t, files) {
  const root = tempDir(t, "kit-findings-");
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
  return root;
}
/** A kit-shaped repository (its own registry and cases) holding only the given classes. */
function kitLike(t, classes, cases = {}) {
  const root = tree(t, { [REG]: JSON.stringify({ v: 1, grammars: registry.grammars, sets: registry.sets, templates: registry.templates, shell: registry.shell, classes }), ".gitignore": ".claude/worktrees/\n", ...cases });
  mkdirSync(join(root, "findings"), { recursive: true });
  return root;
}
const cls = (id, over = {}) => ({ id, rule: "a rule long enough to read as one", level: "source", first_seen: ["a real finding"], cases: `findings/${id}`, ...over });

test("a class without a declared contract fails the findings check: a rule exists only as data the engine runs (wo-0008)", async (t) => {
  const root = kitLike(t, [cls("made-up-class")]);
  const r = await checkFindings(root, {}, kit);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /\/classes\/0\/detect: is required/.test(p.problem)), JSON.stringify(r.problems));
  const bad = kitLike(t, [cls("made-up-class", { detect: [{ kind: "query", files: { include: ["**/*.js"] }, problem: "a query detector without its query" }] })]);
  assert.ok((await checkFindings(bad, {}, kit)).problems.some((p) => /detect\/0/.test(p.file + p.problem)), "a contract the schema refuses");
});

test("a gate that lets its must-fail case through fails the findings check", async (t) => {
  const root = kitLike(t, registry.classes, {
    "findings/wallclock-assert/must-fail/not-really/packages/x/test/a.test.mjs": "test('ok', () => assert.ok(true));\n",
    "findings/wallclock-assert/must-pass/clean/packages/x/test/a.test.mjs": "test('ok', () => assert.ok(true));\n",
  });
  const r = await checkFindings(root, {}, kit);
  assert.ok(r.problems.some((p) => /wallclock-assert gate lets its must-fail case through/.test(p.problem)), JSON.stringify(r.problems));
});

test("every finding class refuses its real case and passes its clean one", async () => {
  assert.ok(registry.classes.every((c) => c.detect.length), "every class declares its contract");
  for (const c of registry.classes) {
    for (const kind of ["must-fail", "must-pass"]) {
      const dir = join(KIT, c.cases, kind);
      const cases = readdirSync(dir);
      assert.ok(cases.length, `${c.id}: no ${kind} case`);
      for (const d of cases) {
        const found = await runGate(c.id, join(dir, d));
        if (kind === "must-fail") assert.ok(found.length > 0, `${c.id} lets ${d} through`);
        else assert.deepEqual(found, [], `${c.id} refuses ${d}`);
      }
    }
  }
});

test("a finding in the repository fails unless one reviewed instance is allowed; an allow entry that matches nothing is stale", async (t) => {
  const src = ['export const m = await import("./x.js")', ".catch(() => null);\n"].join("");   // assembled, so this file is not itself the finding
  const site = tree(t, { ".gitignore": ".claude/worktrees/\n", "src/a.js": src });
  const bare = await checkFindings(site, {}, kit);
  assert.ok(bare.problems.some((p) => p.file === "src/a.js:1" && /swallowed-error/.test(p.problem)), JSON.stringify(bare.problems));
  const entry = { file: "src/a.js", category: "finding:swallowed-error", match: ['import("./x.js")', ".catch(() => null)"].join(""), context: "export const m", reason: "the reviewed reason this one instance stays" };   // the instance as the gate reports it
  writeFileSync(join(site, "canon.allow.json"), JSON.stringify({ $schema: "x", entries: [entry] }));
  const allowed = await checkFindings(site, {}, kit);
  assert.ok(!allowed.problems.some((p) => p.file === "src/a.js:1"), JSON.stringify(allowed.problems));
  writeFileSync(join(site, "src/a.js"), "export const m = 1;\n");
  const stale = await checkFindings(site, {}, kit);
  assert.ok(stale.problems.some((p) => /stale allow entry/.test(p.problem)), JSON.stringify(stale.problems));
});

test("a site without its own registry runs the registry its kit ships, and the gates of the running CLI", async (t) => {
  const site = tree(t, { ".gitignore": "node_modules/\n", "package.json": JSON.stringify({ scripts: { qa: "kit site no-such-command" } }) });
  const r = await checkFindings(site, {}, kit);
  assert.equal(r.configured, true);
  assert.ok(r.problems.some((p) => /stray-gitlink/.test(p.problem)), "the worktree ignore is required everywhere");
  assert.ok(r.problems.some((p) => /"kit site no-such-command" is not a command/.test(p.problem)), JSON.stringify(r.problems));
});

test("the kit's own cases are copied as they are: a case directory is never a repository of its own", (t) => {
  const root = tempDir(t, "kit-findings-copy-");
  cpSync(join(KIT, "findings"), join(root, "findings"), { recursive: true });
  assert.ok(readdirSync(join(root, "findings")).length >= 8);
});

test("a finding allow entry belongs to the findings check: the hardcoding scan never calls it stale (review H1)", async (t) => {
  const { scanHardcoding } = await import("../src/canon/hardcoding.js");
  const site = tree(t, { "src/a.js": "export const a = 1;\n" });
  const entry = { file: "src/a.js", category: "finding:swallowed-error", match: "x", context: "x", reason: "the reviewed reason this one instance stays" };
  const r = scanHardcoding(site, { paths: ["src/**"] }, { registry: kit.registry, allow: { entries: [entry] } });
  assert.deepEqual(r.stale, []);
});

test("one allow entry covers one instance: a second instance of the same match is a finding (review H2)", async (t) => {
  const line = ['export const m = await import("./x.js")', ".catch(() => null);\n"].join("");   // assembled, so this file is not itself the finding
  const site = tree(t, { ".gitignore": ".claude/worktrees/\n", "src/a.js": line + line.replace("const m", "const n") });
  const entry = { file: "src/a.js", category: "finding:swallowed-error", match: ['import("./x.js")', ".catch(() => null)"].join(""), context: "export const", reason: "the reviewed reason this one instance stays" };   // the instance as the gate reports it
  writeFileSync(join(site, "canon.allow.json"), JSON.stringify({ $schema: "x", entries: [entry] }));
  const r = await checkFindings(site, {}, kit);
  assert.equal(r.problems.filter((p) => p.file.startsWith("src/a.js:")).length, 1, JSON.stringify(r.problems));
});

test("swallowed-error refuses every written form of the class and passes the handled ones (review H4)", async (t) => {
  const forms = JSON.parse(readFileSync(join(KIT, "findings/swallowed-error/forms.json"), "utf8"));
  for (const f of forms.refuse) { const found = await runGate("swallowed-error", tree(t, { [f.file]: f.src })); assert.ok(found.some((x) => x.match !== "parse error"), `lets through (or only cannot parse): ${f.src} ${JSON.stringify(found)}`); }
  for (const f of forms.pass) assert.deepEqual(await runGate("swallowed-error", tree(t, { [f.file]: f.src })), [], `refuses: ${f.src}`);
});

// every class whose cases carry forms.json (tree forms) is proven here: the list comes from the registry, so a new class's
// forms can never sit untested (swallowed-error keeps its single-file forms, proven above)
const TREE_FORMS = JSON.parse(readFileSync(join(KIT, "packages/core/registry/finding-classes.json"), "utf8")).classes
  .filter((c) => c.id !== "swallowed-error" && existsSync(join(KIT, c.cases, "forms.json"))).map((c) => c.id);
test("every finding class has its written forms: forms.json, or (a git-index class, whose forms need a real index) a test of its own in this file", () => {
  const all = JSON.parse(readFileSync(join(KIT, "packages/core/registry/finding-classes.json"), "utf8")).classes;
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const without = all.filter((c) => !existsSync(join(KIT, c.cases, "forms.json"))
    && !(c.detect.every((d) => d.kind === "git") && self.includes(`test("${c.id} `))).map((c) => c.id);
  assert.deepEqual(without, [], `classes proven only by their real case: ${without.join(", ")}`);
});
for (const id of TREE_FORMS) {
  test(`${id}: every written form of the class is refused, the handled forms pass`, async (t) => {
    const forms = JSON.parse(readFileSync(join(KIT, `findings/${id}/forms.json`), "utf8"));
    for (const f of forms.refuse) { const found = await runGate(id, tree(t, f.files)); assert.ok(found.some((x) => x.match !== "parse error"), `lets through (or only cannot parse): ${JSON.stringify(f.files)} ${JSON.stringify(found)}`); }
    for (const f of forms.pass) assert.deepEqual(await runGate(id, tree(t, f.files)), [], `refuses: ${JSON.stringify(f.files)}`);
  });
}

test("the stray-gitlink gate reads the directory it is asked about, also inside a git hook (GIT_DIR exported)", async (t) => {
  const root = tree(t, { ".gitignore": ".claude/worktrees/\n" });
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", root, "init", "-q"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  execFileSync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `160000,${"c".repeat(40)},vendor/z`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = join(KIT, ".git"); delete process.env.GIT_INDEX_FILE;   // as git runs a hook of the kit's own repository
  try { assert.ok((await runGate("stray-gitlink", root)).some((f) => f.file === "vendor/z"), "the hook's repository was read instead"); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("a case's .git-index is read in the one form the live index is read in (git ls-files -s -z), never misread", async (t) => {
  // the newline form of the same two gitlinks: read as NUL records it would be one entry with a newline in its path
  const text = `160000 ${"e".repeat(40)} 0\t.claude/worktrees/agent-a\n160000 ${"d".repeat(40)} 0\t.claude/worktrees/agent-b\n`;
  await assert.rejects(runGate("stray-gitlink", tree(t, { ".gitignore": "node_modules/\n", ".git-index": text })), /not in git ls-files -s -z form/);
  await assert.rejects(runGate("stray-gitlink", tree(t, { ".gitignore": "node_modules/\n", ".git-index": "160000 x\0" })), /does not write/);
});

test("stray-gitlink reads the real index and .gitmodules the way git does (review M5)", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo = (files) => { const r = tree(t, files); git(r, "init", "-q"); git(r, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/x`); return r; };
  // a committed .git-index never stands in for the real index of a repository
  const forged = repo({ ".gitignore": ".claude/worktrees/\n", ".git-index": "" });
  assert.ok((await runGate("stray-gitlink", forged)).some((f) => f.file === "vendor/x"), "the forged fixture hid the gitlink");
  // .gitmodules is read as git reads it: a longer path or a comment does not register vendor/x
  const near = repo({ ".gitignore": ".claude/worktrees/\n", ".gitmodules": '# path = vendor/x\n[submodule "xy"]\n\tpath = vendor/xy\n\turl = https://example.org/xy\n' });
  assert.ok((await runGate("stray-gitlink", near)).some((f) => f.file === "vendor/x"), "a near path registered it");
  const real = repo({ ".gitignore": ".claude/\n", ".gitmodules": '[submodule "x"]\n\tpath = vendor/x\n\turl = https://example.org/x\n' });
  git(real, "add", ".gitmodules");   // registered means committed: CI checks out the commit
  assert.deepEqual(await runGate("stray-gitlink", real), [], "registered, and .claude/ ignores the worktrees");
  // a directory inside a work tree (a site in a monorepo) reads that tree's index for its own paths
  const mono = tree(t, { ".gitignore": ".claude/worktrees/\n", "site/.gitignore": ".claude/worktrees/\n", "site/a.js": "1\n" });
  git(mono, "init", "-q"); git(mono, "update-index", "--add", "--cacheinfo", `160000,${"b".repeat(40)},site/vendor/y`);
  assert.ok((await runGate("stray-gitlink", join(mono, "site"))).some((f) => f.file === "vendor/y"), "a gitlink in a monorepo site was not read");
  // .gitmodules as committed and as git parses it (kit #112 review of 1441ec3): a path without a url fails checkout too; the
  // working-tree copy is not what CI checks out; ./ and a trailing / name the same path
  const nourl = repo({ ".gitignore": ".claude/worktrees/\n", ".gitmodules": '[submodule "x"]\n\tpath = vendor/x\n' });
  git(nourl, "add", ".gitmodules");
  assert.ok((await runGate("stray-gitlink", nourl)).some((f) => f.file === "vendor/x"), "a submodule with no url passed");
  const unstaged = repo({ ".gitignore": ".claude/worktrees/\n" });
  writeFileSync(join(unstaged, ".gitmodules"), '[submodule "x"]\n\tpath = vendor/x\n\turl = https://example.org/x\n');
  git(unstaged, "add", ".gitmodules");
  writeFileSync(join(unstaged, ".gitmodules"), '[submodule "z"]\n\tpath = vendor/z\n\turl = https://example.org/z\n');
  assert.deepEqual(await runGate("stray-gitlink", unstaged), [], "the committed .gitmodules registers vendor/x, whatever the working copy says");
  const dotted = repo({ ".gitignore": ".claude/worktrees/\n", ".gitmodules": '[submodule "x"]\n\tpath = ./vendor/x/\n\turl = https://example.org/x\n' });
  git(dotted, "add", ".gitmodules");
  assert.deepEqual(await runGate("stray-gitlink", dotted), [], "./vendor/x/ names vendor/x");
  // a working-tree .gitmodules that is not committed registers nothing: CI checks out the commit (#122 delta review)
  const untracked = repo({ ".gitignore": ".claude/worktrees/\n", ".gitmodules": '[submodule "x"]\n\tpath = vendor/x\n\turl = https://example.org/x\n' });
  assert.ok((await runGate("stray-gitlink", untracked)).some((f) => f.file === "vendor/x"), "an uncommitted .gitmodules registered the gitlink");
  // a tracked file under an agent worktree directory, at any depth, in any case, whatever characters its name has
  for (const path of [".claude/worktrees/agent-a/x.js", "pkg/.claude/worktrees/b/y.js", ".Claude/Worktrees/c/z.js", ".claude/worktrees/agént-1/x.js"]) {
    const w = tree(t, { ".gitignore": ".claude/worktrees/\n" });
    git(w, "init", "-q"); git(w, "update-index", "--add", "--cacheinfo", `100644,${"c".repeat(40)},${path}`);
    assert.ok((await runGate("stray-gitlink", w)).length, `${path} was not refused`);
  }
  // an index git cannot read is an error, never an empty index
  const broken = repo({ ".gitignore": ".claude/worktrees/\n" });
  writeFileSync(join(broken, ".git/index"), "not an index");
  await assert.rejects(runGate("stray-gitlink", broken), /git/);
});

test("a must-fail case is the real finding, byte for byte: a sample, an edited file, an unaccounted file or no provenance fails (review M7)", async (t) => {
  const cp = () => { const root = tempDir(t, "kit-findings-prov-"); cpSync(join(KIT, "findings"), join(root, "findings"), { recursive: true }); mkdirSync(join(root, "packages/core/registry"), { recursive: true }); cpSync(join(KIT, REG), join(root, REG)); writeFileSync(join(root, ".gitignore"), ".claude/worktrees/\n"); return root; };
  const real = "findings/platform-limits/must-fail/cloudflare-helpers-plain-sqlite";
  const clean = await checkFindings(cp(), {}, kit);
  assert.ok(!clean.problems.some((p) => p.file.startsWith("findings/")), JSON.stringify(clean.problems.filter((p) => p.file.startsWith("findings/"))));
  const edited = cp();
  writeFileSync(join(edited, real, "packages/cloudflare/test/helpers.mjs"), readFileSync(join(edited, real, "packages/cloudflare/test/helpers.mjs"), "utf8").replace("export", "export "));
  assert.ok((await checkFindings(edited, {}, kit)).problems.some((p) => /is not blob [0-9a-f]{40}/.test(p.problem)), "an edited copy");
  const extra = cp();
  writeFileSync(join(extra, real, "packages/cloudflare/test/sample.test.mjs"), "new DatabaseSync(':memory:')\n");
  assert.ok((await checkFindings(extra, {}, kit)).problems.some((p) => /does not account for/.test(p.problem)), "a sample added next to it");
  const bare = cp();
  rmSync(join(bare, real, "source.json"));
  assert.ok((await checkFindings(bare, {}, kit)).problems.some((p) => /without its provenance/.test(p.problem)), "no source.json");
});

test("a must-fail case refused for something other than the finding it was cut from fails (review L4)", async (t) => {
  const root = tempDir(t, "kit-findings-expect-");
  cpSync(join(KIT, "findings"), join(root, "findings"), { recursive: true });
  mkdirSync(join(root, "packages/core/registry"), { recursive: true }); cpSync(join(KIT, REG), join(root, REG));
  writeFileSync(join(root, ".gitignore"), ".claude/worktrees/\n");
  const src = join(root, "findings/wallclock-assert/must-fail/kit-117-bench-budget/source.json");
  writeFileSync(src, readFileSync(src, "utf8").replace("r.p50 <= r.budgetP50", "a budget assertion the gate never saw"));
  const r = await checkFindings(root, {}, kit);
  assert.ok(r.problems.some((p) => /not for the finding it was cut from/.test(p.problem)), JSON.stringify(r.problems.slice(0, 3)));
});

test("the scans never read an agent's worktree as the repository's own files (review L3)", async (t) => {
  const { walk } = await import("../src/canon/files.js");
  const root = tree(t, { "src/a.js": "export const a = 1;\n", ".claude/worktrees/agent-x/src/b.js": "export const b = 1;\n", ".claude/settings.json": "{}\n" });
  assert.deepEqual(walk(root), [".claude/settings.json", "src/a.js"]);
});

test("the engine has no class-specific code: no class id appears in it, every rule is the registry's data (wo-0008)", () => {
  const engine = readFileSync(join(KIT, "packages/cli/src/canon/engine.js"), "utf8");
  for (const c of registry.classes) assert.ok(!engine.includes(c.id), `engine.js names ${c.id}`);
  assert.ok(!existsSync(join(KIT, "packages/cli/src/canon/gates.js")) && !existsSync(join(KIT, "packages/cli/src/canon/commands.js")), "the hand-written gates and shell reader are gone");
});

test("a file its canonical parser cannot read is a finding, never skipped (wo-0008)", async (t) => {
  for (const [file, src, id] of [["src/a.js", "export const = ;\n", "swallowed-error"], ["a.py", "def f(:\n", "swallowed-error"], ["test/t.test.mjs", "const t = (;\n", "wallclock-assert"],
    [".github/workflows/ci.yml", "jobs: [\n", "workflow-command-exists"], ["wrangler.toml", "[vars\n", "empty-required-config"], ["package.json", "{ not json", "tool-version-single-source"]]) {
    const found = await runGate(id, tree(t, { [file]: src }));
    assert.ok(found.some((f) => f.file === file && /cannot parse|parse error/.test(f.problem + f.match)), `${id} skipped ${file}: ${JSON.stringify(found)}`);
  }
});

test("the declared templates are checked as the site build renders them: the code contracts pass on the built sample site (wo-0008)", async (t) => {
  const { main } = await import("../src/index.js");
  const out = tempDir(t, "kit-findings-built-");
  const err = [];
  const code = await main(["site", "build", "--config", join(KIT, "examples/site-sample/site.config.js"), "--out", out], { cwd: KIT, out: () => {}, err: (s) => err.push(s) });
  assert.equal(code, 0, err.join("\n"));
  const files = readdirSync(out, { recursive: true }).map(String).filter((f) => /\.m?js$/.test(f));
  assert.ok(files.length > 3, `built scripts: ${files.length}`);
  for (const id of ["swallowed-error"]) {
    const found = await runGate(id, out, files);
    assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.match}`), [], `${id} on the rendered templates`);
  }
});

test("a broken contract fails loudly, never matches nothing: a pattern without @finding, a predicate on a capture the pattern lacks, an undeclared bind or set (review of 80bf52e)", async (t) => {
  const { runDetectors } = await import("../src/canon/engine.js");
  const root = tree(t, { "src/a.js": "p.catch(() => null);\n" });
  const files = ["src/a.js"];
  const ctx = { root, files, read: (f) => readFileSync(join(root, f), "utf8"), registry: { ...registry }, validate: () => [], git: () => ({}), member: null };
  const det = (over) => ({ id: "x", detect: [{ kind: "query", files: { include: ["**/*.js"] }, problem: "a problem long enough to read", query: '(call_expression) @finding', ...over }] });
  await assert.rejects(runDetectors(det({ query: "(call_expression) @call" }), ctx), /no @finding/);
  await assert.rejects(runDetectors(det({ query: '((call_expression) @finding (#eq? @typo "x"))' }), ctx), /@typo/);
  await assert.rejects(runDetectors(det({ query: '((call_expression function: (_) @f) @finding (#bound? @f "nobody"))' }), ctx), /bind "nobody"/);
  await assert.rejects(runDetectors(det({ query: '((call_expression function: (_) @f) @finding (#any-of-set? @f "nosuch"))' }), ctx), /set "nosuch"/);
  await assert.rejects(runDetectors(det({ files: { include: ["**/*.txt"] } }), { ...ctx, files: ["notes.txt"], read: () => "x" }), /no grammar/);
});

test("a declared template glob hides no code: every file under it is a template the site build renders (review of 80bf52e)", () => {
  const { matchesGlob } = require_path();
  const files = readdirSync(KIT, { recursive: true }).map(String).filter((f) => !/(^|\/)(node_modules|\.git)\//.test(f) && /\.(m?js|cjs|ts)$/.test(f));
  const under = files.filter((f) => registry.templates.include.some((g) => matchesGlob(f, g)));
  assert.ok(under.length > 5, `templates found: ${under.length}`);
  for (const f of under) assert.match(readFileSync(join(KIT, f), "utf8"), /\{\{[^{}]+\}\}/, `${f} is under a template glob but holds no template placeholder: it is code the contracts must read`);
});
