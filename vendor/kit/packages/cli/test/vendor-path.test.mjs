// The vendored kit snapshot's location has one source, kit.canon.json "vendor", read through packages/cli/src/vendor-path.js, and that
// source is itself protected (kit #139 independent review at 832e86a: the canon was unprotected, guardRel did not normalise, launcher.sh,
// canon/facts.js, canon/findings.js, content-state.js and resilience/check.js named vendor/kit, and a malformed vendor failed open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { DEFAULT_VENDOR_PATH, snapshotRoots, vendorRoots } from "../src/vendor-path.js";
import { decide, decideGit } from "../src/agent-guard/rules.js";
import { digestOf, guardChanges, signApproval, verifyApprovals } from "../src/agent-guard/approvals-gate.js";
import { matchAny } from "../src/agent-guard/common.js";
import { mergeRegistry } from "../src/agent-guard/registry.js";
import { KIT_REGISTRY_FILE, LAUNCH_SHIM, guardRel, retargetProblem, shimText } from "../src/agent-guard/install.js";
import { repoFacts } from "../src/canon/facts.js";
import { watcherFacts } from "../src/resilience/check.js";
import { gitEnv } from "../src/git.js";

const kitReg = JSON.parse(readFileSync(KIT_REGISTRY_FILE, "utf8"));
const ROOT = "/repo";
const LAUNCHER = fileURLToPath(new URL("../src/agent-guard/launcher.sh", import.meta.url));
const CUSTOM = "third_party/kit";
const ctxFor = (vendor, files = {}) => ({ root: ROOT, registry: mergeRegistry(kitReg, null, vendor).registry, hookRel: `${vendorRoots(vendor).snapshot}/packages/cli/src/agent-guard/daemon.mjs`, readFile: (p) => files[p.replace(`${ROOT}/`, "")] ?? null, branch: () => "feature" });
const at = (ctx) => ({
  write: (rel, content) => decide({ hook_event_name: "PreToolUse", cwd: ROOT, tool_name: "Write", tool_input: { file_path: `${ROOT}/${rel}`, content } }, ctx),
  edit: (rel, old_string, new_string) => decide({ hook_event_name: "PreToolUse", cwd: ROOT, tool_name: "Edit", tool_input: { file_path: `${ROOT}/${rel}`, old_string, new_string } }, ctx),
  bash: (command) => decide({ hook_event_name: "PreToolUse", cwd: ROOT, tool_name: "Bash", tool_input: { command } }, ctx),
});
const denied = (d, rule) => { assert.equal(d.action, "deny", `expected deny ${rule}, got ${JSON.stringify(d)}`); assert.equal(d.rule, rule); };
const allowed = (d) => assert.equal(d.action, "allow", JSON.stringify(d));
const matchGuard = (rel) => matchAny(rel, kitReg.protected.globs, true) && kitReg.guardPaths.some((g) => rel.startsWith(g.split("#")[0]));

test("one source: every root of a custom vendor.path and the default is generated; a malformed vendor fails closed", () => {
  assert.deepEqual(vendorRoots(undefined).globs, [`${DEFAULT_VENDOR_PATH}/**`, `${DEFAULT_VENDOR_PATH}.manifest.json`]);
  assert.deepEqual(snapshotRoots({ path: `./${CUSTOM}//` }).map((r) => r.snapshot), [CUSTOM, DEFAULT_VENDOR_PATH], "the default stays a root when vendor.path moves");
  for (const bad of ["vendor/kit", null, [], { path: 5 }, { path: "../x" }, { path: "/abs" }, { path: "a", manifest: 3 }]) {
    assert.throws(() => vendorRoots(bad), /vendor/, JSON.stringify(bad));
    assert.ok(mergeRegistry(kitReg, null, bad).problems.length, `the registry holds on ${JSON.stringify(bad)}`);
  }
});

test("must fail: with a custom vendor.path, every agent write into either root is a hand-edit of a generated file, by any tool or command", () => {
  const g = at(ctxFor({ path: CUSTOM }));
  for (const root of [CUSTOM, DEFAULT_VENDOR_PATH]) {
    for (const f of ["x.mmd", "README.md", "packages/x.js"]) denied(g.write(`${root}/${f}`, "flowchart TB\n a-->b\n"), "generated-hand-edit");
    for (const cmd of [`cp a.js ${root}/packages/x.js`, `echo x | tee ${root}/packages/x.js`, `sed -i s/a/b/ ${root}/packages/x.js`, `echo x > ${root}/docs/a.md`])
      denied(g.bash(cmd), "generated-hand-edit");
  }
  denied(g.write(`${CUSTOM}.manifest.json`, "{}"), "generated-hand-edit");
  denied(g.write(`${DEFAULT_VENDOR_PATH}.manifest.json`, "{}"), "generated-hand-edit");
  const ln = g.bash(`ln -s /tmp/evil ${CUSTOM}/packages/x.js`);
  assert.equal(ln.action, "deny", `a symlink into the snapshot is refused: ${JSON.stringify(ln)}`);
});

