// kit check resilience and the watcher. Every finding of the #113 review (scratchpad probes 1-19, A-I) is reproduced FIRST here, then fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE = fileTempDir("kit-res-");      // one directory for the file, removed when its tests end
let SEQ = 0;
const freshDir = () => { const d = join(BASE, `d${SEQ++}`); mkdirSync(d, { recursive: true }); return d; };
import { bundled } from "../src/canon/index.js";
import { checkResilience, requiredSecrets, activeChannels, watcherFacts, loadRules, monitorConfig } from "../src/resilience/check.js";
import { recordDrill, sha256File } from "../src/resilience/drills.js";
import { findWranglerConfigs, readWranglerConfig, d1Index, d1Id } from "../src/wrangler-config.js";
import { maxGapMin } from "../src/cron.js";
import { parseYaml } from "../src/yaml-lite.js";
import { watchStatus, watchHealth, keepalive, statusProblems } from "../src/resilience/watch.js";
import { repoFacts, PREDICATES, deployScan } from "../src/canon/facts.js";
import { alertVariables, ALERT_CHANNELS, CHANNEL_ROOTS } from "@saasreport/channels";
import { DEAD_MAN_PROVIDERS } from "../../monitor/src/guard.js";
import { main } from "../src/index.js";

const TODAY = "2026-10-07";
const kit = bundled();
const SITE = `name = "site-web"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\n[[r2_buckets]]\nbinding = "PODCASTS"\nbucket_name = "site-podcasts"\n`;
const MONVARS = (o = {}) => Object.entries({ MONITOR_DB_ID: "mon-id", MONITOR_WATCHED_DB_IDS: "site-id", MONITOR_ROUTES: "email,telegram", MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_STALE_AFTER_MIN: "1560", MONITOR_FETCH_TIMEOUT_MS: "10000", ...o })
  .filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = "${v}"`).join("\n");
const MON = (vars = MONVARS(), d1 = `binding = "MONITOR_DB"\ndatabase_name = "mon"\ndatabase_id = "mon-id"`, extra = "") => `name = "site-monitor"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\n${d1}\n[vars]\n${vars}\n[triggers]\ncrons = ["45 2 * * *"]\n${extra}`;
const KIT = "node vendor/kit/packages/cli/bin/kit.js resilience";
const WATCH = `on:\n  schedule:\n    - cron: "7 */2 * * *"\njobs:\n  watch:\n    runs-on: ubuntu-24.04\n    permissions:\n      actions: write\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: ${KIT} keepalive --monitor site-journeys\n      - run: ${KIT} watch --monitor site-journeys\n        env:\n          MONITOR_STATUS_URL: \${{ vars.MONITOR_STATUS_URL }}\n`;

/** A repository that passes every rule; each test breaks one thing. No address and no secret anywhere. */
function fixture(mut = () => {}, files = {}) {
  const root = freshDir();
  const w = (f, t) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); };
  w("wrangler.toml", SITE); w("monitor/wrangler.toml", MON()); w("backup.config.json", "{}\n");
  w(".github/workflows/watch.yml", WATCH); w("proofs/alert.log", "alert drill log\n"); w("proofs/restore.log", "restore drill log\n");
  for (const [f, t] of Object.entries(files)) if (t === null) w(f, ""); else w(f, t);
  const drill = (kind, subject, file) => ({ kind, subject, date: "2026-10-01", result: "pass", proof_path: file, proof_sha256: sha256File(join(root, file)) });
  const doc = {
    $schema: "x", project: "site",
    routes: [{ id: "mail", channel: "email" }, { id: "chat", channel: "telegram" }],
    monitors: [{ id: "site-journeys", kind: "worker", worker: { wrangler: "monitor/wrangler.toml" }, database_binding: "MONITOR_DB", watches: [{ wrangler: "wrangler.toml" }],
      root: "cloudflare", routes: ["mail", "chat"], stale_after_min: 1560, fetch_timeout_ms: 10000,
      dead_man: { provider: "healthchecks.io", root: "healthchecks.io", interval_min: 1440, grace_min: 120 },
      watcher: { workflow: ".github/workflows/watch.yml", url_env: "MONITOR_STATUS_URL" } }],
    backups: [{ id: "site-d1", source: { kind: "d1", name: "site-id" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" },
      { id: "site-podcasts", source: { kind: "r2", name: "site-podcasts" }, destination: { kind: "r2", name: "site-backups" }, config: "backup.config.json" }],
    drills: [drill("alert", "site-journeys", "proofs/alert.log"), drill("restore", "site-d1", "proofs/restore.log"), drill("restore", "site-podcasts", "proofs/restore.log")],
  };
  mut(doc, root, w);
  w("resilience.json", JSON.stringify(doc, null, 2));
  return root;
}
const run = (root) => checkResilience(root, { resilience: {} }, kit, { today: TODAY });
const txt = async (root) => (await run(root)).problems.map((p) => `${p.file}: ${p.problem}`).join("\n");

test("a complete resilience.json passes", async () => {
  const r = await run(fixture());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("R1: the one wrangler reader finds configs by content (any name, deploy/**, workers/*/wrangler.*.toml), reads every [env.*] and resolves D1 by id", async () => {
  const root = fixture(() => {}, {
    "deploy/x/wrangler.production.toml": `name = "x"\ncompatibility_date = "2026-01-01"\n[env.production]\n[[env.production.d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\n`,
    "workers/a/wrangler.staging.jsonc": `{ // c\n "name": "a", "main": "i.js", "compatibility_date": "2026-01-01", "d1_databases": [{"binding":"DB","database_id":"a-id",}] }`,
    "packages/p/package.json": `{ "name": "p", "main": "x.js", "version": "1", "license": "MIT" }`,
    "templates/t/wrangler.toml": `name = "t"\ncompatibility_date = "2026-01-01"\n`,
  });
  // M8: no path regex decides what is deployed: a template is a candidate until a reviewed not-deployed entry says otherwise
  assert.deepEqual(findWranglerConfigs(root, { deployed: true }), ["deploy/x/wrangler.production.toml", "monitor/wrangler.toml", "templates/t/wrangler.toml", "workers/a/wrangler.staging.jsonc", "wrangler.toml"]);
  assert.deepEqual(findWranglerConfigs(root, { deployed: true, allow: [{ file: "templates/t/wrangler.toml", category: "not-deployed", match: "t", context: "name = ", reason: "a template the generator copies; never deployed from here" }] }), ["deploy/x/wrangler.production.toml", "monitor/wrangler.toml", "workers/a/wrangler.staging.jsonc", "wrangler.toml"]);
  const cs = findWranglerConfigs(root).map((f) => readWranglerConfig(root, f));
  const x = cs.find((c) => c.file.startsWith("deploy/"));
  assert.equal(x.envs.production.name, "x-production");
  assert.equal(d1Id(x.envs.production.d1[0], d1Index(cs)), "site-id", "a name-only binding resolves to the id the other configs give it");
  assert.equal(d1Id({ name: null, id: null }, d1Index(cs)), null, "null is never an identity (null === null is not 'same')");
});

