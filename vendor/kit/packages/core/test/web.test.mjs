// markdown, seo (jsonLd, sitemap, robots, llms), feeds, calendar links, i18n, ids
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, renderMarkdown, toPlain, markdown, org, website, graph, crumbs, jsonLdScript, sitemap, robots, llmsTxt, llmsFull,
  rss, podcastRss, podcastGuid, itunesDuration, calendarLinks, calendarLinksFor, eventIcs, i18n, t, digits, strings, slugify, isSlug, zonedToUtc, dates } from "../src/index.js";
import { faConfig, enConfig } from "./helpers.mjs";

const fa = defineConfig({ ...faConfig(), site: { ...faConfig().site, logo: "/logo.png", org: { sameAs: ["https://t.me/demo"] }, description: "توضیح سایت" } });
const en = defineConfig(enConfig());

test("markdown escapes HTML and unsafe links", () => {
  const { html, headings } = renderMarkdown("## عنوان\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](/calendar/) [z](https://example.com) [s](https://demo.example/blog/a)\n\n```js\n<b>code</b>\n```\n\n| a | b |\n| --- | --- |\n| ۱ | `c` |", { origin: "https://demo.example" });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('href="#"'));
  assert.ok(html.includes('href="/calendar/"'));
  assert.ok(html.includes('href="https://example.com" target="_blank" rel="noopener"'));
  assert.ok(html.includes('href="https://demo.example/blog/a">'));
  assert.ok(html.includes("&lt;b&gt;code&lt;/b&gt;"));
  assert.ok(html.includes("<table>"));
  assert.equal(headings[0].text, "عنوان");
  assert.equal(toPlain("**a** [b](/x)"), "a b");
  assert.equal(markdown.render, renderMarkdown);
  assert.equal(markdown.readingMinutes("word ".repeat(450)), 2);
});

test("jsonLd graph, org and crumbs come from config", () => {
  const g = graph(org(fa), website(fa), crumbs(fa, [["بلاگ", "/blog/"]]));
  assert.equal(g["@context"], "https://schema.org");
  const [o, w, c] = g["@graph"];
  assert.deepEqual(o, { "@type": "Organization", "@id": "https://demo.example/#org", name: "نمونه", url: "https://demo.example", logo: { "@type": "ImageObject", url: "https://demo.example/logo.png" }, sameAs: ["https://t.me/demo"] });
  assert.equal(w.inLanguage, "fa-IR");
  assert.deepEqual(c.itemListElement.map((x) => [x.position, x.name, x.item]), [[1, "خانه", "https://demo.example/"], [2, "بلاگ", "https://demo.example/blog/"]]);
  assert.match(jsonLdScript({ a: "</script>" }), /\\u003c\/script>/);
});

