// Worker options that let an existing site keep its look, wording and public contracts on kit
// (shell, section strings, sign-up box, API payload hooks, llms builder, sitemap/robots tuning, feed guids, admin post episodes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";

const withStrings = (strings) => (c) => ({ ...c, strings: { ...(c.strings || {}), ...strings } });

test("shell: logo, extra head, robots, og image details, footer items and note, self-hosted font faces", async () => {
  const { get, env } = makeKit("fa", {
    config: (c) => ({ ...c, brand: { ...c.brand, fonts: { body: "Vazirmatn", faces: [{ family: "Vazirmatn", weight: 700, src: "/fonts/V-Bold.ttf", format: "truetype" }] } } }),
    options: { shell: { logo: { src: "/logo-nav.png", width: 198, height: 45 }, head: '<link rel="manifest" href="/site.webmanifest">', robots: "index, follow, max-snippet:-1",
      og: { image: "/og-default.png", width: 1200, height: 630, type: "image/png", secure: true }, scripts: ["/extra.js"] },
      footer: { items: [["/", "صفحه اصلی"], ["/blog/", "بلاگ"]], note: "© {localYear} / {year} — {name}" } } });
  await seed(env);
  const html = await (await get("/blog/")).text();
  assert.match(html, /<img class="kbar__logo" src="\/logo-nav.png" alt="نمونه" width="198" height="45">/);
  assert.match(html, /<link rel="manifest" href="\/site.webmanifest">/);
  assert.match(html, /<meta name="robots" content="index, follow, max-snippet:-1">/);
  assert.match(html, /og:image" content="https:\/\/fa.example.org\/og-default.png"><meta property="og:image:secure_url"[^>]+><meta property="og:image:type" content="image\/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/);
  assert.match(html, /@font-face\{font-family:"Vazirmatn";src:url\("\/fonts\/V-Bold.ttf"\) format\("truetype"\);font-weight:700/);
  assert.doesNotMatch(html, /fonts.googleapis/);
  assert.match(html, /<nav class="kfoot__links"><a href="\/">صفحه اصلی<\/a><a href="\/blog\/">بلاگ<\/a><a href="\/blog\/feed.xml">/);
  assert.match(html, /<p>© ۱۴۰۵ \/ ۲۰۲۶ — سازمان نمونه<\/p>/);
  assert.match(html, /<script src="\/extra.js" defer><\/script>/);
});

test("section strings: eyebrow, heading, lead (HTML), description, page and item titles; og images per section", async () => {
  const { get, env } = makeKit("fa", {
    config: withStrings({ "blog.eyebrow": "بلاگ نمونه", "blog.heading": "نوشته‌ها", "blog.description": "توضیح متا", "blog.itemTitle": "{title} | بلاگ نمونه",
      "glossary.leadHtml": '{terms} واژه؛ <a href="/podcasts/#daily">برنامه روزانه</a>', "glossary.pageTitle": "واژه‌نامه بزرگ | {site}", "blog.cardMeta": "{date}، {n} دقیقه" }),
    options: { blog: { og: { image: "/og-blog.png", alt: "بلاگ" } } } });
  await seed(env);
  const idx = await (await get("/blog/")).text();
  assert.match(idx, /<p class="eyebrow"><span class="dot"><\/span>بلاگ نمونه<\/p><h1>نوشته‌ها<\/h1>/);
  assert.match(idx, /<meta name="description" content="توضیح متا">/);
  assert.match(idx, /og:image" content="https:\/\/fa.example.org\/og-blog.png"/);
  assert.match(idx, /۱۴۰۵، ۱ دقیقه/);
  const post = await (await get("/blog/hello-world")).text();
  assert.match(post, /<title>سلام دنیا \| بلاگ نمونه<\/title>/);
  const g = await (await get("/glossary/")).text();
  assert.match(g, /<p>۳ واژه؛ <a href="\/podcasts\/#daily">برنامه روزانه<\/a><\/p>/);
  assert.match(g, /<title>واژه‌نامه بزرگ \| نمونه<\/title>/);
});

test("subscribe box on the blog and events pages posts to /api/forms/<form>", async () => {
  const { get, env } = makeKit("fa", { options: { subscribe: { form: "newsletter", title: "خبرنامه", note: "هر ماه یک نامه.", privacyUrl: "/privacy", events: { title: "رویدادها را از دست ندهید" } } } });
  await seed(env);
  const blog = await (await get("/blog/")).text();
  assert.match(blog, /<form class="form form--row" data-form="newsletter" data-done="عضویت شما ثبت شد." novalidate>/);
  assert.match(blog, /<h2 id="csub-newsletter">خبرنامه<\/h2><p>هر ماه یک نامه.<\/p>/);
  assert.match(blog, /<a href="\/privacy">سیاست حریم خصوصی<\/a>/);
  assert.match(await (await get("/events/")).text(), /رویدادها را از دست ندهید/);
  assert.doesNotMatch(await (await makeKit("fa").get("/blog/")).text(), /data-form="newsletter"/);
});

test("api hooks reshape public JSON payloads (existing contracts)", async () => {
  const { get, env } = makeKit("fa", { now: "2026-10-01T08:00:00Z", options: { api: {
    podcasts: (p, { rows, url }) => ({ ok: true, n: rows.length, limit: url.searchParams.get("limit"), first: p.episodes[0]?.slug }),
    blogPosts: (p) => ({ ok: true, slugs: p.posts.map((x) => x.slug) }),
    glossaryToday: (p, { term }) => ({ ok: p.ok, fa: term?.term ?? null }),
  } } });
  await seed(env);
  const pj = await (await get("/api/podcasts?limit=5")).json();
  assert.deepEqual({ ...pj, first: undefined }, { ok: true, n: 2, limit: "5", first: undefined });
  assert.ok(["daily-iban", "weekly-2026-09-26"].includes(pj.first));
  assert.deepEqual(await (await get("/api/blog/posts")).json(), { ok: true, slugs: ["hello-world"] });
  const t = await (await get("/api/glossary/today")).json();
  assert.equal(t.ok, true); assert.ok(t.fa);
});

test("llms.build replaces the index; .md source lines and transcript heading are configurable", async () => {
  const { get, env } = makeKit("fa", { options: { llms: { build: ({ full, posts, glossary, postMd }) => `# Custom\n${posts.length} posts, ${glossary.terms.length} terms${full ? `\n${postMd(posts[0])}` : ""}`,
    source: "Sample Org (نمونه)", transcriptHeading: "متن کامل (Transcript)", relatedLabel: "Related", relatedSep: "، " } } });
  await seed(env);
  assert.equal(await (await get("/llms.txt")).text(), "# Custom\n1 posts, 3 terms");
  assert.match(await (await get("/llms-full.txt")).text(), /source: Sample Org \(نمونه\)/);
  assert.match(await (await get("/podcasts/daily-iban.md")).text(), /## متن کامل \(Transcript\)/);
  assert.match(await (await get("/glossary/iban.md")).text(), /\nRelated: \[/);
});

test("sitemap lists nav paths (tunable, fragments and sitemap:false left out); robots comments and AI rules", async () => {
  const { get, env } = makeKit("fa", { options: {
    nav: [{ href: "/calendar/", label: "تقویم", sitemap: { changefreq: "monthly", priority: "0.7" } }, { href: "/#api", label: "API" }, { href: "/x/", label: "X", sitemap: false }],
    security: { robotsComment: "Welcome.", aiComment: "AI crawlers welcome.", aiDisallow: ["/api/forms/"] } } });
  await seed(env);
  const sm = await (await get("/sitemap.xml")).text();
  assert.match(sm, /<url><loc>https:\/\/fa.example.org\/events\/<\/loc><changefreq>weekly<\/changefreq><priority>0.7<\/priority><\/url><url><loc>https:\/\/fa.example.org\/calendar\/<\/loc><changefreq>monthly<\/changefreq><priority>0.7<\/priority><\/url>/);
  assert.doesNotMatch(sm, /#api|\/x\//);
  const robots = await (await get("/robots.txt")).text();
  assert.match(robots, /^# Welcome.\nUser-agent: \*\nAllow: \/\nDisallow: \/api\/forms\/\nDisallow: \/api\/reactions/);
  assert.match(robots, /\n# AI crawlers welcome.\nUser-agent: GPTBot[\s\S]*?Allow: \/\nDisallow: \/api\/forms\/\n\nSitemap:/);
});

test("podcast shows: guidPrefix keeps episode guids, cover1400, badges, clock or minutes, section heading", async () => {
  const { get, env } = makeKit("fa", { config: (c) => ({ ...c, shows: { ...c.shows,
    weekly: { ...c.shows.weekly, guidPrefix: "old-podcast-", cover: "/cover.png", cover1400: "/cover-1400.png", badge: "هفتگی", badgeClass: "kb--snapshot", duration: "minutes", heading: "هفتگی", category: ["Business > Investing", "Technology"] } } }) });
  await seed(env);
  const feed = await (await get("/podcasts/feed.xml")).text();
  assert.match(feed, /<guid isPermaLink="false">old-podcast-weekly-2026-09-26<\/guid>/);
  assert.match(feed, /<itunes:image href="https:\/\/fa.example.org\/cover.png"\/><image><url>https:\/\/fa.example.org\/cover-1400.png<\/url>/);
  assert.match(feed, /<itunes:category text="Technology"\/>/);
  const idx = await (await get("/podcasts/")).text();
  assert.match(idx, /<h2 class="sec">هفتگی/);
  assert.match(idx, /<span class="kb kb--snapshot">هفتگی<\/span>/);
  assert.match(idx, /، ۱ دقیقه<\/span>/);   // Persian comma: «·» next to a Persian digit reorders (CONSTITUTION.md §7)
});

test("admin: {post} queues the audio version of a published post", async () => {
  const { get, env } = makeKit("fa");
  await seed(env);
  const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };
  const r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ post: "hello-world" }) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.slug, "post-hello-world");
  const row = await env.DB.prepare("SELECT series, kind, source_type, source_ref, script_json, script_model FROM podcast_episodes WHERE slug = 'post-hello-world'").first();
  assert.deepEqual(row, { series: "weekly", kind: "article", source_type: "post", source_ref: "hello-world", script_json: null, script_model: null });
  assert.equal((await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ post: "nope" }) })).status, 422);
});