test("R1: a Worker this repository deploys under any name must be watched (a deploy config under any name makes notApplicable false)", async () => {
  const root = fixture(() => {}, { "deploy/decide/wrangler.jsonc": `{ "name": "saasreport-decide", "main": "src/index.js", "compatibility_date": "2026-09-01" }` });
  assert.match(await txt(root), /deploy\/decide\/wrangler\.jsonc: every-worker-watched: .*no monitor/);
  const facts = repoFacts(root, {});
  assert.equal(PREDICATES["no-deployed-workers"].holds(facts), false);
  const empty = freshDir();
  assert.equal(PREDICATES["no-deployed-workers"].holds(repoFacts(empty, {})), true);
  // the kit itself deploys nothing: saasreport-decide's deploy config lives in the project that owns it (the project that owns it)
  const KIT_ROOT = new URL("../../../", import.meta.url).pathname;
  assert.deepEqual(deployScan(KIT_ROOT, {}).deployed, [], "the kit's templates and examples are reviewed not-deployed entries");
});

test("PROBE B/C/D: the same database is caught in [env.*] sections and across id-only / name-only bindings", async () => {
  // B: the watched site binds the monitor's database only under [env.production]
  let root = fixture((d) => { d.monitors[0].watches = [{ wrangler: "wrangler.toml", env: "production" }]; }, { "wrangler.toml": `${SITE}[env.production]\n[[env.production.d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "mon-id"\n` });
  assert.match(await txt(root), /monitor-own-database: .*MONITOR_DB is database mon-id, which a watched Worker binds/);
  // C: the monitor's deployed [env.production] binds the site's database
  root = fixture((d) => { d.monitors[0].worker.env = "production"; }, { "monitor/wrangler.toml": `${MON()}[env.production]\n[[env.production.d1_databases]]\nbinding = "MONITOR_DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\n[env.production.vars]\n${MONVARS({ MONITOR_DB_ID: "site-id" })}\n` });
  assert.match(await txt(root), /MONITOR_DB is database site-id, which a watched Worker binds/);
  // D: the site has an id only, the monitor names the same database by name only
  root = fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_DB_ID: "site-id" }), `binding = "MONITOR_DB"\ndatabase_name = "site"`), "wrangler.toml": SITE });
  assert.match(await txt(root), /MONITOR_DB is database site-id, which a watched Worker binds/);
  // an unresolvable watched name cannot be proven different
  root = fixture(() => {}, { "wrangler.toml": `name = "site-web"\ncompatibility_date = "2026-01-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "nowhere"\n` });
  assert.match(await txt(root), /has no database_id the configs can resolve/);
});

test("R2: the runtime's [vars] must carry the ids, routes, provider and limit the configs and resilience.json say", async () => {
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_DB_ID: undefined })) })), /MONITOR_DB_ID is missing; it must be "mon-id"/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_WATCHED_DB_IDS: "other" })) })), /MONITOR_WATCHED_DB_IDS is "other"; it must be "site-id"/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_ROUTES: "email" })) })), /alert-routes-proven: \[vars\] MONITOR_ROUTES/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_DEADMAN_PROVIDER: "other" })) })), /monitor-dead-man: \[vars\] MONITOR_DEADMAN_PROVIDER/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_STALE_AFTER_MIN: "60" })) })), /monitor-stale-window: \[vars\] MONITOR_STALE_AFTER_MIN/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_FETCH_TIMEOUT_MS: "99" })) })), /alert-routes-proven: \[vars\] MONITOR_FETCH_TIMEOUT_MS is "99"; it must be "10000" \(from resilience\.json\)/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_FETCH_TIMEOUT_MS: undefined })) })), /alert-routes-proven: \[vars\] MONITOR_FETCH_TIMEOUT_MS is missing; it must be "10000"/);
  assert.match(await txt(fixture((d) => { delete d.monitors[0].fetch_timeout_ms; })), /alert-routes-proven: monitor \S+ declares no fetch_timeout_ms/);
});

test("R7 / PROBE E: recipients and secrets are never committed: any value of a recipient or secret variable in [vars] fails", async () => {
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(`${MONVARS()}\nMONITOR_NOTIFY_TO = "someone@example.invalid"`) })), /alerts-have-recipients: \[vars\] MONITOR_NOTIFY_TO is a recipient or a secret/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(`${MONVARS()}\nMONITOR_DEADMAN_URL = "https://hc-ping.com/x"`) })), /\[vars\] MONITOR_DEADMAN_URL is a recipient or a secret/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON(`${MONVARS()}\nOPS_NOTIFY_TO = ""`) })), /\[vars\] OPS_NOTIFY_TO is a recipient or a secret/);
});

test("R7: the required secret NAMES are derived from the routes (the runtime's own variables), never declared by hand", async () => {
  const root = fixture();
  const doc = JSON.parse(readFileSync(join(root, "resilience.json"), "utf8"));
  assert.deepEqual(requiredSecrets(doc, doc.monitors[0]), ["MONITOR_DEADMAN_URL", "MONITOR_NOTIFY_TO", "MONITOR_TELEGRAM_CHAT_ID", "MONITOR_TOKEN", "TELEGRAM_BOT_TOKEN"]);
  assert.ok(requiredSecrets(doc, doc.monitors[0], { monitor: { drill: { form: "contact" } } }).includes("FORMS_DRILL_KEY"), "a form drill needs the key that signs its test submission");
  doc.monitors[0].dead_man.provider = "github-actions";
  assert.ok(!requiredSecrets(doc, doc.monitors[0]).includes("MONITOR_DEADMAN_URL"), "github-actions: the watcher is the dead-man, no URL");
});

