// A bilingual site (English at /, Arabic at /ar/): routes, links, feeds, sitemap hreflang, llms.txt, the daily cron per
// locale, stored slugs and the locale column, the admin API under /ar, redirects for stored-slug links, and the
// migration that adds the locale column without touching existing rows.
import { migrationOrder } from "@saasreport/core/migration-order";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { buildKit } from "../src/kit.js";
import { makeDB, makeR2, makeWF, DEPS, jsonLd, makeKit, seed, wire } from "./helpers.mjs";
import { bilingualConfig, bilingualContent } from "../../core/test/fixtures/bilingual.mjs";

const DAY = 864e5, dayOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const ORIGIN = "https://finance.example";
let kit, env, get, report, announced = 0, workflowOpts;

before(async () => {
  kit = buildKit(bilingualConfig(), bilingualContent(), {
    now: () => new Date("2026-10-04T08:00:00Z"),
    nav: [{ href: { en: "/about/", ar: "/ar/about/" }, label: { en: "About", ar: "من نحن" } }],
    deps: { ...DEPS, announcePending: async () => { announced++; return { sent: 0 }; }, createPodcastWorkflow: (o) => { workflowOpts = o; return class {}; } },
  });
  env = { DB: makeDB(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "k", ADMIN_TOKEN: "secret", IP_SALT: "salt",
    ASSETS: { fetch: async (r) => new Response(`asset ${new URL(r.url).pathname}`) } };
  get = (path, init = {}) => kit.fetch(new Request(`${ORIGIN}${path}`, wire(init)), env, { waitUntil() {} });
  report = await kit.runDaily(env, { day: dayOf("2026-10-04") });
  // Publish the queued episodes as the workflow would (audio in R2 under the stored slug).
  const lines = JSON.stringify([{ speaker: "host", text: "x", start_ms: 0 }]);
  await env.DB.prepare("UPDATE podcast_episodes SET status = 'published', published_at = '2026-10-04T03:00:00.000Z', duration_ms = 61000, audio_bytes = 4, script_json = ?, number = 1").bind(lines).run();
  env.PODCASTS.store.set("podcasts/ar/week-2026-10-04.mp3", new TextEncoder().encode("ar01"));
  env.PODCASTS.store.set("podcasts/week-2026-10-04.mp3", new TextEncoder().encode("en01"));
});
const page = async (path, status = 200) => { const r = await get(path); assert.equal(r.status, status, path); return r.text(); };

test("the daily cron publishes every locale, stores non-default slugs with their prefix, announces once", async () => {
  assert.deepEqual(report.posts, ["week-2026-10-04", "ar/week-2026-10-04"]);
  assert.deepEqual(report.episodes, ["week-2026-10-04", "term-sukuk", "ar/week-2026-10-04", "ar/term-sukuk"]);
  assert.deepEqual(Object.keys(report.locales), ["en", "ar"]);
  assert.equal(announced, 1);
  const posts = (await env.DB.prepare("SELECT slug, locale, title FROM posts ORDER BY slug").all()).results;
  assert.deepEqual(posts.map((p) => [p.slug, p.locale]), [["ar/week-2026-10-04", "ar"], ["week-2026-10-04", ""]]);
  assert.equal(posts[0].title, "ما هي الصكوك");
  const eps = (await env.DB.prepare("SELECT slug, locale, summary FROM podcast_episodes ORDER BY slug").all()).results;
  assert.deepEqual(eps.map((e) => [e.slug, e.locale]), [["ar/term-sukuk", "ar"], ["ar/week-2026-10-04", "ar"], ["term-sukuk", ""], ["week-2026-10-04", ""]]);
  const wf = env.PODCAST_WF.created.find((c) => c.params.slug === "ar/week-2026-10-04");
  assert.match(wf.id, /^ar-week-2026-10-04-/, "workflow ids carry no slash");
  assert.deepEqual(wf.params, { slug: "ar/week-2026-10-04", locale: "ar" });
  assert.deepEqual(Object.keys(workflowOpts.locales), ["en", "ar"]);
  assert.equal(workflowOpts.locales.ar.config.site.locale, "ar");
  assert.equal(workflowOpts.locales.ar.config.tts.voices.host, "Despina");
});

test("blog: English at /blog/, Arabic at /ar/blog/, each with its own language, links, feed and JSON-LD", async () => {
  const en = await page("/blog/"), ar = await page("/ar/blog/");
  assert.match(en, /<html lang="en" dir="ltr">/);
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.match(en, /href="\/blog\/week-2026-10-04"/);
  assert.doesNotMatch(en, /ما هي الصكوك/);
  assert.match(ar, /<a href="\/ar\/blog\/week-2026-10-04">/);
  assert.match(ar, /ما هي الصكوك/);
  assert.match(ar, /<link rel="canonical" href="https:\/\/finance.example\/ar\/blog\/">/);
  assert.match(ar, /<link rel="alternate" hreflang="en" href="https:\/\/finance.example\/blog\/"><link rel="alternate" hreflang="ar" href="https:\/\/finance.example\/ar\/blog\/"><link rel="alternate" hreflang="x-default" href="https:\/\/finance.example\/blog\/">/);
  assert.match(ar, /<nav class="kbar__nav" aria-label="الأقسام"><a href="\/ar\/blog\/" aria-current="page">المدونة<\/a><a href="\/ar\/podcasts\/">البودكاست<\/a><a href="\/ar\/glossary\/">المسرد<\/a>/);
  assert.match(ar, /<nav class="kbar__langs" aria-label="اللغات"><a href="\/blog\/" hreflang="en" lang="en">English<\/a><\/nav>/);
  assert.match(en, /<a href="\/ar\/blog\/" hreflang="ar" lang="ar">العربية<\/a>/);
  assert.match(ar, /<a href="\/ar\/about\/">من نحن<\/a>/, "localized options");
  assert.match(ar, /href="\/ar\/blog\/feed.xml"/);
  const post = await page("/ar/blog/week-2026-10-04");
  const ld = jsonLd(post);
  const bp = ld.find((n) => n["@type"] === "BlogPosting");
  assert.deepEqual([bp.inLanguage, bp.url, bp.publisher["@id"]], ["ar", `${ORIGIN}/ar/blog/week-2026-10-04`, `${ORIGIN}/#org`]);
  assert.equal(ld.find((n) => n["@type"] === "WebSite").inLanguage, "ar");
  assert.match(post, /data-rx="post:ar\/week-2026-10-04"/);
  assert.match(post, /\[حلقة هذا الأسبوع\]|حلقة هذا الأسبوع<\/a>/);
  assert.match(post, /href="\/ar\/podcasts\/week-2026-10-04"/);
  assert.equal((await get("/blog/week-2026-10-04")).status, 200);
  assert.equal((await get("/ar/blog/ar-week-2026-10-04")).status, 404);
  const feed = await page("/ar/blog/feed.xml");
  assert.match(feed, /<language>ar<\/language>/);
  assert.match(feed, /<link>https:\/\/finance.example\/ar\/blog\/week-2026-10-04<\/link>/);
  assert.doesNotMatch(await page("/blog/feed.xml"), /\/ar\//);
  const api = await (await get("/ar/api/blog/posts")).json();
  assert.deepEqual(api.posts.map((p) => [p.slug, p.url]), [["week-2026-10-04", `${ORIGIN}/ar/blog/week-2026-10-04`]]);
  assert.match(await page("/ar/blog/week-2026-10-04.md"), /url: https:\/\/finance.example\/ar\/blog\/week-2026-10-04/);
});

test("podcasts: one show per locale, feeds with itunes:language, audio from the locale's R2 key", async () => {
  const pods = await page("/ar/podcasts/");
  assert.match(pods, /href="\/ar\/podcasts\/week-2026-10-04"/);
  assert.match(pods, /<audio preload="none" src="\/ar\/podcasts\/audio\/week-2026-10-04.mp3">/);
  assert.match(pods, /href="\/ar\/podcasts\/weekly\/feed.xml"/);
  assert.match(pods, /الأسبوعية/);
  const feed = await page("/ar/podcasts/weekly/feed.xml");
  assert.match(feed, /<language>ar<\/language><itunes:language>ar<\/itunes:language>/);
  assert.match(feed, /<enclosure url="https:\/\/finance.example\/ar\/podcasts\/audio\/week-2026-10-04.mp3"/);
  assert.match(feed, /<guid isPermaLink="false">finance.example-podcast-ar\/week-2026-10-04<\/guid>/);
  assert.doesNotMatch(feed, /term-sukuk|<title>The Weekly/);
  const enFeed = await page("/podcasts/weekly/feed.xml");
  assert.match(enFeed, /<itunes:language>en<\/itunes:language>/);
  assert.doesNotMatch(enFeed, /\/ar\//);
  assert.equal(await (await get("/ar/podcasts/audio/week-2026-10-04.mp3")).text(), "ar01");
  assert.equal(await (await get("/podcasts/audio/week-2026-10-04.mp3")).text(), "en01");
  const ep = await page("/ar/podcasts/week-2026-10-04");
  assert.match(ep, /"@type":"PodcastEpisode"[^]*"inLanguage":"ar"/);
  assert.match(ep, /<a href="\/ar\/blog\/week-2026-10-04">/, "the written version, in the same locale");
});

test("glossary per locale, today's term in its language", async () => {
  const g = await page("/ar/glossary/");
  assert.match(g, /<a class="gterm" data-gterm href="\/ar\/glossary\/sukuk"/);
  assert.match(g, /<h2><a href="\/ar\/glossary\/sukuk">الصكوك<\/a>/);
  assert.match(await page("/ar/glossary/sukuk"), /<h1>الصكوك<\/h1>/);
  assert.match(await page("/glossary/sukuk"), /<h1>Sukuk<\/h1>/);
  const today = await (await get("/ar/api/glossary/today")).json();
  assert.deepEqual([today.term.term, today.term.url, today.episode.url], ["الصكوك", `${ORIGIN}/ar/glossary/sukuk`, `${ORIGIN}/ar/podcasts/term-sukuk`]);
});

test("discovery: one sitemap with hreflang alternates, one llms.txt for both locales", async () => {
  const sm = await page("/sitemap.xml");
  assert.match(sm, /xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.match(sm, /<url><loc>https:\/\/finance.example\/ar\/blog\/week-2026-10-04<\/loc><xhtml:link rel="alternate" hreflang="en" href="https:\/\/finance.example\/blog\/week-2026-10-04"\/><xhtml:link rel="alternate" hreflang="ar" href="https:\/\/finance.example\/ar\/blog\/week-2026-10-04"\/><xhtml:link rel="alternate" hreflang="x-default" href="https:\/\/finance.example\/blog\/week-2026-10-04"\/>/);
  assert.match(sm, /<loc>https:\/\/finance.example\/ar\/glossary\/sukuk<\/loc>/);
  assert.match(sm, /<loc>https:\/\/finance.example\/<\/loc>/);
  const llms = await page("/llms.txt");
  assert.match(llms, /^# Sample Finance\n/);
  assert.match(llms, /Languages: en \(ltr\) https:\/\/finance.example\/, ar \(rtl\) https:\/\/finance.example\/ar\//);
  assert.match(llms, /## المدونة \(ar\)\n- \[ما هي الصكوك\]\(https:\/\/finance.example\/ar\/blog\/week-2026-10-04.md\)/);
  assert.match(llms, /## Blog \(en\)\n- \[What sukuk are\]\(https:\/\/finance.example\/blog\/week-2026-10-04.md\)/);
  assert.match(llms, /## Optional\n- \[Full text\]\(https:\/\/finance.example\/llms-full.txt\)/);
  assert.match(await page("/llms-full.txt"), /# ما هي الصكوك\n\nSource: https:\/\/finance.example\/ar\/blog\/week-2026-10-04/);
  assert.match(await page("/robots.txt"), /Sitemap: https:\/\/finance.example\/sitemap.xml/);
});

test("routing: static pages keep their path, stored-slug links redirect, the API and reactions work under /ar", async () => {
  assert.equal(await page("/ar/"), "asset /ar/");
  assert.equal(await page("/"), "asset /");
  const r = await get("/blog/ar/week-2026-10-04");
  assert.deepEqual([r.status, r.headers.get("location")], [301, "/ar/blog/week-2026-10-04"]);
  assert.equal((await get("/podcasts/ar/term-sukuk")).headers.get("location"), "/ar/podcasts/term-sukuk");
  const like = await (await get("/api/reactions", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ item: "post:ar/week-2026-10-04", like: true }) })).json();
  assert.deepEqual([like.ok, like.likes], [true, 1]);
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };
  const gen = await (await get("/ar/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "daily", ref: "takaful" }) })).json();
  assert.deepEqual([gen.ok, gen.slug], [true, "ar/term-takaful"]);
  const st = await (await get("/ar/api/podcasts/admin/term-takaful", { headers: auth })).json();
  assert.equal(st.episode.slug, "ar/term-takaful");
  const list = await (await get("/ar/api/podcasts/admin", { headers: auth })).json();
  assert.ok(list.episodes.every((e) => e.slug.startsWith("ar/")));
  assert.equal((await get("/ar/no-such-page")).status, 200, "unknown paths fall through to static assets");
});

test("single-locale sites never read or write the locale column", async () => {
  for (const lang of ["fa", "en"]) {
    const k = makeKit(lang);
    await seed(k.env, { lang });
    k.env.DB.log.length = 0;
    for (const p of ["/blog/", "/blog/hello-world", "/blog/feed.xml", "/podcasts/", "/podcasts/feed.xml", "/glossary/", "/events/", "/sitemap.xml", "/llms.txt", "/api/blog/posts", "/api/podcasts"]) await k.get(p);
    await k.kit.runDaily(k.env, { day: dayOf(k.weekDate) });
    assert.ok(k.env.DB.log.length > 10);
    assert.deepEqual(k.env.DB.log.filter((sql) => /locale/.test(sql)), [], lang);
    assert.ok(k.env.PODCAST_WF.created.every((c) => !("locale" in c.params)));
  }
});

test("migration 0006 adds the locale column and keeps every row ('' = the default locale)", () => {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(migrationOrder);
  assert.ok(files.includes("0006_locale.sql"));
  const db = withD1Limits(new DatabaseSync(":memory:"));
  for (const f of files.filter((f) => f < "0006")) db.exec(readFileSync(dir + f, "utf8"));
  const now = "2026-10-01T00:00:00.000Z";
  db.prepare("INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, source, status, published_at, updated_at, channel_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("a", "weekly", "topic", "A", "s", "b", "[]", "auto", "published", now, now, "sent");
  db.prepare("INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, audio_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("e", "weekly", "weekly", "topic", "E", "topic", "published", "podcasts/e.mp3", now, now);
  db.prepare("INSERT INTO events (slug, title, starts_at, ends_at, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("v", "V", now, now, now, now);
  const all = (t) => db.prepare(`SELECT * FROM ${t} ORDER BY slug`).all().map((r) => ({ ...r }));
  const before = { posts: all("posts"), podcast_episodes: all("podcast_episodes"), events: all("events") };
  db.exec(readFileSync(dir + "0006_locale.sql", "utf8"));
  for (const t of Object.keys(before)) assert.deepEqual(all(t), before[t].map((r) => ({ ...r, locale: "" })), t);
  db.prepare("INSERT INTO posts (slug, kind, title, published_at, updated_at, locale) VALUES ('ar/a', 'topic', 'أ', ?, ?, 'ar')").run(now, now);
  assert.deepEqual(db.prepare("SELECT slug FROM posts WHERE locale = '' ORDER BY slug").all().map((r) => r.slug), ["a"]);
});
