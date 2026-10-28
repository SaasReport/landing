// kit check staleness (docs/FRESHNESS.md): five declared classes of staleness, a must-fail test for each, and a fresh fixture that passes.
// No network: the git remote is a bare repository in a temp directory, and every other outside read (the kit's head, the Workers'
// /api/build, the toolchain versions) is injected through `deps`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stalenessReport, stalenessLocal, stalenessAlert, defaultDeps, CLASSES } from "../src/staleness.js";
import { bundled } from "../src/canon/index.js";
import { gitEnv } from "../src/git.js";
import { main } from "../src/index.js";
import { TEST } from "../src/test-seam.js";
import { stripKitCheckout } from "../src/source.js";
import { alertVariables } from "@saasreport/channels";
import { tempDir } from "../../core/test/support/temp.mjs";

const kit = bundled();
const repoFile = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-13T12:00:00Z");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", env: gitEnv() }).trim();
const GOOD = { node: "22.22.2", npm: "10.9.7", git: "2.55.0", docker: "29.8.0" };   // the pins of registry/toolchain.json
const sha = (c) => c.repeat(40);
const write = (root, f, body) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : JSON.stringify(body)); };

/** A work tree whose origin is a bare repository beside it, both at one commit on main. */
function fixture(t) {
  const base = tempDir(t, "kit-fresh-");
  const bare = join(base, "origin.git"), root = join(base, "work");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  git(base, "clone", "-q", bare, root);
  git(root, "checkout", "-q", "-b", "main");
  write(root, "README.md", "x\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "one"); git(root, "push", "-q", "origin", "main");
  return { base, bare, root };
}
const run = (root, extra = {}) => stalenessReport(root, { now: NOW, kit, deps: { versions: () => GOOD, where: () => "codespace", fetch: async () => { throw new Error("no network in the suite"); }, ...extra } });
const classes = (r) => r.findings.map((f) => f.class);

test("a fresh fixture is fresh: every applicable class checked, no finding, the head named", async (t) => {
  const { root } = fixture(t);
  const r = await run(root);
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.derived_from.main_head, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(r.checked, ["branch-behind-main", "registry-fact-stale", "toolchain-drift"]);
  assert.equal(r.mode, "repo");
  assert.deepEqual(r.not_applicable.map((n) => n.class).sort(), ["deploy-behind-main", "podcast-behind-schedule", "scratch-aged", "vendor-behind-head"]);
  assert.equal(kit.validator.validate(r, kit.byName("staleness-report")).length, 0);
});

test("branch-behind-main: a branch that has not fetched, one that fetched and lags, and a detached worktree are findings; main itself is not", async (t) => {
  const { base, bare, root } = fixture(t);
  const first = git(root, "rev-parse", "HEAD");
  git(root, "branch", "lagging");
  git(root, "worktree", "add", "-q", "--detach", join(base, "wt"), first);
  // main moves on at the remote, from another clone
  const other = join(base, "other");
  git(base, "clone", "-q", bare, other);
  write(other, "b.txt", "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "two"); git(other, "push", "-q", "origin", "main");
  const head = git(other, "rev-parse", "HEAD");
  // the live head is asked of the remote, so a clone that never fetched is behind even though its own origin/main is "current"
  let r = await run(root);
  assert.equal(r.derived_from.main_head, head);
  assert.deepEqual(r.findings.map((f) => f.subject.split(" ")[0]).sort(), ["(detached)", "lagging", "main"]);
  assert.ok(classes(r).every((c) => c === "branch-behind-main"));
  assert.ok(r.findings.every((f) => f.expected === head));
  // after fetch and a fast-forward of main only the lagging branch and the worktree remain
  git(root, "pull", "-q", "--ff-only", "origin", "main");
  r = await run(root);
  assert.deepEqual(r.findings.map((f) => f.subject.split(" ")[0]).sort(), ["(detached)", "lagging"]);
  // rebasing them onto main clears the class
  git(root, "branch", "-f", "lagging", "main");
  git(join(base, "wt"), "checkout", "-q", "--detach", "main");
  assert.deepEqual((await run(root)).findings, []);
});

test("branch-behind-main: an unreadable remote is a finding, never a pass", async (t) => {
  const { root } = fixture(t);
  git(root, "remote", "set-url", "origin", join(root, "no-such-remote.git"));
  const r = await run(root);
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].class, "branch-behind-main");
  assert.equal(r.findings[0].unreadable, true);
  assert.equal(r.derived_from.main_head, null);
});

test("branch-behind-main: injected remote and branches (the shape every other test relies on)", async (t) => {
  const { root } = fixture(t);
  const r = await run(root, { lsRemote: async () => sha("a"), branches: () => [{ name: "x", sha: sha("b") }, { name: "y", sha: sha("c") }], contains: (_r, _h, s) => s === sha("c") });
  assert.deepEqual(r.findings.map((f) => f.subject), ["x"]);
});

function vendored(root, commit, date = "2026-10-01T00:00:00Z") {
  write(root, "kit.canon.json", { project: "saasreport", vendor: { path: "vendor/kit", include: ["packages"] } });
  write(root, "vendor/kit.manifest.json", { source: { repository: "https://github.com/SaasReport/kit", ref: "main", commit, commit_date: date }, files: [] });
}

