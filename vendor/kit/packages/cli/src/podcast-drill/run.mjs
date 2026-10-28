/**
 * The publish drill's child process (podcast-drill.js starts it with --conditions=workerd and register.mjs). It runs the project's OWN Worker
 * module, the one wrangler.toml `main` names, exactly as the daily cron does: its scheduled() handler, on a fresh local D1 built from the
 * project's own migrations under D1's limits, with its own workflow class running the episode; the TTS answer is a fixture (no provider call, any
 * other outbound request is refused). It then asserts the row, the audio, the feed item and the episode page and writes the proof document.
 *
 * argv[2] = JSON { root, series, at (ISO), out (file for the proof), commit }
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { provenanceProblem } from "@saasreport/core/podcast-provenance";
import { openD1, applyMigrations, migrationDirs } from "../d1-local.js";
import { readWranglerConfig } from "../wrangler-config.js";
import { fixtureTts, makeR2, offline } from "./fixtures.js";
import { loadProject } from "../project.js";

const args = JSON.parse(process.argv[2]);
const checks = [];
const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail: String(detail).slice(0, 600) }); return Boolean(ok); };
const proof = { v: 1, kind: "publish", subject: args.series, series: args.series, show: "", day: 0, scheduled_at: args.at, dry: true, engine: "node:sqlite+d1-limits", migrations: [], commit: args.commit || null, slug: "", ok: false, checks };
const finish = () => { proof.ok = checks.length > 0 && checks.every((c) => c.ok); writeFileSync(args.out, `${JSON.stringify(proof, null, 2)}\n`); process.exit(0); };
const fail = (id, detail) => { check(id, false, detail); finish(); };

try {
  const root = resolve(args.root);
  // the project's Worker and its D1 binding, read by the kit's one wrangler reader
  const file = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"].find((f) => existsSync(resolve(root, f)));
  if (!file) fail("cron-ran", "no wrangler config at the repository root (wrangler.toml, wrangler.jsonc or wrangler.json)");
  const facts = readWranglerConfig(root, file).envs[""];
  if (!facts.main) fail("cron-ran", `${file} names no main: there is no Worker whose scheduled handler the cron calls`);
  const dbBinding = facts.d1.find((d) => d.binding === "DB");
  if (!dbBinding) fail("migrations", `${file} binds no D1 as DB (the binding the kit runtime reads)`);

  const project = await loadProject(root);
  const series = project.config.series.find((x) => x.id === args.series);
  if (!series?.podcast) fail("cron-ran", `kit.config.js declares no podcast series "${args.series}" (podcast series: ${project.config.series.filter((x) => x.podcast).map((x) => x.id).join(", ") || "none"})`);
  proof.show = series.podcast.show;

  // 1. a fresh D1 from the migrations this binding applies, in order
  const d1 = openD1();
  const { dirs } = migrationDirs(root);
  const mine = dirs.find((d) => d.bindings.some((b) => b.config === file && b.binding === "DB" && b.env === ""));
  if (!mine) fail("migrations", `${file}: the DB binding names no migrations directory with .sql files`);
  const problems = applyMigrations(d1.sqlite, mine.files, { root });
  proof.migrations = mine.files.map((f) => f.slice(root.length + 1));
  if (!check("migrations", problems.length === 0, problems.length ? problems.map((p) => p.problem).join("; ") : `${mine.files.length} migration file(s) applied in order`)) finish();

  // 2. the Worker, as deployed: wrangler's vars, the bindings the cron touches, a fixture for the only outbound call (the TTS provider)
  const bucket = makeR2();
  const pending = [], workflowErrors = [];
  const worker = await import(pathToFileURL(resolve(root, facts.main)).href);
  const wfBinding = (await import("../wrangler-config.js")).readWranglerRaw(resolve(root, file)).workflows?.find((w) => w.binding === "PODCAST_WF");
  const Workflow = wfBinding ? worker[wfBinding.class_name] : null;
  if (!worker.default?.scheduled) fail("cron-ran", `${facts.main} exports no scheduled handler`);
  if (!Workflow) fail("cron-ran", `${file} declares no PODCAST_WF workflow, or ${facts.main} does not export its class`);
  const env = {
    ...facts.vars,
    DB: d1.binding, PODCASTS: bucket,
    GEMINI_API_KEY: "dry-run-fixture",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    PODCAST_WF: {
      // a workflow that throws is a finding of the drill (recorded under no-errors), never a crash of it
      create: async ({ id, params }) => { pending.push(new Workflow({}, env).run({ payload: params }, { do: async (_name, a, b) => (b || a)() }).catch((e) => { workflowErrors.push({ step: "workflow", slug: params?.slug, error: String(e?.message || e).slice(0, 400) }); })); return { id }; },
      get: async (id) => ({ status: async () => ({ status: "running", id }) }),
    },
  };
  if ((env.TTS_PROVIDER || "gemini") !== "gemini") fail("cron-ran", `the project's TTS provider is ${env.TTS_PROVIDER}: the dry drill answers a Gemini request with a fixture, the only provider podcast.config.json allows`);
  const ctx = { waitUntil: (p) => { pending.push(p); }, passThroughOnException() {} };
  const restore = offline(fixtureTts());

  // 3. the cron
  let report;
  try {
    report = await worker.default.scheduled({ type: "scheduled", cron: facts.crons[0] ?? "", scheduledTime: Date.parse(args.at) }, env, ctx);
    for (let i = 0; i < 50 && pending.length; i++) await Promise.all(pending.splice(0));
  } catch (e) { restore(); fail("cron-ran", `the scheduled handler threw: ${String(e?.stack || e).split("\n").slice(0, 3).join(" | ")}`); }
  const reports = [].concat(report ?? []).filter((r) => r && typeof r === "object");
  check("cron-ran", reports.length > 0, reports.length ? `scheduled() returned its report (day ${reports[0].day})` : "scheduled() returned no report");
  proof.day = Number(reports[0]?.day ?? 0);
  const errors = [...reports.flatMap((r) => r.errors || []), ...workflowErrors];
  check("no-errors", errors.length === 0, errors.length ? errors.map((e) => `${e.step || "?"} ${e.slug || ""}: ${e.error}`).join("; ") : "the report holds no error");

  // 4. the row
  const rows = (await d1.binding.prepare("SELECT * FROM podcast_episodes WHERE series = ? ORDER BY created_at").bind(args.series).all()).results;
  const row = rows.find((r) => reports.some((x) => (x.episodes || []).includes(r.slug))) || rows.at(-1) || null;
  if (!row) { restore(); const skipped = reports.flatMap((r) => r.skipped || []); fail("row", `no podcast_episodes row for series ${args.series} after the cron ran${skipped.length ? ` (skipped: ${JSON.stringify(skipped).slice(0, 300)})` : ""}`); }
  proof.slug = row.slug; proof.show = row.show || proof.show;
  check("row", row.status === "published" && row.audio_key && row.published_at, `${row.slug}: status ${row.status}${row.error ? `, error: ${String(row.error).slice(0, 200)}` : ""}, audio_key ${row.audio_key || "none"}`);
  const prov = provenanceProblem(row, { origins: ["cron"] });
  check("provenance", prov === null, prov ?? `origin cron, record valid`);
  const object = row.audio_key ? bucket.store.get(row.audio_key) : null;
  check("audio", object && object.length > 0, object ? `${row.audio_key}: ${object.length} bytes` : `no object ${row.audio_key} in the bucket`);

  // 5. the feed item and the page, through the Worker's own fetch
  const site = String(project.config.site.url).replace(/\/$/, "");
  const get = async (path) => worker.default.fetch(new Request(`${site}${path}`), env, ctx);
  const showId = row.show || series.podcast.show;
  const feedPaths = [...new Set([project.config.shows?.[showId]?.feed, `/podcasts/${showId}/feed.xml`, "/podcasts/feed.xml"].filter(Boolean))];
  let feed = "", feedAt = "";
  for (const p of feedPaths) { const r = await get(p); const t = r.ok ? await r.text() : ""; if (t.includes("<rss")) { feed = t; feedAt = p; if (t.includes(row.slug.replace(/^.*\//, ""))) break; } }
  check("feed-item", feed.includes("<item") && feed.includes(row.slug.replace(/^.*\//, "")), feed ? `${feedAt}: ${feed.includes("<item") ? "has items" : "no <item>"}; ${feed.includes(row.slug.replace(/^.*\//, "")) ? "names" : "does not name"} ${row.slug}` : `no RSS feed at ${feedPaths.join(" or ")}`);
  const page = await get(`/podcasts/${row.slug.replace(/^.*\//, "")}`);
  const html = page.ok ? await page.text() : "";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  check("page", page.ok && (html.includes(esc(row.title)) || html.includes(row.title)), page.ok ? `/podcasts/${row.slug}: 200, ${html.includes(esc(row.title)) || html.includes(row.title) ? "names" : "does not name"} "${row.title}"` : `/podcasts/${row.slug} answered ${page.status}`);
  restore();
} catch (e) {
  checks.push({ id: "cron-ran", ok: false, detail: `the drill itself failed: ${String(e?.stack || e).split("\n").slice(0, 4).join(" | ")}`.slice(0, 600) });
}
finish();