test("must fail: kit.canon.json's vendor block is protected; its other keys are not", () => {
  const before = JSON.stringify({ project: "x", vendor: { path: CUSTOM }, diagrams: "docs/diagrams" }, null, 2);
  const g = at(ctxFor({ path: CUSTOM }, { "kit.canon.json": before }));
  denied(g.edit("kit.canon.json", `"path": "${CUSTOM}"`, `"path": "elsewhere/kit"`), "guard-tamper");
  denied(g.write("kit.canon.json", JSON.stringify({ project: "x", diagrams: "docs/diagrams" })), "guard-tamper");
  denied(g.write("kit.canon.json", "{ not json"), "guard-tamper");
  denied(g.bash("sed -i s/third_party/elsewhere/ kit.canon.json"), "guard-tamper");
  allowed(g.edit("kit.canon.json", `"diagrams": "docs/diagrams"`, `"diagrams": "docs/figures"`));
  allowed(at(ctxFor({ path: CUSTOM })).write("kit.canon.json", before));      // a new canon file is the bootstrap
});

test("guardRel normalises vendor.path the one way (./, //, \\\\ and a trailing slash), and finds no guard pack on a malformed one", () => {
  const root = fileTempDir("kit-guardrel-");
  mkdirSync(join(root, CUSTOM, "packages/cli/src/agent-guard"), { recursive: true });
  writeFileSync(join(root, CUSTOM, "packages/cli/src/agent-guard/daemon.mjs"), "");
  for (const path of [CUSTOM, `./${CUSTOM}`, "third_party//kit/", "third_party\\kit"]) assert.equal(guardRel(root, { vendor: { path } }), `${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`, path);
  assert.equal(guardRel(root, { vendor: { path: 5 } }), null);
  assert.equal(guardRel(root, { vendor: "third_party/kit" }), null);
});

test("must fail: the launcher runs only the hook client sync wrote; a decoy vendor, a duplicate key or a planted hook decides nothing (review of #139 at 7b1aac9)", () => {
  const src = readFileSync(LAUNCHER, "utf8");
  assert.ok(!/kit\.canon\.json|vendor/.test(src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")), "the launcher reads no configuration to find enforcement");
  const repo = (canon, { shim = true } = {}) => {
    const root = fileTempDir("kit-launcher-");
    spawnSync("git", ["init", "-q", root], { env: gitEnv() });
    writeFileSync(join(root, "kit.canon.json"), canon);
    for (const [dir, says] of [[CUSTOM, "REAL-HOOK"], ["evil", "EVIL-HOOK"]]) {
      mkdirSync(join(root, dir, "packages/cli/src/agent-guard"), { recursive: true });
      writeFileSync(join(root, dir, "packages/cli/src/agent-guard/hook.sh"), `echo ${says}\n`);
    }
    mkdirSync(join(root, "packages/cli/src/agent-guard"), { recursive: true });
    writeFileSync(join(root, "packages/cli/src/agent-guard/hook.sh"), "echo PLANTED-KIT-PATH\n");
    if (shim) { mkdirSync(join(root, ".claude/hooks"), { recursive: true }); writeFileSync(join(root, LAUNCH_SHIM), shimText(`${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`)); }
    return root;
  };
  const launch = (root) => spawnSync("bash", [LAUNCHER], { input: JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "a.txt") } }), encoding: "utf8", env: gitEnv() });
  const decoy = `{ "zz": { "vendor": { "path": "evil" } }, "vendor": { "path": "${CUSTOM}" } }`;
  const dup = `{ "vendor": { "path": "evil" }, "vendor": { "path": "${CUSTOM}" } }`;
  for (const canon of [decoy, dup, JSON.stringify({ vendor: { path: "evil" } })]) {
    const r = launch(repo(canon));
    assert.match(r.stdout, /REAL-HOOK/, canon); assert.doesNotMatch(r.stdout, /EVIL|PLANTED/, canon);
  }
  const none = launch(repo(decoy, { shim: false }));
  assert.equal(none.status, 2); assert.match(none.stderr, /no guard pack/); assert.doesNotMatch(none.stdout, /HOOK/);
  // the guard's view of the same edits: a decoy nested vendor and a duplicate key before the real one leave the parsed vendor as it was
  // (and nothing reads them); a duplicate after it, or any case of the file name, moves it and is refused
  const before = JSON.stringify({ project: "x", vendor: { path: CUSTOM } });
  const g = at(ctxFor({ path: CUSTOM }, { "kit.canon.json": before, "KIT.canon.json": before }));
  allowed(g.write("kit.canon.json", `{ "project": "x", "zz": { "vendor": { "path": "evil" } }, "vendor": { "path": "${CUSTOM}" } }`));
  allowed(g.write("kit.canon.json", `{ "project": "x", "vendor": { "path": "evil" }, "vendor": { "path": "${CUSTOM}" } }`));
  denied(g.write("kit.canon.json", `{ "project": "x", "vendor": { "path": "${CUSTOM}" }, "vendor": { "path": "evil" } }`), "guard-tamper");
  denied(g.write("KIT.canon.json", JSON.stringify({ project: "x", vendor: { path: "evil" } })), "guard-tamper");
  // sync resolves the hook client once, through vendor-path.js; a hook planted before a move is never the one it names
  assert.match(shimText(`${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`), new RegExp(`/\\.\\./\\.\\./${CUSTOM}/packages/cli/src/agent-guard/hook\\.sh`));
  assert.ok(matchGuard(LAUNCH_SHIM), "the hook client is a guard path and a protected file");
});