test("R4 / R8: the registry's recipient list covers every variable the runtime reads; every rule id the check uses is a registry rule", async () => {
  const { rules, recipientVars } = loadRules(kit);
  for (const ch of ["email", "telegram", "bale", "webhook"]) for (const v of alertVariables(ch).secrets.filter((n) => !/TOKEN$/.test(n))) assert.ok(recipientVars.includes(v), `${v} (read by the ${ch} route) is in separation.recipientVars`);
  const used = new Set(readFileSync(new URL("../src/resilience/check.js", import.meta.url), "utf8").match(/P\("([a-z-]+)"/g).map((m) => m.slice(3, -1)));
  for (const id of used) assert.ok(rules.some((r) => r.id === id && r.enforce.canon?.includes("resilience")), `rule ${id} is a class-resilience registry rule enforced by the resilience check`);
  assert.equal(readFileSync(new URL("../../core/registry/constitution.rules.json", import.meta.url), "utf8").includes("_note"), false);
});

test("PROBE F / F2 / R6: the watcher workflow is PARSED: a schedule or a watch only in comments, a disabled job, no keepalive each fail", async () => {
  const f = (wf) => txt(fixture(() => {}, { ".github/workflows/watch.yml": wf }));
  assert.match(await f("# schedule:\n#  - cron: x\n# kit resilience watch\non: workflow_dispatch\njobs: {}\n"), /has no on.schedule cron/);
  assert.match(await f(WATCH.replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-24.04\n    if: false")), /job "watch" has an `if`/);
  assert.match(await f(WATCH.replace(`      - run: ${KIT} watch`, `      - run: |\n          # ${KIT} watch`)), /no step runs exactly `node scripts\/kit\.mjs resilience watch --monitor site-journeys`/);
  assert.match(await f(WATCH.replace("    permissions:\n      actions: write\n", "")), /keepalive without permissions actions: write/);
  assert.match(await f(WATCH.replace('"7 */2 * * *"', '"7 3 * * 1"')), /runs every 10080 min at worst, longer than stale_after_min/);
  assert.deepEqual(Object.keys(watcherFacts(WATCH).watch), ["site-journeys"]);
});

test("M5: watcherFacts is fail-closed: only the exact kit invocation, after npm ci, with no if, continue-on-error, shell or extra command counts", async () => {
  const f = (wf) => txt(fixture(() => {}, { ".github/workflows/watch.yml": wf }));
  const W = (from, to) => WATCH.replace(from, to);
  const WATCH_RUN = `      - run: ${KIT} watch --monitor site-journeys`;
  // a command that merely mentions the words
  assert.match(await f(W(WATCH_RUN, `      - run: echo ${KIT} watch --monitor site-journeys`)), /a watcher step runs exactly/);
  assert.match(await f(W(WATCH_RUN, `      - run: ${KIT} watch --monitor site-journeys || true`)), /a watcher step runs exactly/);
  assert.match(await f(W(WATCH_RUN, `      - run: ${KIT} watch --monitor site-journeys\n        continue-on-error: true`)), /step 4 has continue-on-error/);
  assert.match(await f(W(WATCH_RUN, `      - run: ${KIT} watch --monitor site-journeys\n        if: false`)), /step 4 has an `if` that is not one of the workflow's schedules/);
  assert.match(await f(W(WATCH_RUN, `      - run: ${KIT} watch --monitor site-journeys\n        shell: bash +e {0}`)), /step 4 sets a shell/);
  assert.match(await f(W("    runs-on: ubuntu-24.04\n", "    runs-on: ubuntu-24.04\n    continue-on-error: true\n")), /job "watch" has continue-on-error/);
  // no npm ci: the vendored CLI's dependencies would be missing (Codex P1 on app #47)
  assert.match(await f(W("      - run: npm ci\n", "")), /runs before `npm ci` in its job/);
  // the url variable must reach the step
  assert.match(await f(W("        env:\n          MONITOR_STATUS_URL: ${{ vars.MONITOR_STATUS_URL }}\n", "")), /the watch step does not pass MONITOR_STATUS_URL/);
  // another monitor's id does not count
  assert.match(await f(W("watch --monitor site-journeys", "watch --monitor other")), /no step runs exactly .*watch --monitor site-journeys/);
});

test("H1: a schedule that never fires, or fires once a year, is a failure, never a pass", async () => {
  assert.equal(maxGapMin(["45 2 30 2 *"]), null, "30 February never comes");
  assert.equal(maxGapMin(["7 3 31 12 *"]), 527040, "once a year (366 days across a leap year)");
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON().replace('crons = ["45 2 * * *"]', 'crons = ["45 2 30 2 *"]') })), /monitor-stale-window: its cron \(45 2 30 2 \*\) never fires/);
  assert.match(await txt(fixture(() => {}, { ".github/workflows/watch.yml": WATCH.replace('"7 */2 * * *"', '"7 2 30 2 *"') })), /monitor-dead-man: its schedule \(7 2 30 2 \*\) never fires/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON().replace('crons = ["45 2 * * *"]', 'crons = ["7 3 31 12 *"]') })), /stale_after_min 1560 is shorter than the longest gap between runs \(527040 min\)/);
  assert.match(await txt(fixture(() => {}, { ".github/workflows/watch.yml": WATCH.replace('"7 */2 * * *"', '"7 3 31 12 *"') })), /runs every 527040 min at worst/);
});

test("H3: coverage is per (file, env): every deployed [env.*] is watched or declared not deployed; D1 and R2 come from every env", async () => {
  const STAGED = `${SITE}[env.staging]\nname = "site-web-staging"\n[[env.staging.d1_databases]]\nbinding = "DB"\ndatabase_name = "site-staging"\ndatabase_id = "staging-id"\n[[env.staging.r2_buckets]]\nbinding = "PODCASTS"\nbucket_name = "site-podcasts-staging"\n`;
  const t = await txt(fixture(() => {}, { "wrangler.toml": STAGED }));
  assert.match(t, /wrangler\.toml: every-worker-watched: \[env\.staging\] of this config is deployed by this repository but no monitor in resilience\.json watches it/);
  assert.match(t, /D1 site-staging \(staging-id\) has no backup entry/);
  assert.match(t, /R2 site-podcasts-staging has no backup entry/);
  // declared not deployed, with a reason: no coverage problem, and its D1/R2 are not required
  const nd = await txt(fixture((d) => { d.not_deployed = [{ wrangler: "wrangler.toml", env: "staging", reason: "staging is declared for local wrangler dev only; never deployed" }]; }, { "wrangler.toml": STAGED }));
  assert.equal(nd, "");
  // a stale not_deployed entry fails
  assert.match(await txt(fixture((d) => { d.not_deployed = [{ wrangler: "wrangler.toml", env: "gone", reason: "an env that was removed long ago from this config" }]; })), /not_deployed names wrangler\.toml \[env\.gone\], which is not a deployed config section \(stale\)/);
});