test("sitemap and robots", () => {
  const xml = sitemap(["/", { loc: "/blog/a&b", lastmod: "2026-09-29T10:00:00Z", changefreq: "monthly", priority: 0.6 }, "https://other.example/x"], { base: "https://demo.example/" });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.ok(xml.includes("<url><loc>https://demo.example/</loc></url>"));
  assert.ok(xml.includes("<loc>https://demo.example/blog/a&amp;b</loc><lastmod>2026-09-29</lastmod><changefreq>monthly</changefreq><priority>0.6</priority>"));
  assert.ok(xml.includes("<loc>https://other.example/x</loc>"));
  assert.ok(sitemap(en, ["/a"]).includes("<loc>https://demo.example/a</loc>"));
  const r = robots(en);
  assert.match(r, /User-agent: \*\nAllow: \/\nDisallow: \/api\/forms\//);
  assert.match(r, /User-agent: ClaudeBot/);
  assert.match(r, /Sitemap: https:\/\/demo\.example\/sitemap\.xml/);
  assert.match(r, /llms\.txt/);
  const off = robots(defineConfig({ ...enConfig(), features: { sitemap: false, llms: false } }), { aiBots: false });
  assert.doesNotMatch(off, /Sitemap:|llms/);
  assert.match(off, /User-agent: CCBot\nDisallow: \/\n/);
});

test("llms.txt and llms-full.txt", () => {
  const sections = [{ title: "Docs", text: "Read these.", links: [{ title: "Blog", url: "/blog/", description: "posts" }, { title: "Ext", url: "https://x.example/" }] }];
  const l = llmsTxt(en, sections);
  assert.match(l, /^# Demo\n\n> A demo site\.\n\nLanguage: en-US \(ltr\)\. Site: https:\/\/demo\.example\n\n## Docs\nRead these\.\n- \[Blog\]\(https:\/\/demo\.example\/blog\/\): posts\n- \[Ext\]\(https:\/\/x\.example\/\)\n/);
  const full = llmsFull(en, sections, [{ title: "A post", url: "/blog/a.md", markdown: "## Part\ntext" }]);
  assert.ok(full.startsWith(l));
  assert.match(full, /\n---\n\n# A post\n\nSource: https:\/\/demo\.example\/blog\/a\.md\n\n## Part\ntext\n/);
});

const wellFormed = (xml) => {
  // tiny structural check: every opened tag closes in order (CDATA and declarations skipped)
  const s = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[^>]*\?>/g, "");
  const stack = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === "/") continue;
    if (!m[1]) stack.push(m[2]); else assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`);
  }
  assert.deepEqual(stack, []);
  assert.doesNotMatch(s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, ""), /&/);
};

test("rss 2.0 feed", () => {
  const xml = rss(en, [{ slug: "a", title: "A & B", summary: "<sum>", published_at: "2026-09-29T10:00:00Z", html: "<p>x ]]> y</p>", tags: ["t"] }]);
  wellFormed(xml);
  assert.match(xml, /<title>A &amp; B<\/title><link>https:\/\/demo\.example\/blog\/a<\/link>/);
  assert.match(xml, /<pubDate>Tue, 29 Sep 2026 10:00:00 GMT<\/pubDate><description>&lt;sum&gt;<\/description>/);
  assert.match(xml, /<atom:link href="https:\/\/demo\.example\/blog\/feed\.xml" rel="self"/);
  assert.match(xml, /<language>en<\/language>/);
});

test("podcast feed: iTunes + Podcasting 2.0, escaped fields, stable guid", async () => {
  const eps = [{ slug: "ep-1", number: 1, title: "نمای <هفته>", summary: "خلاصه & نکته", duration_ms: 125000, audio_bytes: 1000, published_at: "2026-09-26T02:30:00.000Z" }];
  const xml = await podcastRss(en, "weekly", eps);
  wellFormed(xml);
  assert.match(xml, /<itunes:image href="https:\/\/demo\.example\/cover\.png"\/>/);
  assert.match(xml, /<enclosure url="https:\/\/demo\.example\/podcasts\/audio\/ep-1\.mp3" length="1000" type="audio\/mpeg"\/>/);
  assert.match(xml, /<itunes:duration>00:02:05<\/itunes:duration>/);
  assert.match(xml, /<title>نمای &lt;هفته&gt;<\/title>/);
  assert.match(xml, /<itunes:category text="Business"><itunes:category text="Investing"\/><\/itunes:category>/);
  assert.match(xml, /<podcast:guid>[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/podcast:guid>/);
  assert.doesNotMatch(xml, /itunes:owner/);
  assert.match(await podcastRss(en, en.shows.weekly, eps, { ownerEmail: "a@b.c" }), /<itunes:owner><itunes:name>Demo<\/itunes:name><itunes:email>a@b\.c<\/itunes:email><\/itunes:owner>/);
  // Podcasting 2.0 reference value: podcastindex.org/namespace/1.0 example
  assert.equal(await podcastGuid("https://mp3s.nashownotes.com/pc20rss.xml"), "917393e3-1b1e-5cef-ace4-edaa54e1f810");
  assert.equal(itunesDuration(3723000), "01:02:03");
  await assert.rejects(() => podcastRss(en, "nope", []), /unknown show/);
});

test("add-to-calendar links and single-event ICS", () => {
  const l = calendarLinks({ title: "وبینار", start: "2026-10-10T13:30:00.000Z", end: "2026-10-10T15:00:00.000Z", details: "https://demo.example/events/x" });
  const g = new URL(l.google);
  assert.equal(g.searchParams.get("action"), "TEMPLATE");
  assert.equal(g.searchParams.get("dates"), "20261010T133000Z/20261010T150000Z");
  assert.equal(g.searchParams.get("text"), "وبینار");
  assert.equal(g.searchParams.get("ctz"), null);
  const a = calendarLinks({ title: "تعطیل", start: "2027-03-21", allDay: true });
  assert.equal(new URL(a.google).searchParams.get("dates"), "20270321/20270322");
  const o = new URL(a.outlook);
  assert.equal(o.searchParams.get("allday"), "true");
  assert.equal(o.searchParams.get("enddt"), "2027-03-22");
  assert.equal(new URL(calendarLinksFor(fa, { title: "x", start: "2026-10-10T10:00:00Z" }).google).searchParams.get("ctz"), "Asia/Tehran");
  const ics = eventIcs(fa, { slug: "webinar", title: "وبینار; ویژه", start: "2026-10-10T13:30:00.000Z", end: "2026-10-10T15:00:00.000Z", details: "a\nb" }, new Date("2026-09-30T00:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:webinar@demo\.example\r\n/);
  assert.match(ics, /DTSTART:20261010T133000Z\r\nDTEND:20261010T150000Z\r\n/);
  assert.ok(ics.includes("SUMMARY:وبینار\\; ویژه\r\n"));
  assert.match(ics, /URL:https:\/\/demo\.example\/events\/webinar/);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test("i18n: digits, strings with overrides, dates", () => {
  assert.equal(i18n.toFaDigits("T+12"), "T+۱۲");
  assert.equal(i18n.toLatinDigits("۱۴۰۵/۰۷/۰۸"), "1405/07/08");
  assert.equal(digits(fa, 2026), "۲۰۲۶");
  assert.equal(digits(en, "۲۰۲۶"), "2026");
  assert.equal(i18n.dirFor("ar-EG"), "rtl");
  assert.equal(t(fa, "episode", { n: "۳" }), "قسمت ۳");
  assert.equal(t(en, "episode", { n: 3 }), "Episode 3");
  assert.equal(t(defineConfig({ ...enConfig(), strings: { episode: "Ep. {n}" } }), "episode", { n: 3 }), "Ep. 3");
  assert.equal(strings({ site: { locale: "de-DE" } }).home, "Home"); // English fallback
  for (const k of Object.keys(i18n.STRINGS.fa)) assert.ok(k in i18n.STRINGS.en, `en is missing ${k}`);
  assert.equal(zonedToUtc("2026-09-30", "06:00", "Asia/Tehran"), "2026-09-30T02:30:00.000Z");
  assert.equal(zonedToUtc("2026-03-29", "06:00", "Europe/Berlin"), "2026-03-29T04:00:00.000Z"); // CEST starts that night
  assert.equal(dates.dayLabel(fa, dates.toDay("1405/07/08")), "چهارشنبه ۸ مهر ۱۴۰۵");
  assert.equal(dates.monthLabel(en, "2026-11"), "November 2026");
  assert.equal(dates.localDay("Asia/Tehran", new Date("2026-09-29T21:00:00Z")), dates.toDay("2026-09-30"));
});

test("ids", () => {
  assert.equal(slugify("Open Finance: T+1 & APIs!"), "open-finance-t-1-apis");
  assert.equal(slugify("واژه"), "");
  assert.equal(isSlug("a-b-1"), true);
  assert.equal(isSlug("A_b"), false);
});
