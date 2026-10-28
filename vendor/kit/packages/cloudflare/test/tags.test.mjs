// Content tags on the Worker (docs/TAGS.md): coloured topic tags with filter and search on /podcasts/ and /blog/, chips on every
// episode and post, the tag pages /tags/ and /tags/<id>/, GET /api/tags, RSS <category>, Markdown twins, llms.txt, sitemap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, formatProblems } from "@saasreport/core/schema";
import { TAG_COLOURS, foldQuery, MAX_FILTER_TAGS, FILTER_TAG_ID_MAX } from "@saasreport/core/tags";
import vm from "node:vm";
import { makeKit, seed, PROV } from "./helpers.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const OPENAPI = read("../contracts/openapi.json");
const text = { fa: (a, b) => ({ fa: a, en: b }) };

const VOCAB = {
  schema: "kit.content-tags.v1", locales: ["en", "fa"],
  groups: [{ id: "tech", label: text.fa("فنی", "Technical") }, { id: "law", label: text.fa("حقوقی", "Legal") }],
  tags: [
    { id: "api", label: text.fa("رابط", "APIs"), group: "tech", colour: "chart2", description: text.fa("رابط‌ها", "Interfaces between systems") },
    { id: "payments", label: text.fa("پرداخت", "Payments"), group: "tech", colour: "chart1", description: text.fa("پرداخت‌ها", "Moving money") },
    { id: "legal", label: text.fa("حقوقی", "Legal & licences"), group: "law", colour: "chart3", description: text.fa("حقوق", "Rules and licences") },
    { id: "reporting", label: text.fa("گزارش", "Reporting"), group: "law", colour: "warn", description: text.fa("گزارش‌دهی", "Reports") },
  ],
};
const SERIES_TAGS = { weekly: ["api"], monthly: ["reporting"], daily: ["payments"] };