test("H4: recipient and secret values are refused in every deployed config and every env's vars, not only the monitor's [vars]", async () => {
  assert.match(await txt(fixture(() => {}, { "wrangler.toml": `${SITE}[vars]\nOPS_NOTIFY_TO = "x"\n` })), /wrangler\.toml: alerts-have-recipients: \[vars\] OPS_NOTIFY_TO is a recipient or a secret/);
  assert.match(await txt(fixture(() => {}, { "wrangler.toml": `${SITE}[env.production]\n[env.production.vars]\nMONITOR_TELEGRAM_CHAT_ID = "-100"\n`, }, )), /\[env\.production\.vars\] MONITOR_TELEGRAM_CHAT_ID is a recipient or a secret/);
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": `${MON()}[env.production]\n[env.production.vars]\nTELEGRAM_BOT_TOKEN = "1:x"\n` })), /monitor\/wrangler\.toml: alerts-have-recipients: \[env\.production\.vars\] TELEGRAM_BOT_TOKEN/);
});

test("M6: a route's failure domain is derived from its channel (no declared root), and two routes on one channel fail", async () => {
  assert.match(await txt(fixture((d) => { d.routes[1].root = "telegram"; })), /\/routes\/1\/root: unknown property "root"/);
  assert.match(await txt(fixture((d) => { d.routes[1].channel = "email"; })), /channel email is used by two routes/);
  assert.match(await txt(fixture((d) => { d.routes[1].channel = "email"; })), /depend on fewer than two failure domains \(cloudflare\)/);
  assert.equal(CHANNEL_ROOTS.email, "cloudflare");
});

test("L14: one source for the channel and dead-man enums; ids unique", async () => {
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/resilience.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.routes.items.properties.channel.enum].sort(), [...ALERT_CHANNELS, "github"].sort());
  assert.deepEqual(Object.keys(CHANNEL_ROOTS).sort(), [...ALERT_CHANNELS, "github"].sort());
  assert.deepEqual([...schema.$defs.monitor.properties.dead_man.properties.provider.enum].sort(), [...DEAD_MAN_PROVIDERS].sort());
  assert.match(await txt(fixture((d) => { d.routes.push({ id: "mail", channel: "bale" }); })), /route id "mail" is declared twice/);
  assert.match(await txt(fixture((d) => { d.monitors.push(structuredClone(d.monitors[0])); })), /monitor id "site-journeys" is declared twice/);
});

const WATCHER_DOC = (d) => {
  d.routes = [{ id: "gh", channel: "github" }, { id: "chat", channel: "telegram" }];
  d.monitors[0] = { id: "site-journeys", kind: "watcher", watches: [{ wrangler: "wrangler.toml" }], root: "github", routes: ["gh", "chat"], stale_after_min: 1560, watcher: { workflow: ".github/workflows/watch.yml", url_env: "SITE_HEALTH_URL" } };
};
const WATCHER_WF = (canary = `      - run: ${KIT} canary --monitor site-journeys\n        if: github.event.schedule == '17 6 * * *'\n        env:\n          MONITOR_TELEGRAM_CHAT_ID: \${{ secrets.MONITOR_TELEGRAM_CHAT_ID }}\n          TELEGRAM_BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}\n`) =>
  WATCH.replace('    - cron: "7 */2 * * *"\n', '    - cron: "7 */2 * * *"\n    - cron: "17 6 * * *"\n').replace("MONITOR_STATUS_URL: ${{ vars.MONITOR_STATUS_URL }}", "SITE_HEALTH_URL: ${{ vars.SITE_HEALTH_URL }}") + canary;

test("M7: a watcher's second route is canaried daily, and the workflow passes the variables the route reads (alertVariables)", async () => {
  const ok = await txt(fixture(WATCHER_DOC, { ".github/workflows/watch.yml": WATCHER_WF(), "monitor/wrangler.toml": null }));
  assert.doesNotMatch(ok, /canary|TELEGRAM/, ok);
  assert.match(await txt(fixture(WATCHER_DOC, { ".github/workflows/watch.yml": WATCHER_WF("") })), /no step runs `... resilience canary --monitor site-journeys`: the watcher's second route is never proven/);
  assert.match(await txt(fixture(WATCHER_DOC, { ".github/workflows/watch.yml": WATCHER_WF().replace("          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}\n", "") })), /the canary step does not pass TELEGRAM_BOT_TOKEN \(read by the telegram route\)/);
  assert.match(await txt(fixture(WATCHER_DOC, { ".github/workflows/watch.yml": WATCHER_WF().replace("if: github.event.schedule == '17 6 * * *'", "if: github.event.schedule == '9 9 * * *'") })), /step 5 has an `if` that is not one of the workflow's schedules/);
  // a watcher runs on GitHub: email (the comms Worker) is not a route it can use (L16 points a Worker without its own monitor to kind watcher)
  assert.match(await txt(fixture((d) => { WATCHER_DOC(d); d.routes[1] = { id: "chat", channel: "email" }; }, { ".github/workflows/watch.yml": WATCHER_WF() })), /a watcher runs on GitHub and cannot reach the comms Worker/);
  assert.match(await txt(fixture(() => {}, { "deploy/x/wrangler.jsonc": `{ "name": "x", "main": "i.js" }` })), /kind "watcher": a scheduled GitHub workflow that checks the Worker's health URL/);
});

test("M10: required secret names follow the project's config overrides (alerts.<channel>.chatIdEnv, deadMan.urlEnv)", async () => {
  const root = fixture((d) => { d.monitors[0].config = { module: "monitor.config.mjs" }; }, {
    "monitor.config.mjs": `export default { monitor: { alerts: { email: { toEnv: "OWNER_ALERT_TO" }, telegram: { chatIdEnv: "OPS_CHAT" } }, deadMan: { urlEnv: "HC_PING_URL" } } };\n`,
  });
  const doc = JSON.parse(readFileSync(join(root, "resilience.json"), "utf8"));
  const cfg = await monitorConfig(root, doc.monitors[0]);
  assert.deepEqual(requiredSecrets(doc, doc.monitors[0], cfg), ["HC_PING_URL", "MONITOR_TOKEN", "OPS_CHAT", "OWNER_ALERT_TO", "TELEGRAM_BOT_TOKEN"]);
  // an overridden name committed as a value is caught too
  writeFileSync(join(root, "wrangler.toml"), `${SITE}[vars]\nOPS_CHAT = "-100"\n`);
  assert.match(await txt(root), /\[vars\] OPS_CHAT is a recipient or a secret/);
  // an unloadable module is a problem, never a silent default
  assert.match(await txt(fixture((d) => { d.monitors[0].config = { module: "missing.mjs" }; })), /its config module cannot be loaded/);
});

test("M8: the deploy scan sees deploy commands, Workers with main but no name, and refuses an unreadable candidate", () => {
  const root = freshDir();
  const w = (f, t) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); };
  w("package.json", `{ "name": "p", "scripts": { "ship": "wrangler deploy -c workers/a/conf.toml" } }`);
  w("workers/a/conf.toml", `main = "src/index.js"\ncompatibility_date = "2026-01-01"\n`);
  w("workers/b/wrangler.toml", `name = "b"\n[[d1_databases]\nbinding = "DB"\n`);
  const r = deployScan(root, {});
  assert.ok(r.commands.some((c) => c.file === "package.json"), "the deploy command is found");
  assert.ok(r.deployed.includes("workers/a/conf.toml"), "main without name is a Worker config");
  assert.ok(r.problems.some((p) => p.file === "workers/b/wrangler.toml"), "a wrangler file that does not parse is a problem, not ignored");
  assert.equal(PREDICATES["no-deployed-workers"].holds(repoFacts(root, {})), false);
});

test("PROBE I: the stale window is measured against the LONGEST gap between firings (several crons, weekdays)", async () => {
  assert.deepEqual([maxGapMin(["0 3 * * *", "0 4 * * 1"]), maxGapMin(["0 3 * * 1-5"]), maxGapMin(["*/30 * * * *"]), maxGapMin(["45 2 * * *"])], [1440, 4320, 30, 1440]);
  assert.equal((await run(fixture(() => {}, { "monitor/wrangler.toml": MON().replace('crons = ["45 2 * * *"]', 'crons = ["0 3 * * *", "0 4 * * 1"]') }))).ok, true, "a daily cron plus a weekly one is daily");
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON().replace('crons = ["45 2 * * *"]', 'crons = ["0 3 * * 1-5"]') })), /stale_after_min 1560 is shorter than the longest gap between runs \(4320 min\)/);
  assert.throws(() => maxGapMin(["61 * * * *"]), /out of range/);
});