test("vendor-behind-head: a vendored kit that is not the kit's head is a finding with its age and lag; the head itself passes", async (t) => {
  const { root } = fixture(t);
  vendored(root, sha("1"));
  const head = { sha: sha("3"), recent: [sha("3"), sha("2"), sha("1")] };
  let r = await run(root, { kitHead: async () => head });
  assert.deepEqual(classes(r), ["vendor-behind-head"]);
  assert.equal(r.findings[0].age_days, 12);
  assert.match(r.findings[0].problem, /2 commits behind/);
  r = await run(root, { kitHead: async () => ({ sha: sha("1") }) });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.checked.includes("vendor-behind-head"), true);
  r = await run(root, { kitHead: async () => { throw new Error("offline"); } });
  assert.equal(r.findings[0].unreadable, true);
});

test("registry-fact-stale: a verified day older than its max age, none declared, in the future or not a date is a finding; a fresh one and a per-fact max pass", async (t) => {
  const { root } = fixture(t);
  write(root, "registry/orgs.json", { max_age_days: 30, orgs: [{ org: "a", verified: "2026-10-13" }, { org: "b", verified: "2026-09-13" }, { org: "c", verified: "2026-09-12" }, { org: "d", verified: "2026-06-01", max_age_days: 200 }] });
  write(root, "registry/none.json", { providers: [{ name: "p", verified: "2026-10-01" }] });
  write(root, "registry/future.json", { max_age_days: 30, x: { verified: "2026-10-14" } });
  write(root, "registry/bad.json", { max_age_days: 30, x: { verified: "2026-13-45" } });
  // must fail (Codex on #148): a value under a verification-day name that is not even date-shaped is a claim too, never skipped as fresh
  write(root, "registry/shape.json", { max_age_days: 30, a: { verified: "unknown" }, b: { checked: "2026/10/01" } });
  const r = await run(root);
  const by = Object.fromEntries(r.findings.map((f) => [f.subject, f]));
  assert.deepEqual(Object.keys(by).sort(), ["registry/bad.json#/x/verified", "registry/future.json#/x/verified", "registry/none.json#/providers/0/verified", "registry/orgs.json#/orgs/2/verified", "registry/shape.json#/a/verified", "registry/shape.json#/b/checked"]);
  assert.match(by["registry/shape.json#/a/verified"].problem, /not a valid date/);
  assert.match(by["registry/shape.json#/b/checked"].problem, /not a valid date/);
  assert.equal(by["registry/orgs.json#/orgs/2/verified"].age_days, 31);
  assert.match(by["registry/none.json#/providers/0/verified"].problem, /no max_age_days is declared/);
  assert.match(by["registry/future.json#/x/verified"].problem, /after today/);
  assert.match(by["registry/bad.json#/x/verified"].problem, /not a valid date/);
  assert.ok(r.findings.every((f) => f.class === "registry-fact-stale"));
});

test("toolchain-drift: any version but the exact pin, and a required tool that cannot run, are findings; a tool not required where this runs is not judged", async (t) => {
  const { root } = fixture(t);
  assert.deepEqual((await run(root)).findings, []);
  let r = await run(root, { versions: () => ({ ...GOOD, node: "22.22.1" }) });
  assert.deepEqual(r.findings.map((f) => [f.class, f.subject, f.observed, f.expected]), [["toolchain-drift", "node", "22.22.1", "22.22.2"]]);
  r = await run(root, { versions: () => ({ ...GOOD, git: "2.54.0", docker: "28.0.0" }) });
  assert.deepEqual(r.findings.map((f) => f.subject), ["git", "docker"]);
  r = await run(root, { versions: () => ({ ...GOOD, npm: null }) });
  assert.equal(r.findings[0].unreadable, true);
  assert.equal(r.findings[0].subject, "npm");
  // on a runner git and docker are not pinned (a runner image carries its own): only node and npm are judged
  r = await run(root, { where: () => "ci", versions: () => ({ ...GOOD, git: "2.40.0", docker: null }) });
  assert.deepEqual(r.findings, []);
  r = await run(root, { where: () => "ci", versions: () => ({ ...GOOD, node: "20.0.0" }) });
  assert.deepEqual(r.findings.map((f) => f.subject), ["node"]);
  // a laptop is not a codespace: node and npm only, never git or docker
  r = await run(root, { where: () => "machine", versions: () => ({ ...GOOD, git: "2.43.0", docker: null }) });
  assert.deepEqual(r.findings, []);
  r = await run(root, { where: () => "machine", versions: () => ({ ...GOOD, npm: "9.0.0" }) });
  assert.deepEqual(r.findings.map((f) => f.subject), ["npm"]);
});

test("where(): the markers toolchain.json names decide ci, codespace or machine; nothing else is a codespace", () => {
  const host = JSON.parse(readFileSync(new URL("../../core/registry/toolchain.json", import.meta.url), "utf8")).host;
  const where = defaultDeps().where;
  assert.equal(where(host, { [host.ci_env]: "true" }), "ci");
  assert.equal(where(host, { [host.codespace_env]: "true" }), "codespace");
  assert.equal(where(host, { [host.ci_env]: "true", [host.codespace_env]: "true" }), "ci");
  assert.equal(where(host, {}), "machine");
  assert.equal(where(host, { [host.codespace_env]: "false", [host.ci_env]: "1" }), "machine");
});

