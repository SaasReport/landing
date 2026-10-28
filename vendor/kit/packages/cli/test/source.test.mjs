// The kit at t=0 (docs/FRESHNESS.md): a site resolves the kit at its head before every use and stores nothing of it. The bootstrap it
// commits (templates/site/scripts/kit.mjs) is the one implementation; these tests run it against a local kit repository and a
// published head object on disk (file: URL in the fixture's registry), never the network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { DEFAULT_HEAD_URL, archiveState, ensure, fetchHead, link, readArchive, repoIdentity, sourceConfig, verify, SourceError } from "../src/source-bootstrap.mjs";
import { kitArchive, kitHead } from "../src/vendor-stale.js";
import { productionCommands } from "../src/release/check.js";
import { walk } from "../src/canon/files.js";
import { scanDeployments } from "../src/wrangler-config.js";
import { BOOTSTRAP, bootstrapText, initSource, siteProblems } from "../src/source.js";
import { runCanon } from "../src/canon/index.js";
import { bundled } from "../src/bundled.js";
import { main } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const TMP = fileTempDir("kit-source-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const kit = bundled();
let KIT, REPO, HEAD_FILE, HEAD1;   // REPO: the fixture kit as a file: URL (kit.canon.json vendor.repository is a URI; a plain path is not)

/** A tiny kit repository: its registry names a published head object on disk, its CLI is a script, its lockfile is empty. */
before(() => {
  KIT = join(TMP, "kit-origin");
  REPO = pathToFileURL(KIT).href;
  mkdirSync(join(KIT, "packages/core/registry"), { recursive: true });
  mkdirSync(join(KIT, "packages/cli/bin"), { recursive: true });
  mkdirSync(join(KIT, "packages/core"), { recursive: true });
  HEAD_FILE = join(TMP, "kit-main.json");
  writeFileSync(join(KIT, "packages/core/registry/kit-head.json"), JSON.stringify({ bucket: "b", key: "k", url: pathToFileURL(HEAD_FILE).href, recent: 300 }));
  writeFileSync(join(KIT, "packages/cli/bin/kit.js"), "#!/usr/bin/env node\nconsole.log('tiny kit', process.argv.slice(2).join(' '));\n");
  writeFileSync(join(KIT, "package.json"), JSON.stringify({ name: "kit", private: true, workspaces: ["packages/*"] }));
  for (const n of ["cli", "core"]) writeFileSync(join(KIT, `packages/${n}/package.json`), JSON.stringify({ name: `@saasreport/${n}`, version: "0.0.0", private: true }));
  // a real lockfile for a real npm ci (the script-mode test spawns npm): no dependency, so it needs no network
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: KIT, stdio: "ignore" });
  writeFileSync(join(KIT, ".gitignore"), "node_modules/\n");
  git(TMP, "init", "-q", "-b", "main", KIT);
  git(KIT, "add", "-A");
  git(KIT, "commit", "-qm", "kit 1");
  HEAD1 = git(KIT, "rev-parse", "HEAD");
  publish(HEAD1);
});
/** The head object on disk; with { archive: true } the archive of sha is written beside it and named by it, as the kit's CI does. */
function publish(sha, { archive = false } = {}) {
  const doc = { v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha, date: git(KIT, "show", "-s", "--format=%cI", sha), recent: [{ sha }] };
  if (archive) {
    const a = kitArchive(KIT, sha);
    const file = join(TMP, a.key);
    writeFileSync(file, a.body);
    doc.archive = { key: a.key, url: pathToFileURL(file).href, sha256: a.sha256, bytes: a.bytes };
  }
  writeFileSync(HEAD_FILE, JSON.stringify(doc));
  return doc;
}
function site(name, { mode = "source", transport = "git" } = {}) {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  const vendor = transport === "archive" ? { mode, path: ".kit", transport, head: pathToFileURL(HEAD_FILE).href } : { mode, path: ".kit", transport, repository: REPO };
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", project: "saasreport", vendor }, null, 2));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "s", private: true, scripts: { test: "node scripts/kit.mjs check canon" } }));
  git(TMP, "init", "-q", "-b", "main", root);
  return root;
}
const noNpm = { npm: () => ({ status: 0 }) };   // the tiny kit has no dependencies: npm ci is a no-op the test does not spawn

