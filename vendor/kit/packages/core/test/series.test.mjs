// Series tooling: the episode contract, the review gate (requireReview + autoPublishCited) with official domains from config,
// citations, and the content-pack shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, seriesTools, citations, hasOfficialHost, originalUrl, officiallyCited, checkCitations, endOf, slugFor, KitConfigError } from "../src/index.js";

const SHA = "a".repeat(64);
const article = "Plain words about a regulation, written for product teams and nothing else. ".repeat(12).trim();
const talk = (a = "host", b = "expert") => Array.from({ length: 8 }, (_, i) => [i % 2 ? b : a, "A short and plain spoken line about the regulation, read aloud as it is written here today, in full."]);
const item = (date, o = {}) => ({ date, slug: `reg-${date}`, title: `Rule ${date}`, summary: "What the rule says.", tags: ["rules"], article, talk: talk(), ...o });

const config = defineConfig({
  site: { name: "Demo", url: "https://demo.example", locale: "en-US" },
  hosts: { host: { name: "Ann" }, expert: { name: "Bob" } },
  sources: { official: ["regulator.example", "gazette.example"] },
});
const tools = seriesTools({ config });

test("config: sources.official is validated and kept; absent stays absent", () => {
  assert.deepEqual(config.sources, { official: ["regulator.example", "gazette.example"] });
  assert.equal(defineConfig({ site: { name: "x", url: "https://x.example" } }).sources, undefined);
  assert.throws(() => defineConfig({ site: { name: "x", url: "https://x.example" }, sources: { official: ["not a domain"] } }), KitConfigError);
});

test("official sources come from config: domains, subdomains and archived copies; nothing hardcoded", () => {
  assert.deepEqual(tools.OFFICIAL_DOMAINS, ["regulator.example", "gazette.example"]);
  assert.ok(tools.hasOfficialHost("https://www.regulator.example/rules/1"));
  assert.ok(tools.hasOfficialHost("https://laws.gazette.example/x"));
  assert.ok(tools.hasOfficialHost("https://web.archive.org/web/20260531id_/https://regulator.example/p"));
  assert.equal(originalUrl("https://web.archive.org/web/2026/regulator.example/p"), "https://regulator.example/p");
  assert.ok(!tools.hasOfficialHost("https://regulator.example.evil.example/") && !tools.hasOfficialHost("https://news.example/") && !tools.hasOfficialHost("nope"));
  assert.ok(!hasOfficialHost("https://regulator.example/"), "no domains, nothing is official");
  assert.ok(citations({ officialDomains: ["a.example"] }).hasOfficialHost("https://a.example/"));
});

test("the review gate: reviewed items publish; with autoPublishCited, officially cited items publish without review", () => {
  const src = [{ title: "Rule text", url: "https://regulator.example/rule" }, { title: "Gazette", url: "https://web.archive.org/web/2026/https://gazette.example/g" }];
  const cit = (i) => ({ source: i, quote: "an exact passage of the official text", page: 2, verified: { sha256: SHA, at: "2026-09-30" } });
  const s = { id: "reg", weekday: "wed", start: "2026-10-07", requireReview: true, autoPublishCited: true, items: [
    item("2026-10-07", { sources: src, citations: [cit(0), cit(1)] }),                       // auto: official + cited
    item("2026-10-14", { review: { status: "reviewed", by: "editor" } }),                    // reviewed by a person
    item("2026-10-21", { sources: src, citations: [cit(0)] }),                               // one source uncited: draft
    item("2026-10-28", { sources: [{ title: "News", url: "https://news.example/x" }], citations: [cit(0)] }), // not official: draft
  ] };
  assert.deepEqual(tools.publishable(s).map((x) => x.date), ["2026-10-07", "2026-10-14"]);
  assert.deepEqual(tools.draftDates(s), ["2026-10-21", "2026-10-28"]);
  assert.deepEqual(tools.publishable({ ...s, autoPublishCited: false }).map((x) => x.date), ["2026-10-14"]);
  assert.equal(tools.publishable({ ...s, requireReview: false }).length, 4);
  assert.ok(officiallyCited(s.items[0], ["regulator.example", "gazette.example"]));
  assert.ok(!officiallyCited(s.items[0], ["regulator.example"]), "the domain list decides");
  assert.ok(checkCitations({ date: "d", sources: [], citations: [{ source: 3, quote: "short", page: 0, verified: {} }] }).length >= 4);
  assert.deepEqual(tools.checkAll([s]), []);
  assert.equal(endOf(s), "2026-10-28");
  assert.equal(endOf({ items: [], start: "2026-10-07" }), "2026-10-06");
  assert.equal(slugFor(s)({ date: "2026-10-14" }), "reg-2026-10-14");
  assert.equal(slugFor(s)({ date: "2026-11-04" }), "reg-2026-11-04");
  const pack = seriesTools({ config, speakers: { n: "ann", k: "bob" } }).contentItems({ ...s, items: [item("2026-10-07", { talk: talk("n", "k"), review: { status: "reviewed" } })] });
  assert.deepEqual(Object.keys(pack[0]), ["date", "slug", "title", "summary", "tags", "sources", "article", "talk"]);
  assert.deepEqual(pack[0].talk[0][0], "ann");
});

test("the episode contract: weekday, slug, limits, alternation and speakability in the series' language", () => {
  assert.deepEqual(tools.checkItem(item("2026-10-07"), "wed"), []);
  const p = tools.checkItem(item("2026-10-08", { slug: "Bad", tags: [], talk: [...talk()].reverse(), sources: [{ title: "", url: "http://x" }], review: { status: "maybe" } }), "wed");
  assert.deepEqual(p.map((x) => x.replace(/^[^:]+: /, "")), [
    "date must be a wed (YYYY-MM-DD)", "slug must be latin kebab-case", "missing tags",
    ...Array(8).fill('talk must alternate "host"/"expert", starting with "host"'),
    "every source needs a title and an https url", "review.status must be draft or reviewed"]);
  const ar = seriesTools({ speech: { locale: "ar" }, speakers: { h: "host", e: "expert" }, limits: { articleMin: 10, talkMin: 10 } });
  const arItem = { date: "2026-10-07", slug: "x", title: "عنوان ·٣", summary: "ملخص", tags: ["و"], article: "نص المقال هنا.", talk: [["h", "نما السوق 12% في 2025 عبر API."], ["e", "نعم."], ["h", "حسنًا."], ["e", "تمامًا."], ["h", "إلى اللقاء."], ["e", "مع السلامة."]] };
  assert.deepEqual(ar.checkItem(arItem, "wed"), ["x: no «·» next to Arabic-Indic digits"]);
  const seasons = tools.checkSeries([item("2026-10-07"), item("2026-10-21"), item("2026-10-28", { slug: "reg-2026-10-21" })], "wed");
  assert.deepEqual(seasons, ["reg-2026-10-21: dates must be consecutive weeks", "reg-2026-10-21: duplicate slug"]);
});