// a schema-valid release.json (kit.release.v1) over real wrangler configs: the Workers have NO `name` in release.json, the release reader derives it from the config
const WRANGLER = (name, main = "src/index.js") => `name = "${name}"\nmain = "${main}"\ncompatibility_date = "2026-09-01"\n`;
function releaseSite(root, extra = {}) {
  write(root, "wrangler.toml", WRANGLER("site-web", "src/worker.js"));
  write(root, "workers/mail/wrangler.toml", WRANGLER("site-mail"));
  write(root, "workers/monitor/wrangler.toml", WRANGLER("site-monitor"));
  write(root, "release.json", {
    $schema: "x", project: "saasreport", state: "ready", workers_dev: "acct",
    build: { run: "npm run build", artifact: ["site"] },
    owner: { secret: "OPS_NOTIFY_TO", targets: [{ wrangler: "wrangler.toml", name: "OPS_NOTIFY_TO" }] },
    databases: [],
    paths: ["workers", "src", "content", "site"],   // a built project declares what its build reads
    workers: [
      { wrangler: "workers/mail/wrangler.toml", behind: { worker: "wrangler.toml", role: "delivery" } },
      { wrangler: "workers/monitor/wrangler.toml", workers_dev: true },
      { wrangler: "wrangler.toml", build: "https://site.example/api/build" },
    ],
    ...extra,
  });
}
// releaseSite, then the root Worker's [assets] directory (releaseSite rewrites the root wrangler.toml)
function releaseSite2(root, paths) {
  releaseSite(root, { paths });
  write(root, "wrangler.toml", `${WRANGLER("site-web", "src/worker.js")}[assets]\ndirectory = "dist/public"\n`);
}
const SITE_URL = "https://site.example/api/build", MON_URL = "https://site-monitor.acct.workers.dev/api/build";
const answering = (table) => ({ fetch: async (url) => { const a = table[url]; if (a instanceof Error) throw a; if (a === undefined) return { ok: false, status: 404, json: async () => ({}) }; return { ok: a.status === undefined, status: a.status ?? 200, json: async () => a }; } });
const current = (head) => ({ [SITE_URL]: { commit: head, services: { delivery: { commit: head } } }, [MON_URL]: { commit: head } });

test("deploy-behind-main: Workers come from release/'s one reader: a workers_dev monitor with no name in release.json is judged, a schema-valid file is required", async (t) => {
  const { root } = fixture(t);
  const head = git(root, "rev-parse", "HEAD");
  releaseSite(root);
  let r = await run(root, answering(current(head)));
  assert.deepEqual(r.findings, []);
  assert.ok(r.checked.includes("deploy-behind-main"));
  // the monitor (workers_dev, named only by its wrangler config) is stale: it must be found, never skipped
  r = await run(root, answering({ ...current(head), [MON_URL]: { commit: sha("8") } }));
  assert.deepEqual(r.findings.map((f) => [f.class, f.subject, f.observed]), [["deploy-behind-main", "site-monitor", sha("8")]]);
  // no commit (a shell deploy), an error answer, a thrown fetch and an answer with no commit are findings
  r = await run(root, answering({ ...current(head), [MON_URL]: { commit: null } }));
  assert.match(r.findings[0].problem, /no commit/);
  r = await run(root, answering({ ...current(head), [SITE_URL]: { status: 404 } }));
  assert.ok(r.findings.some((f) => f.unreadable && /site-web/.test(f.subject)));
  r = await run(root, answering({ ...current(head), [MON_URL]: new Error("dns") }));
  assert.equal(r.findings[0].unreadable, true);
  // a release.json that is not kit.release.v1 (the old hand-shaped one) cannot be judged: unreadable, never "no Workers"
  write(root, "release.json", { workers_dev: "acct", workers: [{ wrangler: "a.toml", build: SITE_URL }] });
  r = await run(root, answering(current(head)));
  assert.deepEqual(r.findings.map((f) => [f.class, f.unreadable]), [["deploy-behind-main", true]]);
  assert.match(r.findings[0].problem, /kit\.release\.v1/);
});

test("deploy-behind-main: a Worker declared `behind` is judged through its front Worker's services[role].commit", async (t) => {
  const { root } = fixture(t);
  const head = git(root, "rev-parse", "HEAD");
  releaseSite(root);
  const r = await run(root, answering({ ...current(head), [SITE_URL]: { commit: head, services: { delivery: { commit: sha("7") } } } }));
  assert.deepEqual(r.findings.map((f) => [f.class, f.subject, f.observed]), [["deploy-behind-main", "site-mail", sha("7")]], "an outdated behind service is found");
  const none = await run(root, answering({ ...current(head), [SITE_URL]: { commit: head, services: {} } }));
  assert.ok(none.findings.some((f) => f.unreadable && /site-mail/.test(f.problem)), "a front Worker that does not report the service is unreadable, never current");
  const gone = await run(root, answering({ ...current(head), [SITE_URL]: { commit: head, services: { delivery: { commit: "unreachable" } } } }));
  assert.ok(gone.findings.some((f) => f.unreadable && /site-mail/.test(f.problem)));
});

