// kit check release, kit release (build, ship, verify, drills) and vendor-stale (docs/RELEASE.md). Every case the 2026-10-13 gap analysis
// found in production is reproduced FIRST here as a must-fail, then the fixture that passes: shell deploys (deploy:mail with no tests), a
// rebuild after the tests (SaasReport deploy:web), /api/build 404, a constant /api/health, MONITOR_NOTIFY_TO diverging from the owner, a kit
// 68 commits behind; and the bootstrap state (claimed while Workers exist, without its drills, READY without drill records).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { release } from "../src/commands/release.js";
import { deployerWorkflowProblems, commandsOf, invocationOf } from "../src/release/deployer-check.js";
import { headCheck, parseLsRemote, HeadCheckError } from "../src/release/head-check.js";
import { reviewMarker, markerText } from "../src/release/review-marker.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { bundled } from "../src/canon/index.js";
import { checkRelease, deploySecretUses, PRODUCTION_COMMAND } from "../src/release/check.js";
import { checkResilience } from "../src/resilience/check.js";
import { sha256File } from "../src/resilience/drills.js";
import { writeSeal, sealProblems } from "../src/release/seal.js";
import { ship, verify, drills, plannedDrills, bootstrapLie, ownerAddress, ghClient, ReleaseError } from "../src/release/run.js";
import { releaseWorkers, monitorStatusUrl, releaseIdentity, IDENTITY_ENV, PLACEHOLDER_D1_ID, OWNER_SECRET } from "../src/release/config.js";
import { wireD1, wireVar, placeholders } from "../src/release/wire.js";
import { staleProblems, headProblems } from "../src/vendor-stale.js";

const BASE = fileTempDir("kit-release-");
let SEQ = 0;
const kit = bundled();
const KITROOT = new URL("../../../", import.meta.url).pathname;
const TEMPLATE = (n) => readFileSync(join(KITROOT, "templates/ci", n), "utf8");
const SHA = "c".repeat(40), OLD = "d".repeat(40);
const SITE_ID = "11111111-1111-4111-8111-111111111111", MON_ID = "22222222-2222-4222-8222-222222222222";
/** The identity env of a local-mode drills run (main, the registered repository, the environment). */
const drillEnv = (o = {}) => ({ GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "SaasReport/core", KIT_RELEASE_ENVIRONMENT: "production", GITHUB_SHA: SHA, ...o });

const SITE = `name = "site-web"\nmain = "src/worker.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site-web"\ndatabase_id = "${SITE_ID}"\nmigrations_dir = "migrations"\n[[services]]\nbinding = "COMMS"\nservice = "site-comms-engine"\n[[services]]\nbinding = "MONITOR"\nservice = "site-monitor"\n`;
const ENGINE = `name = "site-comms-engine"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site-web"\ndatabase_id = "${SITE_ID}"\nmigrations_dir = "../../migrations"\n[[services]]\nbinding = "MAIL"\nservice = "site-mail-sender"\n`;
const MAIL = `name = "site-mail-sender"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n`;
const MONVARS = `MONITOR_DB_ID = "${MON_ID}"\nMONITOR_WATCHED_DB_IDS = "${SITE_ID}"\nMONITOR_ROUTES = "email"\nMONITOR_DEADMAN_PROVIDER = "github-actions"\nMONITOR_STALE_AFTER_MIN = "1560"\nMONITOR_FETCH_TIMEOUT_MS = "10000"`;
const MON = (id = MON_ID) => `name = "site-monitor"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "MONITOR_DB"\ndatabase_name = "site-monitor"\ndatabase_id = "${id}"\nmigrations_dir = "migrations"\n[vars]\n${MONVARS}\n[triggers]\ncrons = ["15 2 * * *"]\n`;
const WATCH = readFileSync(join(KITROOT, "templates/resilience/watch.yml"), "utf8");
const ENTRY = 'import { withBuild } from "@saasreport/cloudflare/build";\nexport default withBuild({ fetch: () => new Response("") });\n';
const SITE_ENTRY = 'import { withBuild, buildBehind } from "@saasreport/cloudflare/build";\nimport { healthResponse } from "@saasreport/cloudflare/health";\nconst w = { fetch: (r, env) => (new URL(r.url).pathname === "/api/health" ? healthResponse(env, { component: "site-web" }) : new Response("")) };\nexport default withBuild(w, async (env) => ({ messages: await buildBehind(env.COMMS) }));\n';
const ENGINE_ENTRY = 'import { withBuild } from "@saasreport/cloudflare/build";\nimport { createCommsEngine } from "@saasreport/comms";\nexport default withBuild(createCommsEngine({}));\n';

function releaseDocOf(o = {}) {
  return {
    $schema: "x", project: "saasreport", state: "ready", workers_dev: "acct",
    build: { run: "npm run build", artifact: ["site"] },
    paths: ["workers", "src", "site"],
    owner: { secret: "OPS_NOTIFY_TO", targets: [{ wrangler: "workers/comms-engine/wrangler.toml", name: "OPS_NOTIFY_TO" }, { wrangler: "workers/monitor/wrangler.toml", name: "MONITOR_NOTIFY_TO" }] },
    databases: [{ name: "site-web" }, { name: "site-monitor" }],
    buckets: [{ name: "site-backups" }],
    workers: [
      { wrangler: "workers/mail-sender/wrangler.toml", behind: { worker: "wrangler.toml", role: "delivery" } },
      { wrangler: "workers/comms-engine/wrangler.toml", behind: { worker: "wrangler.toml", role: "messages" } },
      { wrangler: "workers/monitor/wrangler.toml", workers_dev: true },
      { wrangler: "wrangler.toml", build: "https://site.example/api/build", purge: true },
    ],
    drills: [{ kind: "alert", subject: "site-journeys", run: "node drill-alert.mjs", proof: "resilience/drills/alert.json" }, { kind: "restore", subject: "site-d1", run: "node drill-restore.mjs", proof: "resilience/drills/restore.json" }],
    ...o,
  };
}

const releaseDoc = releaseDocOf;

