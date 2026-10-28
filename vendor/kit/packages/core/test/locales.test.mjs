// Multi-locale sites (site.locales): config per locale, both content forms, contracts per locale, planner, posts, SEO, feeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defineConfig, KitConfigError, configFor, contentFor, localesOf, isMultiLocale, isLocalized, localize, localePath, eachLocale,
  checkContent, planner, buildPost, agenda, sitemap, hreflangs, llmsTxtLocales, podcastRss, website, org, loadContent,
} from "../src/index.js";
import { bilingualConfig, bilingualContent, bilingualContentFields } from "./fixtures/bilingual.mjs";
import { faConfig } from "./helpers.mjs";

const root = defineConfig(bilingualConfig());
const ar = configFor(root, "ar");

test("defineConfig: the default locale's config, every locale behind configFor, localized values resolved", () => {
  assert.ok(isMultiLocale(root));
  assert.deepEqual(localesOf(root), ["en", "ar"]);
  assert.equal(root.site.locale, "en");
  assert.equal(root.site.dir, "ltr");
  assert.equal(root.site.url, "https://finance.example");
  assert.equal(root.site.name, "Sample Finance");
  assert.equal(configFor(root, "en").site.name, root.site.name);
  assert.equal(configFor(configFor(root, "ar"), "ar"), configFor(root, "ar"), "a locale's config is its own");
  assert.deepEqual([ar.site.locale, ar.site.dir, ar.site.url, ar.site.root, ar.site.base, ar.site.name, ar.site.org.url],
    ["ar", "rtl", "https://finance.example/ar", "https://finance.example", "/ar", "التمويل النموذجي", "https://finance.example"]);
  assert.equal(ar.hosts.host.name, "لينا");
  assert.deepEqual(ar.tts.voices, { host: "Despina", expert: "Algenib" });
  assert.equal(ar.shows.weekly.title, "الأسبوعية");
  assert.equal(ar.shows.weekly.language, "ar");
  assert.equal(ar.speech.locale, "ar");
  assert.deepEqual(ar.series.map((s) => s.id), ["weekly", "daily"], "series.locales: [\"en\"] keeps notes out of ar");
  assert.deepEqual(root.series.map((s) => s.id), ["weekly", "daily", "notes"]);
  assert.equal(localePath(root, "ar", "/blog/"), "/ar/blog/");
  assert.equal(localePath(root, "en", "/blog/"), "/blog/");
  assert.throws(() => configFor(root, "fr"), /unknown locale "fr"/);
});

test("defineConfig: problems name their locale; bad locale lists are rejected", () => {
  const bad = bilingualConfig();
  bad.site.timezone = { en: "Asia/Riyadh", ar: "Mars/Olympus" };
  assert.throws(() => defineConfig(bad), (e) => e instanceof KitConfigError && e.problems.some((p) => p.startsWith("[ar] site.timezone")));
  assert.throws(() => defineConfig({ ...bilingualConfig(), site: { ...bilingualConfig().site, locales: ["en", "en"] } }), /twice/);
  assert.throws(() => defineConfig({ ...bilingualConfig(), site: { ...bilingualConfig().site, locales: "en,ar" } }), /site.locales must be an array/);
});

test("single-locale configs are untouched (no locale fields; one locale in site.locales is the same site)", () => {
  const fa = defineConfig(faConfig());
  assert.ok(!isMultiLocale(fa));
  for (const k of ["locales", "defaultLocale", "root", "base", "localeKey"]) assert.equal(fa.site[k], undefined, k);
  const one = { ...faConfig(), site: { ...faConfig().site, locales: ["fa"] } };
  assert.deepEqual(JSON.parse(JSON.stringify(defineConfig(one))), JSON.parse(JSON.stringify(fa)));
  assert.deepEqual(eachLocale(fa, { a: 1 }), [{ locale: "fa-IR", config: fa, content: { a: 1 }, base: "" }]);
});

test("content: keyed per locale and localized fields resolve to the same packs", () => {
  const keyed = bilingualContent(), fields = bilingualContentFields();
  for (const l of ["en", "ar"]) {
    const c = configFor(root, l);
    for (const s of c.series) assert.deepEqual(contentFor(root, fields, l)[s.id], contentFor(root, keyed, l)[s.id], `${l} ${s.id}`);
  }
  assert.equal(contentFor(root, keyed, "ar").weekly[0].title, "ما هي الصكوك");
  assert.equal(contentFor(root, fields, "ar").daily.categories[0].name, "الأساسيات");
  assert.ok(isLocalized({ en: 1, ar: 2 }, ["en", "ar"]) && !isLocalized({ en: 1, slug: "x" }, ["en", "ar"]));
  assert.deepEqual(localize({ a: { en: "x" }, f: Math.max }, "ar", ["en", "ar"]), { a: "x", f: Math.max }, "a missing locale falls back to the default");
});

test("checkContent checks every locale with its own speech and limits; problems carry the locale", () => {
  for (const content of [bilingualContent(), bilingualContentFields()]) assert.deepEqual(checkContent(root, content), []);
  const broken = bilingualContent();
  broken.ar.weekly[0].talk[1][1] = "جملة طويلة جدًا ".repeat(14);
  broken.en.daily.terms[0].definition = "Sukuk are certificates with 2 figures in this definition, which is not allowed.";
  const p = checkContent(root, broken);
  assert.ok(p.some((x) => x.startsWith("[ar] weekly 2026-10-04: talk line 2 empty or longer than 190")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("[en] daily sukuk: definition contains a figure")), p.join("\n"));
  // The same Latin word is fine in English, and digits/percent/API are fine in Arabic once spelled out.
  assert.ok(!p.some((x) => x.startsWith("[en] weekly")));
});