test("deploy-behind-main: the deployable paths are derived from the Workers' configs (workers/** included) and migrations; release.json paths are added to them; docs-only merges are not drift", async (t) => {
  const { root } = fixture(t);
  const pushFile = (f, body) => { write(root, f, body); git(root, "add", "-A"); git(root, "commit", "-qm", f); git(root, "push", "-q", "origin", "main"); return git(root, "rev-parse", "HEAD"); };
  releaseSite(root);
  const before = pushFile("release.json.keep", "x\n");
  const workerOnly = pushFile("workers/mail/src/helper.js", "export const h = 1;\n");
  const docs = pushFile("docs/x.md", "x\n");
  const only = (commit) => answering({ [SITE_URL]: { commit, services: { delivery: { commit } } }, [MON_URL]: { commit } });
  const workersOf = (r) => r.findings.filter((f) => f.subject !== "release.json");
  releaseSite(root, { paths: ["workers", "src"] });   // Worker code deploys, docs do not
  assert.deepEqual(workersOf(await run(root, only(docs))), [], "main's head");
  assert.deepEqual(workersOf(await run(root, only(workerOnly))), [], "the last commit touching Worker code, with a docs-only merge after it");
  const r = await run(root, only(before));
  assert.ok(workersOf(r).length === 3 && workersOf(r).every((f) => f.expected === workerOnly), "a commit touching only workers/** is the deploy base: every Worker before it is behind");
  assert.match(workersOf(r)[0].problem, /before the last commit on main that touched a deployable path/);
  // release.json paths ADD to the derived set: docs/ deploys there as well, and Worker code still does
  releaseSite(root, { paths: ["docs"] });
  assert.equal((await run(root, only(workerOnly))).findings.length, 3, "docs/ is declared and a later commit touched it: a Worker at the Worker-code commit is behind");
  assert.deepEqual((await run(root, only(docs))).findings, []);
  // the derived set itself, from the one reader
  const { deployablePaths } = await import("../src/staleness.js");
  const { loadRelease, releaseWorkers } = await import("../src/release/config.js");
  releaseSite(root);
  const paths = deployablePaths(releaseWorkers(root, loadRelease(root, kit).doc), ["release.json"]);
  for (const p of ["workers/mail", "workers/mail/src", "workers/monitor", "src", "release.json"]) assert.ok(paths.includes(p), `${p} is deployable`);
});

test("deploy-behind-main: a built project must declare `paths` (kit release check fails without); declared and derived paths are a union, the assets directory is in it even when `paths` omits it", async (t) => {
  const { root } = fixture(t);
  const pushFile = (f, body) => { write(root, f, body); git(root, "add", "-A"); git(root, "commit", "-qm", f); git(root, "push", "-q", "origin", "main"); return git(root, "rev-parse", "HEAD"); };
  const only = (commit) => answering({ [SITE_URL]: { commit, services: { delivery: { commit } } }, [MON_URL]: { commit } });
  const { deployablePaths } = await import("../src/staleness.js");
  const { loadRelease, releaseWorkers } = await import("../src/release/config.js");
  // must-fail: a release.json with a build and no `paths` is refused by the release reader (so `kit release check`), and the staleness check cannot read it
  releaseSite(root, { paths: undefined });
  const missing = loadRelease(root, kit);
  assert.equal(missing.doc, null);
  assert.ok(missing.problems.some((x) => /paths/.test(x.problem)), "the schema names the missing `paths`");
  const base = pushFile("README2.md", "x\n");
  assert.ok((await run(root, only(base))).findings.some((f) => f.unreadable && f.subject === "release.json"));
  // the built-assets directory is read from the wrangler config
  releaseSite2(root, ["content"]);   // `paths` omits dist/public on purpose
  assert.ok(deployablePaths(releaseWorkers(root, loadRelease(root, kit).doc), []).includes("dist/public"), "the [assets] directory is derived");
  const before = pushFile("docs/z.md", "z\n");
  // must-pass: a change to the assets directory makes a Worker behind, though `paths` omits it
  const assets = pushFile("dist/public/app.js", "built\n");
  let r = await run(root, only(before));
  assert.ok(r.findings.length === 3 && r.findings.every((f) => f.expected === assets), "assets changed after the Worker's commit: behind");
  assert.deepEqual((await run(root, only(assets))).findings, []);
  // the declared path is added to the derived set: content/ deploys
  const content = pushFile("content/post.md", "p\n");
  r = await run(root, only(assets));
  assert.ok(r.findings.length === 3 && r.findings.every((f) => f.expected === content), "a declared path deploys");
  // must stay fresh: a docs-only commit after the deploy
  const docs = pushFile("docs/y.md", "y\n");
  assert.deepEqual((await run(root, only(content))).findings, [], "a docs-only commit stays fresh");
});