/** A repository that passes every release rule; each test breaks one thing. */
function fixture(mut = () => {}, { drillsRecorded = true } = {}) {
  const root = join(BASE, `r${SEQ++}`);
  const w = (f, t) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); };
  w("wrangler.toml", SITE); w("workers/comms-engine/wrangler.toml", ENGINE); w("workers/mail-sender/wrangler.toml", MAIL); w("workers/monitor/wrangler.toml", MON());
  w("src/worker.js", SITE_ENTRY); w("workers/comms-engine/src/index.js", ENGINE_ENTRY); w("workers/mail-sender/src/index.js", ENTRY); w("workers/monitor/src/index.js", ENTRY);
  w("migrations/0001_init.sql", "CREATE TABLE t (a);\n"); w("workers/monitor/migrations/0001.sql", "CREATE TABLE m (a);\n");
  w("package.json", JSON.stringify({ name: "site", scripts: { test: "kit check canon && node --test", build: "kit site build" } }, null, 2));
  w("vendor/kit/templates/ci/production.yml", TEMPLATE("production.yml")); w("vendor/kit/templates/ci/drift.yml", TEMPLATE("drift.yml"));
  w(".github/workflows/production.yml", TEMPLATE("production.yml")); w(".github/workflows/drift.yml", TEMPLATE("drift.yml")); w(".github/workflows/test.yml", TEMPLATE("test.yml")); w(".github/workflows/watch.yml", WATCH);
  w("site/index.html", "<!doctype html>\n"); w("backup.config.json", "{}\n");
  w("resilience/drills/alert.json", "{}\n"); w("resilience/drills/restore.json", "{}\n");
  const drill = (kind, subject, file) => ({ kind, subject, date: "2026-10-12", result: "pass", proof_path: file, proof_sha256: sha256File(join(root, file)) });
  const res = {
    $schema: "x", project: "site",
    routes: [{ id: "mail", channel: "email" }, { id: "chat", channel: "telegram", deferred: { reason: "Owner decision: the bot comes later, switch it on then", decided_by: "owner", decided_on: "2026-10-08" } }],
    monitors: [{ id: "site-journeys", kind: "worker", worker: { wrangler: "workers/monitor/wrangler.toml" }, database_binding: "MONITOR_DB",
      watches: [{ wrangler: "wrangler.toml" }, { wrangler: "workers/comms-engine/wrangler.toml" }, { wrangler: "workers/mail-sender/wrangler.toml" }],
      root: "cloudflare", routes: ["mail", "chat"], stale_after_min: 1560, fetch_timeout_ms: 10000,
      dead_man: { provider: "github-actions", root: "github", interval_min: 1440, grace_min: 120 },
      watcher: { workflow: ".github/workflows/watch.yml", url_env: "MONITOR_STATUS_URL" } }],
    backups: [{ id: "site-d1", source: { kind: "d1", name: "site-web" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" },
      { id: "monitor-d1", source: { kind: "d1", name: "site-monitor" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" }],
    drills: drillsRecorded ? [drill("alert", "site-journeys", "resilience/drills/alert.json"), drill("restore", "site-d1", "resilience/drills/restore.json"), drill("restore", "monitor-d1", "resilience/drills/restore.json")] : [],
  };
  const rel = releaseDoc();
  rel.drills.push({ kind: "restore", subject: "monitor-d1", run: "node drill-restore.mjs monitor", proof: "resilience/drills/restore.json" });
  mut({ rel, res, w, root });
  w("release.json", JSON.stringify(rel, null, 2)); w("resilience.json", JSON.stringify(res, null, 2));
  return root;
}
const CANON = { project: "kit", release: {}, resilience: {}, vendor: { path: "vendor/kit" } };
const check = (root) => checkRelease(root, CANON, kit);
const txt = async (root) => (await check(root)).problems.map((p) => `${p.file}: ${p.problem}`).join("\n");

test("a complete release.json, the templates and derived endpoints pass", async () => {
  const r = await check(fixture());
  assert.deepEqual(r.problems, []);
  assert.ok(r.ok && r.checked > 5);
});

test("must-fail: SaasReport's shell deploys: deploy:mail with no tests, deploy:web rebuilding after the tests", async () => {
  const t = await txt(fixture(({ w }) => w("package.json", JSON.stringify({ name: "site", scripts: {
    test: "kit check canon", "deploy:mail": "wrangler deploy -c workers/mail-sender/wrangler.toml",
    "deploy:web": "npm test && kit check fa-review && npm run stamp && npm run db:migrate:remote && wrangler deploy -c wrangler.toml && kit purge",
    "db:migrate:remote": "wrangler d1 migrations apply site-web --remote" } }))));
  assert.match(t, /one-production-workflow: "deploy:mail": wrangler deploy[^\n]*without running the tests \(a Worker deployed without tests\)/);
  assert.match(t, /tested-artefact-deployed: "deploy:web" rebuilds after the tests/);
  assert.match(t, /one-production-workflow: "db:migrate:remote"[^\n]*changes production outside/);
});

test("must-fail: a production workflow that differs from the template (a build after the tests) or a second deploying workflow", async () => {
  const added = TEMPLATE("production.yml").replace("      - name: ship (guard", "      - run: npm run stamp\n      - name: ship (guard");
  let t = await txt(fixture(({ w }) => w(".github/workflows/production.yml", added)));
  assert.match(t, /one-production-workflow: differs from vendor\/kit\/templates\/ci\/production\.yml/);
  t = await txt(fixture(({ w }) => w(".github/workflows/hotfix.yml", "jobs:\n  x:\n    steps:\n      - run: npx wrangler deploy -c wrangler.toml\n")));
  assert.match(t, /\.github\/workflows\/hotfix\.yml: one-production-workflow: - run: npx wrangler deploy -c wrangler\.toml: changes production outside/);
  t = await txt(fixture(({ w }) => w(".github/workflows/drift.yml", "name: drift\n")));
  assert.match(t, /drift\.yml: one-production-workflow: differs from vendor\/kit\/templates\/ci\/drift\.yml/);
  assert.ok(PRODUCTION_COMMAND.test("wrangler secret put OPS_NOTIFY_TO") && PRODUCTION_COMMAND.test("node x/kit.js release ship") && !PRODUCTION_COMMAND.test("wrangler deploy --dry-run".replace("deploy", "dev")));
});

test("must-fail: a Worker with no /api/build (no withBuild), or one not released", async () => {
  let t = await txt(fixture(({ w }) => w("workers/mail-sender/src/index.js", "export default { fetch: () => new Response('') };\n")));
  assert.match(t, /served-commit-verified: the entry of site-mail-sender does not wrap its Worker with withBuild/);
  t = await txt(fixture(({ rel }) => { rel.workers = rel.workers.filter((x) => x.wrangler !== "workers/mail-sender/wrangler.toml"); }));
  assert.match(t, /workers\/mail-sender\/wrangler\.toml: every-worker-released: this config is deployed by this repository but is not a release\.json worker/);
  t = await txt(fixture(({ rel }) => { rel.workers.reverse(); }));
  assert.match(t, /every-worker-released: site-web binds site-comms-engine \(COMMS\) but is deployed before it/);
});

test("must-fail: a constant /api/health (the four sites on 2026-10-13)", async () => {
  let t = await txt(fixture(({ w }) => w("src/worker.js", `${ENTRY}\n    if (url.pathname === "/api/health") return json({ ok: true, component: \`\${PROJECT}-web\` });\n`)));
  assert.match(t, /src\/worker\.js:4: health-from-monitor: \/api\/health answers a constant ok: true/);
  t = await txt(fixture(({ w }) => w("src/worker.js", `${ENTRY}\n    if (url.pathname === "/api/health") {\n      return json({\n        ok: true,\n        component: "x",\n      });\n    }\n`)));
  assert.match(t, /src\/worker\.js:4: health-from-monitor/, "the multi-line form is found too");
});

test("must-fail: the monitor's recipient and the engine's owner are not both the one owner address", async () => {
  let t = await txt(fixture(({ rel }) => { rel.owner.targets = rel.owner.targets.filter((x) => x.name !== "MONITOR_NOTIFY_TO"); }));
  assert.match(t, /one-owner-address: the monitor site-journeys emails MONITOR_NOTIFY_TO on workers\/monitor\/wrangler\.toml, which is not an owner target/);
  t = await txt(fixture(({ rel }) => { rel.owner.targets = rel.owner.targets.filter((x) => x.name !== "OPS_NOTIFY_TO"); }));
  assert.match(t, /one-owner-address: the comms engine site-comms-engine holds the owner's recipients in OPS_NOTIFY_TO/);
  t = await txt(fixture(({ rel }) => { rel.project = "site"; }));
  assert.match(t, /one-owner-address: project "site" has no domain in the kit project registry/);
  t = await txt(fixture(({ rel }) => { rel.owner.secret = "OTHER_TO"; }));
  assert.match(t, /kit\.release\.v1/, "the owner secret is fixed: OPS_NOTIFY_TO");
});

test("must-fail: a D1 bound but not a release database, or two migrations directories for one database", async () => {
  let t = await txt(fixture(({ rel }) => { rel.databases = rel.databases.filter((d) => d.name !== "site-monitor"); }));
  assert.match(t, /d1-migrated-before-binders: D1 site-monitor is bound by workers\/monitor\/wrangler\.toml but is not a release database/);
  t = await txt(fixture(({ w }) => w("workers/comms-engine/wrangler.toml", ENGINE.replace('"../../migrations"', '"migrations"'))));
  assert.match(t, /name 2 migrations directories/);
});

test("T0 main-only production release shares the live publisher credential with the protected drills step", () => {
  const w = TEMPLATE("production.yml");
  const drillsStep = w.slice(w.indexOf("      - name: drills (the ones asked for; every one in bootstrap)"));
  assert.ok(drillsStep.includes("PODCAST_ADMIN_TOKEN: " + "$" + "{{ secrets.PODCAST_ADMIN_TOKEN }}"));
  assert.ok(w.indexOf("PODCAST_ADMIN_TOKEN:") > w.indexOf("      - name: ship ("),
    "publisher credential is never added to the build, tests, or untrusted PR steps");
});

test("bootstrap: valid before the first deploy (resilience's drills are owed, not waived); must-fail when claimed after one, or without its drills", async () => {
  const boot = (extra = () => {}) => fixture((f) => { f.rel.state = "bootstrap"; extra(f); }, { drillsRecorded: false });
  let root = boot();
  assert.deepEqual((await check(root)).problems, []);
  const res = await checkResilience(root, CANON, kit, { today: "2026-10-13" });
  assert.ok(!res.problems.some((p) => /resilience-proven-by-drills/.test(p.problem)), res.problems.map((p) => p.problem).join("\n"));
  assert.match(res.summary, /bootstrap: 3 drill\(s\) owed by the first production run/);
  // READY without drill records: strict
  root = fixture(() => {}, { drillsRecorded: false });
  assert.ok((await checkResilience(root, CANON, kit, { today: "2026-10-13" })).problems.some((p) => /resilience-proven-by-drills: no alert drill recorded/.test(p.problem)));
  // bootstrap without a drill command for every required drill
  let t = await txt(boot(({ rel }) => { rel.drills = rel.drills.filter((d) => d.kind !== "alert"); }));
  assert.match(t, /bootstrap-before-first-deploy: no drill command for alert:site-journeys/);
  root = boot(({ rel }) => { rel.drills = rel.drills.filter((d) => d.kind !== "alert"); });
  assert.ok((await checkResilience(root, CANON, kit, { today: "2026-10-13" })).problems.some((p) => /resilience-proven-by-drills/.test(p.problem)), "an invalid bootstrap owes nothing: the drill rule stays strict");
  // claimed after a deployment: a receipt with a deployed commit, or drills recorded
  t = await txt(boot(({ w }) => w("release/bootstrap.json", JSON.stringify({ checked_at: "2026-10-13T00:00:00Z", run: "r", commit: SHA, workers: {}, eligible: true, deployed_commit: SHA }))));
  assert.match(t, /bootstrap-before-first-deploy: records a deployment/);
  t = await txt(fixture(({ rel }) => { rel.state = "bootstrap"; }));
  assert.match(t, /bootstrap-before-first-deploy: drills are recorded: production has run/);
});

test("seal: the deployed artefact is the tested one; a rebuild after the tests is refused", () => {
  const root = fixture();
  assert.match(sealProblems(root, ["site"])[0], /no seal/);
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  assert.deepEqual(sealProblems(root, ["site"]), []);
  writeFileSync(join(root, "site/index.html"), "<!doctype html><p>rebuilt</p>\n");
  assert.match(sealProblems(root, ["site"])[0], /the artefact changed after the sealed build \(a rebuild after the tests\?\): site\/index\.html \(changed\)/);
  assert.throws(() => writeSeal(root, ["nothing-here"]), /the build produced nothing/);
});

/** Fakes for ship: every outside effect recorded in order. */
/** A distinct, valid uuid per created database name (hex only). */
const NEW_ID = (n) => { const h = [...n].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8).padEnd(8, "3")}-3333-4333-8333-${h.slice(8, 20).padEnd(12, "3")}`; };
const sealOf = (root) => JSON.parse(readFileSync(join(root, ".release/seal.json"), "utf8")).sha256;
function fakes(root, { present = [], builds = {}, d1 = { "site-web": SITE_ID, "site-monitor": MON_ID }, served = SHA, subdomain = "acct", head = SHA, branches = ["main"] } = {}) {
  const calls = [];
  const cf = {
    scriptExists: async (n) => { calls.push(`exists ${n}`); return present.includes(n); },
    scriptSecretExists: async () => false, // an unreadable/absent Cloudflare binding cannot be treated as a usable secret
    // the Worker's settings: present, and the BUILD_COMMIT its version carries (builds[n]: a sha, null for a shell deploy, "error" for an unreadable one)
    scriptBuildCommit: async (n) => { calls.push(`settings ${n}`); if (builds[n] === "error") throw new Error("Cloudflare answered 500"); return present.includes(n) ? { present: true, commit: builds[n] ?? null } : { present: false }; },
    subdomain: async () => subdomain,
    d1Find: async (n) => (d1[n] ? { uuid: d1[n], name: n } : null),
    d1Create: async (n) => { calls.push(`create d1 ${n}`); d1[n] = NEW_ID(n); return { uuid: d1[n] }; },
    r2Exists: async () => true, r2Create: async (n) => calls.push(`create r2 ${n}`),
  };
  const gh = { mainHead: async () => head, environment: async () => ({ deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } }), branchPolicies: async () => branches.map((name) => ({ name, type: "branch" })) };
  const backedUp = new Map();
  const wrangler = async (args, o = {}) => {
    calls.push(`wrangler ${args.filter((a) => !a.includes("/tmp") && !a.endsWith("-migrate.toml")).join(" ")}${o.input ? " <stdin>" : ""}`);
    if (args[0] === "d1" && args[1] === "export") {
      writeFileSync(args[args.indexOf("--output") + 1], "-- immutable fixture export\\nCREATE TABLE existing (id TEXT);\\n");
    }
    if (args[0] === "r2" && args[1] === "object" && args[2] === "put") {
      backedUp.set(args[3], readFileSync(args[args.indexOf("--file") + 1]));
    }
    if (args[0] === "r2" && args[1] === "object" && args[2] === "get") {
      const bytes = backedUp.get(args[3]); if (!bytes) throw Error("missing R2 backup " + args[3]);
      writeFileSync(args[args.indexOf("--file") + 1], bytes);
    }
  };
  const fetch = async (url) => {
    const site = { commit: served, services: { messages: { commit: served, services: {} }, delivery: { commit: served, services: {} } } };
    return new Response(JSON.stringify(url.includes("site.example") ? { ...site, services: { messages: site.services.messages, delivery: site.services.delivery } } : { commit: served, services: {} }), { headers: { "content-type": "application/json" } });
  };
  const env = { GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA, GITHUB_REPOSITORY: "SaasReport/core", GITHUB_RUN_ID: "1", OPS_NOTIFY_TO: "info@saasreport.ai", MONITOR_TOKEN: "monitor-token-fixture", KIT_RELEASE_ENVIRONMENT: "production", SEAL_SHA256: existsSync(join(root, ".release/seal.json")) ? sealOf(root) : "" };
  const tmp = join(root, ".tmp"); mkdirSync(tmp, { recursive: true });
  return { calls, deps: { kit, env, cf, gh, wrangler, checkoutHead: async () => (env.KIT_RELEASE_SOURCE_SHA || env.GITHUB_SHA), run: async (w) => calls.push(`run ${w}`), fetch, log: () => {}, tmp, attempts: 1, waitMs: 0, sleep: async () => {} } };
}

test("ship: each D1 migrated before the first Worker that binds it, every Worker deployed with its commit, the owner address after, then verified", async () => {
  const root = fixture();
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  const r = await ship(root, deps);
  assert.equal(r.state, "ready");
  const order = calls.filter((c) =>
    (c.startsWith("wrangler") || c.startsWith("run")) &&
    !c.startsWith("wrangler d1 export") && !c.startsWith("wrangler r2 object"));
  const backupCalls = calls.filter((c) => c.startsWith("wrangler d1 export") || c.startsWith("wrangler r2 object"));
  assert.equal(backupCalls.length, 10, "both existing D1 databases exported and each SQL backup and receipt independently read back from R2 before migration");
  assert.equal(backupCalls.filter((c) => c.startsWith("wrangler d1 export ") && c.includes(" --skip-confirmation ")).length, 2,
    "both physical D1 exports must be headless: Wrangler export prompts unless --skip-confirmation is explicitly passed");
  for (const name of ["site-web", "site-monitor"]) {
    const backup = calls.findIndex((c) => c.startsWith(`wrangler d1 export ${name} --remote`));
    const migration = calls.findIndex((c) => c.startsWith(`wrangler d1 migrations apply ${name}`));
    assert.ok(backup >= 0 && migration > backup, `${name}: pre-migration D1 export must precede SQL`);
  }
  const tag = `--var BUILD_COMMIT:${SHA} --tag ${SHA.slice(0, 12)} --message ${SHA}`;
  assert.deepEqual(order, [
    `wrangler deploy -c workers/mail-sender/wrangler.toml ${tag}`,
    "wrangler d1 migrations apply site-web --remote --config",
    `wrangler deploy -c workers/comms-engine/wrangler.toml ${tag}`,
    "wrangler d1 migrations apply site-monitor --remote --config",
    `wrangler deploy -c workers/monitor/wrangler.toml ${tag}`,
    `wrangler deploy -c wrangler.toml ${tag}`,
    "run purge",
    "wrangler secret put MONITOR_TOKEN -c workers/monitor/wrangler.toml <stdin>",
    "wrangler secret put OPS_NOTIFY_TO -c workers/comms-engine/wrangler.toml <stdin>",
    "wrangler secret put MONITOR_NOTIFY_TO -c workers/monitor/wrangler.toml <stdin>",
  ]);
  assert.ok(!calls.some((c) => c.includes("info@saasreport.ai")), "the address goes through stdin, never argv");
});


test("T0 daemon bootstrap: generates one cryptographic credential for both Workers and never logs it", async () => {
  const root = fixture(({ rel }) => {
    rel.generated_secrets = ["DEVELOPER_KEY_PEPPER", "MONITOR_TOKEN"];
    rel.secrets = [
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" },
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "workers/comms-engine/wrangler.toml" },
    ];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  delete deps.env.MONITOR_TOKEN;
  deps.cf.scriptSecretExists = async () => false;
  const values = [];
  const original = deps.wrangler;
  deps.wrangler = async (args, opts = {}) => {
    if (args[0] === "secret" && args[2] === "DEVELOPER_KEY_PEPPER") values.push(opts.input);
    await original(args, opts);
  };
  await ship(root, deps);
  assert.equal(values.length, 2, "both declared consumers receive a daemon-owned pepper");
  assert.ok(values[0].length >= 64 && values[0] === values[1], "same random 384-bit credential, not independent Worker peppers");
  assert.equal(calls.filter((c) => c.startsWith("wrangler secret put MONITOR_TOKEN")).length, 1);
  assert.ok(!calls.join("\n").includes(values[0]), "no credential in GitHub log argv or proof");
});

test("T0 first bootstrap hands cryptographic admin credential to same protected publisher job, no git artifact or log", async () => {
  const root = fixture(({ rel }) => { rel.state = "bootstrap"; rel.generated_secrets = ["ADMIN_TOKEN"]; rel.secrets = [{ name: "ADMIN_TOKEN", wrangler: "wrangler.toml" }]; }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.env.GITHUB_ACTIONS = "true";
  deps.env.RUNNER_TEMP = join(root, ".tmp");
  deps.cf.scriptSecretExists = async () => false;
  // Cloudflare-only site is still shell-deployed: first publication must come after ship.
  const first = deps.fetch;
  let deployed = false, value = "";
  const wrangler = deps.wrangler;
  deps.wrangler = async (args, opts = {}) => {
    if (args[0] === "deploy") deployed = true;
    if (args[0] === "secret" && args[2] === "ADMIN_TOKEN") value = opts.input;
    await wrangler(args, opts);
  };
  deps.fetch = async (url, opts) => (deployed ? first(url, opts) : new Response("not found", { status: 404 }));
  await ship(root, deps);
  const handoff = JSON.parse(readFileSync(join(root, ".tmp", "kit-daemon-admin-1.json"), "utf8"));
  assert.deepEqual([handoff.schema, handoff.run, handoff.commit], ["kit.daemon-admin-handoff.v1", "1", SHA]);
  assert.equal(handoff.token, value, "the publisher receives only the just-installed real site Worker credential");
  assert.ok(value.length >= 64 && !calls.join("\n").includes(value));
});
test("T0 explicitly authorized bootstrap rotates only irretrievable legacy admin after read-only unreleased proof", async () => {
  const root = fixture(({ rel }) => {
    rel.state = "bootstrap";
    rel.generated_secrets = ["ADMIN_TOKEN", "DEVELOPER_KEY_PEPPER"];
    rel.rotate_legacy_admin_on_bootstrap = true;
    rel.secrets = [
      { name: "ADMIN_TOKEN", wrangler: "wrangler.toml" },
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" },
    ];
  }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const f = fakes(root);
  f.deps.cf.scriptSecretExists = async (worker, name) => name === "ADMIN_TOKEN";
  f.deps.env.RUNNER_TEMP = join(root, ".tmp");
  f.deps.env.GITHUB_ACTIONS = "true";
  const deployed = f.deps.fetch;
  let changed = false;
  f.deps.fetch = async (url, init) => changed ? deployed(url, init) : new Response("not found", { status: 404 });
  const secretWrites = [];
  const wrangler = f.deps.wrangler;
  f.deps.wrangler = async (args, options = {}) => {
    if (args[0] === "secret") secretWrites.push({ name: args[2], value: options.input });
    if (args[0] === "deploy") changed = true;
    return wrangler(args, options);
  };
  await ship(root, f.deps);
  const admin = secretWrites.filter((x) => x.name === "ADMIN_TOKEN");
  const pepper = secretWrites.filter((x) => x.name === "DEVELOPER_KEY_PEPPER");
  assert.equal(admin.length, 1, "only the authorized legacy admin bearer rotates at cutover");
  assert.equal(pepper.length, 1, "nonexisting pepper bootstraps deterministically once");
  assert.equal(admin[0].value.length >= 64, true);
  const handoff = JSON.parse(readFileSync(join(root, ".tmp", "kit-daemon-admin-1.json"), "utf8"));
  assert.equal(handoff.token, admin[0].value);
  assert.ok(!f.calls.join("\\n").includes(admin[0].value));
});

test("T0 Bootstrap admin rotation is NEVER allowed to mutate a previously released Worker", async () => {
  const root = fixture(({ rel }) => {
    rel.state = "bootstrap";
    rel.generated_secrets = ["ADMIN_TOKEN"];
    rel.rotate_legacy_admin_on_bootstrap = true;
    rel.secrets = [{ name: "ADMIN_TOKEN", wrangler: "wrangler.toml" }];
  }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const f = fakes(root, { present: ["site-web"], builds: { "site-web": OLD } });
  f.deps.cf.scriptSecretExists = async () => true;
  await assert.rejects(ship(root, f.deps), /bootstrap claimed while Workers exist/);
  assert.equal(f.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")).length, 0);
});

test("T0 repeated release preserves existing Cloudflare daemon bindings without secret rotation", async () => {
  const root = fixture(({ rel }) => { rel.generated_secrets = ["MONITOR_TOKEN"]; });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  delete deps.env.MONITOR_TOKEN;
  deps.cf.scriptSecretExists = async () => true;
  await ship(root, deps);
  assert.equal(calls.filter((c) => c.startsWith("wrangler secret put MONITOR_TOKEN")).length, 0,
    "a subsequent deployment must not rotate a Cloudflare-owned key");
});

test("T0 partial multi-Worker credential state denies BEFORE any SQL or deployment", async () => {
  const root = fixture(({ rel }) => {
    rel.generated_secrets = ["DEVELOPER_KEY_PEPPER"];
    rel.secrets = [
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" },
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "workers/comms-engine/wrangler.toml" },
    ];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.cf.scriptSecretExists = async (workerName) => workerName === "site-web";
  await assert.rejects(ship(root, deps), /partial existing Worker secret bindings/);
  assert.equal(calls.filter((x) => x.startsWith("wrangler") || x.startsWith("create")).length, 0);
});

test("T0 preflight distinguishes two Workers sharing a config but using distinct Wrangler environments", async () => {
  const root = fixture(({ rel, w }) => {
    rel.generated_secrets = ["DEVELOPER_KEY_PEPPER"];
    rel.workers.push({ wrangler: "wrangler.toml", env: "canary", behind: { worker: "wrangler.toml", role: "canary" } });
    rel.secrets = [
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" },
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml", env: "canary" },
    ];
    w("wrangler.toml", SITE + '\n[env.canary]\nname = "site-canary"\nmain = "src/worker.js"\n');
  });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.cf.scriptSecretExists = async (workerName) => workerName === "site-web";
  await assert.rejects(ship(root, deps), /partial existing Worker secret bindings/,
    "site-web's real pepper must not be overwritten because canary lacks it");
  assert.equal(calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")).length, 0);
});

test("T0 provider secret already on the Cloudflare Worker survives a release without re-entering the value in GitHub", async () => {
  const root = fixture(({ rel }) => { rel.secrets = [{ name: "GEMINI_API_KEY", wrangler: "wrangler.toml" }]; });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.cf.scriptSecretExists = async (workerName, name) => workerName === "site-web" && name === "GEMINI_API_KEY";
  await ship(root, deps);
  assert.ok(!calls.some((c) => c.startsWith("wrangler secret put GEMINI_API_KEY")), "Cloudflare's existing encrypted provider credential is never replaced by blank CI env");
});

test("T0 partially bound shared provider secret cannot silently diverge across Workers", async () => {
  const root = fixture(({ rel }) => {
    rel.secrets = [
      { name: "GEMINI_API_KEY", wrangler: "wrangler.toml" },
      { name: "GEMINI_API_KEY", wrangler: "workers/comms-engine/wrangler.toml" },
    ];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.cf.scriptSecretExists = async (workerName) => workerName === "site-web";
  await assert.rejects(ship(root, deps), /partial remote secret bindings/);
  assert.ok(!calls.some((c) => c.startsWith("wrangler") || c.startsWith("create")), "no D1/Worker mutation from an incomplete external credential");
});

test("T0 optional operator credential: empty cold-start is safe, later protected provision enables it", async () => {
  const withOptional = (rel) => {
    rel.generated_secrets = ["ADMIN_TOKEN"];
    rel.secrets = [{ name: "ADMIN_TOKEN", wrangler: "wrangler.toml" }];
    rel.optional_secrets = [{ name: "PODCAST_ADMIN_TOKEN", wrangler: "wrangler.toml" }];
  };
  const root = fixture(({ rel }) => withOptional(rel));
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  deps.cf.scriptSecretExists = async () => false;
  await ship(root, deps);
  assert.equal(calls.some((c) => c.startsWith("wrangler secret put PODCAST_ADMIN_TOKEN")), false,
    "optional caller key is NOT invented or required for autonomous daemon operation");
  assert.equal(calls.filter((c) => c.startsWith("wrangler secret put ADMIN_TOKEN")).length, 1);

  const root2 = fixture(({ rel }) => withOptional(rel));
  writeSeal(root2, ["site"], { commit: SHA, build: "npm run build" });
  const enabled = fakes(root2);
  enabled.deps.cf.scriptSecretExists = async () => false;
  enabled.deps.env.PODCAST_ADMIN_TOKEN = "operator-provisioned-through-protected-environment";
  await ship(root2, enabled.deps);
  assert.equal(enabled.calls.filter((c) => c.startsWith("wrangler secret put PODCAST_ADMIN_TOKEN")).length, 1,
    "operator token is installed only from the protected environment and never generated");
});

test("T0 provider keys cannot be minted or disguised as daemon secrets", async () => {
  const root = fixture(({ rel }) => {
    rel.generated_secrets = ["MONITOR_TOKEN"];
    rel.secrets = [{ name: "GEMINI_API_KEY", wrangler: "wrangler.toml" }];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  delete deps.env.MONITOR_TOKEN;
  deps.cf.scriptSecretExists = async () => false;
  await assert.rejects(ship(root, deps), /environment lacks GEMINI_API_KEY/);
  assert.equal(calls.filter((x) => x.startsWith("wrangler") || x.startsWith("create")).length, 0);
  const malformed = fixture(({ rel }) => { rel.generated_secrets = ["GEMINI_API_KEY"]; });
  assert.match((await txt(malformed)), /generated_secrets|release/);
});

test("must-fail T=0 D1 backup plan: no project-owned R2 backup means no SQL or deploy", async () => {
  const root = fixture(({ res }) => { res.backups = []; });
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  await assert.rejects(ship(root, deps), /pre-migration D1 backup refused: site-web: expected exactly one/);
  assert.equal(calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")).length, 0,
    "no provisioning, SQL or Worker mutation without a canonical backup plan");
});

test("must-fail T=0 D1 backup integrity: corrupted R2 readback blocks ALL SQL and deploys", async () => {
  const root = fixture();
  writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
  const { calls, deps } = fakes(root);
  const original = deps.wrangler;
  deps.wrangler = async (args, options) => {
    await original(args, options);
    if (args[0] === "r2" && args[1] === "object" && args[2] === "get")
      writeFileSync(args[args.indexOf("--file") + 1], "corrupted backup");
  };
  await assert.rejects(ship(root, deps), /pre-migration D1 backup refused: site-web: R2 readback differs/);
  assert.ok(!calls.some((c) => c.startsWith("wrangler d1 migrations apply") || c.startsWith("wrangler deploy")),
    "R2 digest mismatch blocks every SQL migration and Worker promotion");
});

test("must-fail: ship stops before ANY production change on an empty owner address, a run off main's HEAD, a changed artefact or a wrong subdomain", async () => {
  const cases = [
    [(d) => { d.env.OPS_NOTIFY_TO = ""; }, /OPS_NOTIFY_TO is empty/],
    [(d) => { d.env.OPS_NOTIFY_TO = "info@saasreport.ai, other@example.org"; }, /must be one address, info@saasreport\.ai/],
    [(d) => { d.env.OPS_NOTIFY_TO = "someone@gmail.com"; }, /is not info@saasreport\.ai: the one owner address is the project's info@/],
    [(d) => { d.checkoutHead = async () => OLD; }, /the checkout is at d{40}, not c{40}/],
    [(d) => { d.env.GITHUB_REF = "refs/heads/feature"; }, /only from main/],
    [(d, root) => { d.gh.mainHead = async () => OLD; }, /but main is d{40}/],
    [(d) => { d.gh.branchPolicies = async () => [{ name: "main" }, { name: "dev" }]; }, /not exactly main/],
    [(d, root) => writeFileSync(join(root, "site/index.html"), "rebuilt\n"), /the artefact changed after the sealed build/],
    [(d) => { d.cf.subdomain = async () => "other"; }, /workers\.dev subdomain is other/],
    [(d) => { d.env.KIT_RELEASE_ENVIRONMENT = "staging"; }, /KIT_RELEASE_ENVIRONMENT is staging, release\.json says production/],
    [(d) => { d.env.GITHUB_REPOSITORY = "someone/app"; }, /this repository someone\/app is not a repository the kit project registry lists for saasreport/],
    [(d) => { d.env.SEAL_SHA256 = "f".repeat(64); }, /the seal on disk \([0-9a-f]{12}\) is not the one the build step reported/],
    [(d) => { d.env.SEAL_SHA256 = ""; }, /SEAL_SHA256 is not set to the build step's digest/],
    [(d, root) => { writeSeal(root, ["site"], { commit: OLD, build: "x" }); d.env.SEAL_SHA256 = sealOf(root); }, /the seal is of d{40}, this run deploys c{40}/],
  ];
  for (const [mut, re] of cases) {
    const root = fixture();
    writeSeal(root, ["site"], { commit: SHA, build: "npm run build" });
    const { calls, deps } = fakes(root);
    mut(deps, root);
    await assert.rejects(ship(root, deps), re);
    assert.deepEqual(calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create") || c.startsWith("run")), [], `${re}: nothing changed`);
  }
  assert.throws(() => ownerAddress({ OPS_NOTIFY_TO: "not-an-address" }, "saasreport.ai"), ReleaseError);
  assert.equal(ownerAddress({ OPS_NOTIFY_TO: "INFO@SaasReport.ai" }, "saasreport.ai"), "INFO@SaasReport.ai");
  assert.throws(() => ownerAddress({ OPS_NOTIFY_TO: "info@saasreport.ai" }, undefined), /no domain in the kit project registry/);
});

test("must-fail: bootstrap claimed while Workers a production run deployed exist (or cannot be read) stops before any change", async () => {
  for (const [builds, want] of [[{ "site-web": SHA }, "present-released"], [{ "site-web": "error" }, "present-unknown"], [{}, "present-released"]]) {   // the last: no BUILD_COMMIT binding, but /api/build serves a sha
    const root = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
    writeSeal(root, ["site"], { commit: SHA, build: "x" });
    const f = fakes(root, { present: ["site-web"], builds });
    await assert.rejects(ship(root, f.deps), /bootstrap claimed while Workers exist that a production run deployed or that cannot be read \(site-web: present-/);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")), []);
    const receipt = JSON.parse(readFileSync(join(root, "release/bootstrap.json"), "utf8"));
    assert.deepEqual([receipt.eligible, receipt.workers["site-web"], receipt.workers["site-monitor"]], [false, want, "absent"]);
    assert.deepEqual(kit.validator.validate(receipt, kit.byName("release-bootstrap")), [], "the receipt is on its contract (kit.release-bootstrap.v1)");
  }
});

test("bootstrap of a site deployed from a shell (three sites on 2026-10-13: Workers live, no BUILD_COMMIT in their versions): eligible, then deploys", async () => {
  const all = ["site-web", "site-comms-engine", "site-mail-sender", "site-monitor"];
  const root = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root, { present: all });   // present, builds[n] undefined: the settings carry no BUILD_COMMIT
  const live = f.deps.fetch;
  let deployed = false;
  const baseWrangler = f.deps.wrangler;
  f.deps.wrangler = async (args, options) => { if (args[0] === "deploy") deployed = true; await baseWrangler(args, options); f.calls.push(`wrangler ${args[0]}`); };
  f.deps.fetch = async (url, init) => (deployed ? live(url, init) : new Response("not found", { status: 404 }));
  const r = await ship(root, f.deps);
  assert.equal(r.state, "bootstrap");
  const receipt = JSON.parse(readFileSync(join(root, "release/bootstrap.json"), "utf8"));
  assert.equal(receipt.eligible, true);
  assert.deepEqual(Object.values(receipt.workers), ["present-unreleased", "present-unreleased", "present-unreleased", "present-unreleased"]);
  assert.ok(all.every((n) => f.calls.includes(`settings ${n}`)), "the evidence is the account's settings, read for every Worker");
  // a 404 on /api/build proves nothing by itself: a present Worker whose settings carry a BUILD_COMMIT is released whatever its endpoint says
  const r2 = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
  writeSeal(r2, ["site"], { commit: SHA, build: "x" });
  const g = fakes(r2, { present: all, builds: { "site-web": OLD } });
  g.deps.fetch = async () => new Response("not found", { status: 404 });
  await assert.rejects(ship(r2, g.deps), /site-web: present-released/);
});

test("bootstrap of a new site: every Worker absent; the monitor's D1 a placeholder wired at run time and recorded", async () => {
  let root, f;
  root = fixture(({ rel, w }) => { rel.state = "bootstrap"; w("workers/monitor/wrangler.toml", MON(PLACEHOLDER_D1_ID).replace(`MONITOR_DB_ID = "${MON_ID}"`, `MONITOR_DB_ID = "${PLACEHOLDER_D1_ID}"`)); }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  f = fakes(root, { d1: { "site-web": SITE_ID } });
  const r = await ship(root, f.deps);
  assert.equal(r.state, "bootstrap"); assert.equal(r.records, true);
  assert.ok(f.calls.includes("create d1 site-monitor"));
  const mon = readFileSync(join(root, "workers/monitor/wrangler.toml"), "utf8");
  assert.ok(mon.includes(`database_id = "${NEW_ID("site-monitor")}"`) && mon.includes(`MONITOR_DB_ID = "${NEW_ID("site-monitor")}"`) && mon.includes(`MONITOR_WATCHED_DB_IDS = "${SITE_ID}"`), mon);
  assert.deepEqual(placeholders(mon), []);
  assert.equal(JSON.parse(readFileSync(join(root, "release/provisioned.json"), "utf8")).d1["site-monitor"], NEW_ID("site-monitor"));
});

test("verify: drift (another commit, or none: a shell deploy) vs unreadable; bootstrap claimed while a build is served", async () => {
  const root = fixture();
  const doc = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
  const workers = releaseWorkers(root, doc);
  const answer = (b) => async () => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  let v = await verify(root, { doc, workers, commit: SHA, fetch: answer({ commit: SHA, services: { messages: { commit: SHA }, delivery: { commit: SHA } } }) });
  assert.deepEqual(v.problems, []);
  v = await verify(root, { doc, workers, commit: SHA, fetch: answer({ commit: null, services: { messages: { commit: OLD }, delivery: { commit: SHA } } }) });
  assert.equal(v.drift, true); assert.match(v.problems.join("\n"), /site-web: serves \(no commit: deployed outside the production workflow\)/);
  v = await verify(root, { doc, workers, commit: SHA, fetch: async () => { throw new Error("down"); } });
  assert.deepEqual([v.drift, v.unreadable], [false, true]);
  v = await verify(root, { doc, workers, commit: SHA, fetch: answer({ commit: SHA, services: { messages: { commit: "unreachable" } } }) });
  assert.equal(v.unreadable, true);
  assert.match(await bootstrapLie({ ...doc, state: "bootstrap" }, workers, answer({ commit: SHA, services: {} })), /release\.json says bootstrap, but site-mail-sender|site-monitor serves/);
  assert.equal(await bootstrapLie(doc, workers, answer({ commit: SHA })), null);
  assert.equal(monitorStatusUrl(root, doc, "workers/monitor/wrangler.toml"), "https://site-monitor.acct.workers.dev/status");
});

test("T0 publisher precedes monitoring and restore: stable, complete, never silently skips a bootstrap drill", () => {
  const batch = [{ kind: "alert", subject: "site-journeys" }, { kind: "restore", subject: "podcasts-r2" },
    { kind: "publish", subject: "daily" }, { kind: "publish", subject: "weekly" },
    { kind: "restore", subject: "site-d1" }];
  const ordered = plannedDrills(batch);
  assert.deepEqual(ordered.map((x) => x.kind + ":" + x.subject),
    ["publish:daily", "publish:weekly", "alert:site-journeys", "restore:podcasts-r2", "restore:site-d1"]);
  assert.equal(ordered.length, batch.length);
  assert.deepEqual(batch.map((x) => x.kind).slice(0, 2), ["alert", "restore"], "planning never mutates the reviewed release manifest");
});

test("drills: the ones asked for; in bootstrap all of them, then the receipt records the deployment and the state becomes ready", async () => {
  const root = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
  const ran = [];
  await assert.rejects(drills(root, { kit, requested: "none", run: async (c) => { ran.push(c); return 0; }, env: drillEnv(), log: () => {} }), /without a receipt proving no production run had deployed/);
  mkdirSync(join(root, "release"), { recursive: true });
  writeFileSync(join(root, "release/bootstrap.json"), JSON.stringify({ checked_at: "2026-10-13T00:00:00Z", run: "r", commit: SHA, workers: { "site-web": "absent" }, eligible: true, deployed_commit: null }));
  const before = ran.length;
  const r = await drills(root, { kit, requested: "none", run: async (c) => { ran.push(c); return 0; }, env: drillEnv(), now: () => new Date("2026-10-13T08:00:00Z"), log: () => {} });
  assert.equal(ran.length - before, 3, "every declared drill, whatever was asked");
  assert.deepEqual(r.drills, ["alert:site-journeys", "restore:site-d1", "restore:monitor-d1"]);
  assert.equal(JSON.parse(readFileSync(join(root, "release.json"), "utf8")).state, "ready");
  assert.equal(JSON.parse(readFileSync(join(root, "release/bootstrap.json"), "utf8")).deployed_commit, SHA);
  assert.equal(JSON.parse(readFileSync(join(root, "resilience.json"), "utf8")).drills.length, 3);
  // and READY never goes back: the check now refuses bootstrap
  const doc = JSON.parse(readFileSync(join(root, "release.json"), "utf8")); doc.state = "bootstrap"; writeFileSync(join(root, "release.json"), JSON.stringify(doc));
  assert.match(await txt(root), /records a deployment/);
  // proof placeholders: {date} and {run} are filled in and handed to the command
  const ph = fixture(({ rel }) => { rel.drills = [{ kind: "alert", subject: "site-journeys", run: "x", proof: "resilience/drills/alert-site-journeys-{date}-{run}.json" }]; });
  const got = [];
  await drills(ph, { kit, requested: "alert", env: drillEnv({ GITHUB_RUN_ID: "42" }), now: () => new Date("2026-10-13T08:00:00Z"), log: () => {},
    run: async (c, extra) => { got.push(extra); writeFileSync(join(ph, extra.KIT_DRILL_PROOF), "{}\n"); return 0; } });
  assert.deepEqual([got[0].KIT_DRILL_PROOF, got[0].KIT_DRILL_DATE], ["resilience/drills/alert-site-journeys-2026-10-13-42.json", "2026-10-13"]);
  assert.equal(JSON.parse(readFileSync(join(ph, "resilience.json"), "utf8")).drills.at(-1).proof_path, "resilience/drills/alert-site-journeys-2026-10-13-42.json");
  // a failed drill is recorded as fail and fails the run
  const ready = fixture();
  await assert.rejects(drills(ready, { kit, requested: "alert", run: async () => 1, env: drillEnv(), now: () => new Date("2026-10-13T08:00:00Z"), log: () => {} }), /drill alert:site-journeys failed \(exit 1\); recorded as fail/);
  assert.equal(JSON.parse(readFileSync(join(ready, "resilience.json"), "utf8")).drills.at(-1).result, "fail");
});

const head = (shas, base = Date.parse("2026-10-13T00:00:00Z")) => ({ v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha: shas[0], date: new Date(base).toISOString(), recent: shas.map((s, i) => ({ sha: s, date: new Date(base - i * 3600e3).toISOString() })) });
const shaN = (i) => i.toString(16).padStart(40, "0");
const served = (doc, status = 200) => async () => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
const manifest = (commit, date) => ({ source: { repository: "https://github.com/SaasReport/kit", ref: "main", commit, commit_date: date } });

test("vendor-stale: must-fail a vendor 68 commits behind; within the bound passes", async () => {
  const doc = head(Array.from({ length: 300 }, (_, i) => shaN(i + 1)));
  assert.deepEqual(headProblems(doc), []);
  const now = Date.parse("2026-10-13T06:00:00Z");
  let s = await staleProblems(manifest(shaN(69), doc.recent[68].date), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" });
  assert.equal(s.behind, 68);
  assert.match(s.problems[0], /is 68 commits behind main 0{12}.* \(limit 30/);
  s = await staleProblems(manifest(shaN(11), doc.recent[10].date), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" });
  assert.deepEqual([s.problems, s.behind], [[], 10]);
  // the bound is exclusive: 29 behind passes, 30 behind (the default max_commits) fails
  assert.deepEqual((await staleProblems(manifest(shaN(30), doc.recent[29].date), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" })).behind, 29);
  assert.equal((await staleProblems(manifest(shaN(30), doc.recent[29].date), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" })).problems.length, 0);
  assert.match((await staleProblems(manifest(shaN(31), doc.recent[30].date), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" })).problems[0], /is 30 commits behind/);
  s = await staleProblems(manifest(shaN(11), doc.recent[10].date), { stale: { max_commits: 5 } }, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" });
  assert.equal(s.problems.length, 1);
  // days: one commit behind, but main has had it for 20 days
  const old = head([shaN(1), shaN(2)], Date.parse("2026-09-20T00:00:00Z"));
  s = await staleProblems(manifest(shaN(2), old.recent[1].date), {}, { fetch: served(old), now, ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /for 23 days/);
  // not in the published window at all
  s = await staleProblems(manifest("e".repeat(40), "2026-08-01T00:00:00.000Z"), {}, { fetch: served(doc), now, ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /is not among main's last 300 first-parent commits and is older than the oldest of them: more than 300 behind/);
});

test("vendor-stale: must-fail an unreachable head in CI (a warning on a machine), a head older than the vendor, a head off its contract", async () => {
  const m = manifest(shaN(1), "2026-10-13T00:00:00.000Z");
  let s = await staleProblems(m, {}, { fetch: async () => { throw new Error("ENOTFOUND"); }, ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /unreachable.*fails closed in CI/);
  s = await staleProblems(m, {}, { fetch: async () => { throw new Error("ENOTFOUND"); }, ci: false, url: "https://pub.example/kit-main.json" });
  assert.deepEqual(s.problems, []); assert.match(s.warnings[0], /a warning on this machine; CI fails closed/);
  s = await staleProblems(m, {}, { fetch: served({}, 404), ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /answered 404/);
  s = await staleProblems(m, {}, { ci: true, url: null });
  assert.match(s.problems[0], /not published yet/);
  const behindVendor = head([shaN(9)], Date.parse("2026-10-10T00:00:00Z"));
  s = await staleProblems(m, {}, { fetch: served(behindVendor), ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /is older than the vendored kit/);
  s = await staleProblems(m, {}, { fetch: served({ sha: "x" }), ci: true, url: "https://pub.example/kit-main.json" });
  assert.match(s.problems[0], /off its contract/);
});

const CENTRAL = { repository: "example/central-deploy", environment: "production-saasreport" };
const centralEnv = (o = {}) => ({ GITHUB_REF: "refs/heads/main", GITHUB_SHA: OLD, GITHUB_REPOSITORY: CENTRAL.repository, GITHUB_RUN_ID: "9", OPS_NOTIFY_TO: "info@saasreport.ai", MONITOR_TOKEN: "monitor-token-fixture",
  KIT_RELEASE_ENVIRONMENT: CENTRAL.environment, KIT_RELEASE_SOURCE_REPOSITORY: "SaasReport/core", KIT_RELEASE_SOURCE_SHA: SHA, ...o });

test("central mode (release.json deployer): the source holds CI only; must-fail a production or drift workflow, or a deploy secret, in the source", async () => {
  const central = (extra = () => {}) => fixture((f) => { f.rel.deployer = CENTRAL; extra(f); });
  let t = await txt(central());
  assert.match(t, /production\.yml: one-production-workflow: release\.json names example\/central-deploy as the deployer \(central mode\)[^\n]*must not exist/);
  assert.match(t, /drift\.yml: one-production-workflow:[^\n]*must not exist/);
  const clean = central(({ root }) => { for (const f of [".github/workflows/production.yml", ".github/workflows/drift.yml"]) writeFileSync(join(root, f), ""); });
  for (const f of [".github/workflows/production.yml", ".github/workflows/drift.yml"]) (await import("node:fs")).rmSync(join(clean, f));
  assert.deepEqual((await check(clean)).problems, []);
  const names = kit.byName("release").$defs.deployCredentials.enum;
  for (const line of ["          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}", "          X: ${{ secrets['CLOUDFLARE_ACCOUNT_ID'] }}", "          X: ${{ format('{0}', secrets.OPS_NOTIFY_TO) }}",
    "          ALL: ${{ toJSON(secrets) }}", "          X: ${{ secrets.cloudflare_api_token }}", "          X: ${{ SECRETS['cf_account_id'] }}", "          X: ${{ secrets.CLOUDFLARE_API_KEY }}", "          X: ${{ secrets.CF_ACCOUNT_ID }}",
    "          X: ${{ secrets[env.WHICH] }}", "          X: ${{ secrets[format('CLOUDFLARE_{0}', 'API_TOKEN')] }}", "    secrets: inherit", "    secrets:"]) {
    const wf = `jobs:\n  t:\n    steps:\n      - run: npm test\n        env:\n${line}\n`;
    writeFileSync(join(clean, ".github/workflows/test.yml"), wf);
    const hit = (await check(clean)).problems.filter((x) => x.file.startsWith(".github/workflows/test.yml"));
    assert.ok(hit.length > 0 && hit.every((x) => x.problem.startsWith("one-production-workflow:") && x.file === ".github/workflows/test.yml:6"), line);
  }
  // not uses: a declared workflow_call secret, a comment, a secret that is not a deploy credential, a name inside a run script
  for (const ok of [`on:\n  workflow_call:\n    secrets:\n      CLOUDFLARE_API_TOKEN:\n        required: true\njobs:\n  t:\n    runs-on: x\n`,
    `jobs:\n  t:\n    steps:\n      # secrets.CLOUDFLARE_API_TOKEN\n      - run: echo "secrets are fine"\n        env:\n          A: \${{ secrets.UNRELATED_TOKEN }}\n          B: \${{ github.event.secrets_url }}\n`]) {
    assert.deepEqual(deploySecretUses(ok, names), [], ok);
  }
  writeFileSync(join(clean, ".github/workflows/test.yml"), "jobs:\n  t:\n    steps:\n      - run: x\n        env: &anchor\n          A: 1\n");
  assert.ok((await check(clean)).problems.some((x) => x.file === ".github/workflows/test.yml"), "an unreadable workflow is a problem, never a pass");
});

test("central mode: ship deploys the tested tree's commit from the deployer only and never reads the source repository through the API", async () => {
  const setup = (envO) => {
    const root = fixture((f) => { f.rel.deployer = CENTRAL; });
    writeSeal(root, ["site"], { commit: SHA, build: "x" });
    const f = fakes(root);
    f.deps.env = centralEnv({ SEAL_SHA256: sealOf(root), ...envO });
    f.deps.checkoutHead = async () => SHA;
    const reads = [];
    const mainHead = f.deps.gh.mainHead; f.deps.gh.mainHead = async () => { reads.push("mainHead"); return mainHead(); };
    return { root, f, reads };
  };
  const nothing = (f) => assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create") || c.startsWith("run")), []);
  let { root, f } = setup({ GITHUB_REPOSITORY: "SaasReport/core" });
  await assert.rejects(ship(root, f.deps), /names example\/central-deploy as this project's deployer; this run is in SaasReport\/core/); nothing(f);
  ({ root, f } = setup({ GITHUB_REF: "refs/heads/try" }));
  await assert.rejects(ship(root, f.deps), /production changes only from main/); nothing(f);
  ({ root, f } = setup({}));
  f.deps.checkoutHead = async () => OLD;
  await assert.rejects(ship(root, f.deps), /the checkout is at d{40}, not c{40}/); nothing(f);
  ({ root, f } = setup({ KIT_RELEASE_SOURCE_SHA: "main" }));
  await assert.rejects(ship(root, f.deps), /KIT_RELEASE_SOURCE_SHA is not a 40-hex commit/); nothing(f);
  ({ root, f } = setup({ GITHUB_REF: "refs/heads/try" }));
  await assert.rejects(ship(root, f.deps), /production changes only from main/); nothing(f);
  ({ root, f } = setup({ KIT_RELEASE_SOURCE_REPOSITORY: "fork-owner/app" }));   // a fork whose main carries the same sha is not the source
  await assert.rejects(ship(root, f.deps), /the source repository fork-owner\/app is not a repository the kit project registry lists for saasreport/); nothing(f);
  ({ root, f } = setup({ KIT_RELEASE_ENVIRONMENT: "production-other" }));   // another project's deployer environment
  await assert.rejects(ship(root, f.deps), /KIT_RELEASE_ENVIRONMENT is production-other, not the deployer environment release\.json names \(production-saasreport\)/); nothing(f);
  // the deployer's environment is the one checked
  let reads; ({ root, f, reads } = setup({}));
  const asked = []; const env = f.deps.gh.environment; f.deps.gh.environment = async (n) => { asked.push(n); return env(n); };
  const r = await ship(root, f.deps);
  assert.deepEqual([r.commit, asked], [SHA, ["production-saasreport"]]);
  assert.deepEqual(reads, [], "central mode never asks the API for a repository's main: the deployer's ls-remote re-read is the proof");
  assert.ok(f.calls.some((c) => c.includes(`--var BUILD_COMMIT:${SHA}`) && c.includes(`--message SaasReport/core@${SHA} by example/central-deploy`)), "BUILD_COMMIT is the source sha, never the deployer's");
  await assert.rejects(drills(root, { kit, requested: "alert", run: async () => 0, env: { ...centralEnv(), GITHUB_REPOSITORY: "SaasReport/core" }, log: () => {} }), /this run is in SaasReport\/core/);
  await assert.rejects(drills(root, { kit, requested: "alert", run: async () => 0, env: centralEnv({ GITHUB_REF: "refs/heads/try" }), log: () => {} }), /production changes only from main/, "drills refuse off-main in central mode too");
});

test("must-fail (review B1): two placeholders in one monitor config are wired per binding, never by a whole-file replace", async () => {
  // a new site: the site's D1 and the monitor's D1 are both created by the run; the monitor config holds the placeholder in its own
  // [[d1_databases]] block AND in MONITOR_DB_ID AND in MONITOR_WATCHED_DB_IDS (the watched site D1 is new too)
  const root = fixture(({ rel, w }) => {
    rel.state = "bootstrap";
    w("wrangler.toml", SITE.replaceAll(SITE_ID, PLACEHOLDER_D1_ID)); w("workers/comms-engine/wrangler.toml", ENGINE.replaceAll(SITE_ID, PLACEHOLDER_D1_ID));
    w("workers/monitor/wrangler.toml", MON(PLACEHOLDER_D1_ID).replaceAll(MON_ID, PLACEHOLDER_D1_ID).replaceAll(SITE_ID, PLACEHOLDER_D1_ID));
  }, { drillsRecorded: false });
  assert.equal(placeholders(readFileSync(join(root, "workers/monitor/wrangler.toml"), "utf8")).length, 3, "three placeholder lines before the run");
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root, { d1: {} });
  await ship(root, f.deps);
  const mon = readFileSync(join(root, "workers/monitor/wrangler.toml"), "utf8"), site = readFileSync(join(root, "wrangler.toml"), "utf8");
  const own = NEW_ID("site-monitor"), watched = NEW_ID("site-web");
  assert.notEqual(own, watched);
  assert.ok(mon.includes(`database_id = "${own}"`), "the monitor's own block got the monitor's id");
  assert.ok(mon.includes(`MONITOR_DB_ID = "${own}"`) && mon.includes(`MONITOR_WATCHED_DB_IDS = "${watched}"`), `the vars name the right databases:\n${mon}`);
  assert.ok(site.includes(`database_id = "${watched}"`));
  assert.deepEqual([placeholders(mon), placeholders(site)], [[], []]);
  assert.ok(!mon.includes(`MONITOR_WATCHED_DB_IDS = "${own}"`), "the monitor never watches itself");
  // a placeholder the kit cannot wire (a database not declared in release.json) is refused, never shipped
  const r2 = fixture(({ rel, w }) => { rel.state = "bootstrap"; w("workers/mail-sender/wrangler.toml", `${MAIL}[[d1_databases]]\nbinding = "X"\ndatabase_name = "site-extra"\ndatabase_id = "${PLACEHOLDER_D1_ID}"\n`); }, { drillsRecorded: false });
  writeSeal(r2, ["site"], { commit: SHA, build: "x" });
  const g = fakes(r2);
  await assert.rejects(ship(r2, g.deps), /workers\/mail-sender\/wrangler\.toml still holds the placeholder id after wiring|site-extra/);
  assert.ok(!g.calls.some((c) => c.startsWith("wrangler deploy")), "nothing deployed with a placeholder left");
});

test("wire.js: the block of the named binding only; a missing block, key or table is an error", () => {
  const two = `[[d1_databases]]\nbinding = "A"\ndatabase_id = "${PLACEHOLDER_D1_ID}"\n[[d1_databases]]\nbinding = "B"\ndatabase_id = "${PLACEHOLDER_D1_ID}"   # keep\n[vars]\nMONITOR_DB_ID = "${PLACEHOLDER_D1_ID}"\n`;
  const out = wireD1(two, "B", MON_ID);
  assert.ok(out.includes(`binding = "A"\ndatabase_id = "${PLACEHOLDER_D1_ID}"`) && out.includes(`binding = "B"\ndatabase_id = "${MON_ID}"   # keep`));
  assert.equal(placeholders(out).length, 2);
  assert.ok(wireVar(out, "MONITOR_DB_ID", MON_ID).includes(`MONITOR_DB_ID = "${MON_ID}"`));
  assert.throws(() => wireD1(two, "C", MON_ID), /no \[\[d1_databases\]\] block with binding = "C"/);
  assert.throws(() => wireVar("name = \"x\"\n", "MONITOR_DB_ID", MON_ID), /no \[vars\] table/);
  assert.throws(() => wireD1(two, "A", "not-an-id"), /not a database id/);
});

test("the owner secret has one source: release.json's schema const is the kit's OWNER_SECRET", () => {
  assert.equal(kit.byName("release").properties.owner.properties.secret.const, OWNER_SECRET);
  const main = { GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "SaasReport/core", GITHUB_SHA: SHA };
  const releaseDoc = () => ({ ...releaseDocOf(), environment: "production" });
  assert.throws(() => releaseIdentity(releaseDoc(), { ...main, KIT_RELEASE_ENVIRONMENT: "staging" }, kit), /KIT_RELEASE_ENVIRONMENT is staging/);
  assert.equal(releaseIdentity(releaseDoc(), { ...main, KIT_RELEASE_ENVIRONMENT: "production" }, kit).commit, SHA);
});

test("must-fail (review 4): a constant health answer in every spelling, after a ; too; healthResponse and another route do not trip it", async () => {
  for (const body of ['return json({ "ok": true });', "return json({ ok: 1 });", "return json({ ok:!0 });", "const x = 1; log(x); return Response.json({ ok: true });", "return new Response(JSON.stringify({ ok: !!1 }));"]) {
    const t = await txt(fixture(({ w }) => w("src/worker.js", `${ENTRY}\nif (url.pathname === "/api/health") { ${body} }\n`)));
    assert.match(t, /src\/worker\.js:\d+: health-from-monitor/, body);
  }
  for (const ok of ['if (p === "/api/health") return healthResponse(env, {}); json({ ok: true });', 'if (p === "/api/health") return healthResponse(env, {});\nif (p === "/api/ping") return json({ ok: true });']) {
    assert.deepEqual((await check(fixture(({ w }) => w("src/worker.js", `${SITE_ENTRY}\n${ok}\n`)))).problems.filter((x) => /health-from-monitor/.test(x.problem)), [], ok);
  }
});

test("identity (review 1): the registry is required, and an unset environment is refused in both modes", () => {
  const main = { GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "SaasReport/core", GITHUB_SHA: SHA };
  const releaseDoc = () => ({ ...releaseDocOf(), environment: "production" });
  assert.throws(() => releaseIdentity(releaseDoc(), { ...main, KIT_RELEASE_ENVIRONMENT: "production" }), /needs the kit project registry/);
  assert.throws(() => releaseIdentity(releaseDoc(), main, kit), /KIT_RELEASE_ENVIRONMENT is \(not set\)/);
  assert.throws(() => releaseIdentity({ ...releaseDoc(), deployer: CENTRAL }, centralEnv({ KIT_RELEASE_ENVIRONMENT: undefined }), kit), /KIT_RELEASE_ENVIRONMENT is \(not set\)/);
  assert.throws(() => releaseIdentity({ ...releaseDoc(), deployer: CENTRAL }, centralEnv({ KIT_RELEASE_SOURCE_SHA: undefined }), kit), /KIT_RELEASE_SOURCE_SHA is not a 40-hex commit/);
});

test("provision (review 2): a monitor that watches its own database, or a watched binding that resolves to no id, stops the run before any deploy", async () => {
  const cases = [
    ({ res }) => res.monitors[0].watches.push({ wrangler: "workers/monitor/wrangler.toml" }),
    ({ w }) => w("workers/mail-sender/wrangler.toml", `${MAIL}[[d1_databases]]\nbinding = "X"\ndatabase_name = "site-unknown"\n`),
  ];
  for (const mut of cases) {
    const root = fixture(mut);
    writeSeal(root, ["site"], { commit: SHA, build: "x" });
    const f = fakes(root);
    await assert.rejects(ship(root, f.deps), ReleaseError);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler")), [], "nothing deployed");
  }
});

test("wire.js (review 5, 6): forms the editor cannot edit are refused, environments and quoting are honoured, array lines end no block, comments hold no placeholder", () => {
  const P = PLACEHOLDER_D1_ID;
  assert.throws(() => wireD1(`d1_databases = [{ binding = "A", database_id = "${P}" }]\n`, "A", MON_ID), /1 d1_databases entry is declared but 0 written as \[\[d1_databases\]\] tables/);
  assert.throws(() => wireD1(`[[d1_databases]]\nbinding = "A"\ndatabase_id = "${P}"\n`, "A", MON_ID, { file: "wrangler.jsonc" }), /JSON\/JSONC wrangler config cannot be wired/);
  assert.throws(() => wireVar(`vars = { MONITOR_DB_ID = "${P}" }\n`, "MONITOR_DB_ID", MON_ID), /not as a \[vars\] table/);
  const env = `[[d1_databases]]\nbinding = "A"\ndatabase_id = "${P}"\n[[env.x.d1_databases]]\nbinding = "A"\ndatabase_id = "${P}"\n[vars]\nK = "${P}"\n[env.x.vars]\nK = "${P}"\n`;
  const e = wireD1(wireVar(env, "K", MON_ID, { env: "x" }), "A", SITE_ID, { env: "x" });
  assert.equal(placeholders(e).map((x) => x.line).join(), "3,8", "only the env block and the env var were wired");
  assert.ok(e.includes(`[env.x.vars]\nK = "${MON_ID}"`) && e.includes(`[[env.x.d1_databases]]\nbinding = "A"\ndatabase_id = "${SITE_ID}"`));
  assert.throws(() => wireVar(env, "K", MON_ID, { env: "y" }), /has no \[env\.y\] section/);
  const multi = `[[d1_databases]]\nbinding = "A"\nextra = [\n  ["x"],\n  ["y"]\n]\ndatabase_id = "${P}"\n`;
  assert.ok(wireD1(multi, "A", SITE_ID).includes(`database_id = "${SITE_ID}"`), "a multi-line array element line is not a table header");
  const quoted = `[[d1_databases]]\n'binding' = "A"\n"database_id" = '${P}'  # keep\n[vars]\n"K" = '${P}'\n`;
  const q = wireVar(wireD1(quoted, "A", SITE_ID), "K", MON_ID);
  assert.ok(q.includes(`"database_id" = '${SITE_ID}'  # keep`) && q.includes(`"K" = '${MON_ID}'`));
  assert.deepEqual(placeholders(`# database_id = "${P}"\nx = "real" # was ${P}\ny = "${P}"\n`).map((x) => x.line), [3]);
});

test("provision (review 6): a placeholder in a config the monitor watches is refused too", async () => {
  const root = fixture(({ res, w }) => { res.monitors[0].watches.push({ wrangler: "extra/wrangler.toml" }); w("extra/wrangler.toml", `name = "extra"\nmain = "x.js"\ncompatibility_date = "2026-09-01"\n[vars]\nX = "${PLACEHOLDER_D1_ID}"\n`); });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root);
  await assert.rejects(ship(root, f.deps), ReleaseError);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler")), []);
});