test("MUST FAIL: nothing stored, the kit resolved at its head: ensure clones at main, verifies against the published head, links; a moved head is refused until fetched again; a dirty checkout and an unpublished head are refused", async () => {
  const root = site("a");
  const cfg = sourceConfig(JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")));
  assert.deepEqual(cfg, { path: ".kit", repository: REPO, transport: "git" });
  const r = await ensure(root, cfg, noNpm);
  assert.equal(r.schema, "kit.kit-source.v1"); assert.equal(r.sha, HEAD1); assert.equal(r.published.sha, HEAD1);
  assert.deepEqual(kit.validator.validate(r, kit.byName("kit-source")), []);
  assert.ok(existsSync(join(root, ".kit/.git")), "a checkout, never a copy");
  assert.equal(readlinkSync(join(root, "node_modules/@saasreport")), "../.kit/node_modules/@saasreport");
  assert.equal(readlinkSync(join(root, "node_modules/.bin/kit")), "../../.kit/packages/cli/bin/kit.js");
  assert.ok(existsSync(join(root, ".kit/node_modules/.kit-source-record.json")), "the record lives inside the checkout's node_modules, so the checkout stays clean");
  // the kit moves: a verify refuses (what is there is not the head), an ensure moves to it
  writeFileSync(join(KIT, "packages/cli/bin/kit.js"), "#!/usr/bin/env node\nconsole.log('tiny kit 2', process.argv.slice(2).join(' '));\n");
  git(KIT, "commit", "-qam", "kit 2");
  const HEAD2 = git(KIT, "rev-parse", "HEAD");
  publish(HEAD2);
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /is at .{12} and the kit's published head is .{12}/.test(e.message));
  const r2 = await ensure(root, cfg, noNpm);
  assert.equal(r2.sha, HEAD2);
  // the head moved but is not published yet: refused, with the reason named (the kit's CI has not published it)
  writeFileSync(join(KIT, "LICENSE"), "L\n"); git(KIT, "add", "-A"); git(KIT, "commit", "-qm", "kit 3");
  await assert.rejects(ensure(root, cfg, noNpm), (e) => e instanceof SourceError && /has not published this head yet/.test(e.message));
  publish(git(KIT, "rev-parse", "HEAD"));
  await ensure(root, cfg, noNpm);
  // a local edit in the checkout: refused, the kit at its head carries none
  writeFileSync(join(root, ".kit/LICENSE"), "edited\n");
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /has changes of its own/.test(e.message));
  await ensure(root, cfg, noNpm);   // ensure resets it
  assert.equal(readFileSync(join(root, ".kit/LICENSE"), "utf8"), "L\n");
  // the published head cannot be read: refused, never a pass
  writeFileSync(HEAD_FILE, "{ not json");
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /not JSON/.test(e.message));
  publish(git(KIT, "rev-parse", "HEAD"));
});

