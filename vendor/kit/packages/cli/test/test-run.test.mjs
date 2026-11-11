// npm test runs inside a temp directory of its own, removed whatever the result (packages/cli/scripts/test-run.mjs): a test
// run never leaves temp files behind (2026-10-07: 7361 kit-* directories, 7.2 GB, filled the disk).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runInTemp, STEPS, stepsOf, browserTestFiles, testFiles } from "../scripts/test-run.mjs";
import { tempDir } from "../../core/test/support/temp.mjs";

const base = (t) => tempDir(t, "kit-test-run-case-");

test("the run's temp directory is removed after a pass, after a failure, and after a step that cannot start", (t) => {
  const b = base(t);
  let seen;
  const pass = runInTemp([["x", []]], { base: b, spawn: (_c, _a, o) => { seen = o.env.TMPDIR; writeFileSync(join(seen, "left.txt"), "1"); return { status: 0 }; } });
  assert.equal(pass.code, 0); assert.equal(seen, pass.dir); assert.ok(!existsSync(pass.dir), "left behind after a pass");
  const fail = runInTemp([["x", []], ["never", []]], { base: b, spawn: (c) => { assert.notEqual(c, "never", "a step after a failure ran"); return { status: 3 }; } });
  assert.equal(fail.code, 3); assert.ok(!existsSync(fail.dir), "left behind after a failure");
  let dir;
  assert.throws(() => runInTemp([["x", []]], { base: b, spawn: (_c, _a, o) => { dir = o.env.TMPDIR; return { error: new Error("ENOENT") }; } }), /ENOENT/);
  assert.ok(!existsSync(dir), "left behind after a step that could not start");
});

test("a run inside a git hook does not hand the hook's repository to its steps (git rev-parse --local-env-vars)", (t) => {
  const b = tempDir(t, "kit-run-env-");
  let seen;
  runInTemp([["x", []]], { base: b, env: { PATH: process.env.PATH, GIT_DIR: "/repo/.git", GIT_INDEX_FILE: "/repo/.git/index", HOME: "/h" }, spawn: (_c, _a, o) => { seen = o.env; return { status: 0 }; } });
  assert.equal(seen.GIT_DIR, undefined, "GIT_DIR reached a step");
  assert.equal(seen.GIT_INDEX_FILE, undefined, "GIT_INDEX_FILE reached a step");
  assert.equal(seen.HOME, "/h");
});

test("npm test is the wrapper, so every run gets its own temp directory", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node packages/cli/scripts/test-run.mjs");
});

test("a commit is pushed only after npm test passes on it: npm ci installs .githooks, whose pre-push tests the pushed commit", async () => {
  const { installHooks } = await import("../scripts/install-hooks.mjs");
  const root = new URL("../../../", import.meta.url).pathname;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.prepare, "node packages/cli/scripts/install-hooks.mjs");
  assert.match(readFileSync(join(root, ".githooks/pre-push"), "utf8"), /^exec node packages\/cli\/scripts\/pre-push\.mjs "\$@"$/m);
  const notRepo = Object.assign(new Error("x"), { stderr: "fatal: not a git repository" });
  assert.match(installHooks(root, { git: () => { throw notRepo; } }), /not a git work tree/);
  assert.throws(() => installHooks(root, { git: () => { throw Object.assign(new Error("x"), { stderr: "fatal: permission denied" }); } }), /x/);
});