test("the alert env block is generated from the route registry: every runner route's secrets, a Bale-only site included; a template without one fails", async () => {
  const { envProblems, envBody, FILES } = await import("../scripts/staleness-env.mjs");
  const { routeSecrets, RUNNER_ROUTES } = await import("../src/staleness.js");
  const names = routeSecrets().map((s) => s.name);
  for (const n of ["MONITOR_BALE_CHAT_ID", "BALE_BOT_TOKEN", "MONITOR_TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN", "MONITOR_WEBHOOK_URL"]) assert.ok(names.includes(n), n);
  assert.deepEqual([...new Set(routeSecrets().map((s) => s.route))].sort(), [...RUNNER_ROUTES].sort());
  for (const f of FILES) {
    const text = repoFile(f);
    assert.deepEqual(envProblems(text), [], f);
    for (const n of names) assert.match(text, new RegExp(`${n}: \\$\\{\\{ secrets\\.${n} \\}\\}`), `${f} passes ${n}`);
  }
  // must-fail: a route's secrets absent from the block, a hand-added line, and a workflow with a hand list and no block
  const text = repoFile(FILES[1]);
  assert.ok(envProblems(text.replace(/\s+BALE_BOT_TOKEN: .*\n/, "\n")).length > 0, "a route whose secrets are absent");
  assert.ok(envProblems(text.replace("# /generated:alert-env", "          EXTRA: x\n          # /generated:alert-env")).length > 0, "a hand-added secret");
  assert.ok(envProblems(text.replace(/ *# generated:alert-env[^\n]*\n[\s\S]*# \/generated:alert-env\n/, "          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}\n"))[0].includes("block is missing"), "a hand list with no block");
  assert.equal(envBody("  ").split("\n").length - 1, names.length);
});

test("unreadable sources are findings, not passes: a missing vendor manifest, an unreadable main head, a Worker listing with no head to judge by", async (t) => {
  const { root } = fixture(t);
  write(root, "kit.canon.json", { project: "saasreport", vendor: { path: "vendor/kit", include: ["packages"] } });
  let r = await run(root);
  assert.deepEqual(r.findings.map((f) => [f.class, f.unreadable]), [["vendor-behind-head", true]]);
  assert.match(r.findings[0].problem, /manifest cannot be read/);
  write(root, "release.json", { workers: [{ wrangler: "a.toml", build: "https://site.example/api/build" }] });
  r = await run(root, { lsRemote: async () => { throw new Error("remote down"); }, branches: () => [] });
  assert.equal(r.derived_from.main_head, null);
  assert.deepEqual(r.findings.map((f) => [f.class, f.unreadable]).sort(), [["branch-behind-main", true], ["deploy-behind-main", true], ["vendor-behind-head", true]]);
});

test("a directory that is not a git work tree: the git classes are not applicable, the rest still run", async (t) => {
  const base = tempDir(t, "kit-fresh-nogit-");
  write(base, "registry/x.json", { max_age_days: 1, v: { verified: "2026-01-01" } });
  const r = await run(base);
  assert.ok(r.not_applicable.some((n) => n.class === "branch-behind-main" && /not a git work tree/.test(n.reason)));
  assert.equal(r.derived_from.main_head, null);
  assert.deepEqual(r.findings.map((f) => f.class), ["registry-fact-stale"]);
});

test("kit check freshness is the older canon check: it reads nothing outside the repository (no fetch, no remote)", async (t) => {
  const { root } = fixture(t);
  write(root, "kit.canon.json", { project: "saasreport", freshness: [] });
  let fetched = 0;
  const err = [], out = [];
  await main(["check", "freshness"], { cwd: root, out: (x) => out.push(x), err: (x) => err.push(x), env: {}, spawn: () => ({ status: 0 }), fetch: () => { fetched += 1; throw new Error("no network"); } });
  assert.equal(fetched, 0);
  assert.doesNotMatch(out.join("") + err.join(""), /staleness/);
});

test("the report is the declared contract, and the alert names every finding once per day", async (t) => {
  const { root } = fixture(t);
  write(root, "registry/x.json", { max_age_days: 1, v: { verified: "2026-01-01" } });
  const r = await run(root);
  assert.equal(r.schema, "kit.staleness-report.v1");
  assert.deepEqual(kit.byName("staleness-report").$defs.class.enum, CLASSES);
  const a = stalenessAlert(r, { repo: "o/r" });
  assert.match(a.subject, /o\/r: 1 staleness finding$/);
  assert.equal(a.idempotencyKey, "staleness:o/r:2026-10-13");
  assert.match(a.lines[0], /^registry-fact-stale: /);
});

test("kit check staleness --json prints the report and exits 1 on a finding; --alert sends it through a reachable route", async (t) => {
  const { root } = fixture(t);
  write(root, "registry/x.json", { max_age_days: 1, v: { verified: "2026-01-01" } });
  const out = [], err = [], posted = [];
  const io = { cwd: root, out: (s) => out.push(s), err: (s) => err.push(s), env: { GITHUB_REPOSITORY: "o/r", MONITOR_WEBHOOK_URL: "https://hook.example/x" },
    fetch: async (url, init) => { posted.push([url, JSON.parse(init.body)]); return new Response("ok", { status: 200 }); },
    [TEST]: { staleness: { now: NOW, deps: { versions: () => GOOD, where: () => "codespace" } } } };
  assert.equal(await main(["check", "staleness", "--json", "--alert"], io), 1);
  const report = JSON.parse(out.join(""));
  assert.deepEqual(kit.validator.validate(report, kit.byName("staleness-report")), [], "the --json output is the declared contract");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].class, "registry-fact-stale");
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], "https://hook.example/x");
  assert.match(posted[0][1].subject, /^o\/r: 1 staleness finding/);
  // no route configured: the finding still fails the run and says so
  err.length = 0; out.length = 0;
  assert.equal(await main(["check", "staleness", "--alert"], { ...io, env: {} }), 1);
  assert.match(err.join("\n"), /no route configured/);
  // --report alerts from a saved report and reads nothing else: no git, no tool, no network except the alert itself
  const saved = join(root, "saved.json"); writeFileSync(saved, JSON.stringify(report));
  posted.length = 0; out.length = 0;
  assert.equal(await main(["check", "staleness", "--alert", "--report", saved], { ...io, [TEST]: { staleness: { now: NOW, deps: { lsRemote: () => { throw new Error("read the world"); }, versions: () => { throw new Error("read the world"); } } } } }), 1);
  assert.equal(posted.length, 1);
  writeFileSync(saved, "{}");
  const errs = [];
  assert.equal(await main(["check", "staleness", "--report", saved], { ...io, err: (x) => errs.push(x) }), 1);
  assert.match(errs.join(""), /not kit\.staleness-report\.v1/);
});

