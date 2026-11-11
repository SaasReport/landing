// The publish chain's alerting and proof: a repository that publishes a daily podcast owes (1) a monitor that runs the `publishing` and `feeds`
// journeys and alerts through at least two declared routes, (2) a fresh publish drill per daily series whose proof is kit.podcast-drill.v1 and
// passed, (3) a release.json command that runs the drill. 2026-10-03..13: three sites published nothing for ten days and nobody was told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { bundled } from "../src/canon/index.js";
import { checkResilience } from "../src/resilience/check.js";
import { sha256File } from "../src/resilience/drills.js";
import { publishDrillNeeds } from "../src/podcast-drill.js";

const KIT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASE = fileTempDir("kit-chain-");
let SEQ = 0;
const kit = bundled();
const TODAY = "2026-10-14";
const SITE = `name = "site-web"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\n[[r2_buckets]]\nbinding = "PODCASTS"\nbucket_name = "site-podcasts"\n`;
const MONVARS = (o = {}) => Object.entries({ MONITOR_DB_ID: "mon-id", MONITOR_WATCHED_DB_IDS: "site-id", MONITOR_ROUTES: "email,telegram", MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_STALE_AFTER_MIN: "1560", MONITOR_FETCH_TIMEOUT_MS: "10000", ...o })
  .filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = "${v}"`).join("\n");
const MON = (vars = MONVARS(), d1 = `binding = "MONITOR_DB"\ndatabase_name = "mon"\ndatabase_id = "mon-id"`, extra = "") => `name = "site-monitor"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\n${d1}\n[vars]\n${vars}\n[triggers]\ncrons = ["45 2 * * *"]\n${extra}`;
const KIT = "node vendor/kit/packages/cli/bin/kit.js resilience";
const WATCH = `on:\n  schedule:\n    - cron: "7 */2 * * *"\njobs:\n  watch:\n    runs-on: ubuntu-24.04\n    permissions:\n      actions: write\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: ${KIT} keepalive --monitor site-journeys\n      - run: ${KIT} watch --monitor site-journeys\n        env:\n          MONITOR_STATUS_URL: \${{ vars.MONITOR_STATUS_URL }}\n`;


const PROOF = (o = {}) => ({
  v: 1, kind: "publish", subject: "daily", series: "daily", show: "daily", day: 20000, scheduled_at: "2026-10-13T03:00:00Z", dry: true, engine: "node:sqlite+d1-limits",
  migrations: ["migrations/0001_posts_events.sql"], commit: null, slug: "term-iban", ok: true,
  checks: ["migrations", "cron-ran", "no-errors", "row", "provenance", "audio", "feed-item", "page"].map((id) => ({ id, ok: true, detail: "ok" })), ...o,
});

/** A podcast site that passes every rule; each test breaks one thing. */
function site({ monitorConfig = 'export { default } from "./kit.config.js";\n', proof = PROOF(), drill = true, routes } = {}) {
  const root = join(BASE, `s${SEQ++}`);
  cpSync(join(KIT_ROOT, "examples/podcast-site"), root, { recursive: true });
  symlinkSync(join(KIT_ROOT, "node_modules"), join(root, "node_modules"));
  const w = (f, t) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); };
  w("podcast.config.json", "{}\n");
  w("wrangler.toml", SITE); w("monitor/wrangler.toml", MON()); w("backup.config.json", "{}\n");
  w("monitor.config.js", monitorConfig);
  w(".github/workflows/watch.yml", WATCH); w("proofs/alert.log", "alert\n"); w("proofs/restore.log", "restore\n");
  w("resilience/drills/publish-daily.json", `${JSON.stringify(proof, null, 2)}\n`);
  w("resilience/drills/publish-weekly.json", `${JSON.stringify(PROOF({ subject: "weekly", series: "weekly", show: "weekly", slug: "week-2026-10-17" }), null, 2)}\n`);
  const d = (kind, subject, file) => ({ kind, subject, date: "2026-10-10", result: "pass", proof_path: file, proof_sha256: sha256File(join(root, file)) });
  const doc = {
    $schema: "x", project: "site",
    routes: routes ?? [{ id: "mail", channel: "email" }, { id: "chat", channel: "telegram" }],
    monitors: [{ id: "site-journeys", kind: "worker", worker: { wrangler: "monitor/wrangler.toml" }, database_binding: "MONITOR_DB", watches: [{ wrangler: "wrangler.toml" }],
      config: { module: "monitor.config.js" }, root: "cloudflare", routes: (routes ?? [{ id: "mail" }, { id: "chat" }]).map((r) => r.id), stale_after_min: 1560, fetch_timeout_ms: 10000,
      dead_man: { provider: "healthchecks.io", root: "healthchecks.io", interval_min: 1440, grace_min: 120 }, watcher: { workflow: ".github/workflows/watch.yml", url_env: "MONITOR_STATUS_URL" } }],
    backups: [{ id: "site-d1", source: { kind: "d1", name: "site-id" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" },
      { id: "site-podcasts", source: { kind: "r2", name: "site-podcasts" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" }],
    drills: [d("alert", "site-journeys", "proofs/alert.log"), d("restore", "site-d1", "proofs/restore.log"), d("restore", "site-podcasts", "proofs/restore.log"), ...(drill ? [d("publish", "daily", "resilience/drills/publish-daily.json"), d("publish", "weekly", "resilience/drills/publish-weekly.json")] : [])],
  };
  w("resilience.json", JSON.stringify(doc, null, 2));
  return root;
}
const run = (root) => checkResilience(root, { resilience: {} }, kit, { today: TODAY });
const text = async (root) => (await run(root)).problems.map((p) => `${p.file}: ${p.problem}`).join("\n");

test("a podcast site with its journeys, two routes and a passed publish drill passes", async () => {
  const r = await run(site());
  assert.deepEqual(r.problems, []);
});

test("publishDrillNeeds: the podcast series of a repository that publishes podcasts, nothing elsewhere", async () => {
  assert.deepEqual((await publishDrillNeeds(site())).ids, ["weekly", "daily"], "every podcast series, not only the daily one");
  const root = join(BASE, "plain"); mkdirSync(root, { recursive: true });
  assert.deepEqual(await publishDrillNeeds(root), { ids: [], problem: null });
  const broken = site(); writeFileSync(join(broken, "kit.config.js"), "throw new Error('x');\n");
  assert.match((await publishDrillNeeds(broken)).problem, /cannot be loaded/);
});

test("MUST FAIL: routes: [] (a site with no alert route: nobody is told) fails kit resilience check, at the top level and in the monitor", async () => {
  const none = await text(site({ routes: [] }));
  assert.match(none, /kit\.resilience\.v1/);
  assert.match(none, /routes/);
  const root = site();
  const doc = JSON.parse(readFileSync(join(root, "resilience.json"), "utf8"));
  doc.monitors[0].routes = [];
  writeFileSync(join(root, "resilience.json"), JSON.stringify(doc));
  assert.match(await text(root), /routes.*(at least|must have)/i);
});

test("MUST FAIL: one route is not enough, two routes on one failure domain are not enough", async () => {
  assert.match(await text(site({ routes: [{ id: "mail", channel: "email" }] })), /routes/);
  assert.match(await text(site({ routes: [{ id: "a", channel: "telegram" }, { id: "b", channel: "bale" }] })), /fewer than two failure domains|routes/);
});

test("MUST FAIL: a monitor that skips the publishing journey, or lists only other journeys, or has no series, alerts nobody when the episode is missing", async () => {
  const skip = await text(site({ monitorConfig: 'import k from "./kit.config.js";\nexport default { ...k, monitor: { ...(k.monitor || {}), skip: ["publishing"] } };\n' }));
  assert.match(skip, /does not run the publishing journey/);
  const only = await text(site({ monitorConfig: 'import k from "./kit.config.js";\nexport default { ...k, monitor: { ...(k.monitor || {}), journeys: ["feeds"] } };\n' }));
  assert.match(only, /does not run the publishing journey/);
  assert.doesNotMatch(only, /does not run the feeds journey/);
  const noFeeds = await text(site({ monitorConfig: 'import k from "./kit.config.js";\nexport default { ...k, monitor: { ...(k.monitor || {}), skip: ["feeds"] } };\n' }));
  assert.match(noFeeds, /does not run the feeds journey/);
  const noSeries = await text(site({ monitorConfig: "export default { site: { name: 'x' } };\n" }));
  assert.match(noSeries, /does not run the publishing journey/);
});

test("MUST FAIL: no publish drill recorded for a daily series", async () => {
  const none = await text(site({ drill: false }));
  assert.match(none, /no publish drill recorded for daily/);
  assert.match(none, /no publish drill recorded for weekly/, "the weekly series owes one too");
});

test("MUST FAIL: a publish drill whose proof is a log, a failed document, another series, or edited after the drill does not count", async () => {
  const log = site(); writeFileSync(join(log, "resilience/drills/publish-daily.json"), "drill ok\n");
  // the recorded sha256 must match the file again, so record a drill over the new bytes
  const redo = (root) => { const f = join(root, "resilience.json"), doc = JSON.parse(readFileSync(f, "utf8")); doc.drills.find((x) => x.kind === "publish").proof_sha256 = sha256File(join(root, "resilience/drills/publish-daily.json")); writeFileSync(f, JSON.stringify(doc)); };
  redo(log);
  assert.match(await text(log), /is not JSON/);
  const failed = site({ proof: PROOF({ ok: false, checks: PROOF().checks.map((c) => (c.id === "feed-item" ? { ...c, ok: false } : c)) }) });
  assert.match(await text(failed), /records a failed drill \(feed-item\)/);
  const other = site({ proof: PROOF({ subject: "weekly" }) });
  assert.match(await text(other), /is for weekly, not daily/);
  const typed = site({ proof: { ok: true } });
  assert.match(await text(typed), /is not kit\.podcast-drill\.v1/);
  const edited = site(); writeFileSync(join(edited, "resilience/drills/publish-daily.json"), `${JSON.stringify(PROOF({ slug: "x" }))}\n`);
  assert.match(await text(edited), /does not match its recorded sha256/);
});

test("MUST FAIL: a publish drill older than 30 days is stale", async () => {
  const root = site();
  const f = join(root, "resilience.json"), doc = JSON.parse(readFileSync(f, "utf8"));
  doc.drills.find((x) => x.kind === "publish").date = "2026-09-01"; writeFileSync(f, JSON.stringify(doc));
  assert.match(await text(root), /publish drill for daily is 43 days old \(limit 30\)/);
});