test("must fail: shell writes to kit.canon.json and the hook client, and inline code that reaches enforcement in any spelling, are refused; reads are not (review of #139 at d95aeda)", () => {
  const g = at(ctxFor({ path: CUSTOM }, { "kit.canon.json": JSON.stringify({ vendor: { path: CUSTOM } }) }));
  for (const cmd of [
    "git checkout HEAD~1 -- kit.canon.json", "git restore --source=HEAD~1 kit.canon.json", "git checkout main -- .claude/hooks/agent-guard.sh",
    "rsync -a /tmp/x kit.canon.json", "rsync /tmp/hook.sh .claude/hooks/agent-guard.sh", "jq . kit.canon.json | sponge KIT.CANON.JSON", "cp /tmp/c Kit.canon.json",
    // P1-C: what main refused, and every join or concatenation of an enforcement directory
    `node -e "require('fs').writeFileSync('.claude/hooks/agent-guard.sh','echo')"`, `python3 -c "import shutil; shutil.copy('x', '.claude/hooks/agent-guard.sh')"`,
    `node -e "require('fs').writeFileSync(require('path').join('.claude/hooks','agent-guard.sh'),'exit 0')"`,
    `node -e "require('fs').writeFileSync('.claude/hooks/'+'agent-guard.sh','exit 0')"`,
    `python3 -c "import os;open(os.path.join('.claude/hooks','agent-guard.sh'),'w').write('exit 0')"`,
    `python3 -c "import os;open(os.path.join('.claude','hooks','agent-guard.sh'),'w').write('x')"`,
    `node -e "require('fs').writeFileSync(require('path').join('.githooks','pre-commit'),'exit 0')"`,
    `node -e "require('fs').writeFileSync(['.Claude','Hooks','agent-guard.sh'].join('/'),'x')"`,
  ]) denied(g.bash(cmd), "guard-tamper");
  denied(g.bash(`rsync -a /tmp/x ${CUSTOM}/packages/`), "generated-hand-edit");
  for (const cmd of [
    `node -e "console.log(require('./${CUSTOM}/packages/core/package.json').version)"`,          // reading the snapshot
    `node -e "console.log(require('./kit.canon.json').checks)"`,                                 // P3: reading the canon
    `python3 -c "import json;print(json.load(open('kit.canon.json')))"`,
    `node -p "JSON.parse(require('fs').readFileSync('kit.canon.json','utf8')).vendor"`,
    `node -e "require('fs').writeFileSync('out.txt','see docs/diagrams/README.md')"`,          // P3: a generated path in content only
    "git restore --staged kit.canon.json", "git restore -S .claude/hooks/agent-guard.sh",         // the index only
  ]) allowed(g.bash(cmd));
  // P2-E: a case variant of an enforcement path is refused like the path itself
  for (const f of [".Claude/hooks/agent-guard.sh", ".claude/Hooks/agent-guard.sh", ".CLAUDE/HOOKS/AGENT-GUARD.SH", ".github/Rulesets/x.json"]) denied(g.write(f, "exit 0\n"), "guard-tamper");
  denied(g.write(".Claude/Settings.json", JSON.stringify({ disableAllHooks: true })), "guard-tamper");
});