test("PROBE H / R3: every monitor's routes are declared, on two failure domains; a worker monitor never names the github route", async () => {
  assert.match(await txt(fixture((d) => { d.monitors[0].routes = ["mail", "nope"]; })), /route "nope" is not declared/);
  assert.match(await txt(fixture((d) => { d.routes.push({ id: "gh", channel: "github" }); d.monitors[0].routes = ["mail", "gh"]; })), /the github route belongs to a watcher monitor/);
});

test("stale window, dead-man timing and root, drills, backups (kept from the first version, now by id)", async () => {
  assert.match(await txt(fixture((d) => { d.monitors[0].stale_after_min = 600; })), /shorter than the longest gap/);
  assert.match(await txt(fixture((d) => { d.monitors[0].dead_man.root = "cloudflare"; })), /the dead-man root "cloudflare" is the monitor's own root/);
  assert.match(await txt(fixture((d) => { d.drills = d.drills.filter((x) => x.kind !== "alert"); })), /resilience-proven-by-drills: no alert drill recorded/);
  const r = fixture(); writeFileSync(join(r, "proofs/alert.log"), "edited\n");
  assert.match(await txt(r), /does not match its recorded sha256/);
  assert.match(await txt(fixture((d) => { d.backups = d.backups.slice(1); })), /D1 site \(site-id\) has no backup entry/);
  assert.equal((await run(fixture((d) => { d.backups[0].source.name = "site"; }))).ok, true, "a backup may name the database by name; it resolves to the id");
  assert.match(await txt(fixture((d) => { d.backups[1].destination = { kind: "r2", name: "site-podcasts" }; })), /destination is the source itself/);
});

test("schema: a watcher monitor has no worker/database/dead-man; a worker monitor needs them", async () => {
  assert.equal((await run(fixture((d) => { delete d.monitors[0].dead_man; }))).ok, false);
  assert.equal((await run(fixture((d) => { d.monitors[0].kind = "watcher"; }))).ok, false);
});

test("YAML subset: values, not text; refuses anchors", async () => {
  assert.deepEqual(parseYaml("on:\n  schedule:\n    - cron: '0 * * * *'\njobs: {}\n"), { on: { schedule: [{ cron: "0 * * * *" }] }, jobs: {} });
  assert.deepEqual(parseYaml("a: |\n  x\n  # y\nb: [1, two]\n"), { a: "x\n# y\n", b: [1, "two"] });
  assert.throws(() => parseYaml("a: &x 1\nb: *x\n"), /anchors/);
});

test("record-drill appends a drill with its proof's sha256", async () => {
  const root = fixture((d) => { d.drills = []; });
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [];
  assert.equal(await main(["resilience", "record-drill", "--kind", "alert", "--subject", "site-journeys", "--result", "pass", "--proof", "proofs/alert.log", "--date", "2026-10-06"], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {} }), 0, out.join("\n"));
  assert.equal(JSON.parse(readFileSync(join(root, "resilience.json"), "utf8")).drills[0].proof_sha256, sha256File(join(root, "proofs/alert.log")));
  assert.throws(() => recordDrill(root, "resilience.json", { kind: "alert", subject: "x", date: "2026-10-06", result: "pass", proof: "nope" }), /must exist/);
});

