import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed, jsonLd } from "./helpers.mjs";

const types = (nodes) => nodes.map((n) => n["@type"]);

for (const lang of ["fa", "en"]) {
  const rtl = lang === "fa";
  const ctx = async (now = "2026-10-01T08:00:00Z") => { const k = makeKit(lang, { now }); await seed(k.env, { lang }); return k; };
  const page = async (get, path, status = 200) => {
    const r = await get(path);
    assert.equal(r.status, status, `${lang} ${path}`);
    assert.match(r.headers.get("content-type"), /^text\/html/, path);
    return r.text();
  };

  test(`${lang}: shell — lang/dir, brand tokens, nav from features, OG/Twitter, org JSON-LD, assets`, async () => {
    const { get, config } = await ctx();
    const html = await page(get, "/blog/");
    // the canonical locale without extensions (site.localeBase: fa-IR, en-US), never the bare language
    assert.match(html, new RegExp(`<html lang="${lang === "fa" ? "fa-IR" : "en-US"}" dir="${rtl ? "rtl" : "ltr"}">`));
    assert.match(html, new RegExp(`<meta property="og:locale" content="${lang === "fa" ? "fa_IR" : "en_US"}">`));
    assert.match(html, new RegExp(`<style>:root\\{--c-accent:${config.brand.colors.accent};--c-ink:#101010;--font-body:Inter, sans-serif\\}</style>`));
    assert.match(html, /<link rel="stylesheet" href="\/kit\/kit\.css\?v=/);
    assert.match(html, /<script src="\/kit\/kit\.js\?v=[^"]+" defer>/);
    assert.match(html, /<meta property="og:title"/);
    assert.match(html, /<meta name="twitter:card"/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${config.site.url}/blog/">`));
    for (const href of ["/blog/", "/podcasts/", "/glossary/", "/events/"]) assert.ok(html.includes(`<a href="${href}"`), href);
    assert.match(html, /<a href="\/blog\/" aria-current="page">/);
    const org = jsonLd(html).find((n) => n["@type"] === "Organization");
    assert.equal(org.name, config.site.org.name);
    assert.equal(org["@id"], `${config.site.url}/#org`);
    assert.match(html, /id="kit-strings"/);
  });

  test(`${lang}: blog index (kind filter, pagination), post, markdown, RSS, JSON`, async () => {
    const { get, env, config } = await ctx();
    let html = await page(get, "/blog/");
    assert.ok(types(jsonLd(html)).includes("Blog"));
    assert.ok(html.includes("/blog/hello-world"));
    assert.ok(!html.includes("future-post"), "unpublished (future) posts are hidden");
    html = await page(get, "/blog/?kind=report");
    assert.ok(!html.includes("/blog/hello-world\""), "kind filter");
    for (let i = 0; i < 13; i++) await env.DB.prepare("INSERT INTO posts (slug, kind, title, summary, body_md, source, published_at, updated_at) VALUES (?, 'article', ?, 's', 'b', 'editorial', ?, ?)").bind(`p-${i}`, `P ${i}`, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").run();
    html = await page(get, "/blog/");
    assert.match(html, /rel="next" href="\?page=2"/);
    html = await page(get, "/blog/?page=2");
    assert.match(html, /rel="prev"/);
    html = await page(get, "/blog/hello-world");
    const ld = jsonLd(html);
    assert.ok(types(ld).includes("BlogPosting") && types(ld).includes("BreadcrumbList"));
    assert.equal(ld.find((n) => n["@type"] === "BlogPosting").inLanguage, config.site.locale);
    assert.match(html, /<link rel="alternate" type="text\/markdown"[^>]*href="\/blog\/hello-world\.md">/);
    assert.match(html, /data-rx="post:hello-world"/);
    assert.match(html, /<aside class="aside">/, "table of contents for 2+ headings");
    let r = await get("/blog/hello-world.md");
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/markdown/);
    assert.match(await r.text(), /^---\ntitle: /);
    r = await get("/blog/feed.xml");
    assert.match(r.headers.get("content-type"), /application\/rss\+xml/);
    const rss = await r.text();
    assert.ok(rss.includes(`<link>${config.site.url}/blog/hello-world</link>`));
    assert.ok(rss.includes(`<language>${config.site.locale}</language>`));
    r = await get("/api/blog/posts?limit=2");
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.posts.length, 2); assert.equal(j.total, 14);
    assert.equal((await get("/blog/missing")).status, 404);
    assert.equal((await get("/blog/missing.md")).status, 404);
    assert.equal((await get("/blog")).status, 301);
  });

  test(`${lang}: events index, page (Event JSON-LD), ICS, add-to-calendar chooser, JSON`, async () => {
    const { get, config } = await ctx();
    let html = await page(get, "/events/");
    assert.ok(html.includes("/events/webinar") && html.includes("/events/meetup"));
    html = await page(get, "/events/webinar");
    const ev = jsonLd(html).find((n) => n["@type"] === "Event");
    assert.equal(ev.startDate, "2026-10-20T13:30:00.000Z");
    assert.equal(ev.eventAttendanceMode, "https://schema.org/OnlineEventAttendanceMode");
    assert.match(html, /data-cal="google" href="https:\/\/calendar\.google\.com\/calendar\/render\?/);
    assert.ok(!html.includes('data-form="event-rsvp"'), "RSVP is opt-in");
    let r = await get("/events/webinar.ics");
    assert.match(r.headers.get("content-type"), /text\/calendar/);
    const ics = await r.text();
    assert.match(ics, /DTSTART:20261020T133000Z/);
    assert.ok(ics.includes(`UID:webinar@${new URL(config.site.url).host}`));
    html = await page(get, "/events/webinar/add");
    for (const c of ["google", "apple", "outlook", "office"]) assert.ok(html.includes(`data-cal="${c}"`), c);
    assert.match(html, /noindex/);
    const g = new URL(/data-cal="google" href="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&"));
    assert.equal(g.searchParams.get("dates"), "20261020T133000Z/20261020T150000Z");
    assert.equal(g.searchParams.get("ctz"), config.site.timezone);
    r = await get("/api/events");
    const j = await r.json();
    assert.deepEqual(j.events.map((e) => e.slug), ["webinar"]);
    assert.equal((await get("/events/nope")).status, 404);
  });

  test(`${lang}: podcasts index (every show), episode (transcript + player + JSON-LD), feeds, JSON API`, async () => {
    const { get, config } = await ctx();
    let html = await page(get, "/podcasts/");
    for (const id of Object.keys(config.shows)) assert.match(html, new RegExp(`<section class="wrap podshow" id="${id}"`));
    const series = jsonLd(html).filter((n) => n["@type"] === "PodcastSeries");
    assert.equal(series.length, 2);
    assert.match(html, /<script src="\/kit\/podcast\.js\?v=/);
    html = await page(get, "/podcasts/weekly-2026-09-26");
    const ep = jsonLd(html).find((n) => n["@type"] === "PodcastEpisode");
    assert.equal(ep.associatedMedia.contentUrl, `${config.site.url}/podcasts/audio/weekly-2026-09-26.mp3`);
    assert.match(ep.transcript, new RegExp(`${Object.values(config.hosts)[0].name}: `));
    assert.match(html, /<ol class="tscript" data-transcript><li data-start="0"/);
    assert.match(html, /class="pp pp--big" data-pp data-duration="65000"/);
    assert.match(html, /data-rx="episode:weekly-2026-09-26"/);
    assert.match(html, /class="rx__rate" role="radiogroup"/);
    for (const [id, sh] of Object.entries(config.shows)) {
      for (const path of [sh.feed || `/podcasts/${id}/feed.xml`, `/podcasts/${id}/feed.xml`]) {
        const r = await get(path);
        assert.equal(r.status, 200, path);
        assert.match(r.headers.get("content-type"), /application\/rss\+xml/);
        const x = await r.text();
        assert.match(x, /xmlns:itunes=/); assert.match(x, /<podcast:guid>[0-9a-f-]{36}<\/podcast:guid>/);
        assert.ok(x.includes(`<title>${sh.title}</title>`));
      }
    }
    const weeklyFeed = await (await get("/podcasts/weekly/feed.xml")).text();
    assert.ok(weeklyFeed.includes("weekly-2026-09-26.mp3") && !weeklyFeed.includes("daily-iban.mp3"));
    const j = await (await get("/api/podcasts?series=daily")).json();
    assert.deepEqual(j.episodes.map((e) => e.slug), ["daily-iban"]);
    assert.equal(j.episodes[0].audio, `${config.site.url}/podcasts/audio/daily-iban.mp3`);
    assert.equal(j.shows.length, 2);
    assert.match(await (await get("/podcasts/weekly-2026-09-26.md")).text(), /## /);
    assert.equal((await get("/podcasts/nope")).status, 404);
  });

  test(`${lang}: glossary taxonomy, term page (DefinedTerm), markdown, API, today, redirects`, async () => {
    const { get, config } = await ctx();
    let html = await page(get, "/glossary/");
    const set = jsonLd(html).find((n) => n["@type"] === "DefinedTermSet");
    assert.equal(set.hasDefinedTerm.length, 3);
    assert.match(html, /data-gsearch/); assert.match(html, /<section class="gcat" id="pay" data-gcat>/);
    assert.match(html, /data-gterm href="\/glossary\/iban"/);
    assert.match(html, /data-glossary-today/, "term of the day on 2026-10-01");
    assert.match(html, /<script src="\/kit\/glossary\.js\?v=/);
    html = await page(get, "/glossary/iban");
    const term = jsonLd(html).find((n) => n["@type"] === "DefinedTerm");
    assert.equal(term.termCode, "iban");
    assert.equal(term.inDefinedTermSet["@id"], `${config.site.url}/glossary/#set`);
    assert.equal(term.subjectOf.url, `${config.site.url}/podcasts/daily-iban`, "published episode linked");
    assert.match(html, /data-pp/);
    assert.match(html, /href="\/glossary\/ledger"/, "related terms");
    const md = await (await get("/glossary/iban.md")).text();
    assert.match(md, /^---\nterm: /);
    const api = await (await get("/api/glossary")).json();
    assert.equal(api.terms.length, 3); assert.equal(api.categories.length, 2);
    assert.equal(api.terms.find((x) => x.slug === "iban").episode_date, "2026-09-30");
    const today = await (await get("/api/glossary/today")).json();
    assert.equal(today.term.slug, "ledger"); assert.equal(today.number, 2);
    for (const p of ["/taxonomy", "/taxonomy/", "/glossary"]) { const r = await get(p); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/glossary/"); }
    assert.equal((await get("/glossary/nope")).status, 404);
  });

  test(`${lang}: glossary today is empty outside the rotation`, async () => {
    const { get } = await ctx("2026-12-01T08:00:00Z");
    const t = await (await get("/api/glossary/today")).json();
    assert.equal(t.term, null);
    assert.match(await (await get("/glossary/")).text(), /data-glossary-empty/);
  });

  test(`${lang}: audio from R2 with byte ranges`, async () => {
    const { get } = await ctx();
    let r = await get("/podcasts/audio/weekly-2026-09-26.mp3");
    assert.equal(r.status, 200); assert.equal(r.headers.get("accept-ranges"), "bytes"); assert.equal(r.headers.get("content-length"), "10");
    r = await get("/podcasts/audio/weekly-2026-09-26.mp3", { headers: { range: "bytes=2-5" } });
    assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await r.text(), "2345");
    r = await get("/podcasts/audio/weekly-2026-09-26.mp3", { headers: { range: "bytes=-3" } });
    assert.equal(await r.text(), "789");
    r = await get("/podcasts/audio/weekly-2026-09-26.mp3", { headers: { range: "bytes=50-" } });
    assert.equal(r.status, 416);
    assert.equal((await get("/podcasts/audio/missing.mp3")).status, 404);
  });

  test(`${lang}: status from the MONITOR Worker over a service binding (H2: the site never binds the monitor's D1), health, 404s`, async () => {
    const { get, env } = await ctx();
    assert.equal(env.MONITOR_DB, undefined, "the site's env has no monitor database");
    const mon = env.MONITOR;
    delete env.MONITOR;
    let r0 = await get("/api/status");
    assert.equal(r0.status, 503, "no MONITOR service bound: no guess from the site's DB");
    assert.deepEqual(await r0.json(), { ok: false, status: "unknown", reason: "not-configured" });
    env.MONITOR = { fetch: async () => { throw new Error("service down"); } };
    r0 = await get("/api/status");
    assert.equal(r0.status, 503); assert.equal((await r0.json()).reason, "unreachable", "the reason code, never the error text");
    // a monitor that never answers is bounded: 503 "timeout"
    rawTimeout: {
      env.MONITOR = { fetch: () => new Promise(() => {}) };
      const keep = setInterval(() => {}, 1000);
      try { r0 = await get("/api/status"); assert.equal(r0.status, 503); assert.equal((await r0.json()).reason, "timeout", "the answer arrives (the test would hang otherwise) and says timeout"); } finally { clearInterval(keep); }
    }
    env.MONITOR = mon;
    let j = await (await get("/api/status")).json();
    assert.equal(j.status, "unknown");
    // 0004 stays (applied migrations are never deleted); 0012 supersedes it: nothing can write a monitor run into the site's database
    await assert.rejects(env.DB.prepare("INSERT INTO monitor_runs (started_at, finished_at, trigger, ok, results_json) VALUES ('2026-10-07T00:00:00Z', '2026-10-07T00:01:00Z', 'cron', 1, '[]')").run(), /superseded: the monitor writes to its own D1/);
    await env.MONITOR.db.prepare("INSERT INTO monitor_runs (started_at, finished_at, trigger, ok, results_json) VALUES (?, ?, 'cron', 0, ?)").bind("2026-10-01T03:00:00Z", "2026-10-01T03:01:00Z", JSON.stringify([{ name: "glossary", ok: false }])).run();
    j = await (await get("/api/status")).json();
    assert.equal(j.status, "stale", "a 2026-10-01 run read today is stale, not failing"); assert.equal(j.last.ok, false); assert.equal(j.last.journeys[0].name, "glossary");
    // /api/health is derived from the monitor, never a constant (kit.health.v1): a stale monitor is not healthy
    const h = await get("/api/health");
    assert.equal(h.status, 503); const hj = await h.json();
    assert.deepEqual([hj.ok, hj.monitor.status, hj.monitor.failed], [false, "stale", ["glossary"]]);
    const r = await get("/nowhere");
    assert.equal(r.status, 404); assert.match(r.headers.get("content-type"), /text\/html/);
    assert.equal((await get("/api/nowhere")).status, 404);
  });
}

test("www host redirects to the canonical host; unknown paths go to static assets", async () => {
  const { kit, env, config } = makeKit("en");
  let r = await kit.fetch(new Request(`https://www.${new URL(config.site.url).host}/blog/`), env, {});
  assert.equal(r.status, 301); assert.equal(r.headers.get("location"), `${config.site.url}/blog/`);
  env.ASSETS = { fetch: async () => new Response("static", { status: 200 }) };
  r = await kit.fetch(new Request(`${config.site.url}/about/`), env, {});
  assert.equal(await r.text(), "static");
});