test("must fail: a missing hook client refuses every action (exit 2), and a site's guard is its snapshot, never a hook planted at the root (review of #139 at d95aeda)", () => {
  // P1-A: the shim is present, its target is not
  const root = fileTempDir("kit-shim-");
  spawnSync("git", ["init", "-q", root], { env: gitEnv() });
  mkdirSync(join(root, ".claude/hooks"), { recursive: true });
  writeFileSync(join(root, LAUNCH_SHIM), shimText(`${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`));
  for (const [tool, input] of [["Write", { file_path: join(root, "a.txt") }], ["Read", { file_path: join(root, "a.txt") }], ["Bash", { command: "ls" }]]) {
    const r = spawnSync("bash", [LAUNCHER], { input: JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }), encoding: "utf8", env: gitEnv() });
    assert.equal(r.status, 2, `${tool}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, /missing or unreadable/);
  }
  // P1-B: a hook and daemon planted at the root of a site are never the guard; sync keeps the snapshot, and sync run from the planted copy refuses
  const site = fileTempDir("kit-site-");
  for (const dir of [`${CUSTOM}/packages/cli/src/agent-guard`, "packages/cli/src/agent-guard"]) { mkdirSync(join(site, dir), { recursive: true }); for (const f of ["daemon.mjs", "hook.sh"]) writeFileSync(join(site, dir, f), ""); }
  assert.equal(guardRel(site, { project: "x", vendor: { path: CUSTOM } }), `${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`);
  assert.equal(guardRel(site, { project: "x" }), null, "no snapshot at the default path: no guard, never the planted root one");
  assert.equal(guardRel(site, { project: "kit" }), "packages/cli/src/agent-guard/daemon.mjs", "the kit itself runs its own");
  assert.match(shimText(guardRel(site, { project: "x", vendor: { path: CUSTOM } })), new RegExp(`${CUSTOM}/packages/cli/src/agent-guard/hook\\.sh`));
  // sync from the planted copy at the root refuses; from the snapshot, or from a kit outside the repository, it writes the snapshot's guard
  const rel = guardRel(site, { project: "x", vendor: { path: CUSTOM } });
  assert.match(retargetProblem(site, rel, join(site, "packages/cli/src/agent-guard/daemon.mjs")), /this sync runs from packages\/cli\/src\/agent-guard\/daemon\.mjs, not from the repository's guard third_party\/kit/);
  assert.equal(retargetProblem(site, rel, join(site, rel)), null);
  assert.equal(retargetProblem(site, rel, "/opt/kit/packages/cli/src/agent-guard/daemon.mjs"), null);
});

test("an owner moves vendor.path through the signed approval of kit.canon.json#/vendor; other keys are not guard changes", () => {
  const root = fileTempDir("kit-approval-");
  const run = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", env: gitEnv() });
  run("init", "-q", "-b", "main"); run("config", "user.email", "t@example.com"); run("config", "user.name", "t");
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ project: "x", vendor: { path: CUSTOM }, diagrams: "docs/diagrams" }, null, 2));
  run("add", "-A"); run("commit", "-q", "--no-verify", "-m", "base");
  run("checkout", "-q", "-b", "other");
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ project: "x", vendor: { path: CUSTOM }, diagrams: "docs/figures" }, null, 2));
  run("commit", "-q", "--no-verify", "-am", "other key");
  assert.deepEqual(guardChanges(root, kitReg.guardPaths, { base: "main" }), [], "a change of another key is not a guard change");
  run("checkout", "-q", "-b", "move", "main");
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ project: "x", vendor: { path: "lib/kit" }, diagrams: "docs/diagrams" }, null, 2));
  run("commit", "-q", "--no-verify", "-am", "move");
  const changes = guardChanges(root, kitReg.guardPaths, { base: "main" });
  assert.deepEqual(changes.map((c) => c.path), ["kit.canon.json#/vendor"]);
  // the commit itself is not hard-denied (audit): the approval gate decides
  const ctx = { root, registry: mergeRegistry(kitReg, null, { path: CUSTOM }).registry, hookRel: `${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`, readFile: () => null, branch: () => null };
  allowed(decideGit({ hook_event_name: "GitCommit", branch: "move", files: [{ path: "kit.canon.json", before: JSON.stringify({ vendor: { path: CUSTOM } }), after: JSON.stringify({ vendor: { path: "lib/kit" } }) }] }, ctx));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const owners = [{ login: "owner", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }];
  const digest = digestOf(changes);
  assert.equal(verifyApprovals({ ledgerText: "", owners, digest }).ok, false, "unapproved: refused");
  const row = signApproval({ privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }), digest, login: "owner" });
  assert.equal(verifyApprovals({ ledgerText: `${JSON.stringify(row)}\n`, owners, digest }).ok, true, "the owner's signed approval lets it through");
});

test("the canon facts and the watcher step read the configured snapshot, and a snapshot left at the default still counts", () => {
  const root = fileTempDir("kit-facts-");
  mkdirSync(join(root, DEFAULT_VENDOR_PATH), { recursive: true });
  assert.equal(repoFacts(root, { vendor: { path: CUSTOM } }).vendoredKit, true, "moving vendor.path does not waive the proof of the snapshot left behind");
  const wf = (cmd) => `on:\n  schedule:\n    - cron: "*/5 * * * *"\njobs:\n  w:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm ci\n      - run: ${cmd}\n`;
  assert.deepEqual(Object.keys(watcherFacts(wf(`node ${CUSTOM}/packages/cli/bin/kit.js resilience watch --monitor site`), CUSTOM).watch), ["site"]);
  // the message names the form a site runs now, the bootstrap (the kit at t=0, docs/FRESHNESS.md); a snapshot at another path is not that form
  assert.match(watcherFacts(wf(`node ${CUSTOM}/packages/cli/bin/kit.js resilience watch --monitor site`)).problems.join("\n"), /node scripts\/kit\.mjs resilience/);
});

test("must fail: the relabel, copy, plant and sync chain never points the guard at a planted hook (review of #139 at 69f4d6d)", () => {
  const site = fileTempDir("kit-relabel-");
  const canon = { project: "site", vendor: { path: CUSTOM } };
  writeFileSync(join(site, "kit.canon.json"), JSON.stringify(canon, null, 2));
  for (const dir of [`${CUSTOM}/packages/cli/src/agent-guard`, "packages/cli/src/agent-guard"]) { mkdirSync(join(site, dir), { recursive: true }); for (const f of ["daemon.mjs", "hook.sh"]) writeFileSync(join(site, dir, f), f === "hook.sh" && dir.startsWith("packages") ? "exit 0\n" : ""); }
  writeFileSync(join(site, `${CUSTOM}.manifest.json`), "{}\n");
  // 1. the relabel is refused, as an edit and as a write, in any case of the name; #/vendor likewise
  const before = readFileSync(join(site, "kit.canon.json"), "utf8");
  const g = at(ctxFor({ path: CUSTOM }, { "kit.canon.json": before, "KIT.CANON.JSON": before }));
  denied(g.edit("kit.canon.json", '"project": "site"', '"project": "kit"'), "guard-tamper");
  denied(g.write("KIT.CANON.JSON", JSON.stringify({ ...canon, project: "kit" })), "guard-tamper");
  allowed(g.write("kit.canon.json", JSON.stringify({ ...canon, diagrams: "docs/diagrams" })));
  // 2. even relabelled, a repository that carries a vendored snapshot manifest is never the kit: no root guard, so sync has nothing to retarget to
  assert.equal(guardRel(site, { ...canon, project: "kit" }), null);
  assert.equal(guardRel(site, canon), `${CUSTOM}/packages/cli/src/agent-guard/daemon.mjs`);
  // 3. a commit that relabels is a guard change: it needs the owner's signed approval
  const run = (...a) => execFileSync("git", ["-C", site, ...a], { encoding: "utf8", env: gitEnv() });
  run("init", "-q", "-b", "main"); run("config", "user.email", "t@example.com"); run("config", "user.name", "t");
  run("add", "kit.canon.json"); run("commit", "-q", "--no-verify", "-m", "base"); run("checkout", "-q", "-b", "relabel");
  writeFileSync(join(site, "kit.canon.json"), JSON.stringify({ ...canon, project: "kit" }, null, 2)); run("commit", "-q", "--no-verify", "-am", "relabel");
  assert.deepEqual(guardChanges(site, kitReg.guardPaths, { base: "main" }).map((c) => c.path), ["kit.canon.json#/project"]);
});

test("must fail: git restore writes the working tree unless the flag is exactly --staged or -S with no --worktree in any spelling", () => {
  const g = at(ctxFor({ path: CUSTOM }));
  for (const cmd of ["git restore --staged --worktr kit.canon.json", "git restore --staged --w .claude/hooks/agent-guard.sh", "git restore -S -W kit.canon.json", "git restore -SW kit.canon.json",
    "git restore -sStable kit.canon.json", "git restore --stage kit.canon.json", "git restore -s HEAD~1 -S --worktree .claude/hooks/agent-guard.sh"]) denied(g.bash(cmd), "guard-tamper");
  for (const cmd of ["git restore --staged kit.canon.json", "git restore -S .claude/hooks/agent-guard.sh"]) allowed(g.bash(cmd));
});