test("hooks are installed only at the top of the repository's own work tree, never on an enclosing repository (#122 review)", async (t) => {
  const { installHooks } = await import("../scripts/install-hooks.mjs");
  const { execFileSync } = await import("node:child_process");
  const { gitEnv } = await import("../src/git.js");
  const g = (d, ...a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", env: gitEnv() });
  const top = tempDir(t, "kit-hooks-");
  g(top, "init", "-q");
  mkdirSync(join(top, ".githooks")); writeFileSync(join(top, ".githooks/pre-push"), "#!/bin/sh\n");
  assert.match(installHooks(top), /pre-push runs npm test/);
  assert.equal(g(top, "config", "core.hooksPath").trim(), ".githooks");
  // a kit vendored inside another repository: the parent's hooks are left alone
  const parent = tempDir(t, "kit-hooks-parent-");
  g(parent, "init", "-q");
  const nested = join(parent, "vendor/kit"); mkdirSync(join(nested, ".githooks"), { recursive: true }); writeFileSync(join(nested, ".githooks/pre-push"), "#!/bin/sh\n");
  assert.match(installHooks(nested), /not the top of its own work tree/);
  assert.throws(() => g(parent, "config", "core.hooksPath"), "the enclosing repository's core.hooksPath was set");
  const outside = tempDir(t, "kit-hooks-none-");
  mkdirSync(join(outside, ".githooks")); writeFileSync(join(outside, ".githooks/pre-push"), "#!/bin/sh\n");
  assert.match(installHooks(outside), /not a git work tree/);
});

test("pre-push tests the pushed commit: refused when a pushed ref is not the checked-out commit or the tree is dirty; deletes run nothing", async () => {
  const { prePushPlan } = await import("../scripts/pre-push.mjs");
  const head = "a".repeat(40), other = "b".repeat(40), zero = "0".repeat(40);
  assert.deepEqual(prePushPlan(`refs/heads/x ${head} refs/heads/x ${other}\n`, { head, clean: true }), { test: true });
  assert.match(prePushPlan(`refs/heads/y ${other} refs/heads/y ${zero}\n`, { head, clean: true }).refuse, /not the checked-out commit/);
  assert.match(prePushPlan(`refs/heads/x ${head} refs/heads/x ${other}\nrefs/heads/y ${other} refs/heads/y ${zero}\n`, { head, clean: true }).refuse, /refs\/heads\/y/);
  assert.match(prePushPlan(`refs/heads/x ${head} refs/heads/x ${other}\n`, { head, clean: false }).refuse, /not committed/);
  assert.deepEqual(prePushPlan(`(delete) ${zero} refs/heads/old ${other}\n`, { head, clean: false }), { test: false });
  assert.deepEqual(prePushPlan("", { head, clean: true }), { test: false });
  assert.throws(() => prePushPlan("garbage\n", { head, clean: true }), /does not read/);
});

test("pre-push: an annotated tag at the checked-out commit is that commit (peeled), and the refusal names the commit pushed (#122 review)", async () => {
  const { prePushPlan } = await import("../scripts/pre-push.mjs");
  const head = "a".repeat(40), tag = "c".repeat(40), other = "b".repeat(40), zero = "0".repeat(40);
  const peel = (sha) => (sha === tag ? head : sha);
  assert.deepEqual(prePushPlan(`refs/tags/v1 ${tag} refs/tags/v1 ${zero}\n`, { head, clean: true, peel }), { test: true });
  assert.match(prePushPlan(`refs/tags/v0 ${other} refs/tags/v0 ${zero}\n`, { head, clean: true, peel }).refuse, /bbbbbbbbbbbb/);
  // a tag of a tree or a blob names no commit: refused with that reason, never a stack trace
  assert.match(prePushPlan(`refs/tags/t ${other} refs/tags/t ${zero}\n`, { head, clean: true, peel: () => null }).refuse, /names no commit/);
});

test("install-hooks: outside a work tree, or with no git at all, nothing to hook, whether or not .githooks is there (#122 review)", async (t) => {
  const { installHooks } = await import("../scripts/install-hooks.mjs");
  const bare = tempDir(t, "kit-hooks-tarball-");   // an npm tarball: no .git, no .githooks
  assert.match(installHooks(bare, { git: () => { throw Object.assign(new Error("x"), { stderr: "fatal: not a git repository" }); } }), /not a git work tree/);
  assert.match(installHooks(bare, { git: () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); } }), /no git/);
  // the real git, in whatever language the caller's locale asks for: install-hooks runs it in the C locale, whose wording it reads
  const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  process.env.LC_ALL = "de_DE.UTF-8"; process.env.LANGUAGE = "de";
  try { assert.match(installHooks(bare), /not a git work tree/); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("forge's gitEnv is the CLI's: the same environment out for the same in (forge has no dependencies, so it keeps a copy)", async () => {
  const cli = await import("../src/git.js");
  const forge = await import("../../forge/scripts/upstream-sync.mjs");
  for (const env of [{ PATH: "/bin" }, { PATH: "/bin", GIT_DIR: "/r", GIT_INDEX_FILE: "/i", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_AUTHOR_NAME: "k" }]) assert.deepEqual(forge.gitEnv(env), cli.gitEnv(env));
  assert.deepEqual(forge.localEnvVars(), cli.localEnvVars());
});

test("gitEnv drops git's own repository-local variables, asked of the real git, and GIT_CONFIG_COUNT's numbered pairs", async () => {
  const { gitEnv, localEnvVars } = await import("../src/git.js");
  for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) assert.ok(localEnvVars().includes(v), v);
  const env = gitEnv({ PATH: "/bin", GIT_DIR: "/r/.git", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", GIT_AUTHOR_NAME: "k" });
  assert.deepEqual(env, { PATH: "/bin", GIT_AUTHOR_NAME: "k" });
});

test("the canon run inside a git hook (GIT_DIR exported) reads each case directory, not the pushing repository", (t) => {
  const root = new URL("../../../", import.meta.url).pathname;
  const b = tempDir(t, "kit-run-hook-");
  const env = { ...process.env, GIT_DIR: join(root, ".git"), GIT_INDEX_FILE: join(root, ".git/index") };
  // through npm test's wrapper, and the kit alone (gitEnv in the gate) with the hook's environment untouched
  assert.equal(runInTemp([[process.execPath, [join(root, "packages/cli/bin/kit.js"), "check", "canon", "--only", "findings"]]], { base: b, env }).code, 0);
  const direct = spawnSync(process.execPath, [join(root, "packages/cli/bin/kit.js"), "check", "canon", "--only", "findings"], { cwd: root, env, encoding: "utf8" });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
});

test("the browser test files run once each in the serial browser step, after the rest, and no file runs twice (they crashed and hung when run in parallel, 2026-10-07)", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const browser = await browserTestFiles(root);
  for (const f of ["theme-qa", "visual-qa", "search-qa", "browser-ci", "browser-bounds"]) assert.ok(browser.includes(`packages/cli/test/${f}.test.mjs`), `${f} is a browser file: ${browser.join(", ")}`);
  const [rest, serial] = (await stepsOf(root)).map((s) => s[1]);
  assert.ok(STEPS[0][1].includes("canon"), "npm test starts with the canon check");
  assert.ok(rest.every((a) => !browser.includes(a)), "no browser file in the parallel step");
  assert.deepEqual(serial, ["packages/cli/scripts/browser-step.mjs"], "the browser files run in browser-step.mjs only");
  const all = [...rest.filter((a) => a.endsWith(".test.mjs")), ...browser];
  assert.deepEqual([...all].sort(), testFiles(root).sort(), "every test file runs exactly once");
  assert.equal(new Set(all).size, all.length);
});

test("gitEnv with a keep-list lets exactly one declared variable through (the index of the commit in progress), validated against git's own list: anything else is refused", async () => {
  const { gitEnv, localEnvVars, KEEPABLE } = await import("../src/git.js");
  assert.deepEqual(KEEPABLE, ["GIT_INDEX_FILE"]);
  assert.ok(localEnvVars().includes("GIT_INDEX_FILE"), "the keepable name is one of git's own repository-local variables");
  const env = { PATH: "/bin", GIT_DIR: "/r/.git", GIT_INDEX_FILE: "/i", GIT_WORK_TREE: "/w", GIT_AUTHOR_NAME: "k" };
  assert.deepEqual(gitEnv(env, { keep: ["GIT_INDEX_FILE"] }), { PATH: "/bin", GIT_INDEX_FILE: "/i", GIT_AUTHOR_NAME: "k" }, "the index stays, every other repository variable goes");
  assert.deepEqual(gitEnv(env, { keep: [] }), gitEnv(env), "an empty keep-list is no keep-list");
  assert.deepEqual(gitEnv({ PATH: "/bin" }, { keep: ["GIT_INDEX_FILE"] }), { PATH: "/bin" }, "a kept name that the environment does not have is not invented");
  assert.deepEqual(gitEnv({ ...env, GIT_INDEX_FILE: "/other" }, { keep: ["GIT_INDEX_FILE"] }).GIT_INDEX_FILE, "/other", "the value is the caller's environment's (the hook's own index, or the one the caller computed)");
  for (const [keep, why] of [[["HOME"], /"HOME" is not one of git's repository-local variables/], [["GIT_DIR"], /"GIT_DIR" may not be kept/], [["GIT_WORK_TREE"], /may not be kept/], [["GIT_INDEX_FILE", "GIT_DIR"], /"GIT_DIR" may not be kept/], ["GIT_INDEX_FILE", /keep must be an array of names/], [[1], /keep must be an array of names/], [undefined, null]]) {
    if (why === null) { assert.doesNotThrow(() => gitEnv(env, { keep })); continue; }
    assert.throws(() => gitEnv(env, { keep }), why, JSON.stringify(keep));
  }
  assert.deepEqual(gitEnv(env, {}), gitEnv(env));
  assert.deepEqual(gitEnv(env, undefined), gitEnv(env));
});