test("a snapshot's leftovers are refused: a real node_modules/@saasreport directory, a vendor/kit snapshot beside the source, a file: dependency; and the bootstrap is held to the template", async () => {
  const root = site("b");
  const cfg = sourceConfig(JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")));
  mkdirSync(join(root, "node_modules/@saasreport/core"), { recursive: true });
  fetchHead(root, cfg);
  assert.throws(() => link(root, cfg), (e) => e instanceof SourceError && /a real directory, a leftover of the snapshot/.test(e.message));
  const problems = siteProblems(root, { mode: "source", path: ".kit", transport: "git", repository: REPO });
  assert.ok(problems.some((p) => p.file === BOOTSTRAP && /missing/.test(p.problem)));
  assert.ok(problems.some((p) => p.file === ".gitignore" && /does not ignore \.kit/.test(p.problem)));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "s", private: true, dependencies: { "@saasreport/core": "file:vendor/kit/packages/core" } }));
  mkdirSync(join(root, "vendor/kit"), { recursive: true });
  const p2 = siteProblems(root, { mode: "source", path: ".kit", transport: "git", repository: REPO });
  assert.ok(p2.some((p) => p.file === "package.json" && /dependencies\.@saasreport\/core/.test(p.problem)));
  assert.ok(p2.some((p) => p.file === "vendor/kit" && /still here beside the source/.test(p.problem)));
  // init writes the bootstrap and the ignore rule and names what the commit must still do
  const r = initSource(root, { repository: REPO, transport: "git" });
  assert.deepEqual(r.written, ["scripts/kit.mjs", ".gitignore"]);
  assert.ok(r.next.some((n) => /remove the kit's packages from package.json/.test(n)));
  assert.equal(readFileSync(join(root, BOOTSTRAP), "utf8"), bootstrapText());
  writeFileSync(join(root, BOOTSTRAP), bootstrapText() + "\n// edited\n");
  assert.ok(siteProblems(root, { mode: "source", path: ".kit", transport: "git", repository: REPO }).some((p) => p.file === BOOTSTRAP && /differs from the kit's/.test(p.problem)));
});

test("kit check canon › vendor in source mode is the t=0 gate: at the head and in order it passes; behind the head it fails; snapshot mode is the finding kit-source-t0", async () => {
  const root = site("c");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.kit/\n");
  const cfg = sourceConfig(JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")));
  initSource(root, { repository: REPO, transport: "git" });
  await ensure(root, cfg, noNpm);
  const ok = await runCanon(root, { only: ["vendor"] });
  assert.equal(ok.results.vendor.ok, true, JSON.stringify(ok.results.vendor.problems));
  assert.match(ok.results.vendor.summary, /the kit at its head .{12} \(source mode, t=0/);
  writeFileSync(join(KIT, "NOTICE"), "N\n"); git(KIT, "add", "-A"); git(KIT, "commit", "-qm", "kit 4"); publish(git(KIT, "rev-parse", "HEAD"));
  const behind = await runCanon(root, { only: ["vendor"] });
  assert.equal(behind.results.vendor.ok, false);
  assert.match(behind.results.vendor.problems[0].problem, /the kit's published head is/);
  // the CLI: kit source check refuses, kit source sync moves to the head, kit source record prints it
  const err = [];
  assert.notEqual(await main(["source", "check"], { cwd: root, out: () => {}, err: (l) => err.push(l) }), 0);
  assert.match(err.join("\n"), /refused/);
  const out = [];
  assert.equal(await main(["source", "sync"], { cwd: root, out: (l) => out.push(l), err: () => {} }), 0);
  assert.match(out.join("\n"), /kit at head .{12}/);
  const rec = [];
  assert.equal(await main(["source", "record"], { cwd: root, out: (l) => rec.push(l), err: () => {} }), 0);
  assert.equal(JSON.parse(rec.join("\n")).schema, "kit.kit-source.v1");
  // the finding class: a snapshot is post-facto
  const snap = site("d", { mode: "snapshot" });
  const f = await runCanon(snap, { only: ["findings"] });
  assert.ok(f.results.findings.problems.some((p) => /kit-source-t0/.test(p.problem)), JSON.stringify(f.results.findings.problems).slice(0, 400));
});

test("the bootstrap as a script: no dependencies, refuses outside source mode, runs the kit command after the ensure", () => {
  const root = site("e");
  initSource(root, { repository: REPO, transport: "git" });
  const r = spawnSync(process.execPath, [join(root, BOOTSTRAP), "check", "canon"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tiny kit.*check canon/, "the kit CLI ran from the checkout with the arguments given");
  // stdout is the kit command's alone: npm's install summary ("up to date", "added N packages") and the bootstrap's own progress go to stderr, so a caller
  // parsing `kit release workers --json` through the bootstrap reads JSON (a fresh checkout installs on this first use)
  assert.ok(r.stdout.trim().split("\n").every((l) => /tiny kit/.test(l)), `stdout carries only the kit's lines:\n${r.stdout}`);
  assert.match(r.stderr, /kit: (cloning|installing)/, "the bootstrap's progress is on stderr");
  const snap = site("f", { mode: "snapshot" });
  initSource(snap, { repository: REPO, transport: "git" }); // writes the bootstrap, and turns the canon to source mode
  writeFileSync(join(snap, "kit.canon.json"), JSON.stringify({ project: "saasreport", vendor: { path: "vendor/kit" } }));
  const bad = spawnSync(process.execPath, [join(snap, BOOTSTRAP)], { cwd: snap, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /vendor\.mode is not "source"/);
  const text = bootstrapText();
  for (const m of text.matchAll(/from "([^"]+)"/g)) assert.ok(m[1].startsWith("node:"), m[1]);
});

test("MUST FAIL: the archive transport, no credential: ensure fetches the published archive, verifies its size and sha256, unpacks it; a moved head is refused until fetched; a local edit, a wrong archive, a head with no archive and a registry naming another head are refused", async () => {
  // a kit whose registry names the head object the fixture site reads (verify cross-checks them)
  const shaA = git(KIT, "rev-parse", "HEAD");
  const docA = publish(shaA, { archive: true });
  const root = site("arc-a", { transport: "archive" });
  const cfg = sourceConfig(JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")));
  assert.deepEqual(cfg, { path: ".kit", repository: "https://github.com/SaasReport/kit", transport: "archive", head: pathToFileURL(HEAD_FILE).href });
  const buf = await readArchive(docA);
  assert.equal(buf.length, docA.archive.bytes);
  // the first ensure runs the real npm ci (Codex on #222: npm ci removes node_modules first, so the archive's records must live outside it)
  const r = await ensure(root, cfg);
  assert.equal(r.transport, "archive"); assert.equal(r.sha, shaA); assert.equal(r.published.sha, shaA);
  assert.equal(r.installed, true, "a real npm ci ran");
  assert.deepEqual(kit.validator.validate(r, kit.byName("kit-source")), []);
  assert.ok(!existsSync(join(root, ".kit/.git")), "an unpacked archive, not a checkout");
  assert.ok(existsSync(join(root, ".kit/packages/cli/bin/kit.js")), "the kit's files, prefix stripped");
  assert.ok(existsSync(join(root, ".kit/.kit-archive-manifest.json")) && existsSync(join(root, ".kit/.kit-archive.json")), "the archive's records live at the root of .kit, outside node_modules and outside the manifest");
  assert.equal((await verify(root, cfg)).sha, shaA, "verified right after the install: nothing the install removed was needed");
  assert.equal(readlinkSync(join(root, "node_modules/.bin/kit")), "../../.kit/packages/cli/bin/kit.js");
  // the same head again: nothing fetched (the archive file is removed to prove it)
  const file = join(TMP, docA.archive.key);
  const bytes = readFileSync(file); unlinkSync(file);
  assert.equal((await ensure(root, cfg, noNpm)).sha, shaA, "current: no fetch");
  writeFileSync(file, bytes);
  // the head moves: verify refuses, ensure moves to it
  writeFileSync(join(KIT, "README.md"), "moved\n"); git(KIT, "add", "-A"); git(KIT, "commit", "-qm", "kit moved");
  const shaB = git(KIT, "rev-parse", "HEAD");
  const docB = publish(shaB, { archive: true });
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /is at .{12} and the kit's published head is .{12}.*run node scripts\/kit\.mjs/.test(e.message));
  assert.equal((await ensure(root, cfg, noNpm)).sha, shaB);
  assert.equal(readFileSync(join(root, ".kit/README.md"), "utf8"), "moved\n");
  // a local edit: refused like a dirty checkout; ensure unpacks again
  writeFileSync(join(root, ".kit/README.md"), "edited\n");
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /has changes of its own \(README\.md\)/.test(e.message));
  writeFileSync(join(root, ".kit/stray.txt"), "x\n");
  assert.throws(() => archiveState(root, cfg), (e) => e instanceof SourceError && /has changes of its own \(README\.md, 1 more\)/.test(e.message));
  assert.equal((await ensure(root, cfg, noNpm)).sha, shaB);
  assert.ok(!existsSync(join(root, ".kit/stray.txt")));
  // the published archive is not the one the head names: refused (size, then sha256)
  const fileB = join(TMP, docB.archive.key);
  const good = readFileSync(fileB);
  writeFileSync(fileB, Buffer.concat([good, Buffer.from("x")]));
  await assert.rejects(readArchive(docB), (e) => e instanceof SourceError && /bytes; the head object says/.test(e.message));
  const tampered = Buffer.from(good); tampered[tampered.length - 1] ^= 0xff;
  writeFileSync(fileB, tampered);
  await assert.rejects(readArchive(docB), (e) => e instanceof SourceError && /has sha256 .* not the published archive/.test(e.message));
  writeFileSync(fileB, good);
  // a head object with no archive: a site that has the head unpacked needs nothing and passes; one that must fetch is refused by name
  publish(shaB);
  assert.equal((await ensure(root, cfg, noNpm)).sha, shaB, "already at the head: no fetch, no archive needed");
  const fresh = site("arc-c", { transport: "archive" });
  await assert.rejects(ensure(fresh, sourceConfig(JSON.parse(readFileSync(join(fresh, "kit.canon.json"), "utf8"))), noNpm), (e) => e instanceof SourceError && /names no archive of/.test(e.message));
  publish(shaB, { archive: true });
  // the unpacked kit's registry names another head URL than the one read: refused
  const reg = join(root, ".kit/packages/core/registry/kit-head.json");
  const regText = readFileSync(reg, "utf8");
  writeFileSync(reg, JSON.stringify({ ...JSON.parse(regText), url: "https://elsewhere.example/kit-main.json" }));
  await assert.rejects(verify(root, cfg), (e) => e instanceof SourceError && /has changes of its own/.test(e.message), "the edit itself is refused first");
  writeFileSync(reg, regText);
  // a git checkout where the archive should be: refused
  const g = site("arc-b", { transport: "archive" });
  mkdirSync(join(g, ".kit/.git"), { recursive: true });
  await assert.rejects(ensure(g, sourceConfig(JSON.parse(readFileSync(join(g, "kit.canon.json"), "utf8"))), noNpm), (e) => e instanceof SourceError && /is a git checkout, but vendor\.transport is "archive"/.test(e.message));
  // the bootstrap's default head URL is the registry's (one source)
  assert.equal(DEFAULT_HEAD_URL, kitHead().url);
  assert.throws(() => sourceConfig({ vendor: { mode: "source", transport: "ftp" } }), /neither "archive".*nor "git"/);
});

test("no CI template checks the kit out or names a key: the bootstrap fetches the published archive with no credential, and every kit step runs through it, never through a snapshot path", () => {
  const dir = new URL("../../../templates/ci/", import.meta.url);
  for (const name of ["test.yml", "staleness.yml", "drift.yml", "production.yml", "independent-review.yml", "scheduled-hold.yml"]) {
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /vendor\/kit\/packages/, `${name} names the snapshot path`);
    assert.doesNotMatch(text, /KIT_SOURCE_KEY/, `${name} names a key for the kit: it needs none`);
    const wf = parseYaml(text);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      if (!job.steps) continue;
      assert.ok(!job.steps.some((s) => s.with?.repository === "SaasReport/kit"), `${name} ${jobName}: checks the kit out; the bootstrap brings it`);
      const first = job.steps.findIndex((s) => /scripts\/kit\.mjs|npm test/.test(s.run ?? ""));
      if (first < 0) continue;
      const site = job.steps.findIndex((s) => /actions\/checkout/.test(s.uses ?? "") && !s.with?.repository);
      assert.ok(site >= 0 && site < first, `${name} ${jobName}: the site is checked out before the kit is used`);
    }
  }
  const watch = readFileSync(new URL("../../../templates/resilience/watch.yml", import.meta.url), "utf8");
  assert.doesNotMatch(watch, /KIT_SOURCE_KEY|repository: SaasReport\/kit/);
});

test("one repository, whatever the transport (Codex on #219): the SSH origin actions/checkout writes with an ssh-key equals the https form the canon names; another repository does not", () => {
  const forms = ["git@github.com:SaasReport/kit.git", "git@github.com:SaasReport/kit", "ssh://git@github.com/SaasReport/kit.git", "https://github.com/SaasReport/kit", "https://github.com/SaasReport/kit.git", "https://x-access-token:t@github.com/SaasReport/kit.git", "HTTPS://GitHub.com/SaasReport/kit/"];
  for (const f of forms) assert.equal(repoIdentity(f), "github.com/SaasReport/kit", f);
  assert.notEqual(repoIdentity("git@github.com:SaasReport/kit-fork.git"), repoIdentity("https://github.com/SaasReport/kit"));
  assert.notEqual(repoIdentity("git@gitlab.com:SaasReport/kit.git"), repoIdentity("https://github.com/SaasReport/kit"));
  assert.equal(repoIdentity("file:///tmp/x/kit"), repoIdentity("/tmp/x/kit"));
  // the checkout in CI: cloned by the SSH form, named by the https form: verified, not refused
  const root = site("g");
  const cfg = sourceConfig(JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")));
  fetchHead(root, cfg);
  git(join(root, ".kit"), "remote", "set-url", "origin", "git@example.invalid:" + REPO.replace("file://", "").slice(1) + ".git");
  assert.throws(() => fetchHead(root, cfg), (e) => e instanceof SourceError && /is a checkout of git@example\.invalid/.test(e.message), "another host is another repository");
  git(join(root, ".kit"), "remote", "set-url", "origin", REPO.replace(/\/$/, "") + "/");
  assert.doesNotThrow(() => fetchHead(root, cfg), "a trailing slash is the same repository");
});

test("the source checkout is the kit, not the site (Codex on #219): the repository walk and the production-command scan leave .kit out, and a source path other than .kit is refused", () => {
  const root = site("h");
  mkdirSync(join(root, ".kit/examples/x"), { recursive: true });
  writeFileSync(join(root, ".kit/examples/x/package.json"), JSON.stringify({ scripts: { deploy: "wrangler deploy" } }));
  mkdirSync(join(root, "vendor/kit"), { recursive: true });
  writeFileSync(join(root, "vendor/kit/package.json"), JSON.stringify({ scripts: { deploy: "wrangler deploy" } }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "s", private: true, scripts: { test: "node scripts/kit.mjs check canon" } }));
  assert.deepEqual(productionCommands(root, ".github/workflows/production.yml"), []);
  assert.ok(walk(root).every((f) => !f.startsWith(".kit/") && !f.startsWith("vendor/")), "the walk skips both");
  assert.ok(siteProblems(root, { mode: "source", path: "tools/kit", repository: REPO }).some((p) => /in source mode the checkout lives at \.kit/.test(p.problem)));
});

test("the source checkout is the kit, not the site (Codex on #219, the deployment scan): a wrangler config and a deploy command planted under .kit (the kit's own finding fixtures) deploy nothing of this repository", () => {
  const root = site("i");
  mkdirSync(join(root, ".kit/findings/x/must-fail/case"), { recursive: true });
  writeFileSync(join(root, ".kit/findings/x/must-fail/case/wrangler.toml"), 'name = "planted"\ncompatibility_date = "2026-01-01"\n');
  writeFileSync(join(root, ".kit/findings/x/must-fail/case/package.json"), JSON.stringify({ scripts: { deploy: "wrangler deploy" } }));
  const s = scanDeployments(root);
  assert.deepEqual([s.all, s.deployed, s.commands, s.problems], [[], [], [], []], JSON.stringify(s));
});