/* ------------------------------------------------------------------ the watcher (probes 15-19) */
const NOW = Date.parse("2026-10-07T12:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const RUN = (o = {}) => ({ started_at: iso(30), finished_at: iso(29), trigger: "cron", ok: true, journeys: [], alert_status: "none", ...o });
const DOC = (o = {}) => ({ ok: true, status: "passing", last: RUN(), recent: [RUN()], routes: [{ route: "email", last_attempt_at: iso(29), last_ok_at: iso(29), last_reason: null, failed: 0 }, { route: "telegram", last_attempt_at: iso(29), last_ok_at: iso(29), last_reason: null, failed: 0 }], ...o });
const serve = (body, { status = 200, type = "application/json" } = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
const W = (doc, o = {}) => watchStatus("https://s/api/status", { staleAfterMin: 1560, routes: ["email", "telegram"], now: NOW, fetch: serve(doc, o), ...o.opts });

test("watch: a live monitor passes", async () => {
  assert.deepEqual(statusProblems(DOC()), []);
  assert.deepEqual(await W(DOC()), { ok: true, problems: [], status: "passing" });
});

test("PROBE 15: a NaN or non-integer limit is a failure, never a silent pass", async () => {
  for (const staleAfterMin of [NaN, "60", 0, 1.5]) assert.equal((await watchStatus("https://s", { staleAfterMin, now: NOW, fetch: serve(DOC()) })).ok, false);
});

test("PROBE 16 / 19 / R9: an HTML 200, an empty object, a document off its contract are failures", async () => {
  assert.match((await W("<html>ok</html>", { type: "text/html" })).problems[0], /not JSON/);
  assert.match((await W({})).problems[0], /breaks its contract/);
  assert.match((await W({ last: { started_at: iso(1) } })).problems[0], /breaks its contract/);
  assert.match((await W(DOC(), { status: 503 })).problems[0], /answered 503/);
  assert.match((await watchStatus("https://s", { staleAfterMin: 60, now: NOW, fetch: async () => { throw new Error("offline"); } })).problems[0], /unreachable: offline/);
});

test("PROBE 17: a failed alert in the window fails, even when the newest run is fine", async () => {
  const r = await W(DOC({ recent: [RUN(), RUN({ alert_status: "failed", alert_reason: "rejected" })] }));
  assert.match(r.problems.join(), /could not deliver an alert, e.g. rejected/);
});

test("PROBE 18: a run dated in the future fails", async () => {
  assert.match((await W(DOC({ last: RUN({ started_at: "2099-01-01T00:00:00.000Z" }) }))).problems.join(), /in the future/);
});

test("L13: a route's last delivery dated in the future fails", async () => {
  assert.match((await W(DOC({ routes: [DOC().routes[0], { ...DOC().routes[1], last_ok_at: "2099-01-01T00:00:00.000Z" }] }))).problems.join(), /route telegram: last delivered 2099-01-01T00:00:00.000Z, in the future/);
});

test("R3: per-route freshness: a route never delivered, delivered too long ago, or with failures in the window fails", async () => {
  assert.match((await W(DOC({ routes: [DOC().routes[0]] }))).problems.join(), /route telegram: no delivery recorded/);
  assert.match((await W(DOC({ routes: [DOC().routes[0], { ...DOC().routes[1], last_ok_at: iso(5000) }] }))).problems.join(), /route telegram: last delivered/);
  assert.match((await W(DOC({ routes: [DOC().routes[0], { ...DOC().routes[1], failed: 2, last_reason: "rejected" }] }))).problems.join(), /route telegram: 2 failed deliveries/);
  assert.match((await W(DOC({ status: "stale", last: RUN({ started_at: iso(2000) }) }))).problems.join(), /min old/);
});

test("watch --monitor: the URL comes from the variable resilience.json names, the limit from resilience.json; failure goes out through a second route", async () => {
  const root = fixture();
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [], sent = [];
  const io = (env, fetch) => ({ cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env, fetch });
  assert.equal(await main(["resilience", "watch", "--monitor", "site-journeys"], io({}, serve(DOC()))), 1, "no URL variable: failure");
  assert.match(out.join(), /MONITOR_STATUS_URL is not set/);
  assert.equal(await main(["resilience", "watch", "--monitor", "site-journeys"], io({ MONITOR_STATUS_URL: "https://s/status" }, async () => new Response(JSON.stringify(DOC({ last: RUN({ started_at: new Date().toISOString() }), routes: DOC().routes.map((r) => ({ ...r, last_ok_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })) })), { headers: { "content-type": "application/json" } }))), 0, out.join("\n"));
  const fetch = async (u, init) => { if (String(u).includes("api.telegram.org")) { sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); } throw new Error("offline"); };
  assert.equal(await main(["resilience", "watch", "--monitor", "site-journeys"], io({ MONITOR_STATUS_URL: "https://s/status", MONITOR_TELEGRAM_CHAT_ID: "-1001234567", TELEGRAM_BOT_TOKEN: "1:x" }, fetch)), 1);
  assert.match(sent[0], /not alive/);
});

test("watcher monitors check a health URL", async () => {
  assert.equal((await watchHealth("https://d/health", { fetch: async () => new Response("ok") })).ok, true);
  assert.match((await watchHealth("https://d/health", { fetch: async () => new Response("", { status: 502 }) })).problems[0], /502/);
});

test("keepalive re-enables the workflow through the API (no commit); secrets checks names on the Worker", async () => {
  const calls = [];
  assert.deepEqual(await keepalive({ token: "t", repository: "o/r", workflow: ".github/workflows/watch.yml", fetch: async (u, i) => { calls.push([i.method, u]); return new Response(null, { status: 204 }); } }), { ok: true });
  assert.deepEqual(calls, [["PUT", "https://api.github.com/repos/o/r/actions/workflows/watch.yml/enable"]]);
  assert.match((await keepalive({ token: "", repository: "o/r", workflow: "w" })).error, /required/);
  const root = fixture();
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [];
  const io = (names, code = 0) => ({ cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {}, exec: async (cmd, args) => { out.push(args.join(" ")); return { code, stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))), stderr: "auth" }; } });
  assert.equal(await main(["resilience", "secrets", "--monitor", "site-journeys"], io(["MONITOR_TOKEN", "MONITOR_NOTIFY_TO"])), 1);
  assert.match(out.join("\n"), /lacks MONITOR_DEADMAN_URL, MONITOR_TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN/);
  assert.match(out.join("\n"), /wrangler secret list --config monitor\/wrangler.toml/);
  assert.equal(await main(["resilience", "secrets", "--monitor", "site-journeys"], io(["MONITOR_TOKEN", "MONITOR_NOTIFY_TO", "MONITOR_DEADMAN_URL", "MONITOR_TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN"])), 0);
  assert.equal(await main(["resilience", "secrets", "--monitor", "site-journeys"], io([], 1)), 1, "wrangler failing is a failure");
});

test("M7: `kit resilience canary` sends through the watcher's reachable routes and fails when one is not delivered", async () => {
  const root = fixture(WATCHER_DOC, { ".github/workflows/watch.yml": WATCHER_WF() });
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [], sent = [];
  const io = (env, fetch) => ({ cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env, fetch });
  const tg = async (u, init) => { sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); };
  assert.equal(await main(["resilience", "canary", "--monitor", "site-journeys"], io({}, tg)), 1, "no secrets: not delivered");
  assert.match(out.join("\n"), /not delivered through telegram/);
  assert.equal(await main(["resilience", "canary", "--monitor", "site-journeys"], io({ MONITOR_TELEGRAM_CHAT_ID: "-1001", TELEGRAM_BOT_TOKEN: "1:x" }, tg)), 0, out.join("\n"));
  assert.match(sent[0], /daily canary/);
  assert.equal(await main(["resilience", "canary", "--monitor", "site-journeys"], io({ MONITOR_TELEGRAM_CHAT_ID: "-1001", TELEGRAM_BOT_TOKEN: "1:x" }, async () => new Response("{}", { status: 403 }))), 1);
});