test("bootstrap (review 8): a present Worker whose /api/build answers neither 404 nor a commit is unknown and refuses; a 404 is not evidence", async () => {
  const all = ["site-web", "site-comms-engine", "site-mail-sender", "site-monitor"];
  const answers = { "200 with no commit": async () => new Response("{}", { headers: { "content-type": "application/json" } }), "200 not JSON": async () => new Response("<html>"), "5xx": async () => new Response("", { status: 503 }), "network error": async () => { throw new Error("ECONNRESET"); } };
  for (const [what, fetch] of Object.entries(answers)) {
    const root = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
    writeSeal(root, ["site"], { commit: SHA, build: "x" });
    const f = fakes(root, { present: all });
    f.deps.fetch = fetch;
    await assert.rejects(ship(root, f.deps), /bootstrap claimed while Workers exist[^]*present-unknown/, what);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")), [], what);
    assert.equal(JSON.parse(readFileSync(join(root, "release/bootstrap.json"), "utf8")).eligible, false, what);
  }
  const root = fixture(({ rel }) => { rel.state = "bootstrap"; }, { drillsRecorded: false });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root, { present: ["site-web"] });
  const live = f.deps.fetch; let deployed = false;
  const baseWrangler2 = f.deps.wrangler;
  f.deps.wrangler = async (a, options) => { if (a[0] === "deploy") deployed = true; await baseWrangler2(a, options); };
  f.deps.fetch = async (u, i) => (deployed ? live(u, i) : new Response("", { status: 404 }));
  assert.equal((await ship(root, f.deps)).state, "bootstrap");
});