test("events: the join link stays private unless publicJoinUrl; scheduled posts get blog.author", async () => {
  const { get, env, kit } = makeKit("fa", { now: "2026-10-03T08:00:00Z", options: { blog: { author: "تحریریه" } } });
  await seed(env);
  await env.DB.prepare("UPDATE events SET join_url = 'https://meet.example/secret' WHERE slug = 'webinar'").run();
  assert.doesNotMatch(await (await get("/events/webinar")).text(), /meet.example/);
  const pub = makeKit("fa", { options: { events: { publicJoinUrl: true } } });
  await seed(pub.env);
  await pub.env.DB.prepare("UPDATE events SET join_url = 'https://meet.example/secret' WHERE slug = 'webinar'").run();
  assert.match(await (await pub.get("/events/webinar")).text(), /"url":"https:\/\/meet.example\/secret"/);
  await kit.runDaily(env, { day: Math.floor(Date.parse("2026-10-03") / 864e5) });
  const p = await env.DB.prepare("SELECT author FROM posts WHERE series = 'weekly'").first();
  assert.equal(p.author, "تحریریه");
});

test("shell: the call to action in the header and the drawer; preferred sources on the blog index and in the footer, Persian digits", async () => {
  const preferredSource = { placements: ["blog", "footer"], strings: { fa: { title: "{name} را در گوگل اولویت‌دار کنید", text: "منبع منتخب شما در ۲ کلیک: {domain}", button: "افزودن به منابع منتخب گوگل 1" } } };
  const { get, env } = makeKit("fa", { options: { shell: { cta: [{ label: "درخواست دمو", modal: "demo" }], preferredSource } } });
  await seed(env);
  const html = await (await get("/blog/")).text();
  assert.match(html, /<header class="kbar kbar--shell">/);
  assert.match(html, /<div class="nav__cta"><a class="btn btn--primary btn--sm" href="\/#demo">درخواست دمو<\/a><span class="kshell__btns">/);
  assert.match(html, /<div class="kshell__cta"><a class="btn btn--primary btn--sm" href="\/#demo">/, "the drawer carries it for phones");
  // the blog index: the card at the end of the page and in the footer; the domain is the host of site.url
  const cards = html.match(/<aside class="kpref kpref--(blog|footer)"/g) || [];
  assert.deepEqual(cards, ['<aside class="kpref kpref--blog"', '<aside class="kpref kpref--footer"']);
  assert.match(html, /href="https:\/\/google\.com\/preferences\/source\?q=fa\.example\.org" target="_blank" rel="noopener">/);
  assert.match(html, /افزودن به منابع منتخب گوگل ۱/, "Persian digits in the card");
  assert.match(html, /\.kpref\{display:grid/);
  // a post page: footer only
  const post = await (await get("/blog/hello-world")).text();
  assert.deepEqual(post.match(/<aside class="kpref kpref--(blog|footer)"/g), ['<aside class="kpref kpref--footer"']);
});

test("shell.cta: a fragment href (#pricing) points at the home page", async () => {
  const { get, env } = makeKit("fa", { options: { shell: { cta: [{ label: "قیمت", href: "#pricing" }, { label: "بلاگ", href: "/blog/" }] } } });
  await seed(env);
  const html = await (await get("/blog/")).text();
  assert.match(html, /<a class="btn btn--primary btn--sm" href="\/#pricing">قیمت<\/a><a class="btn btn--primary btn--sm" href="\/blog\/">بلاگ<\/a>/);
});