test("a verifier that cannot read its report still alerts, through the same route, and fails", async (t) => {
  const { root } = fixture(t);
  const posted = [], err = [];
  const io = { cwd: root, out: () => {}, err: (x) => err.push(x), env: { GITHUB_REPOSITORY: "o/r", MONITOR_WEBHOOK_URL: "https://hook.example/x" },
    fetch: async (url, init) => { posted.push(JSON.parse(init.body)); return new Response("ok", { status: 200 }); }, [TEST]: { staleness: { now: NOW } } };
  const bad = join(root, "report.json");
  for (const body of ["", "{ not json", "{}"]) {
    writeFileSync(bad, body); posted.length = 0; err.length = 0;
    assert.equal(await main(["check", "staleness", "--alert", "--report", bad], io), 1, JSON.stringify(body));
    assert.equal(posted.length, 1, "one crash alert");
    assert.match(posted[0].subject, /^o\/r: the staleness verifier crashed$/);
    assert.match(err.join(""), /crash alert sent/);
  }
  // without --alert the error is the failure itself; with no route it still exits 1 and says the failed run is the alert
  err.length = 0;
  assert.equal(await main(["check", "staleness", "--alert", "--report", bad], { ...io, env: {} }), 1);
  assert.match(err.join(""), /crash alert: no route configured/);
  const none = await main(["check", "staleness", "--report", join(root, "missing.json")], { ...io, err: (x) => err.push(x) });
  assert.notEqual(none, 0);
});

test("the verification-day names are one list: staleness.json and the verified-without-max-age gate say the same", () => {
  const names = JSON.parse(readFileSync(new URL("../../core/registry/staleness.json", import.meta.url), "utf8")).verification_days;
  const classes = JSON.parse(readFileSync(new URL("../../core/registry/finding-classes.json", import.meta.url), "utf8")).classes;
  const gate = classes.find((c) => c.id === "verified-without-max-age").detect[0].schema.$defs.node.if.properties.properties.anyOf.map((x) => x.required[0]);
  assert.deepEqual(gate, names);
});

test("the constant-group secret allow-list is exactly the alert channels' secrets, and covers what the staleness workflows use", () => {
  const classes = JSON.parse(readFileSync(new URL("../../core/registry/finding-classes.json", import.meta.url), "utf8")).classes;
  const dep = classes.find((c) => c.id === "ci-run-concurrency").detect[0].schema.$defs.nosecret.anyOf[0].not.pattern;
  const allowed = dep.match(/\(\?:([^)]*)\)/)[1].split("|");
  const fromChannels = new Set(["telegram", "bale", "webhook"].flatMap((c) => [...alertVariables(c, {}).secrets, ...alertVariables(c, {}).optional]));
  // and nothing for the kit: the bootstrap fetches the published archive of the head with no credential (the kit at t=0, docs/FRESHNESS.md)
  assert.deepEqual([...allowed].sort(), [...fromChannels].sort(), "one list: the secrets the alert channels read");
  for (const f of [".github/workflows/staleness.yml", "templates/ci/staleness.yml"]) for (const m of repoFile(f).matchAll(/secrets\.([A-Z_]+)/g)) assert.ok(allowed.includes(m[1]), `${f} uses ${m[1]}`);
});

test("the default reads are real git and real tools (a smoke test, no network)", async (t) => {
  const { root } = fixture(t);
  const d = defaultDeps();
  assert.equal(await d.lsRemote(root, "origin", "main"), git(root, "rev-parse", "HEAD"));
  assert.deepEqual((await d.branches(root)).map((b) => b.name), ["main"]);
  const v = d.versions();
  for (const tool of ["node", "npm", "git"]) assert.match(v[tool], /^\d+\.\d+\.\d+$/);
  assert.ok(v.docker === null || /^\d+\.\d+\.\d+$/.test(v.docker));
});

const pin = JSON.parse(readFileSync(new URL("../../core/registry/toolchain.json", import.meta.url), "utf8")).tools;
const WORKFLOWS = [".github/workflows/test.yml", ".github/workflows/staleness.yml", ".github/workflows/rerun-unstarted.yml", "templates/ci/test.yml", "templates/ci/staleness.yml", "templates/resilience/watch.yml"];