test("re-review: cron dialects: Cloudflare numbers weekdays 1 = Sunday ... 7 = Saturday (names, L, #); GitHub is POSIX 0-6", async () => {
  const { parseCron } = await import("../src/cron.js");
  // the same text, two schedules: on Cloudflare "1" is Sunday, on GitHub it is Monday
  assert.deepEqual([...parseCron("0 3 * * 1", { dialect: "cloudflare" }).sets[4]], [0]);
  assert.deepEqual([...parseCron("0 3 * * 1").sets[4]], [1]);
  assert.deepEqual([...parseCron("0 3 * * 7", { dialect: "cloudflare" }).sets[4]], [6], "7 is Saturday on Cloudflare");
  assert.throws(() => parseCron("0 3 * * 7"), /out of range 0-6 \(GitHub, POSIX: 0 = Sunday/);
  assert.throws(() => parseCron("0 3 * * 0", { dialect: "cloudflare" }), /out of range 1-7 \(Cloudflare: 1 = Sunday/);
  assert.deepEqual([...parseCron("0 3 * * MON-FRI", { dialect: "cloudflare" }).sets[4]], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 3 * * mon-fri").sets[4]], [1, 2, 3, 4, 5], "names mean the same day in both");
  // Cloudflare's weekday 2-6 is Monday to Friday: a 3-day weekend gap; the GitHub reading would be Tuesday to Saturday
  assert.equal(maxGapMin(["0 3 * * 2-6"], { dialect: "cloudflare" }), 3 * 1440);
  assert.equal(maxGapMin(["0 3 L * *"], { dialect: "cloudflare" }), 31 * 1440, "last day of the month");
  assert.equal(maxGapMin(["0 3 * * 2#1"], { dialect: "cloudflare" }), 35 * 1440, "the first Monday: at most five weeks apart");
  assert.equal(maxGapMin(["0 3 * * 6L"], { dialect: "cloudflare" }), 35 * 1440, "the last Friday");
  assert.throws(() => parseCron("0 3 1 * 2", { dialect: "cloudflare" }), /restrict one of them/);
  // the monitor's wrangler cron is read in the Cloudflare dialect
  assert.match(await txt(fixture(() => {}, { "monitor/wrangler.toml": MON().replace('crons = ["45 2 * * *"]', 'crons = ["45 2 * * 0"]') })), /out of range 1-7 \(Cloudflare/);
});

test("re-review M2: the kit's own watcher template passes the kit's own check (npm ci, exact steps, keepalive, daily canary)", async () => {
  const tpl = readFileSync(new URL("../../../templates/resilience/watch.yml", import.meta.url), "utf8");
  const w = watcherFacts(tpl);
  assert.deepEqual(w.problems, []);
  assert.ok(w.watch["site-journeys"] && w.keepalive.has("site-journeys") && w.canary["site-journeys"]);
  assert.equal(maxGapMin([w.canary["site-journeys"].cron]), 1440);
  assert.equal(await txt(fixture(() => {}, { ".github/workflows/watch.yml": tpl })), "");
  // and as a watcher monitor's workflow, whose second route must be canaried
  assert.doesNotMatch(await txt(fixture(WATCHER_DOC, { ".github/workflows/watch.yml": tpl.replace("MONITOR_STATUS_URL: ${{ vars.MONITOR_STATUS_URL }}", "SITE_HEALTH_URL: ${{ vars.SITE_HEALTH_URL }}") })), /monitor-dead-man|alert-routes-proven/);
});

test("re-review: every deploy command maps to the config it deploys, a generated dist/ config included; a config the repo lacks is a problem", () => {
  const root = freshDir();
  const w = (f, t) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); };
  w("package.json", `{ "name": "p", "scripts": { "ship": "vite build && wrangler deploy -c dist/wrangler.json", "ship2": "cd site && wrangler deploy --config=build/out.jsonc" } }`);
  w("dist/wrangler.json", `{ "name": "p-web", "main": "index.js", "compatibility_date": "2026-01-01", "d1_databases": [{ "binding": "DB", "database_id": "x" }] }`);
  w("apps/a/package.json", `{ "name": "a", "scripts": { "deploy": "wrangler deploy" } }`);
  w("apps/a/wrangler.toml", `name = "a"\nmain = "i.js"\ncompatibility_date = "2026-01-01"\n`);
  const r = deployScan(root, {});
  assert.deepEqual(r.commands.map((c) => [c.file, c.config]), [["apps/a/package.json", "apps/a/wrangler.toml"], ["package.json", "dist/wrangler.json"], ["package.json", "build/out.jsonc"]]);
  assert.ok(r.deployed.includes("dist/wrangler.json"), "a generated config the command deploys is a deployed config (dist/ is not walked)");
  assert.ok(r.problems.some((p) => /deploys build\/out\.jsonc, which is not in the repository/.test(p.problem)));
});

test("re-review: the site's MONITOR service binding must target this monitor Worker; the watcher reads the monitor's OWN /status", async () => {
  assert.match(await txt(fixture(() => {}, { "wrangler.toml": `${SITE}[[services]]\nbinding = "MONITOR"\nservice = "other-monitor"\n` })), /monitor-dead-man: service binding MONITOR targets "other-monitor", not the monitor Worker "site-monitor"/);
  assert.doesNotMatch(await txt(fixture(() => {}, { "wrangler.toml": `${SITE}[[services]]\nbinding = "MONITOR"\nservice = "site-monitor"\n` })), /service binding MONITOR/);
  const root = fixture();
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [];
  assert.equal(await main(["resilience", "watch", "--monitor", "site-journeys"], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: { MONITOR_STATUS_URL: "https://site.example/api/status" }, fetch: serve(DOC()) }), 1);
  assert.match(out.join("\n"), /must be the monitor Worker's own https:\/\/<monitor>\/status/);
});

// A route the owner has not switched on yet (resilience.json `deferred`): declared, not active. Root cause of the provisioning failure that
// asked for Telegram secrets the owner had decided not to create: the secrets, MONITOR_ROUTES, the drills and the canary all read the
// DECLARED routes; they now read the ACTIVE ones through one function (activeRoutes), and "declared but inactive" is a reviewed object, not a deleted route.
const DEFER = (d) => { d.routes[1].deferred = { reason: "owner decision 2026-10-08: skip the Telegram bot for now", decided_by: "owner", decided_on: "2026-10-08" }; };
const EMAIL_ONLY = { "monitor/wrangler.toml": MON(MONVARS({ MONITOR_ROUTES: "email" })) };

test("deferred route: email-only passes the check, needs no Telegram secret, and the report lists the deferral", async () => {
  const root = fixture(DEFER, EMAIL_ONLY);
  const r = await run(root);
  assert.deepEqual(r.problems, []);
  const doc = JSON.parse(readFileSync(join(root, "resilience.json"), "utf8"));
  assert.deepEqual(requiredSecrets(doc, doc.monitors[0]), ["MONITOR_DEADMAN_URL", "MONITOR_NOTIFY_TO", "MONITOR_TOKEN"]);
  assert.deepEqual(activeChannels(doc, doc.monitors[0]), ["email"]);
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [];
  assert.equal(await main(["resilience", "report"], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {} }), 0);
  assert.match(out.join("\n"), /deferred route chat \(telegram; 2026-10-08, by owner\): owner decision/);
  assert.doesNotMatch(out.join("\n"), /TELEGRAM_BOT_TOKEN/);
});

test("deferred route: undeferred (active) still needs its secrets, and a monitor whose MONITOR_ROUTES still lists the deferred channel fails", async () => {
  const doc = JSON.parse(readFileSync(join(fixture(), "resilience.json"), "utf8"));
  assert.deepEqual(requiredSecrets(doc, doc.monitors[0]), ["MONITOR_DEADMAN_URL", "MONITOR_NOTIFY_TO", "MONITOR_TELEGRAM_CHAT_ID", "MONITOR_TOKEN", "TELEGRAM_BOT_TOKEN"]);
  assert.match(await txt(fixture(DEFER)), /\[vars\] MONITOR_ROUTES is "email,telegram"; it must be "email"/);
  assert.match(await txt(fixture(() => {}, EMAIL_ONLY)), /\[vars\] MONITOR_ROUTES is "email"; it must be "email,telegram"/);
});

test("deferred route: the deferral must carry its reason and date, every route cannot be deferred, the watcher's github route cannot, secrets stay out of git", async () => {
  assert.match(await txt(fixture((d) => { DEFER(d); d.routes[1].deferred.reason = "later"; }, EMAIL_ONLY)), /kit\.resilience\.v1/);
  assert.match(await txt(fixture((d) => { DEFER(d); delete d.routes[1].deferred.decided_on; }, EMAIL_ONLY)), /kit\.resilience\.v1/);
  assert.match(await txt(fixture((d) => { DEFER(d); d.routes[0].deferred = d.routes[1].deferred; }, EMAIL_ONLY)), /every route is deferred: nobody would be told/);
  assert.match(await txt(fixture((d) => { WATCHER_DOC(d); d.routes[0].deferred = { reason: "owner decision 2026-10-08: skip it", decided_by: "owner", decided_on: "2026-10-08" }; }, { ".github/workflows/watch.yml": WATCHER_WF(), "monitor/wrangler.toml": null })), /cannot be deferred/);
  assert.match(await txt(fixture(DEFER, { "monitor/wrangler.toml": MON(`${MONVARS({ MONITOR_ROUTES: "email" })}\nTELEGRAM_BOT_TOKEN = "1:x"`) })), /\[vars\] TELEGRAM_BOT_TOKEN is a recipient or a secret/);
  // the two-failure-domain design is still counted over the declared routes: a deferral does not let a project declare one channel
  assert.match(await txt(fixture((d) => { DEFER(d); d.routes[1].channel = "email"; }, EMAIL_ONLY)), /channel email is used by two routes|fewer than two failure domains/);
});

test("deferred route: the daily canary has nothing to prove through a deferred route and says so; with no deferral an unreachable route still fails", async () => {
  const root = fixture(DEFER, EMAIL_ONLY);
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  const out = [];
  const io = { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {}, fetch: async () => { throw new Error("nothing is sent"); } };
  assert.equal(await main(["resilience", "canary", "--monitor", "site-journeys"], io), 0, out.join("\n"));
  assert.match(out.join("\n"), /telegram deferred by the owner/);
  const plain = fixture(() => {}, EMAIL_ONLY);
  writeFileSync(join(plain, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
  assert.equal(await main(["resilience", "canary", "--monitor", "site-journeys"], { ...io, cwd: plain }), 1);
});

test("deferred route: an overridden secret name of the deferred channel is never a [vars] value either (review: the check used default names)", async () => {
  const files = { ...EMAIL_ONLY, "monitor.config.mjs": `export default { monitor: { alerts: { telegram: { chatIdEnv: "OPS_CHAT" } } } };\n`, "monitor/wrangler.toml": MON(`${MONVARS({ MONITOR_ROUTES: "email" })}\nOPS_CHAT = "-100"`) };
  const t = await txt(fixture((d) => { DEFER(d); d.monitors[0].config = { module: "monitor.config.mjs" }; }, files));
  assert.match(t, /\[vars\] OPS_CHAT is a recipient or a secret/);
});

test("deferred route: a malformed or truncated deferral does not deactivate the route (fail closed in every command, review of core#5)", async () => {
  const doc = JSON.parse(readFileSync(join(fixture(), "resilience.json"), "utf8"));
  const full = { reason: "owner decision 2026-10-08: skip the Telegram bot for now", decided_by: "owner", decided_on: "2026-10-08" };
  for (const bad of ["later", true, [], {}, { ...full, decided_on: "soon" }, { ...full, reason: "later" }, { ...full, decided_by: "" }]) {
    doc.routes[1].deferred = bad;
    assert.ok(requiredSecrets(doc, doc.monitors[0]).includes("TELEGRAM_BOT_TOKEN"), `kept active: ${JSON.stringify(bad)}`);
    assert.deepEqual(activeChannels(doc, doc.monitors[0]), ["email", "telegram"]);
  }
  doc.routes[1].deferred = full;
  assert.ok(!requiredSecrets(doc, doc.monitors[0]).includes("TELEGRAM_BOT_TOKEN"));
});

test("deferred route: every subcommand loads resilience.json through the schema: \"later\" and a missing decided_on fail secrets, watch, canary, report", async () => {
  const full = { reason: "owner decision 2026-10-08: skip the Telegram bot for now", decided_by: "owner" };
  for (const bad of ["later", full]) {
    const root = fixture((d) => { d.routes[1].deferred = bad; }, EMAIL_ONLY);
    writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "x", project: "kit", resilience: {} }));
    for (const sub of [["secrets", "--monitor", "site-journeys"], ["watch", "--monitor", "site-journeys"], ["canary", "--monitor", "site-journeys"], ["report"]]) {
      const out = [];
      let code; try { code = await main(["resilience", ...sub], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: { MONITOR_STATUS_URL: "https://m.example/status" }, fetch: async () => { throw new Error("no network"); }, exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) }); } catch (e) { code = 1; out.push(e.message); }
      assert.notEqual(code, 0, `${sub[0]} must fail closed: ${out.join(" ")}`);
      assert.match(out.join("\n"), /kit\.resilience\.v1/, sub[0]);
    }
  }
});