test("vendor-stale (review 9): a commit dated inside the window yet not in it is not on main's first-parent line, and says so", async () => {
  const doc = head(Array.from({ length: 300 }, (_, i) => shaN(i + 1)));
  const s = await staleProblems(manifest("e".repeat(40), doc.recent[150].date), {}, { fetch: served(doc), now: Date.parse("2026-10-13T06:00:00Z"), ci: true, url: "https://pub.example/kit-main.json" });
  assert.equal(s.problems.length, 1);
  assert.match(s.problems[0], /is not on main's first-parent line/);
  assert.doesNotMatch(s.problems[0], /more than \d+ behind/);
});

test("drift.yml (review 10): the dispatcher reads filtered queries over every unfinished status; the lowest active drift run dispatches, never while production is active", () => {
  const text = TEMPLATE("drift.yml");
  assert.ok(!/select\(\.status/.test(text), "no unfiltered listing counted client-side");
  const from = text.indexOf("          active() {"), to = text.indexOf("          fi\n", from) + "          fi\n".length;
  const snippet = text.slice(from, to).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = join(BASE, `drift${SEQ++}`); mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/gh"), '#!/bin/bash\nif [ "$1" = api ]; then url="$*"; [ -n "$FAKE_FAIL" ] && case "$url" in *"/$FAKE_FAIL/"*) exit 1;; esac; wf=$(echo "$url" | sed -E "s#.*/workflows/([^/]+)/runs.*#\\1#"); st=$(echo "$url" | sed -E "s#.*status=([a-z_]+).*#\\1#"); [ -f "$FAKE_DIR/$wf.$st" ] && cat "$FAKE_DIR/$wf.$st"; exit 0; fi\nif [ "$1" = workflow ]; then echo "$*" >> "$FAKE_DIR/dispatched"; fi\n', { mode: 0o755 });
  const run = (active, fail = "") => {
    for (const f of ["dispatched", "summary"]) writeFileSync(join(dir, f), "");
    for (const [name, ids] of Object.entries(active)) writeFileSync(join(dir, name), `${ids.join("\n")}\n`);
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", snippet], { env: { FAKE_FAIL: fail, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_DIR: dir, GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "50", GITHUB_STEP_SUMMARY: join(dir, "summary") }, encoding: "utf8" });
    assert.equal(r.status === 0, !fail, r.stderr);
    const out = readFileSync(join(dir, "dispatched"), "utf8").trim();
    for (const name of Object.keys(active)) writeFileSync(join(dir, name), "");
    return out;
  };
  assert.equal(run({ "drift.yml.in_progress": [50] }), "workflow run production.yml --ref main");
  assert.equal(run({ "drift.yml.in_progress": [50], "drift.yml.queued": [51] }), "workflow run production.yml --ref main", "a later queued drift run does not stop the lowest");
  assert.equal(run({ "drift.yml.in_progress": [50], "drift.yml.waiting": [49] }), "", "an earlier active drift run dispatches, not this one");
  for (const st of ["queued", "waiting", "requested", "pending", "in_progress"]) assert.equal(run({ "drift.yml.in_progress": [50], [`production.yml.${st}`]: [7] }), "", `a production run ${st} blocks the dispatch`);
  // fail closed: a failed query is never read as "nothing active"
  assert.equal(run({ "drift.yml.in_progress": [50] }, "production.yml"), "", "the production-runs call fails: nothing dispatched, the step fails");
  assert.equal(run({ "drift.yml.in_progress": [50] }, "drift.yml"), "", "the drift-runs call fails: nothing dispatched, the step fails");
  assert.ok(/--paginate/.test(text) && /set -euo pipefail/.test(text));
});

test("templates (spec d): every kit invocation is node scripts/kit.mjs (the kit at its head, docs/FRESHNESS.md), never a snapshot path, npx or a bare kit", async () => {
  const { readdirSync } = await import("node:fs");
  for (const dir of ["ci", "resilience"]) for (const f of readdirSync(join(KITROOT, "templates", dir)).filter((x) => /\.ya?ml$/.test(x))) {
    readFileSync(join(KITROOT, "templates", dir, f), "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("#")) return;
      assert.ok(!/\bnpx\b[^\n]*\bkit\b/.test(t), `${f}:${i + 1} runs kit through npx`);
      assert.ok(!/(^|run:\s*|[;&|]\s*|then\s+|-\s+)kit\s+[a-z]/.test(t), `${f}:${i + 1} runs a bare kit`);
      assert.ok(!/bin\/kit\.js/.test(t), `${f}:${i + 1} names the CLI by a snapshot path`);
      if (/^(- )?run:/.test(t) && /kit\.mjs/.test(t)) assert.ok(/node scripts\/kit\.mjs/.test(t), `${f}:${i + 1} names the CLI by another path`);
    });
  }
});

test("ship (spec c, a): the seal is re-checked before EACH Worker, and a run that cannot read its tree's HEAD is refused", async () => {
  const root = fixture();
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root);
  let n = 0;
  const baseWrangler3 = f.deps.wrangler;
  f.deps.wrangler = async (a, options) => { await baseWrangler3(a, options); f.calls.push(`wrangler ${a[0]}`); if (a[0] === "deploy" && ++n === 1) writeFileSync(join(root, "site/index.html"), "changed between two Workers\\n"); };
  await assert.rejects(ship(root, f.deps), /the artefact changed after the sealed build/);
  assert.equal(f.calls.filter((c) => c === "wrangler deploy").length, 1, "the second Worker was never deployed");
  const r2 = fixture();
  writeSeal(r2, ["site"], { commit: SHA, build: "x" });
  const g = fakes(r2);
  delete g.deps.checkoutHead;
  await assert.rejects(ship(r2, g.deps), /checkout's HEAD cannot be read/);
  assert.deepEqual(g.calls.filter((c) => c.startsWith("wrangler")), []);
});

test("environment read (spec b): the GitHub client names the permission question when the environment cannot be read", async () => {
  const gh = ghClient({ token: "t", repository: "example/central-deploy", fetch: async () => new Response("{}", { status: 404 }) });
  await assert.rejects(gh.environment("production-x"), /answered 404 \(the environment does not exist, or the job token cannot read it/);
  await assert.rejects(gh.mainHead(), (e) => e instanceof ReleaseError && !/job token/.test(e.message));
});

test("kit release build (review 11): the seal names the source commit in central mode, never the deployer's GITHUB_SHA; central without it is refused", async () => {
  const mk = () => fixture(({ rel, w }) => { rel.deployer = CENTRAL; rel.build = { run: "mkdir -p site && echo built > site/index.html", artifact: ["site"] }; });
  const run = async (root, env) => { const out = [], err = []; const code = await release({ cwd: root, env, out: (m) => out.push(m), err: (m) => err.push(m) }, { _: ["build"], flags: {} }); return { code, out, err }; };
  const root = mk();
  assert.equal((await run(root, centralEnv())).code, 0);
  assert.equal(JSON.parse(readFileSync(join(root, ".release/seal.json"), "utf8")).commit, SHA, "the source sha, not the deployer's GITHUB_SHA");
  await assert.rejects(run(mk(), centralEnv({ KIT_RELEASE_SOURCE_SHA: undefined })), (e) => /KIT_RELEASE_SOURCE_SHA is not a 40-hex commit/.test(e.message) && IDENTITY_ENV.central.every((n) => e.message.includes(n)), "the refusal names every variable a deployer must pass");
  const local = fixture(({ rel }) => { rel.build = { run: "mkdir -p site && echo built > site/index.html", artifact: ["site"] }; });
  assert.equal((await run(local, drillEnv())).code, 0);
  assert.equal(JSON.parse(readFileSync(join(local, ".release/seal.json"), "utf8")).commit, SHA);
  await assert.rejects(run(local, drillEnv({ KIT_RELEASE_ENVIRONMENT: undefined })), /KIT_RELEASE_ENVIRONMENT is \(not set\)/);
});

test("kit release workers --json (spec e): { project, workers: [{ name, wrangler }] } on its contract, in deploy order", async () => {
  const root = fixture();
  const out = [];
  assert.equal(await release({ cwd: root, env: {}, out: (m) => out.push(m), err: () => {} }, { _: ["workers"], flags: { json: true } }), 0);
  const got = JSON.parse(out.join("\n"));
  assert.deepEqual(got, { project: "saasreport", workers: [
    { name: "site-mail-sender", wrangler: "workers/mail-sender/wrangler.toml" }, { name: "site-comms-engine", wrangler: "workers/comms-engine/wrangler.toml" },
    { name: "site-monitor", wrangler: "workers/monitor/wrangler.toml" }, { name: "site-web", wrangler: "wrangler.toml" }] });
  assert.deepEqual(kit.validator.validate(got, kit.byName("release-workers")), []);
  assert.notDeepEqual(kit.validator.validate({ project: "x", workers: [{ name: "a" }] }, kit.byName("release-workers")), [], "a Worker without its wrangler path is off the contract");
});

test("release: a Worker with workers_dev true needs the account subdomain (schema), and readServed never skips a declared Worker silently (Codex on #148)", async () => {
  const { readServed } = await import("../src/release/run.js");
  const doc = { workers: [] };   // no top-level workers_dev
  const r = await readServed(doc, [{ name: "mon", wrangler: "workers/monitor/wrangler.toml", workers_dev: true }], async () => { throw new Error("never fetched"); });
  assert.deepEqual(r.served, {}); assert.equal(r.unreadable.length, 1); assert.match(r.unreadable[0], /^mon: no build endpoint can be derived/);
  const problems = (d) => kit.validator.validate(d, kit.byName("release")).length;
  const base = releaseDocOf();
  assert.equal(problems(base), 0);
  const { workers_dev, ...noSub } = base;
  assert.ok(problems(noSub) > 0, "a workers_dev Worker with no top-level subdomain is refused by the schema");
  assert.equal(problems({ ...noSub, workers: noSub.workers.filter((w) => !w.workers_dev) }), 0, "no workers_dev Worker: the subdomain is optional");
});

test("drill-proof-in-records: a drill proof outside workflows.ci.records.paths is refused (the records step would never commit it); under it, with placeholders, it passes", async () => {
  const bad = await txt(fixture(({ rel }) => { rel.drills[0].proof = "proofs/alert.json"; }));
  assert.match(bad, /drill-proof-in-records: drill alert:site-journeys writes its proof to proofs\/alert\.json, which is outside workflows\.ci\.records\.paths/);
  const release = await txt(fixture(({ rel }) => { rel.drills[0].proof = "release/proofs/alert-{date}.json"; }));
  assert.match(release, /drill-proof-in-records/, "release/ is not a records path: only release.json and the two receipts are");
  assert.doesNotMatch(await txt(fixture(({ rel }) => { rel.drills[0].proof = "resilience/drills/alert-{date}-{run}.json"; })), /drill-proof-in-records/);
  assert.doesNotMatch(await txt(fixture()), /drill-proof-in-records/);
  // the site's own records.paths widens it: the same constant the trigger ignores
  const own = await txt(fixture(({ rel, w }) => { rel.drills[0].proof = "proofs/alert.json"; w("kit.canon.json", JSON.stringify({ workflows: { ci: { records: { paths: ["proofs/**", "resilience/drills/**"] } } } })); }));
  assert.doesNotMatch(own, /drill-proof-in-records/);
});

test("records-check-by-push-event: the records check comes from a push, never workflow_dispatch; a template that dispatches, pushes with the token, or whose tested workflow ignores the records branch is refused", async () => {
  const prod = TEMPLATE("production.yml");
  assert.doesNotMatch(await txt(fixture()), /records-check-by-push-event/, "the kit's own templates pass");
  // must fail: the check replaced by a dispatched run (the old design: GitHub does not let it satisfy a required check)
  const dispatched = prod.replace(/(gh pr create[\s\S]*?\n)(\s*)(?=\S*$)/, "$1$2").replace(/\n$/, "") + '\n          gh workflow run test.yml --ref "${branch}"\n';
  let t = await txt(fixture(({ w }) => w(".github/workflows/production.yml", dispatched)));
  assert.match(t, /records-check-by-push-event: .*the job that opens the records pull request dispatches a run \(gh workflow run test\.yml/);
  // must fail: pushed with the token (no deploy key), so the push starts no workflow
  t = await txt(fixture(({ w }) => w(".github/workflows/production.yml", prod.replace("          ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}\n", "          persist-credentials: true\n"))));
  assert.match(t, /records-check-by-push-event: .*the step before the push does not check out with `ssh-key/);
  // must fail: the tested workflow does not run on the push of the records branch
  t = await txt(fixture(({ w }) => w(".github/workflows/test.yml", TEMPLATE("test.yml").replace("branches: [main, 'resilience-records/**']", "branches: [main]"))));
  assert.match(t, /records-check-by-push-event: no workflow named test lists resilience-records\/\*\* in on\.push\.branches/);
});

test("records-check-by-push-event reads the records job as structure: the key on another step, a token push, an echoed dispatch and a rerouted remote are refused", async () => {
  const prod = TEMPLATE("production.yml");
  const push = '          git push origin "HEAD:refs/heads/${branch}"   # over SSH with the deploy key: this push starts the tested workflow on the records branch\n';
  assert.ok(prod.includes(push) && prod.includes("          ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}\n"), "the template shape the cases rewrite");
  const run = async (yml) => txt(fixture(({ w }) => w(".github/workflows/production.yml", yml)));
  // the key named on an unrelated step (a `with` of another action) while the checkout carries no ssh-key
  let t = await run(prod.replace("          ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}\n", "          persist-credentials: true\n").replace("      - uses: actions/setup-node@v4\n        with:\n", "      - uses: actions/setup-node@v4\n        with:\n          token: ${{ secrets.RECORDS_DEPLOY_KEY }}\n"));
  assert.match(t, /records-check-by-push-event: .*the step before the push does not check out with `ssh-key/);
  // the checkout has the key and a token: persisted credentials of the token win for https remotes
  t = await run(prod.replace("          ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}\n", "          ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}\n          token: ${{ github.token }}\n"));
  assert.match(t, /records-check-by-push-event: .*and no `token`/);
  // checkout with the key, but pushed to an https URL carrying the token (starts no workflow)
  t = await run(prod.replace(push, '          git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/${branch}"\n'));
  assert.match(t, /records-check-by-push-event: .*reroutes git to a token or URL/);
  assert.match(t, /records-check-by-push-event: .*the push is `git push "https:/);
  // remote set-url before an otherwise plain push
  t = await run(prod.replace(push, '          git remote set-url origin "https://github.com/${GITHUB_REPOSITORY}.git"\n' + push));
  assert.match(t, /records-check-by-push-event: .*reroutes git to a token or URL \(git remote set-url/);
  // a dispatched run is a command; an echo or a comment that only names it is not
  t = await run(prod.replace(push, push + '          gh workflow run test.yml --ref "${branch}"\n'));
  assert.match(t, /records-check-by-push-event: .*dispatches a run \(gh workflow run test\.yml/);
  t = await run(prod.replace(push, push + '          echo "not gh workflow run, not /dispatches"\n          # gh workflow run test.yml\n'));
  assert.doesNotMatch(t, /records-check-by-push-event/, "naming the dispatch in an echo or a comment is not a dispatch");
  // a push option that reroutes the remote (extra header) is not the plain ssh push
  t = await run(prod.replace(push, '          git -c "http.extraheader=AUTHORIZATION: bearer ${GH_TOKEN}" push origin "HEAD:refs/heads/${branch}"\n'));
  assert.match(t, /records-check-by-push-event: .*the push is `git -c/);
});

// the deployer's workflow (a central deploy repository), reduced to what `kit release deployer-check` reads
const DEPLOY = (steps) => `name: deploy\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    steps:\n${steps.map((st) => {
  const { name, run, env, ...extra } = st;
  const runYaml = String(run).includes("\n") ? `run: |\n${String(run).split("\n").map((l) => `          ${l}`).join("\n")}` : `run: ${run}`;
  return `      - name: ${name}\n        ${runYaml}\n${Object.entries(extra).map(([k, v]) => `        ${k}: ${v}\n`).join("")}${env ? `        env:\n${Object.entries(env).map(([k, v]) => `          ${k}: ${v}`).join("\n")}\n` : ""}`;
}).join("")}`;
const KEY = { name: "key", run: "node bin/deployer.mjs key --project x" };
const HEADCHECK = { name: "head-check", run: "node vendor/kit/packages/cli/bin/kit.js release head-check", env: { KIT_RELEASE_ENVIRONMENT: "x", KIT_RELEASE_SOURCE_REPOSITORY: "y", KIT_RELEASE_SOURCE_SHA: "z", GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=keys/known_hosts" } };
const REREAD = { name: "main's HEAD now (git ls-remote)", run: 'node bin/deployer.mjs head --project "${PROJECT}" --planned "${PLANNED}"' };
const UNLOAD = { name: "key leaves ssh-agent", run: "node bin/deployer.mjs unload" };
const SHIP = { name: "ship", run: "node vendor/kit/packages/cli/bin/kit.js release ship", env: { KIT_RELEASE_ENVIRONMENT: "x", KIT_RELEASE_SOURCE_REPOSITORY: "y", KIT_RELEASE_SOURCE_SHA: "z", GH_TOKEN: "t" } };
const problemsOf = (steps) => deployerWorkflowProblems(DEPLOY(steps)).map((x) => x.problem);

test("deployer-check: ship immediately preceded by the ls-remote re-read (only a key unload between) passes; every other shape fails", () => {
  assert.deepEqual(problemsOf([KEY, REREAD, SHIP]), []);
  assert.deepEqual(problemsOf([KEY, REREAD, UNLOAD, SHIP]), [], "the key leaves ssh-agent before the source's kit runs");
  assert.deepEqual(problemsOf([KEY, HEADCHECK, SHIP]), [], "kit release head-check, with the identity env and the pinned host key");
  // must-fail (Codex on #147): a raw ls-remote compares nothing, its output can be discarded and the step still passes
  for (const raw of ["git ls-remote -- git@github.com:o/r.git refs/heads/main", "git ls-remote git@github.com:o/r.git refs/heads/main > /dev/null", "git ls-remote git@github.com:o/r.git refs/heads/main || true"]) {
    const ps = problemsOf([KEY, { name: "ls-remote", run: raw }, SHIP]);
    assert.equal(ps.length, 1, raw); assert.match(ps[0], /raw git ls-remote/);
  }
  assert.equal(problemsOf([KEY, { ...HEADCHECK, env: { KIT_RELEASE_ENVIRONMENT: "x" } }, SHIP]).length, 3, "head-check without the source sha, repository and pinned host key");
  assert.equal(problemsOf([KEY, SHIP]).length, 1, "no re-read at all");
  assert.equal(problemsOf([KEY, REREAD, { name: "npm ci", run: "npm ci" }, SHIP]).length, 1, "source code runs between the re-read and ship");
  assert.equal(problemsOf([KEY, REREAD, { name: "kit", run: "node vendor/kit/packages/cli/bin/kit.js release build" }, SHIP]).length, 1);
  assert.equal(problemsOf([REREAD, SHIP]).length, 1, "the deploy key is never loaded");
  assert.equal(problemsOf([KEY, { name: "api", run: "gh api repos/o/r/commits/main --jq .sha" }, SHIP]).length, 1, "an API read is no re-read");
  assert.equal(problemsOf([KEY, { name: "head", run: "gh api repos/o/r/commits/main && node bin/deployer.mjs head" }, SHIP]).length, 1, "the re-read must not be an API call");
  assert.equal(problemsOf([KEY, REREAD, { ...SHIP, env: { KIT_RELEASE_ENVIRONMENT: "x" } }]).length, 2, "the ship step names the source repository and sha");
  for (const bad of ["SOURCE_ACCESS_TOKEN", "GH_APP_PRIVATE_KEY", "GITHUB_APP_TOKEN", "DEPLOY_PAT", "GH_SOURCE_TOKEN", "GITHUB_PAT_X"]) assert.equal(problemsOf([KEY, REREAD, { ...SHIP, env: { ...SHIP.env, [bad]: "t" } }]).length, 1, `${bad}: a source-reading credential is refused`);
  // the project's declared Worker secrets pass whatever their suffix (Codex on #147, P2): never a blanket *_TOKEN rule
  const withSecrets = (names) => deployerWorkflowProblems(DEPLOY([KEY, REREAD, { ...SHIP, env: { ...SHIP.env, ...Object.fromEntries(names.map((n) => [n, "t"])) } }]), { declared: ["MONITOR_TOKEN", "TELEGRAM_BOT_TOKEN"] }).map((x) => x.problem);
  assert.deepEqual(withSecrets(["MONITOR_TOKEN", "TELEGRAM_BOT_TOKEN", "FORMS_DRILL_KEY", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "KIT_RELEASE_SECRETS"]), []);
  assert.deepEqual(problemsOf([KEY, REREAD, { ...SHIP, env: { ...SHIP.env, MONITOR_TOKEN: "t" } }]), [], "not a source credential by name, declared or not");
  assert.equal(withSecrets(["SOURCE_GH_ACCESS"]).length, 1);
  assert.equal(problemsOf([KEY, REREAD, { name: "x", run: "echo" }]).length, 1, "no ship step");
  assert.equal(deployerWorkflowProblems("jobs: [unclosed").length, 1, "an unreadable workflow is a problem");
});

test("deployer-check (Codex round 2): a re-read whose outcome cannot fail the job is a finding, naming the mask; the plain and the always-true forms pass", () => {
  const masked = (extra, run) => problemsOf([KEY, { ...HEADCHECK, ...(run ? { run } : {}), ...extra }, SHIP]);
  const HC = HEADCHECK.run;
  // must-fail, one per mask form
  const cases = [
    ["continue-on-error: true", { "continue-on-error": "true" }, null, /continue-on-error/],
    ["continue-on-error as an expression", { "continue-on-error": "${{ true }}" }, null, /continue-on-error/],
    ["a non-trivial if", { if: "github.event_name == 'push'" }, null, /if: github\.event_name/],
    ["if: false", { if: "false" }, null, /if: false/],
    ["|| true", {}, `${HC} || true`, /\|\| true/],
    ["|| :", {}, `${HC} || :`, /\|\| true/],
    ["|| exit 0", {}, `${HC} || exit 0`, /\|\| true/],
    ["set +e", {}, `set +e\n${HC}`, /set \+e/],
    ["a trailing ; true", {}, `${HC}; true`, /trailing ;/],
    ["a pipe without pipefail", {}, `${HC} | tee head.log`, /pipe without set -o pipefail/],
    ["a background &", {}, `${HC} &`, /background &/],
    ["another command after it", {}, `${HC}\necho done`, /another command follows/],
  ];
  for (const [what, extra, run, re] of cases) {
    const ps = masked(extra, run);
    assert.ok(ps.some((x) => /cannot fail the job/.test(x) && re.test(x)), `${what}: ${ps.join(" | ")}`);
  }
  // must-pass: the plain step, an always-true if, pipefail with a pipe, set -e, a comment, continue-on-error: false
  assert.deepEqual(masked({}, null), []);
  for (const extra of [{ if: "true" }, { if: "${{ true }}" }, { if: "success()" }, { if: "always()" }, { "continue-on-error": "false" }]) assert.deepEqual(masked(extra, null), [], JSON.stringify(extra));
  assert.deepEqual(masked({}, `set -euo pipefail\n# the re-read\n${HC}`), []);
  assert.deepEqual(masked({}, `set -o pipefail\n${HC} | tee head.log`), []);
  // deployer.mjs head is held to the same rules
  assert.equal(problemsOf([KEY, { ...REREAD, run: `${REREAD.run} || true` }, SHIP]).filter((x) => /cannot fail the job/.test(x)).length, 1);
});

test("deployer-check (Codex round 3): a step runs a command by invocation, never by text; an intervening unload step is the unload only", () => {
  // must-fail: the text of the re-read inside another command is no re-read (the job would pass without executing any re-read)
  for (const fake of ['echo "kit release head-check"', "echo node bin/deployer.mjs head", "# node bin/deployer.mjs head\necho skipped", 'printf "%s" "kit release head-check" > head.log']) {
    const ps = problemsOf([KEY, { name: "fake", run: fake }, SHIP]);
    assert.ok(ps.some((x) => /no step re-reads main's HEAD/.test(x)), `${fake}: ${ps.join(" | ")}`);
  }
  assert.ok(problemsOf([KEY, { ...HEADCHECK, run: `${HEADCHECK.run}\necho "kit release head-check"` }, SHIP]).some((x) => /another command follows/.test(x)), "the echo of the re-read is not the re-read as the last command");
  // must-fail: a step between the re-read and ship that unloads the key AND does anything else is not an unload step
  for (const extra of ["node bin/deployer.mjs unload && echo '{}' > release.json", "node bin/deployer.mjs unload; sed -i s/a/b/ wrangler.toml", "cp x release.json\nnode bin/deployer.mjs unload", "echo node bin/deployer.mjs unload"]) {
    const ps = problemsOf([KEY, REREAD, { name: "unload+", run: extra }, SHIP]);
    assert.ok(ps.some((x) => /sits between them/.test(x)), `${extra}: ${ps.join(" | ")}`);
  }
  // must-pass: the unload alone, with a launcher path, an env assignment or two unload steps; a ship step with VAR=value prefixes
  assert.deepEqual(problemsOf([KEY, REREAD, { name: "u", run: "CI=1 node ./bin/deployer.mjs unload --quiet" }, UNLOAD, SHIP]), []);
  assert.deepEqual(problemsOf([KEY, REREAD, { ...SHIP, run: `KIT_X=1 npx kit release ship` }]), []);
  // the key load and the raw ls-remote are read the same way
  assert.equal(problemsOf([{ name: "k", run: "echo ssh-add" }, REREAD, SHIP]).length, 1, "an echoed ssh-add loads no key");
  assert.ok(problemsOf([KEY, { name: "raw", run: "cd src && git ls-remote origin main" }, SHIP]).some((x) => /raw git ls-remote/.test(x)));
  // commandsOf and invocationOf
  assert.deepEqual(commandsOf("set -e\n# c\na && b; c\n"), ["set -e", "a", "b", "c"]);
  assert.equal(invocationOf("A=1 B=2 node vendor/kit/packages/cli/bin/kit.js release ship --x"), "kit.js release ship --x");
  assert.equal(invocationOf("npx kit release ship"), "kit release ship");
  assert.equal(invocationOf("node scripts/kit.mjs release ship"), "kit.mjs release ship", "the bootstrap of a site at t=0");
  assert.deepEqual(problemsOf([KEY, REREAD, { ...SHIP, run: "node scripts/kit.mjs release ship" }]), [], "a ship through the bootstrap (kit.mjs) is a ship");
  assert.ok(problemsOf([KEY, REREAD, { ...SHIP, run: "node scripts/kit.mjs release drills" }]).some((p) => /no step runs `kit release ship`/.test(p)), "and only ship is ship");
});

test("deployer-check through the CLI: exit codes", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "good.yml"), DEPLOY([KEY, REREAD, SHIP])); writeFileSync(join(dir, "bad.yml"), DEPLOY([KEY, SHIP]));
  const run = async (arg) => { const out = [], err = []; const code = await release({ cwd: dir, env: {}, out: (m) => out.push(m), err: (m) => err.push(m) }, { _: ["deployer-check", arg], flags: {} }); return { code, out, err }; };
  assert.equal((await run("good.yml")).code, 0);
  const bad = await run("bad.yml");
  assert.equal(bad.code, 1); assert.ok(bad.err.length >= 2);
  await assert.rejects(run(undefined), /name the deployer's workflow file/);
});

test("the kit holds no source-repository API token: no mention in code, schemas or docs (central mode trusts the deployer's ls-remote re-read)", () => {
  const word = ["SOURCE", "GH", "TOKEN"].join("_");
  const files = ["packages/cli/src/release/run.js", "packages/cli/src/release/config.js", "packages/cli/src/commands/release.js", "packages/core/schemas/release.schema.json", "docs/RELEASE.md", "templates/ci/production.yml", "templates/ci/drift.yml"];
  for (const f of files) assert.ok(!readFileSync(join(KITROOT, f), "utf8").includes(word), `${f} mentions the source token`);
});

test("ship writes EVERY secret the monitors declare from the environment to its Workers; one absent refuses before any deploy; a value never appears in argv or the log", async () => {
  const root = fixture(({ rel, res, w }) => {
    // the monitor's config module declares the form drill: FORMS_DRILL_KEY joins its required secrets (kit resilience secrets: the one source)
    w("monitor.config.js", "export default { monitor: { drill: { form: 'contact' } } };\n");
    res.monitors[0].config = { module: "monitor.config.js" };
    rel.secrets = [{ name: "FORMS_DRILL_KEY", wrangler: "wrangler.toml" }];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const lines = [];
  const f = fakes(root);
  f.deps.env = { ...f.deps.env, FORMS_DRILL_KEY: "drill-key-fixture" };
  f.deps.log = (m) => lines.push(m);
  await ship(root, f.deps);
  const puts = f.calls.filter((c) => c.startsWith("wrangler secret put"));
  assert.deepEqual(puts, [
    "wrangler secret put FORMS_DRILL_KEY -c workers/monitor/wrangler.toml <stdin>", "wrangler secret put FORMS_DRILL_KEY -c wrangler.toml <stdin>", "wrangler secret put MONITOR_TOKEN -c workers/monitor/wrangler.toml <stdin>",
    "wrangler secret put OPS_NOTIFY_TO -c workers/comms-engine/wrangler.toml <stdin>", "wrangler secret put MONITOR_NOTIFY_TO -c workers/monitor/wrangler.toml <stdin>"]);
  assert.ok(![...f.calls, ...lines].some((c) => /drill-key-fixture|monitor-token-fixture/.test(c)), "no value in argv or the log");
  // the secrets map of the environment (toJSON(secrets)) is read too
  const g = fakes(root);
  g.deps.env = { ...g.deps.env, KIT_RELEASE_SECRETS: JSON.stringify({ FORMS_DRILL_KEY: "from-the-map" }) };
  writeSeal(root, ["site"], { commit: SHA, build: "x" }); g.deps.env.SEAL_SHA256 = sealOf(root);
  await ship(root, g.deps);
  assert.equal(g.calls.filter((c) => c.includes("secret put FORMS_DRILL_KEY")).length, 2);
  // must-fail: a declared secret absent from the environment: nothing is created, migrated or deployed
  for (const missing of ["FORMS_DRILL_KEY", "MONITOR_TOKEN"]) {
    const h = fakes(root);
    delete h.deps.env[missing]; h.deps.env.FORMS_DRILL_KEY ??= undefined; if (missing === "MONITOR_TOKEN") h.deps.env.FORMS_DRILL_KEY = "drill-key-fixture";
    await assert.rejects(ship(root, h.deps), new RegExp(`the environment lacks ${missing}`));
    assert.deepEqual(h.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create") || c.startsWith("run")), [], `${missing}: nothing changed`);
  }
  // A runtime secret may be required by an application Worker without being a monitor secret.
  const validRuntime = fixture(({ rel }) => {
    rel.secrets = [{ name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" }];
  });
  assert.deepEqual((await check(validRuntime)).problems, [],
    "explicit app runtime secrets are governed release contract entries");
  const bad = fixture(({ rel }) => {
    rel.secrets = [
      { name: "DEVELOPER_KEY_PEPPER", wrangler: "workers/other/wrangler.toml" },
      { name: "OPS_NOTIFY_TO", wrangler: "wrangler.toml" },
    ];
  });
  const t = await txt(bad);
  assert.match(t, /declared-secrets-written: secrets DEVELOPER_KEY_PEPPER names workers\/other\/wrangler\.toml, which is not a release worker/);
  assert.match(t, /declared-secrets-written: secrets OPS_NOTIFY_TO is reserved for owner-address delivery/);
  assert.ok(!/one-owner-address: secrets /.test(t),
    "invalid runtime destinations are reported under their own canon rule");
  assert.deepEqual((await check(fixture(({ rel, res, w }) => { w("monitor.config.js", "export default { monitor: { drill: { form: 'c' } } };\n"); res.monitors[0].config = { module: "monitor.config.js" }; rel.secrets = [{ name: "FORMS_DRILL_KEY", wrangler: "wrangler.toml" }]; }))).problems, []);
});

test("runtime secret requirements are admitted before any Cloudflare writes and secret bytes stay private", async () => {
  const root = fixture(({ rel }) => {
    rel.secrets = [{ name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" }];
  });
  writeSeal(root, ["site"], { commit: SHA, build: "x" });
  const f = fakes(root);
  await assert.rejects(ship(root, f.deps), /environment lacks DEVELOPER_KEY_PEPPER/);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("wrangler") || c.startsWith("create")), [],
    "missing runtime pepper fails before any Cloudflare changes");
  const g = fakes(root), logs = [];
  g.deps.env.DEVELOPER_KEY_PEPPER = "secret-pepper-test-only-value";
  g.deps.log = (line) => logs.push(line);
  await ship(root, g.deps);
  assert.ok(g.calls.some((c) => c.includes("secret put DEVELOPER_KEY_PEPPER -c wrangler.toml <stdin>")));
  assert.ok(!JSON.stringify([...g.calls, ...logs]).includes("secret-pepper-test-only-value"));
});

test("head-check (Codex on #147): ls-remote of the source's main must equal KIT_RELEASE_SOURCE_SHA and the checkout's HEAD; every mismatch, an unreadable answer and an unpinned host key refuse", async () => {
  const doc = { ...releaseDoc(), environment: "production", deployer: CENTRAL };
  const PIN = "ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=keys/known_hosts";
  const env = (o = {}) => centralEnv({ GIT_SSH_COMMAND: PIN, ...o });
  const ok = (sha = SHA) => ({ doc, kit, env: env(), lsRemote: async () => `${sha}\trefs/heads/main\n`, checkoutHead: async () => SHA });
  assert.deepEqual(await headCheck(ok()), { repository: "SaasReport/core", sha: SHA });
  const asked = []; await headCheck({ ...ok(), lsRemote: async (r) => { asked.push(r); return `${SHA} refs/heads/main`; } });
  assert.deepEqual(asked, ["SaasReport/core"], "the registered source repository is read");
  const refused = async (deps, re) => assert.rejects(headCheck(deps), (e) => e instanceof HeadCheckError && re.test(e.message));
  await refused(ok(OLD), /main is d{40}, not KIT_RELEASE_SOURCE_SHA c{40}/);                                       // main moved
  await refused({ ...ok(), checkoutHead: async () => OLD }, /the checkout is at d{40}, not c{40}/);                     // another tree
  await refused({ ...ok(), checkoutHead: async () => { throw new Error("no git"); } }, /checkout's HEAD cannot be read/);
  await refused({ ...ok(), lsRemote: async () => "" }, /0 line\(s\)/);                                                   // an empty answer
  await refused({ ...ok(), lsRemote: async () => `${SHA} refs/heads/main\n${OLD} refs/heads/main\n` }, /2 line\(s\)/);
  await refused({ ...ok(), lsRemote: async () => `${SHA} refs/heads/dev\n` }, /not exactly refs\/heads\/main/);
  await refused({ ...ok(), lsRemote: async () => "not-a-sha\trefs/heads/main" }, /is not a commit/);
  await refused({ ...ok(), lsRemote: async () => { throw new Error("Permission denied (publickey)"); } }, /ls-remote of SaasReport\/core failed \(Permission denied \(publickey\)\): refused/);
  await refused({ ...ok(), env: env({ GIT_SSH_COMMAND: "ssh" }) }, /StrictHostKeyChecking=yes/);
  await refused({ ...ok(), env: env({ GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=yes" }) }, /UserKnownHostsFile/);
  await refused({ ...ok(), env: env({ GIT_SSH_COMMAND: undefined }) }, /GIT_SSH_COMMAND/);
  await refused({ ...ok(), env: env({ KIT_RELEASE_SOURCE_REPOSITORY: "fork-owner/app" }) }, /not a repository the kit project registry lists/);
  await refused({ ...ok(), env: env({ KIT_RELEASE_SOURCE_SHA: "main" }) }, /not a 40-hex commit/);
  await refused({ ...ok(), doc: { ...releaseDoc(), environment: "production" }, env: drillEnv({ GIT_SSH_COMMAND: PIN }) }, /central mode/);
  assert.throws(() => parseLsRemote("garbage"), HeadCheckError);
  // through the CLI: exit codes, with the ls-remote and checkout seams (no network, no ssh)
  const root = fixture(({ rel }) => { rel.deployer = CENTRAL; });
  const run = async (lsOut, e = env()) => { const out = [], err = []; const code = await release({ cwd: root, env: e, out: (m) => out.push(m), err: (m) => err.push(m), lsRemote: async () => lsOut, checkoutHead: async () => SHA }, { _: ["head-check"], flags: {} }); return { code, out, err }; };
  assert.equal((await run(`${SHA} refs/heads/main`)).code, 0);
  const bad = await run(`${OLD} refs/heads/main`);
  assert.equal(bad.code, 1); assert.match(bad.err.join(), /not KIT_RELEASE_SOURCE_SHA/);
});

test("review-marker --post-status (Codex round 2): the verdict is a commit status on the PR's head, re-posted from every comment event, so a marker edited to blocked or deleted fails it at once", async () => {
  const HEAD = "a".repeat(40);
  const state = { head: HEAD, comments: [], posted: [], hook: null };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") { state.posted.push({ url: u, ...JSON.parse(init.body) }); state.hook?.(); return Response.json({}); }
    if (/\/pulls\/7$/.test(u)) return Response.json({ head: { sha: state.head } });
    if (/\/commits\/([0-9a-f]{40})\/statuses/.test(u)) { const sha = /commits\/([0-9a-f]{40})/.exec(u)[1]; return Response.json(state.posted.filter((x) => x.url.endsWith(`/${sha}`)).reverse()); }   // newest first, as GitHub lists them
    const page = Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? 1);
    return Response.json(state.comments.slice((page - 1) * 100, page * 100));
  };
  const run = (o = {}) => reviewMarker({ owner: "007dude", repository: "o/r", pr: 7, token: "t", fetch, post: true, ...o });
  const last = () => state.posted.at(-1);
  const clean = { id: 1, user: { login: "007dude" }, body: markerText(HEAD), created_at: "2026-10-14T01:00:00Z", updated_at: "2026-10-14T01:00:00Z" };
  // green: a clean marker posts success on the PR's head, with the context the ruleset requires
  state.comments = [clean];
  assert.equal((await run()).ok, true);
  assert.deepEqual([last().url, last().state, last().context], [`https://api.github.com/repos/o/r/statuses/${HEAD}`, "success", "independent-review"]);
  // the owner EDITS the marker to blocked after the green run: the comment event re-runs the check and the status turns failure
  state.comments = [{ ...clean, body: markerText(HEAD, "blocked"), updated_at: "2026-10-14T02:00:00Z" }];
  assert.equal((await run()).ok, false);
  assert.deepEqual([last().state, last().context], ["failure", "independent-review"]);
  assert.match(last().description, /verdict=blocked/);
  // DELETED: no marker, failure
  state.comments = [];
  assert.equal((await run()).ok, false); assert.equal(last().state, "failure");
  // an older comment edited to blocked after a newer clean one counts from its edit (the latest edit wins)
  state.comments = [{ ...clean, id: 2, created_at: "2026-10-14T03:00:00Z", updated_at: "2026-10-14T03:00:00Z" }, { ...clean, id: 1, body: markerText(HEAD, "blocked"), created_at: "2026-10-14T01:00:00Z", updated_at: "2026-10-14T04:00:00Z" }];
  assert.equal((await run()).ok, false);
  // Codex on kit #149: clean (1), then blocked (2), then the blocking comment DELETED must not promote the older clean marker (1)
  state.posted = [];
  const c1 = { ...clean, id: 1 }, c2 = { ...clean, id: 2, body: markerText(HEAD, "blocked"), created_at: "2026-10-14T02:00:00Z", updated_at: "2026-10-14T02:00:00Z" };
  state.comments = [c1]; assert.equal((await run()).ok, true);
  state.comments = [c1, c2]; assert.equal((await run()).ok, false); assert.match(last().description, /blocked by comment 2/);
  state.comments = [c1];
  assert.equal((await run()).ok, false, "a deleted blocker does not promote the older clean marker");
  assert.match(last().description, /a blocking marker was deleted: post a new marker/);
  assert.equal((await run()).ok, false, "and it stays failure on the next event");
  // must pass: clean, blocked, then a NEW clean marker (a later comment)
  state.comments = [c1, c2, { ...clean, id: 3, created_at: "2026-10-14T03:00:00Z", updated_at: "2026-10-14T03:00:00Z" }];
  assert.equal((await run()).ok, true); assert.equal(last().state, "success");
  state.posted = [];
  // a stranger's marker never turns it green; a new push (another head) posts failure on the NEW head
  state.comments = [{ ...clean, user: { login: "someone" } }];
  assert.equal((await run()).ok, false);
  state.comments = [clean]; state.head = "b".repeat(40);
  assert.equal((await run()).ok, false);
  assert.equal(last().url, `https://api.github.com/repos/o/r/statuses/${"b".repeat(40)}`);
  state.head = HEAD;
  // two events racing: the marker is edited to blocked WHILE a run is posting success; the run reads again and posts the latest
  state.comments = [clean]; state.posted = [];
  state.hook = () => { if (state.posted.length === 1) state.comments = [{ ...clean, body: markerText(HEAD, "blocked"), updated_at: "2026-10-14T05:00:00Z" }]; };
  const raced = await run();
  state.hook = null;
  assert.deepEqual(state.posted.map((x) => x.state), ["success", "failure"], "the stale success is followed by the latest verdict");
  assert.equal(raced.ok, false);
  // a status that cannot be posted is a refusal, never a pass
  const broken = await reviewMarker({ owner: "007dude", repository: "o/r", pr: 7, token: "t", post: true, fetch: async (u, init = {}) => (init.method === "POST" ? new Response("{}", { status: 403 }) : fetch(u, init)) });
  assert.equal(broken.ok, false); assert.match(broken.reason, /cannot be posted as a status/);
  assert.equal(broken.posted, undefined, "nothing stands on the head: that is an error, never a posted verdict");
  // without --post-status nothing is posted
  state.comments = [clean]; state.posted = []; assert.equal((await run({ post: false })).ok, true); assert.deepEqual(state.posted, []);
  assert.equal((await run({ post: false })).posted, undefined);
  // `posted`: the status that stands on the head is the final verdict, success or failure
  state.comments = [clean]; assert.equal((await run()).posted, true);
  state.comments = []; { const r = await run(); assert.deepEqual([r.ok, r.posted], [false, true]); }
});

// The verdict is the STATUS (the ruleset reads the status, never the job). A job that went red for every "not reviewed yet" was a failed-run
// notification and billable minutes for something the status already said: with --post-status the command exits 0 once it has posted.
test("review-marker --post-status exits 0 once the verdict is posted as the status, success or failure; the exit code is the verdict only without it, or when nothing could be posted", async () => {
  const HEAD = "a".repeat(40);
  const root = fixture(({ w }) => w("kit.canon.json", JSON.stringify({ project: "saasreport" })));   // the owner of the registry project (007dude) is the marker's author
  const state = { comments: [], posted: [], deny: false };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST") return state.deny ? new Response("{}", { status: 403 }) : (state.posted.push(JSON.parse(init.body)), Response.json({}));
    if (/\/pulls\/7$/.test(u)) return Response.json({ head: { sha: HEAD } });
    if (/\/statuses/.test(u)) return Response.json([]);
    return Response.json(Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? 1) === 1 ? state.comments : []);
  };
  const cli = async (flags) => { const out = [], err = []; const code = await release({ cwd: root, env: { GITHUB_REPOSITORY: "o/r", GH_TOKEN: "t" }, out: (m) => out.push(m), err: (m) => err.push(m), fetch }, { _: ["review-marker"], flags: { pr: "7", ...flags } }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const clean = { id: 1, user: { login: "007dude" }, body: markerText(HEAD), created_at: "2026-10-14T01:00:00Z", updated_at: "2026-10-14T01:00:00Z" };
  // not reviewed yet: the status says failure, and the job that posted it succeeded
  const unreviewed = await cli({ "post-status": true });
  assert.equal(unreviewed.code, 0, unreviewed.err);
  assert.match(unreviewed.out, /posted failure on the head: .*no independent-review marker/);
  assert.equal(state.posted.at(-1).state, "failure");
  // reviewed: success
  state.comments = [clean];
  const reviewed = await cli({ "post-status": true });
  assert.equal(reviewed.code, 0); assert.match(reviewed.out, /posted success on the head/); assert.equal(state.posted.at(-1).state, "success");
  // without --post-status the exit code IS the verdict (a person running the check, a script)
  state.comments = [];
  const bare = await cli({});
  assert.equal(bare.code, 1); assert.match(bare.err, /FAIL independent-review: no independent-review marker/);
  state.comments = [clean]; assert.equal((await cli({})).code, 0);
  // nothing could be posted: an error, red
  state.deny = true; state.comments = [];
  const denied = await cli({ "post-status": true });
  assert.equal(denied.code, 1); assert.match(denied.err, /cannot be posted as a status/);
});

test("review-marker (governance independent_review_marker): only the owner's clean marker for the PR's current head passes; a new head, a stranger, a later verdict and an unreadable PR fail", async () => {
  const HEAD = "a".repeat(40), NEWER = "b".repeat(40);
  const api = ({ head = HEAD, comments = [], status = 200 } = {}) => async (url) => {
    const u = String(url);
    if (status !== 200) return new Response("{}", { status });
    if (/\/pulls\/7$/.test(u)) return Response.json({ head: { sha: head } });
    if (/\/statuses/.test(u)) return Response.json([]);
    const page = Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? 1);
    return Response.json(comments.slice((page - 1) * 100, page * 100));
  };
  const c = (login, body, at) => ({ user: { login }, body, created_at: at });
  const run = (o) => reviewMarker({ owner: "007dude", repository: "o/r", pr: 7, head: HEAD, token: "t", fetch: api(o) });
  { const r0 = await run({ comments: [c("007dude", `reviewed ${markerText(HEAD)}`, "2026-10-14T01:00:00Z")] }); assert.equal(r0.ok, true, r0.reason); }
  assert.equal((await run({ comments: [c("007DUDE", markerText(HEAD), "2026-10-14T01:00:00Z")] })).ok, true, "GitHub logins are case-insensitive");
  const no = async (o, re) => { const r = await run(o); assert.equal(r.ok, false); assert.match(r.reason, re); };
  await no({ comments: [] }, /no independent-review marker for a{40} by 007dude/);
  await no({ comments: [c("someone-else", markerText(HEAD), "2026-10-14T01:00:00Z")] }, /no independent-review marker/);          // the author is checked, never the body alone
  await no({ comments: [c("007dude", markerText(NEWER), "2026-10-14T01:00:00Z")] }, /no independent-review marker for a{40}/);       // a marker of another head
  await no({ head: NEWER, comments: [c("007dude", markerText(HEAD), "2026-10-14T01:00:00Z")] }, /the pull request's head is b{40}, not a{40}/);   // a new push
  await no({ comments: [c("007dude", markerText(HEAD), "2026-10-14T01:00:00Z"), c("007dude", markerText(HEAD, "blocked"), "2026-10-14T02:00:00Z")] }, /verdict=blocked/);
  assert.equal((await run({ comments: [c("007dude", markerText(HEAD, "blocked"), "2026-10-14T01:00:00Z"), c("007dude", markerText(HEAD), "2026-10-14T02:00:00Z")] })).ok, true, "the latest verdict counts");
  await no({ comments: [c("007dude", "<!-- independent-review head=" + HEAD + " verdict=clean", "2026-10-14T01:00:00Z")] }, /no independent-review marker/);  // a truncated marker
  await no({ status: 500 }, /cannot read the pull request \(GET [^)]*500\): refused/);
  // more than one page of comments is read
  const many = [...Array.from({ length: 100 }, (_, i) => c("x", "noise", `2026-10-14T00:${String(i % 60).padStart(2, "0")}:00Z`)), c("007dude", markerText(HEAD), "2026-10-14T03:00:00Z")];
  assert.equal((await run({ comments: many })).ok, true);
  for (const [o, re] of [[{ owner: "" }, /no owner\.github/], [{ head: "x" }, /not a 40-hex/], [{ pr: "x" }, /not a pull request number/], [{ token: "" }, /GH_TOKEN is not set/]]) {
    const r = await reviewMarker({ owner: "007dude", repository: "o/r", pr: 7, head: HEAD, token: "t", fetch: api(), ...o });
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
});

test("production template maintains one serial Cloudflare writer without cancelling a live migration", () => {
  const source = TEMPLATE("production.yml");
  assert.match(source, /group: production-\$\{\{ github\.run_id \}\}/);
  assert.match(source, /  production:\n[\s\S]*?    concurrency:\n      group: production-mutation\n      cancel-in-progress: false/);
  assert.match(source, /branch="\$\(node scripts\/kit\.mjs release records branch\)"/);
  assert.match(source, /node scripts\/kit\.mjs release records paths > /);
  assert.doesNotMatch(source, /\$\{kit\}/);
});
