// kit CLI: init (en/fa), check, plan, render, publish/status (against a local fake admin API), migrate/deploy (dry runs only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, parseToml } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const BIN = fileURLToPath(new URL("../bin/kit.js", import.meta.url));
const TMP = fileTempDir("kit-cli-");

/** Run the CLI in-process with captured output. */
async function kit(argv, { cwd = TMP, env = {}, fetch, spawn } = {}) {
  const out = [], err = [];
  const code = await main(argv, {
    cwd, env, out: (s) => out.push(s), err: (s) => err.push(s),
    fetch: fetch || (() => { throw new Error("no network in tests"); }),
    spawn: spawn || (() => { throw new Error("spawn must not be called in tests"); }),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
/** A fresh site from the template (linked to this checkout's packages). */
async function site(name, locale = "en") {
  const r = await kit(["init", name, "--locale", locale, "--link"]);
  assert.equal(r.code, 0, r.err);
  return join(TMP, name);
}

test("parseArgs: positionals, values, booleans, = and aliases", () => {
  const a = parseArgs(["plan", "--from", "2026-09-30", "--json", "--days=10", "-C", "x", "--no-force"], { boolean: ["json", "force"], alias: { C: "cwd" } });
  assert.deepEqual(a, { _: ["plan"], flags: { from: "2026-09-30", json: true, days: "10", cwd: "x", force: false } });
  assert.deepEqual(parseArgs(["render", "daily", "iban", "--speakable"], { boolean: ["speakable"] }), { _: ["render", "daily", "iban"], flags: { speakable: true } });
});

test("parseToml reads what the CLI needs from wrangler.toml", () => {
  const t = parseToml(`name = "a" # c\n[assets]\ndirectory = "./site"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "db-a"\n[[d1_databases]]\nbinding = "X"\n[triggers]\ncrons = ["30 2 * * *"]\n`);
  assert.equal(t.name, "a");
  assert.equal(t.assets.directory, "./site");
  assert.deepEqual(t.d1_databases.map((d) => d.binding), ["DB", "X"]);
  assert.deepEqual(t.triggers.crons, ["30 2 * * *"]);
});

test("--version, --help and unknown commands", async () => {
  const v = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  const h = await kit(["--help"]);
  assert.equal(h.code, 0);
  for (const c of ["init", "check", "plan", "render", "publish", "status", "migrate", "deploy"]) assert.match(h.out, new RegExp(`\\b${c}\\b`));
  const u = await kit(["frobnicate"]);
  assert.equal(u.code, 1);
  assert.match(u.err, /unknown command "frobnicate"/);
});

test("init: English starter with client assets, named after the directory", async () => {
  const dir = await site("money-notes");
  for (const f of ["kit.config.js", "wrangler.toml", "package.json", "src/worker.js", "public/index.html", "README.md", ".gitignore",
    "content/index.js", "content/weekly.js", "content/monthly.js", "content/glossary.js",
    "public/kit/kit.css", "public/kit/kit.js", "public/kit/podcast.js", "public/kit/glossary.js", "public/kit/calendar.js", "public/kit/datepicker.js"])
    assert.ok(existsSync(join(dir, f)), f);
  assert.ok(!existsSync(join(dir, "locales")), "locale overlays are not copied");
  const w = parseToml(readFileSync(join(dir, "wrangler.toml"), "utf8"));
  assert.equal(w.name, "money-notes");
  assert.equal(w.d1_databases[0].database_name, "money-notes");
  assert.equal(w.r2_buckets[0].bucket_name, "money-notes-podcasts");
  assert.equal(w.workflows[0].class_name, "PodcastWorkflow");
  assert.equal(w.ai.binding, "AI");
  assert.ok(w.triggers.crons.length);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "money-notes");
  assert.match(readFileSync(join(dir, "public/index.html"), "utf8"), /<html lang="en" dir="ltr">/);
  assert.match(readFileSync(join(dir, "public/index.html"), "utf8"), /\/kit\/kit\.css/);
  assert.equal(readFileSync(join(dir, "src/worker.js"), "utf8").trim().split("\n").length, 5, "the 5-line worker");
  assert.ok(lstatSync(join(dir, "node_modules/@saasreport/core")).isSymbolicLink());
  const v = spawnSync(join(dir, "node_modules/.bin/kit"), ["--version"], { encoding: "utf8" });
  assert.equal(v.status, 0, "node_modules/.bin/kit runs this CLI");
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /```mermaid\n%%\{init:/);
});

test("init: --locale fa gives the Persian RTL Jalali variant; bad locale and non-empty dirs are refused", async () => {
  const dir = await site("fa-site", "fa");
  const cfg = readFileSync(join(dir, "kit.config.js"), "utf8");
  assert.match(cfg, /locale: "fa-IR"/);
  assert.match(cfg, /system: "jalali"/);
  assert.match(readFileSync(join(dir, "public/index.html"), "utf8"), /<html lang="fa" dir="rtl">/);
  assert.match(readFileSync(join(dir, "content/glossary.js"), "utf8"), /تسویه/);
  const c = await kit(["check"], { cwd: dir });
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /fa-IR, jalali/);
  assert.equal((await kit(["init", "x", "--locale", "de"])).code, 1);
  const again = await kit(["init", "fa-site"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /not empty/);
});

test("check: the starter passes; content and config problems exit 1 with every problem listed", async () => {
  const dir = await site("check-ok");
  const ok = await kit(["check"], { cwd: dir });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /weekly 2, monthly 2, daily 6; no problems/);

  const bad = await site("check-bad");
  const g = join(bad, "content/glossary.js");
  writeFileSync(g, readFileSync(g, "utf8").replace('related: ["direct-debit", "chargeback"]', 'related: ["nope"]').replace("Settlement is the final step", "Settlement (T+2 in 3 days) is the final step"));
  const r = await kit(["check"], { cwd: bad });
  assert.equal(r.code, 1);
  assert.match(r.err, /related «nope» is not in the glossary/);
  assert.match(r.err, /definition contains a figure/);

  const badCfg = await site("check-badcfg");
  const k = join(badCfg, "kit.config.js");
  writeFileSync(k, readFileSync(k, "utf8").replace('url: "https://example.org"', 'url: "example.org"').replace('on: "mon"', 'on: "someday"'));
  const rc = await kit(["check"], { cwd: badCfg });
  assert.equal(rc.code, 1);
  assert.match(rc.err, /site\.url must be an absolute http\(s\) URL/);
  assert.match(rc.err, /series\[0\] \(weekly\)\.on must be a weekday/);

  const none = await kit(["check"], { cwd: TMP });
  assert.equal(none.code, 1);
  assert.match(none.err, /no kit\.config\.js/);
});

test("plan: agenda.md for the sample windows; --json has episodes; gaps exit 1", async () => {
  const dir = await site("plan-site");
  const r = await kit(["plan", "--from", "2026-09-28", "--days", "70"], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /10 items, 8 episodes/);
  const md = readFileSync(join(dir, "agenda.md"), "utf8");
  assert.match(md, /^# Example Money Notes publishing agenda/);
  assert.match(md, /Sample topic: compound interest/);
  assert.match(md, /No problems\./);

  const j = await kit(["plan", "--from", "2026-09-28", "--days", "70", "--json", "--out", "false"], { cwd: dir });
  const data = JSON.parse(j.out);
  assert.equal(data.stats.series.weekly.items, 2);
  assert.equal(data.stats.series.monthly.items, 2);
  assert.equal(data.stats.series.daily.episodes, 6);
  const first = data.items.find((x) => x.series === "daily");
  assert.equal(first.slug, "term-settlement");
  assert.equal(first.episode.slug, "term-settlement");
  assert.equal(first.number, 1);
  assert.equal(first.episode.lines[0].speaker, "host");
  assert.match(first.episode.lines[0].text, /^Hi! One Term a Day, episode 1\. Today's term: Settlement\./);
  const wk = data.items.find((x) => x.series === "weekly");
  assert.ok(wk.episode.lines.some((l) => /This week has 5 business days/.test(l.text)), "the runtime's calendar segment is included");

  const gap = await site("plan-gap");
  const k = join(gap, "kit.config.js");
  writeFileSync(k, readFileSync(k, "utf8").replace('start: "2026-09-28", end: "2026-10-03"', 'start: "2026-09-28"'));
  const g = await kit(["plan", "--from", "2026-09-28", "--days", "10", "--out", "-"], { cwd: gap });
  assert.equal(g.code, 1);
  assert.match(g.err, /daily 2026-10-04: no term left in the rotation/);
  assert.match(g.out, /## Problems/);
  assert.equal((await kit(["plan", "--days", "x"], { cwd: dir })).code, 1);
});

test("render: prints the script with speakers and the duration against the limit", async () => {
  const dir = await site("render-site");
  const r = await kit(["render", "weekly", "2026-09-28"], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^week-2026-09-28 · Money in Two Minutes · 2026-09-28 06:00 UTC/);
  assert.match(r.out, /\nAlex: Hi! This is Money in Two Minutes, from Example Money Notes\. I'm Alex, here with Sam\.\nSam: Hello everyone!/);
  assert.match(r.out, /16 turns, \d+ characters, about 1:\d\d at 11 characters\/s \(limit 2:30\)/);

  const d = await kit(["render", "daily", "term-chargeback", "--json"], { cwd: dir });
  const ep = JSON.parse(d.out);
  assert.equal(ep.slug, "term-chargeback");
  assert.equal(ep.number, 5);
  assert.ok(ep.estimatedMs > 30000 && ep.estimatedMs < 80000);
  const s = await kit(["render", "daily", "chargeback", "--speakable"], { cwd: dir });
  assert.match(s.out, /episode five/, "numbers in words");

  assert.match((await kit(["render", "monthly", "2026-10"], { cwd: dir })).err, /has no podcast/);
  assert.match((await kit(["render", "weekly", "2026-09-29"], { cwd: dir })).err, /nothing scheduled/);
  assert.match((await kit(["render", "yearly", "x"], { cwd: dir })).err, /unknown series "yearly" \(series: weekly, monthly, daily\)/);

  const fa = await site("render-fa", "fa");
  const f = await kit(["render", "daily", "settlement"], { cwd: fa });
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /سارا: سلام! یک واژه در روز، قسمت ۱\. واژه امروز: تسویه\./);
});

/** A fake admin API: records requests, answers like @saasreport/cloudflare's handlers. */
async function fakeSite(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    seen.push(r);
    const [status, json] = handler(r);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test("publish and status call the admin API with KIT_ADMIN_TOKEN", async () => {
  const dir = await site("admin-site");
  const api = await fakeSite((r) => {
    if (r.auth !== "Bearer t0k") return [401, { ok: false, error: "unauthorized" }];
    if (r.url === "/api/podcasts/generate") return [200, { ok: true, slug: "week-2026-09-28", status: "queued", created: true, workflow_id: "wf-1" }];
    if (r.url === "/api/podcasts/admin") return [200, { ok: true, tts_configured: true, episodes: [{ slug: "week-2026-09-28", series: "weekly", status: "published", updated_at: "2026-09-28T06:02:00Z" }] }];
    if (r.url === "/api/podcasts/admin/week-2026-09-28") return [200, { ok: true, episode: { slug: "week-2026-09-28", series: "weekly", show: "weekly", status: "review", error: "audio is 161 s, over the 150 s limit", workflow_id: "wf-1", duration_ms: 161000 }, workflow: { status: "complete" } }];
    return [404, { ok: false, error: "not_found" }];
  });
  const opts = { cwd: dir, fetch: globalThis.fetch };
  try {
    const noToken = await kit(["publish", "weekly", "2026-09-28", "--url", api.url], opts);
    assert.equal(noToken.code, 1);
    assert.match(noToken.err, /KIT_ADMIN_TOKEN is not set/);

    const p = await kit(["publish", "weekly", "2026-09-28", "--force"], { ...opts, env: { KIT_ADMIN_TOKEN: "t0k", KIT_SITE_URL: api.url } });
    assert.equal(p.code, 0, p.err);
    assert.match(p.out, /queued week-2026-09-28 \(workflow wf-1\)/);
    assert.deepEqual(api.seen.at(-1), { method: "POST", url: "/api/podcasts/generate", auth: "Bearer t0k", body: { series: "weekly", ref: "2026-09-28", force: true } });

    const n = api.seen.length;
    const dry = await kit(["publish", "daily", "inflation", "--dry-run", "--url", api.url], opts);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /dry run: POST http:\/\/127\.0\.0\.1:\d+\/api\/podcasts\/generate/);
    assert.match(dry.out, /"series":"daily","ref":"inflation","force":false/);
    assert.equal(api.seen.length, n, "a dry run sends nothing");
    assert.match((await kit(["publish", "daily", "unknown-term", "--url", api.url], { ...opts, env: { KIT_ADMIN_TOKEN: "t0k" } })).err, /nothing scheduled/);

    const s = await kit(["status", "--url", api.url], { ...opts, env: { KIT_ADMIN_TOKEN: "t0k" } });
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /speech configured, 1 recent episodes/);
    assert.match(s.out, /published\s+week-2026-09-28/);
    const one = await kit(["status", "week-2026-09-28", "--url", api.url], { ...opts, env: { KIT_ADMIN_TOKEN: "t0k" } });
    assert.match(one.out, /week-2026-09-28 \(weekly\/weekly\): review — audio is 161 s/);
    assert.match(one.out, /workflow wf-1: complete/);

    const denied = await kit(["status", "--url", api.url], { ...opts, env: { KIT_ADMIN_TOKEN: "wrong" } });
    assert.equal(denied.code, 1);
    assert.match(denied.err, /status failed \(401\): unauthorized/);
    const pd = await kit(["publish", "weekly", "2026-09-28", "--url", api.url], { ...opts, env: { KIT_ADMIN_TOKEN: "wrong" } });
    assert.equal(pd.code, 1);
    assert.match(pd.err, /unauthorized — check KIT_ADMIN_TOKEN/);
  } finally { await api.close(); }
  const down = await kit(["status", "--url", "http://127.0.0.1:9"], { cwd: dir, fetch: globalThis.fetch, env: { KIT_ADMIN_TOKEN: "t" } });
  assert.equal(down.code, 1);
  assert.match(down.err, /cannot reach/);
});

test("migrate --dry-run prints the wrangler command (local by default, --remote on request)", async () => {
  const dir = await site("mig-site");
  const l = await kit(["migrate", "--dry-run"], { cwd: dir });
  assert.equal(l.code, 0, l.err);
  assert.match(l.out, /^dry run: npx wrangler d1 migrations apply mig-site --local {3}# migrations: node_modules\/@saasreport\/cloudflare\/migrations$/);
  const r = await kit(["migrate", "--remote", "--dry-run"], { cwd: dir });
  assert.match(r.out, /d1 migrations apply mig-site --remote/);
  const d = await kit(["migrate", "--dry-run", "--database", "other"], { cwd: dir });
  assert.match(d.out, /apply other --local/);
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.bin/wrangler"), "#!/bin/sh\n");
  assert.match((await kit(["migrate", "--dry-run"], { cwd: dir })).out, /^dry run: wrangler d1 migrations apply/, "the project's own wrangler when installed");
  assert.match((await kit(["migrate", "--dry-run"], { cwd: TMP })).err, /no wrangler\.toml/);
});

test("deploy --dry-run checks, then prints the asset refresh and wrangler deploy without doing them", async () => {
  const dir = await site("dep-site");
  rmSync(join(dir, "public/kit"), { recursive: true });
  const r = await kit(["deploy", "--dry-run", "--env", "staging"], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dry run: 1\. kit check\nok: Example Money Notes/);
  assert.match(r.out, /dry run: 2\. write client assets to public\/kit\//);
  assert.match(r.out, /dry run: 3\. npx wrangler deploy --env staging {3}# Worker "dep-site"/);
  assert.ok(!existsSync(join(dir, "public/kit")), "a dry run writes nothing");

  const bad = await site("dep-bad");
  const g = join(bad, "content/glossary.js");
  writeFileSync(g, readFileSync(g, "utf8").replace('related: ["direct-debit", "chargeback"]', 'related: ["nope"]'));
  const b = await kit(["deploy", "--dry-run"], { cwd: bad });
  assert.equal(b.code, 1);
  assert.match(b.err, /deploy stopped/);
});