/** A kit with the vocabulary, series tags, one term that overrides its series' tags, and seeded rows. */
async function site({ lang = "en", tags = VOCAB } = {}) {
  const k = makeKit(lang, {
    options: { tags },
    config: (c) => { for (const s of c.series) s.tags = SERIES_TAGS[s.id]; return c; },
    content: (c) => { c.daily.terms[0].tags = ["payments", "legal"]; return c; },
  });
  await seed(k.env, { lang });
  const run = (sql, ...a) => k.env.DB.prepare(sql).bind(...a).run();
  const now = "2026-10-01T00:00:00.000Z";
  await run("UPDATE posts SET tags = ? WHERE slug = 'hello-world'", JSON.stringify(["api", "reporting"]));
  await run("INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, source, status, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "licences-101", null, "howto", "Licences 101", "What a licence allows", "## Rights\nText", JSON.stringify(["legal"]), "editorial", "published", "2026-09-20T00:00:00.000Z", now);
  await run("INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, source, status, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "old-free-tags", null, "article", "Old free tags", "Rows from before the vocabulary", "x", JSON.stringify(["not-in-vocabulary"]), "editorial", "published", "2026-09-10T00:00:00.000Z", now);
  return k;
}
const page = async (k, path) => { const r = await k.get(path); return { r, html: await r.text() }; };
const cards = (html) => [...html.matchAll(/<article class="epcard"[^>]*data-slug="([^"]+)"/g)].map((m) => m[1]);
const posts = (html) => [...html.matchAll(/<article class="pcard"[^>]*data-slug="([^"]+)"/g)].map((m) => m[1]);

test("a tag chip is a link to its tag page, painted by its colour role class with the derived text role (no inline colour)", async () => {
  const k = await site();
  const { html } = await page(k, "/podcasts/daily-iban");
  const chips = html.match(/<ul class="tags"[^>]*>[\s\S]*?<\/ul>/)?.[0];
  assert.ok(chips, "the episode page lists its tags");
  assert.match(chips, /<a class="tg tg--chart1" href="\/tags\/payments\/">Payments<\/a>/);
  assert.match(chips, /<a class="tg tg--chart3" href="\/tags\/legal\/">Legal &amp; licences<\/a>/, "the term's own tags override its series' tags");
  assert.doesNotMatch(chips, /style=|#[0-9a-f]{3,6}\b|rgb\(/i, "no literal colour, no inline style");
  const css = readFileSync(new URL("../assets/kit.css", import.meta.url), "utf8");
  const on = (role) => (role === "accent" ? "accent-ink" : `on-${role.replace(/(\d)/, "-$1")}`);
  for (const role of TAG_COLOURS) {
    const rule = new RegExp(`\\.tg--${role}\\{([^}]*)\\}`).exec(css)?.[1];
    assert.ok(rule, `kit.css has a rule for .tg--${role}`);
    assert.ok(rule.startsWith(`--c:var(--c-${role.replace(/(\d)/, "-$1")}`) && rule.includes(`--on-c:var(--c-${on(role)}`), `kit.css paints .tg--${role} with the role and its on-role`);
    assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgb|hsl/i, `.tg--${role} writes no colour: it falls back to roles the sheet already has`);
  }
  assert.doesNotMatch(css, /--c-chart-\d:#|--c-on-chart-\d:#|--c-warn:#|--c-on-(ok|warn|err):#/, "the sheet holds no tone fill of its own: the Worker's brand colours (workerColors) are the one source");
});

test("episode and post pages name their tag ids in <meta name=\"kit:tags\"> (the static search index reads the same tag)", async () => {
  const k = await site();
  assert.match((await page(k, "/podcasts/daily-iban")).html, /<meta name="kit:tags" content="payments legal">/);
  assert.match((await page(k, "/blog/hello-world")).html, /<meta name="kit:tags" content="api reporting">/);
});

test("an episode inherits its series' tags; an item's own tags replace them", async () => {
  const k = await site();
  const weekly = (await page(k, "/podcasts/weekly-2026-09-26")).html;
  assert.match(weekly, /href="\/tags\/api\/"/);
  assert.doesNotMatch(weekly, /href="\/tags\/payments\/"/);
  const daily = (await page(k, "/podcasts/daily-iban")).html;
  assert.ok(daily.includes('href="/tags/payments/"') && daily.includes('href="/tags/legal/"'));
});

test("the podcasts page: a filter bar, tag chips with counts, cards carrying their tags", async () => {
  const k = await site();
  const { r, html } = await page(k, "/podcasts/");
  assert.equal(r.status, 200);
  assert.match(html, /<form class="tagbar[^"]*" method="get" action="\/podcasts\/"[^>]*data-tagbar/);
  assert.match(html, /<input[^>]*type="search"[^>]*name="q"/);
  assert.match(html, /<a class="tg tg--chart2" href="\/podcasts\/\?tag=api"[^>]*aria-pressed="false"[^>]*>APIs/);
  assert.deepEqual(cards(html).sort(), ["daily-iban", "weekly-2026-09-26"]);
  assert.match(html, /data-tags="payments legal"/);
  assert.match(html, /src="\/kit\/tags\.js/);
});

test("podcasts filter: by tag, by show, combined, and search over title, summary and tag labels", async () => {
  const k = await site();
  const ids = async (q) => cards((await page(k, `/podcasts/${q}`)).html);
  assert.deepEqual(await ids("?tag=legal"), ["daily-iban"]);
  assert.deepEqual(await ids("?tag=api"), ["weekly-2026-09-26"]);
  assert.deepEqual(await ids("?show=weekly"), ["weekly-2026-09-26"]);
  assert.deepEqual(await ids("?show=daily&tag=legal"), ["daily-iban"]);
  assert.deepEqual(await ids("?show=weekly&tag=legal"), []);
  assert.deepEqual(await ids("?tag=payments&tag=legal"), ["daily-iban"], "several tags: an episode needs all of them");
  assert.deepEqual(await ids("?tag=payments&tag=api"), []);
  assert.deepEqual(await ids("?q=iban"), ["daily-iban"], "title");
  assert.deepEqual(await ids("?q=minute"), ["daily-iban"], "summary");
  assert.deepEqual(await ids("?q=licences"), ["daily-iban"], "tag label");
  assert.deepEqual(await ids("?q=episode+one"), ["weekly-2026-09-26"]);
  assert.deepEqual(await ids("?q=iban&tag=payments&show=daily"), ["daily-iban"], "search, tag and show combined");
  assert.deepEqual(await ids("?q=iban&tag=api"), []);
  assert.deepEqual(await ids("?tag=nonsense"), [], "an unknown tag matches nothing");
  const none = (await page(k, "/podcasts/?tag=nonsense")).html;
  assert.match(none, /class="empty[^"]*"[^>]*data-tags-none/);
  const pressed = (await page(k, "/podcasts/?tag=legal&show=daily")).html;
  assert.match(pressed, /href="\/podcasts\/\?show=daily"[^>]*aria-pressed="true"[^>]*>Legal/, "a pressed chip links to the state without it");
});

test("the filter reaches beyond the per-show page limit (the server filters before it limits)", async () => {
  const k = await site();
  const run = (sql, ...a) => k.env.DB.prepare(sql).bind(...a).run();
  for (let i = 0; i < 40; i++) {
    const at = `2026-08-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`;
    await run(`INSERT INTO podcast_episodes (slug, series, show, number, kind, title, summary, source_type, source_ref, script_json, status, audio_bytes, duration_ms, published_at, created_at, updated_at, provenance_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `weekly-old-${i}`, "weekly", "weekly", 100 + i, "topic", `Older ${i}`, "s", "topic", `2026-01-${i}`, "[]", "published", 1, 1000, at, at, at, PROV("weekly", `r${i}`, at));
  }
  const html = (await page(k, "/podcasts/?tag=api&show=weekly")).html;
  assert.equal(cards(html).length, 41, "all 41 weekly episodes carry the series tag api, not just the newest 30");
});

test("blog: chips on cards, filter by tag and kind, search, pagination keeps the filter", async () => {
  const k = await site();
  const all = posts((await page(k, "/blog/")).html);
  assert.ok(["hello-world", "licences-101", "old-free-tags"].every((s) => all.includes(s)));
  assert.deepEqual(posts((await page(k, "/blog/?tag=api")).html), ["hello-world"]);
  assert.deepEqual(posts((await page(k, "/blog/?tag=legal")).html), ["licences-101"]);
  assert.deepEqual(posts((await page(k, "/blog/?tag=legal&kind=article")).html), []);
  assert.deepEqual(posts((await page(k, "/blog/?tag=legal&kind=howto")).html), ["licences-101"]);
  assert.deepEqual(posts((await page(k, "/blog/?q=allows")).html), ["licences-101"], "summary");
  assert.deepEqual(posts((await page(k, "/blog/?q=reporting")).html), ["hello-world"], "tag label");
  assert.deepEqual(posts((await page(k, "/blog/?tag=api&tag=reporting")).html), ["hello-world"]);
  assert.deepEqual(posts((await page(k, "/blog/?tag=api&tag=legal")).html), []);
  const html = (await page(k, "/blog/")).html;
  assert.match(html, /<form class="tagbar[^"]*" method="get" action="\/blog\/"/);
  assert.match(html, /<a class="tg tg--chart3" href="\/blog\/\?tag=legal"/);
  assert.match(html, /data-slug="hello-world"[\s\S]*?<ul class="tags[^"]*"[\s\S]*?APIs/);
});

test("a post page lists its tags as chips to the tag pages; a tag outside the vocabulary is shown neutral, never as a link", async () => {
  const k = await site();
  const { html } = await page(k, "/blog/hello-world");
  assert.match(html, /<ul class="tags"[^>]*>[\s\S]*<a class="tg tg--chart2" href="\/tags\/api\/">APIs<\/a>[\s\S]*<a class="tg tg--warn" href="\/tags\/reporting\/">Reporting<\/a>/);
  const old = (await page(k, "/blog/old-free-tags")).html;
  assert.match(old, /<span class="tg tg--unknown">not-in-vocabulary<\/span>/);
  assert.doesNotMatch(old, /href="\/tags\/not-in-vocabulary/);
});

test("the tag index /tags/ groups the tags and counts podcasts and posts", async () => {
  const k = await site();
  const { r, html } = await page(k, "/tags/");
  assert.equal(r.status, 200);
  assert.match(html, /<h2[^>]*>Technical<\/h2>[\s\S]*<h2[^>]*>Legal<\/h2>/);
  assert.match(html, /<a class="tg tg--chart3" href="\/tags\/legal\/">Legal &amp; licences<\/a>\s*<small[^>]*>1 podcast, 1 post<\/small>/);
  assert.match(html, /Rules and licences/);
  assert.match(html, /<link rel="canonical" href="https:\/\/en\.example\.org\/tags\/"/);
});

test("a tag page lists the podcasts and the posts of that tag, and answers 404 for an unknown tag", async () => {
  const k = await site();
  const { r, html } = await page(k, "/tags/payments/");
  assert.equal(r.status, 200);
  assert.deepEqual(cards(html), ["daily-iban"]);
  assert.match(html, /<h1><span class="tg tg--chart1 tg--lg">Payments<\/span><\/h1>/);
  assert.match(html, /Moving money/);
  const legal = (await page(k, "/tags/legal/")).html;
  assert.deepEqual(cards(legal), ["daily-iban"]);
  assert.deepEqual(posts(legal), ["licences-101"]);
  const api = (await page(k, "/tags/api/")).html;
  assert.deepEqual(cards(api), ["weekly-2026-09-26"]);
  assert.deepEqual(posts(api), ["hello-world"]);
  assert.equal((await k.get("/tags/nonsense/")).status, 404);
  const bare = await k.get("/tags");
  assert.ok([301, 302, 308].includes(bare.status));
  assert.equal(bare.headers.get("location"), "/tags/");
});

test("GET /api/tags and /api/tags/<id> conform to the OpenAPI contract", async () => {
  const k = await site();
  const names = ["Tag", "TagGroup", "TagIndex", "TagItem", "TagDetail"];
  const defs = JSON.parse(JSON.stringify(Object.fromEntries(names.map((n) => [n, OPENAPI.components.schemas[n]]))).replaceAll("#/components/schemas/", "#/$defs/"));
  const check = (value, name) => formatProblems(validate(value, { $defs: defs, $ref: `#/$defs/${name}` }));
  const idx = await (await k.get("/api/tags")).json();
  assert.deepEqual(check(idx, "TagIndex"), []);
  const legal = idx.tags.find((t) => t.id === "legal");
  assert.deepEqual({ ...legal }, { id: "legal", label: "Legal & licences", description: "Rules and licences", group: "law", group_label: "Legal", colour: "chart3",
    counts: { podcasts: 1, posts: 1 }, url: "https://en.example.org/tags/legal/" });
  assert.deepEqual(idx.groups.map((g) => g.id), ["tech", "law"]);
  const one = await (await k.get("/api/tags/legal")).json();
  assert.deepEqual(check(one, "TagDetail"), []);
  assert.deepEqual(one.podcasts.map((e) => e.slug), ["daily-iban"]);
  assert.deepEqual(one.posts.map((p) => p.slug), ["licences-101"]);
  assert.equal((await k.get("/api/tags/nonsense")).status, 404);
  for (const path of ["/api/tags", "/api/tags/{id}"]) assert.ok(OPENAPI.paths[path]?.get, `${path} is in the contract`);
});

test("/api/podcasts and /api/blog/posts carry tags and take tag, q (and show) filters", async () => {
  const k = await site();
  const eps = await (await k.get("/api/podcasts?tag=legal")).json();
  assert.deepEqual(eps.episodes.map((e) => e.slug), ["daily-iban"]);
  assert.deepEqual(eps.episodes[0].tags, ["payments", "legal"]);
  assert.deepEqual(eps.episodes[0].tag_labels, ["Payments", "Legal & licences"]);
  assert.deepEqual((await (await k.get("/api/podcasts?q=episode")).json()).episodes.map((e) => e.slug), ["weekly-2026-09-26"]);
  const ps = await (await k.get("/api/blog/posts?tag=api")).json();
  assert.deepEqual(ps.posts.map((p) => p.slug), ["hello-world"]);
  assert.equal(ps.total, 1);
  assert.deepEqual(ps.posts[0].tags, ["api", "reporting"]);
  assert.deepEqual(ps.posts[0].tag_labels, ["APIs", "Reporting"]);
  assert.deepEqual((await (await k.get("/api/blog/posts?q=allows")).json()).posts.map((p) => p.slug), ["licences-101"]);
});

test("RSS: a <category> per tag label on every podcast item and blog post", async () => {
  const k = await site();
  const daily = await (await k.get("/podcasts/daily/feed.xml")).text();
  const item = daily.match(/<item>[\s\S]*?<\/item>/)[0];
  assert.match(item, /<category>Payments<\/category>/);
  assert.match(item, /<category>Legal &amp; licences<\/category>/);
  const blog = await (await k.get("/blog/feed.xml")).text();
  const post = blog.match(/<item>(?:(?!<\/item>)[\s\S])*?hello-world[\s\S]*?<\/item>/)[0];
  assert.match(post, /<category>APIs<\/category>/);
  assert.match(post, /<category>Reporting<\/category>/);
});

test("Markdown twins and llms.txt carry the tags", async () => {
  const k = await site();
  const ep = await (await k.get("/podcasts/daily-iban.md")).text();
  assert.match(ep, /^tags: \["Payments", "Legal & licences"\]$/m);
  assert.match(ep, /^tag_ids: \["payments", "legal"\]$/m);
  const post = await (await k.get("/blog/hello-world.md")).text();
  assert.match(post, /^tags: \["APIs", "Reporting"\]$/m);
  const llms = await (await k.get("/llms.txt")).text();
  assert.match(llms, /\/podcasts\/daily-iban\.md\).*\(tags: Payments, Legal & licences\)/);
  assert.match(llms, /\/blog\/hello-world\.md\).*\(tags: APIs, Reporting\)/);
  assert.match(llms, /## Topics[\s\S]*\[Legal & licences\]\(https:\/\/en\.example\.org\/tags\/legal\/\)/);
  const full = await (await k.get("/llms-full.txt")).text();
  assert.match(full, /tag_ids: \["payments", "legal"\]/);
});

test("the sitemap lists /tags/ and every tag page", async () => {
  const k = await site();
  const xml = await (await k.get("/sitemap.xml")).text();
  for (const id of ["", "api/", "legal/", "payments/", "reporting/"]) assert.ok(xml.includes(`<loc>https://en.example.org/tags/${id}</loc>`), `/tags/${id}`);
});

test("a Persian site: labels in Persian, counts in Persian digits, RTL-safe separators", async () => {
  const k = await site({ lang: "fa" });
  const { html } = await page(k, "/tags/");
  assert.match(html, /<h2[^>]*>فنی<\/h2>/);
  assert.match(html, /پرداخت/);
  assert.match(html, /۱ پادکست/);
  const main = html.match(/<main[\s\S]*<\/main>/)[0];
  assert.doesNotMatch(main, /·/, "no middle dot beside digits");
  assert.doesNotMatch(main, /<small[^>]*>[^<]*[0-9]/, "no Latin digits in the counts");
});

test("without a vocabulary the feature is off: no /tags/, no chips, no filter bar", async () => {
  const k = makeKit("en");
  await seed(k.env, { lang: "en" });
  assert.equal((await k.get("/tags/")).status, 404);
  assert.equal((await k.get("/api/tags")).status, 404);
  const html = await (await k.get("/podcasts/")).text();
  assert.doesNotMatch(html, /tagbar|class="tg /);
});

test("the browser script and the server fold queries the same way (a copy tested against its source)", async () => {
  const src = readFileSync(new URL("../assets/tags.js", import.meta.url), "utf8");
  const vm = await import("node:vm");
  const ctx = { document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} }, window: {}, history: {}, location: { search: "" }, URLSearchParams };
  vm.runInNewContext(src, ctx);
  assert.equal(typeof ctx.window.KitTags?.fold, "function", "the script exposes its fold");
  for (const s of ["  ك ي  Ábc‌d ", "مجوز نرم‌افزار", "APIs  Open", "ÀÉÎ"]) assert.equal(ctx.window.KitTags.fold(s), foldQuery(s));
});

test("a multi-locale site: the vocabulary reaches every locale with its own labels, and a post made by the cron inherits its series' tags", async () => {
  const { buildKit } = await import("../src/kit.js");
  const { makeDB, DEPS, wire } = await import("./helpers.mjs");
  const { bilingualConfig, bilingualContent } = await import("../../core/test/fixtures/bilingual.mjs");
  const vocab = { schema: "kit.content-tags.v1", locales: ["en", "ar"], groups: [{ id: "finance", label: { en: "Finance", ar: "التمويل" } }],
    tags: [{ id: "sukuk", label: { en: "Sukuk", ar: "الصكوك" }, group: "finance", colour: "chart1", description: { en: "Asset-backed certificates", ar: "شهادات مدعومة بأصول" } }] };
  const config = bilingualConfig();
  for (const s of config.series) s.tags = ["sukuk"];
  const content = bilingualContent();
  for (const loc of Object.values(content)) for (const items of Object.values(loc)) if (Array.isArray(items)) for (const it of items) delete it.tags;
  const kit = buildKit(config, content, { now: () => new Date("2026-10-04T08:00:00Z"), tags: vocab, deps: { ...DEPS, announcePending: async () => ({ sent: 0 }) } });
  const env = { DB: makeDB(), IP_SALT: "salt", ADMIN_TOKEN: "x", GEMINI_API_KEY: "k", PODCAST_WF: { create: async (o) => ({ id: o.id }) }, PODCASTS: { head: async () => null } };
  const get = (path) => kit.fetch(new Request(`https://finance.example${path}`, wire({})), env, { waitUntil() {} });
  await kit.runDaily(env, { day: Math.floor(Date.parse("2026-10-04T00:00:00Z") / 864e5) });
  assert.deepEqual((await env.DB.prepare("SELECT slug, tags FROM posts WHERE slug LIKE '%week-2026-10-04'").all()).results.map((r) => JSON.parse(r.tags)), [["sukuk"], ["sukuk"]]);
  const en = await (await get("/tags/")).text(), ar = await (await get("/ar/tags/")).text();
  assert.match(en, /<a class="tg tg--chart1" href="\/tags\/sukuk\/">Sukuk<\/a>/);
  assert.match(ar, /<a class="tg tg--chart1" href="\/ar\/tags\/sukuk\/">الصكوك<\/a>/);
  assert.equal((await get("/ar/tags/sukuk/")).status, 200);
});

test("the filter script folds each card once at load, updates once per frame, and encodes a tag in the URL it builds", () => {
  const js = readFileSync(new URL("../assets/tags.js", import.meta.url), "utf8");
  assert.match(js, /const folded = new Map\(cards\.map\(\(c\) => \[c, fold\(c\.dataset\.q\)\]\)\)/, "the card text is folded at load");
  assert.doesNotMatch(js, /fold\(c\.dataset\.q\)\.includes/, "never folded again while typing");
  assert.match(js, /requestAnimationFrame\(/, "one update per frame");
  assert.match(js, /tag=\$\{encodeURIComponent\(t\)\}/, "a tag id is encoded in the query");
  assert.doesNotMatch(js, /`tag=\$\{t\}`/);
});

// ---- the client acts only on the complete, unfiltered catalogue (Codex, PR #151) ----------------------------------------
const bar = (html) => /<form class="tagbar[^>]*>/.exec(html)?.[0] || "";
const complete = (html) => /data-catalogue="complete"/.test(bar(html));

test("the server declares the catalogue complete only when no tag, show, kind, search or page applies and nothing was cut off", async () => {
  const k = await site();
  assert.ok(complete((await page(k, "/podcasts/")).html), "the unfiltered podcasts page holds every episode");
  assert.ok(complete((await page(k, "/blog/")).html), "the unfiltered blog, one page");
  // must fail: any filter makes the DOM a part of the catalogue, so the client must not treat it as the whole
  for (const path of ["/podcasts/?show=weekly", "/podcasts/?tag=api", "/podcasts/?q=iban", "/podcasts/?show=weekly&tag=api",
    "/blog/?q=licence", "/blog/?tag=legal", "/blog/?kind=howto", "/blog/?page=2", "/blog/?tag=legal&q=licence"]) {
    assert.ok(!complete((await page(k, path)).html), `${path} is a partial list: no data-catalogue="complete"`);
  }
  assert.doesNotMatch((await page(k, "/podcasts/?show=weekly")).html, /data-complete/, "the old per-result flag is gone");
});

test("the server does not declare a truncated catalogue complete", async () => {
  const k = makeKit("en", { options: { tags: VOCAB }, config: (c) => { for (const s of c.series) { s.tags = SERIES_TAGS[s.id]; s.limit = 1; } c.shows = Object.fromEntries(Object.entries(c.shows || {}).map(([id, sh]) => [id, { ...sh, limit: 1 }])); return c; } });
  await seed(k.env, { lang: "en" });
  const { html } = await page(k, "/podcasts/");
  const shown = cards(html).length;
  const all = (await (await k.get("/api/podcasts?limit=200")).json()).episodes?.length ?? shown;
  assert.equal(complete(html), shown >= all, "complete exactly when every episode is on the page");
});

/** The browser script in a sandbox with a fake page: which listeners it registers, and whether a click is intercepted. */
function runScript({ catalogue }) {
  const listeners = { form: {}, input: {} };
  const attrs = { "data-catalogue": catalogue ? "complete" : undefined };
  const chip = { dataset: { tag: "api" }, getAttribute: (n) => (n === "aria-pressed" ? "false" : null), setAttribute() {}, matches: () => false };
  const input = { value: "", addEventListener: (t, f) => { listeners.input[t] = f; }, after() {} };
  const form = {
    dataset: catalogue ? { catalogue: "complete" } : {}, getAttribute: (n) => (n === "action" ? "/blog/" : attrs[n] ?? null),
    querySelector: (q) => (q === "[data-tag-q]" ? input : null), querySelectorAll: (q) => (q.includes("a[data-tag") ? [chip] : []),
    addEventListener: (t, f) => { listeners.form[t] = f; },
  };
  const card = { dataset: { tags: "legal", q: "Licences 101" }, hidden: false, closest: () => null };
  const doc = { querySelector: (q) => (q === "[data-tagbar]" ? form : null), querySelectorAll: (q) => (q === "[data-tags][data-q]" ? [card] : []), createElement: () => ({}) };
  const sandbox = { window: {}, document: doc, history: { replaceState() {} }, requestAnimationFrame: (f) => f() };
  vm.runInNewContext(readFileSync(new URL("../assets/tags.js", import.meta.url), "utf8"), sandbox, { filename: "tags.js" });
  const click = (target) => { let prevented = false; listeners.form.click?.({ target: { closest: () => target }, preventDefault() { prevented = true; } }); return prevented; };
  return { listeners, click, chip, input, card };
}

test("must fail: on a filtered page a chip is never intercepted and the search input is never live (a toggle off or a widened search reaches the server)", () => {
  const r = runScript({ catalogue: false });
  assert.equal(r.listeners.input.input, undefined, "no live search over the part of the catalogue the server returned");
  assert.equal(r.click(r.chip), false, "a chip click is not prevented: the link goes to the server, which restores the other shows");
  assert.equal(r.listeners.form.click, undefined, "no chip handler at all");
  assert.ok(r.listeners.form.keydown, "the space bar still answers a link with role=button");
});

test("on the complete catalogue a chip toggles instantly and typing filters the cards", () => {
  const r = runScript({ catalogue: true });
  assert.equal(typeof r.listeners.input.input, "function", "live search");
  assert.equal(r.click(r.chip), true, "the chip is intercepted: the DOM holds every item");
  r.input.value = "zzz"; r.listeners.input.input();
  assert.equal(r.card.hidden, true, "a word nothing matches hides the card");
});

// ---- the tag query parameter is an array, with the limits the handler enforces ----------------------------------------
test("the contract declares ?tag= as an exploded array with the handler's limits, and the SDKs expose an array", () => {
  for (const path of ["/api/podcasts", "/api/blog/posts"]) {
    const p = OPENAPI.paths[path].get.parameters.find((x) => x.name === "tag");
    assert.equal(p.style, "form");
    assert.equal(p.explode, true);
    assert.equal(p.schema.type, "array", `${path}: tag is an array`);
    assert.equal(p.schema.maxItems, MAX_FILTER_TAGS, "the item limit is the handler's constant");
    assert.equal(p.schema.items.maxLength, FILTER_TAG_ID_MAX, "the id length is the handler's constant");
    assert.equal(p.schema.items.type, "string");
  }
  const dts = readFileSync(new URL("../../../sdk/kit/index.d.ts", import.meta.url), "utf8");
  assert.equal([...dts.matchAll(/^\s*tag\?: (.+);$/gm)].every((m) => m[1] === "string[]"), true, "the TypeScript SDK types tag as string[]");
  assert.ok(/tag\?: string\[\];/.test(dts));
  const py = readFileSync(new URL("../../../sdk/kit/python/kit_sdk/__init__.py", import.meta.url), "utf8");
  assert.match(py, /"name": "tag",\s*"in": "query",\s*"required": False,\s*"type": "array",\s*"style": "form",\s*"explode": True/, "the Python SDK serialises tag as an exploded array");
});

test("the handler uses no more tags than the contract allows, and repeats AND", async () => {
  const k = await site();
  const many = Array.from({ length: MAX_FILTER_TAGS + 4 }, (_, i) => `tag=x${i}`).join("&");
  const r = await k.get(`/api/blog/posts?${many}`);
  assert.equal(r.status, 200);
  const both = await (await k.get("/api/blog/posts?tag=api&tag=reporting")).json();
  assert.ok(both.posts.every((x) => x.tags.includes("api") && x.tags.includes("reporting")), "several tags are required together");
});