test("toolchain.json is the one source: every workflow and template names exactly its node, and engines admits it", () => {
  for (const f of WORKFLOWS) {
    const found = [...repoFile(f).matchAll(/node-version:\s*([^\s#]+)/g)].map((m) => m[1]);
    assert.ok(found.length > 0, `${f} sets a node-version`);
    for (const v of found) assert.equal(v, pin.node.exact, `${f} node-version is the pinned ${pin.node.exact}`);
  }
  const engines = JSON.parse(repoFile("package.json")).engines.node;
  assert.match(engines, /^>=\d+\.\d+\.\d+$/);
  assert.ok(Number(engines.match(/\d+/)[0]) <= Number(pin.node.exact.split(".")[0]), "engines.node admits the pinned major");
});

test("one action version set: each action the staleness workflows use is at the version main's test workflow (or its template) uses", () => {
  const versions = (text) => new Map([...text.matchAll(/uses:\s*([^@\s]+)@(\S+)/g)].map((m) => [m[1], m[2]]));
  const main = new Map([...versions(repoFile("templates/ci/test.yml")), ...versions(repoFile(".github/workflows/test.yml"))]);
  for (const f of [".github/workflows/staleness.yml", "templates/ci/staleness.yml"]) for (const [name, v] of versions(repoFile(f))) assert.equal(v, main.get(name), `${f}: ${name}`);
});

test("the staleness workflows alert from the saved report and share one constant concurrency group; the kit's differs from the template only in the CLI path", () => {
  for (const f of [".github/workflows/staleness.yml", "templates/ci/staleness.yml"]) {
    const text = repoFile(f);
    assert.match(text, /group: staleness\n\s+cancel-in-progress: true/);
    assert.match(text, /check staleness --alert --report staleness-report\.json/);
    assert.doesNotMatch(text, /\bpull_request\b[^\n]*:\s*$|\n\s+push:/);
  }
  // the kit itself runs its CLI from packages/cli and checks out no kit at .kit (it is the kit): the template's kit-checkout step and bootstrap call are the one difference
  const norm = (t) => stripKitCheckout(t).split("\n").filter((l) => !l.startsWith("#") && !/^\s+#/.test(l)).join("\n").replaceAll("node scripts/kit.mjs", "node packages/cli/bin/kit.js");
  assert.equal(norm(repoFile(".github/workflows/staleness.yml")), norm(repoFile("templates/ci/staleness.yml")));
});

test("the clock rule: the kit's own pre-push and test runners never run the staleness verifier", () => {
  for (const f of ["packages/cli/scripts/pre-push.mjs", "packages/cli/scripts/test-run.mjs", "package.json"]) assert.doesNotMatch(repoFile(f), /check staleness/, f);
});

test("every owed obligation is a row of the registry, shown in docs/FRESHNESS.md, and its threshold pointer resolves", () => {
  const rows = JSON.parse(readFileSync(new URL("../../core/registry/staleness-obligations.json", import.meta.url), "utf8")).obligations;
  const doc = repoFile("docs/FRESHNESS.md");
  const classes = new Set([...CLASSES, "staleness-unverified"]);
  for (const r of rows) {
    assert.ok(doc.includes(`\`${r.id}\``), `docs/FRESHNESS.md shows obligation ${r.id}`);
    assert.ok(classes.has(r.class), `${r.id}: class ${r.class} is declared`);
    if (r.threshold) {
      const [file, pointer] = r.threshold.split("#");
      const target = ["staleness.json"].includes(file) ? file : null;
      if (target) { let v = JSON.parse(readFileSync(new URL(`../../core/registry/${file}`, import.meta.url), "utf8")); for (const k of pointer.slice(1).split("/")) v = v?.[k]; assert.notEqual(v, undefined, `${r.id}: ${r.threshold} resolves`); }
    }
  }
  assert.ok(rows.some((r) => r.id === "machine-scheduler" && r.command === "kit check staleness --local --alert"));
  assert.ok(rows.some((r) => r.id === "comms-ingress" && /POST \/v1\/comms\/dispatch/.test(r.owed)));
});

test("--local: a registered worktree behind main, on another branch, gone, an unregistered worktree and aged scratch are findings; a synced one passes", async (t) => {
  const { base, bare, root } = fixture(t);
  const scratch = join(base, "scratch"); mkdirSync(scratch);
  const wtPath = join(base, "wt1");
  git(root, "worktree", "add", "-q", "-b", "agent/one", wtPath, "main");
  const head0 = git(root, "rev-parse", "HEAD");
  const entry = (extra = {}) => ({ path: wtPath, repo: "o/r", branch: "agent/one", owner: "agent-1", last_sync: head0, ...extra });
  const reg = (worktrees, extra = {}) => { writeFileSync(join(scratch, "worktrees.json"), JSON.stringify({ v: 1, root: base, scratch, worktrees, ...extra })); };
  const local = (deps = {}, env = {}) => stalenessLocal(base, { now: NOW, kit, env, deps: { lsRemote: (dir) => git(dir, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], ...deps } });
  reg([{ path: root, repo: "o/r", branch: "main", owner: "owner", last_sync: head0 }, entry()]);
  let r = await local({ discover: () => [root, wtPath] });
  assert.deepEqual(r.findings, []);
  assert.equal(r.mode, "local");
  assert.deepEqual(kit.validator.validate(r, kit.byName("staleness-report")), []);
  // main moves on at the remote
  const other = join(base, "other"); git(base, "clone", "-q", bare, other);
  write(other, "b.txt", "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "two"); git(other, "push", "-q", "origin", "main");
  r = await local({ discover: () => [root, wtPath] });
  assert.deepEqual(r.findings.map((f) => f.class), ["branch-behind-main", "branch-behind-main"]);
  assert.match(r.findings[1].problem, /owner agent-1, last synced to /);
  assert.ok(Object.values(r.derived_from.heads).every((h) => /^[0-9a-f]{40}$/.test(h)));
  // another branch than registered, a gone directory, an unregistered worktree
  reg([entry({ branch: "agent/other" }), entry({ path: join(base, "gone"), branch: "agent/gone" })]);
  r = await local({ discover: () => [root, wtPath, join(base, "stray")] });
  const texts = r.findings.map((f) => f.problem);
  assert.equal(texts.filter((x) => /is on agent\/one, the registry says agent\/other/.test(x)).length, 1);
  assert.equal(texts.filter((x) => /registered worktree directory is gone/.test(x)).length, 1);
  assert.equal(texts.filter((x) => /stray is a worktree under .* not in the worktree registry/.test(x)).length, 1);
  assert.ok(r.findings.every((f) => f.class === "branch-behind-main"));
  // scratch is aged by the NEWEST file inside each entry (a bounded walk), in the directory the registry or KIT_SCRATCH names, never the working directory
  const day = 86400000, at = (days) => new Date(NOW.getTime() - days * day);
  const touch = (p, days) => { utimesSync(p, at(days), at(days)); };
  mkdirSync(join(scratch, "old")); writeFileSync(join(scratch, "old/a.log"), "x"); touch(join(scratch, "old/a.log"), 15); touch(join(scratch, "old"), 15);
  mkdirSync(join(scratch, "active")); mkdirSync(join(scratch, "active/deep")); writeFileSync(join(scratch, "active/deep/old.txt"), "x"); writeFileSync(join(scratch, "active/deep/new.txt"), "x");
  touch(join(scratch, "active/deep/old.txt"), 40); touch(join(scratch, "active/deep/new.txt"), 1); touch(join(scratch, "active/deep"), 40); touch(join(scratch, "active"), 40);
  mkdirSync(join(scratch, "pkg/node_modules/x"), { recursive: true }); writeFileSync(join(scratch, "pkg/node_modules/x/fresh.js"), "x"); writeFileSync(join(scratch, "pkg/old.txt"), "x");
  touch(join(scratch, "pkg/old.txt"), 30); touch(join(scratch, "pkg"), 30); touch(join(scratch, "worktrees.json"), 400);
  r = await local({ discover: () => [] });
  const aged = r.findings.filter((f) => f.class === "scratch-aged");
  assert.deepEqual(aged.map((f) => [f.subject, f.age_days]).sort(), [[join(scratch, "old"), 15], [join(scratch, "pkg"), 30]], "an old directory with a fresh file deep inside is not aged; node_modules is not walked; the registry file is exempt");
  // the same directory from KIT_SCRATCH, which wins over the registry; the registry itself is then read from it
  const alt = join(base, "alt-scratch"); mkdirSync(alt); mkdirSync(join(alt, "stale")); writeFileSync(join(alt, "stale/f"), "x"); touch(join(alt, "stale/f"), 20); touch(join(alt, "stale"), 20);
  writeFileSync(join(alt, "worktrees.json"), JSON.stringify({ v: 1, root: base, worktrees: [] }));
  r = await local({ discover: () => [] }, { KIT_SCRATCH: alt });
  assert.deepEqual(r.findings.filter((f) => f.class === "scratch-aged").map((f) => [f.subject, f.age_days]), [[join(alt, "stale"), 20]]);
  // a tree larger than the walk bound cannot be aged: an unreadable finding, never a guess
  r = await local({ discover: () => [], scratchTree: () => [{ name: "huge", newestMs: 0, truncated: true }] });
  assert.deepEqual(r.findings.filter((f) => f.class === "scratch-aged").map((f) => f.unreadable), [true]);
  // no scratch declared anywhere: not applicable, and the report says so
  writeFileSync(join(scratch, "worktrees.json"), JSON.stringify({ v: 1, root: base, worktrees: [] }));
  r = await local({ discover: () => [] });
  assert.ok(r.not_applicable.some((n) => n.class === "scratch-aged" && /no scratch directory is declared/.test(n.reason)));
  assert.ok(!r.checked.includes("scratch-aged"));
  // a declared scratch directory that does not exist is unreadable, not fresh
  r = await stalenessLocal(base, { now: NOW, kit, registryFile: join(scratch, "worktrees.json"), env: { KIT_SCRATCH: join(base, "nowhere") }, deps: { discover: () => [] } });
  assert.equal(r.findings.find((f) => f.class === "scratch-aged")?.unreadable, true);
});

test("--local through the CLI reads the registry named in staleness.json and refuses a registry that is not kit.worktrees.v1", async (t) => {
  const { base } = fixture(t);
  mkdirSync(join(base, "scratch"));
  writeFileSync(join(base, "scratch/worktrees.json"), JSON.stringify({ v: 1, root: base, worktrees: [{ path: "relative", repo: "o/r", branch: "b", owner: "a", last_sync: "x" }] }));
  const errs = [];
  const io = { cwd: base, out: () => {}, err: (x) => errs.push(x), env: {} };
  assert.notEqual(await main(["check", "staleness", "--local"], io), 0);
  assert.match(errs.join(""), /does not satisfy kit\.worktrees\.v1/);
  errs.length = 0;
  assert.notEqual(await main(["check", "staleness", "--local", "--registry", "nope.json"], io), 0);
  assert.match(errs.join(""), /worktree registry .* cannot be read/);
});