test("loadContent resolves sources per locale into a pack keyed per locale", async () => {
  const cfg = bilingualConfig();
  cfg.series[0].source = { en: () => ({ default: bilingualContent().en.weekly }), ar: async () => ({ default: bilingualContent().ar.weekly }) };
  const r = defineConfig(cfg);
  const loaded = await loadContent(r, { daily: bilingualContentFields().daily, notes: bilingualContent().en.notes });
  assert.deepEqual(Object.keys(loaded), ["en", "ar"]);
  assert.equal(loaded.ar.weekly[1].title, "التكافل باختصار");
  assert.equal(loaded.ar.daily.terms[0].term, "الصكوك");
  assert.deepEqual(checkContent(r, loaded), []);
});

test("planner and posts per locale: same slugs, Arabic text, links under /ar/", () => {
  const content = bilingualContent();
  const pe = planner(root, content), pa = planner(ar, contentFor(root, content, "ar"));
  const e = pe.due("2026-10-04"), a = pa.due("2026-10-04");
  assert.deepEqual(e.map((x) => x.slug), ["week-2026-10-04", "term-sukuk"]);
  assert.deepEqual(a.map((x) => x.slug), ["week-2026-10-04", "term-sukuk"]);
  assert.deepEqual(pe.due("2026-10-07").map((x) => x.slug), ["note-2026-10-07"]);
  assert.deepEqual(pa.due("2026-10-07").map((x) => x.slug), []);
  const post = buildPost(pa, a[0]);
  assert.equal(post.title, "ما هي الصكوك");
  assert.match(post.body_md, /\[حلقة هذا الأسبوع\]\(\/ar\/podcasts\/week-2026-10-04\)/);
  assert.match(post.body_md, /## تقويم العمل لهذا الأسبوع/);
  assert.match(buildPost(pe, e[0]).body_md, /\(\/podcasts\/week-2026-10-04\)/);
});

test("agenda plans every locale, each in its own language", () => {
  const r = agenda(root, bilingualContent(), { from: "2026-10-04", days: 8 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(Object.keys(r.locales), ["en", "ar"]);
  assert.match(r.markdown, /^# Sample Finance publishing agenda/);
  assert.match(r.markdown, /# جدول نشر التمويل النموذجي/);
  assert.equal(r.items.filter((x) => x.locale === "ar").length, 4);
});

test("SEO: one organization, sitemap hreflang alternates, hreflangs, one llms.txt for both locales", () => {
  assert.equal(org(ar)["@id"], "https://finance.example/#org");
  assert.deepEqual(website(ar).publisher, { "@id": "https://finance.example/#org" });
  assert.equal(website(ar).inLanguage, "ar");
  assert.deepEqual(hreflangs(ar, "/blog/"), [
    { hreflang: "en", href: "https://finance.example/blog/" }, { hreflang: "ar", href: "https://finance.example/ar/blog/" },
    { hreflang: "x-default", href: "https://finance.example/blog/" }]);
  assert.deepEqual(hreflangs(defineConfig(faConfig()), "/blog/"), []);
  const xml = sitemap([{ loc: "/blog/", alternates: hreflangs(root, "/blog/") }, "/only/"], { base: "https://finance.example" });
  assert.match(xml, /xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.match(xml, /<url><loc>https:\/\/finance.example\/blog\/<\/loc><xhtml:link rel="alternate" hreflang="en" href="https:\/\/finance.example\/blog\/"\/><xhtml:link rel="alternate" hreflang="ar" href="https:\/\/finance.example\/ar\/blog\/"\/>/);
  assert.doesNotMatch(sitemap(["/a/"], { base: "https://x.example" }), /xhtml/, "no alternates, no namespace: single-locale sitemaps are unchanged");
  const llms = llmsTxtLocales(root, [{ config: root, sections: [{ title: "Pages", links: [{ title: "Blog", url: "/blog/" }] }] },
    { config: ar, sections: [{ title: "صفحات", links: [{ title: "المدونة", url: "/blog/" }] }] }]);
  assert.match(llms, /^# Sample Finance\n\n> A bilingual sample site\.\n\nLanguages: en \(ltr\) https:\/\/finance.example\/, ar \(rtl\) https:\/\/finance.example\/ar\//);
  assert.match(llms, /## التمويل النموذجي \(ar\)\nموقع نموذجي بلغتين\.\nLanguage: ar \(rtl\)/);
  assert.match(llms, /## صفحات \(ar\)\n- \[المدونة\]\(https:\/\/finance.example\/ar\/blog\/\)/);
});

test("podcast feeds: one show per locale, with language and itunes:language", async () => {
  const xml = await podcastRss(ar, "weekly", [{ slug: "week-2026-10-04", title: "ما هي الصكوك", summary: "s", published_at: "2026-10-04T03:00:00Z" }]);
  assert.match(xml, /<language>ar<\/language><itunes:language>ar<\/itunes:language>/);
  assert.match(xml, /<atom:link href="https:\/\/finance.example\/ar\/podcasts\/weekly\/feed.xml"/);
  assert.match(xml, /<enclosure url="https:\/\/finance.example\/ar\/podcasts\/audio\/week-2026-10-04.mp3"/);
  const en = await podcastRss(root, "weekly", []);
  assert.match(en, /<language>en<\/language><itunes:language>en<\/itunes:language>/);
  assert.notEqual((xml.match(/<podcast:guid>(.*?)<\/podcast:guid>/) || [])[1], (en.match(/<podcast:guid>(.*?)<\/podcast:guid>/) || [])[1], "each locale's show has its own guid");
  const fa = defineConfig(faConfig());
  assert.doesNotMatch(await podcastRss(fa, "weekly", []), /itunes:language/, "single-locale feeds are unchanged");
});
