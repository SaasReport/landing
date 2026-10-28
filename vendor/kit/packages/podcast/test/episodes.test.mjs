import test from "node:test";
import assert from "node:assert/strict";
import { episodeFromItem, podcastStrings } from "../src/index.js";
import { faConfig, enConfig, topicItem, termItem, categories } from "./fixtures.mjs";

const calendarBit = ({ config, series, item }) => ({
  lines: [["host", `calendar for ${item.date}?`], ["expert", "five business days."]],
  summary: "Plus the week's calendar.",
});

test("topic episode (fa): intro/outro from strings with show, site and host names; calendar bit appended", () => {
  const ep = episodeFromItem(faConfig, faConfig.series[0], topicItem, { calendarBit });
  assert.equal(ep.slug, "week-2026-10-03");
  assert.equal(ep.kind, "topic");
  assert.equal(ep.series, "weekly");
  assert.equal(ep.show, "weekly");
  assert.equal(ep.title, "Open APIs");
  assert.equal(ep.summary, "Why open APIs matter. Plus the week's calendar.");
  assert.equal(ep.maxSeconds, 150);
  assert.equal(ep.source_ref, "2026-10-03");
  assert.equal(ep.lines[0].speaker, "host");
  assert.equal(ep.lines[0].text, "سلام! اینجا دو دقیقه نمونهه، از نمونه مالی. من مریمم، با بهرام.");
  // intro "سلام به همه!" (expert) and the first talk line (host) do not merge; talk "expert" + calendar "host" alternate
  const texts = ep.lines.map((l) => l.text).join(" | ");
  assert.match(texts, /calendar for 2026-10-03\?/);
  assert.match(ep.lines.at(-1).text, /تا هفته بعد، خداحافظ!$/);
  assert.match(ep.lines.at(-2).text, /تو بلاگ نمونه مالیه\.$/);
  for (let i = 1; i < ep.lines.length; i++) assert.notEqual(ep.lines[i].speaker, ep.lines[i - 1].speaker, "turns are merged");
  assert.ok(ep.estimatedMs > 0);
});

test("topic episode without the calendar function or for non-weekly series", () => {
  const ep = episodeFromItem(faConfig, "weekly", topicItem);
  assert.equal(ep.summary, "Why open APIs matter.");
  assert.ok(!ep.lines.some((l) => /calendar/.test(l.text)));
  const monthlyTopic = { id: "m", kind: "topic", every: "month", podcast: { show: "weekly" } };
  assert.ok(!episodeFromItem(faConfig, monthlyTopic, topicItem, { calendarBit }).lines.some((l) => /calendar/.test(l.text)));
});

test("term episode (fa): number in Persian digits, category name, show title", () => {
  const ep = episodeFromItem(faConfig, "daily", termItem, { number: 12, categories });
  assert.equal(ep.slug, "term-iban");
  assert.equal(ep.kind, "term");
  assert.equal(ep.number, 12);
  assert.equal(ep.title, "یک دقیقه با نمونه، قسمت ۱۲: IBAN");
  assert.equal(ep.summary, "International bank account number. (Payments)");
  assert.equal(ep.lines[0].text, "سلام! یک دقیقه با نمونه، قسمت ۱۲. واژه امروز: IBAN. What's an IBAN?");
  assert.equal(ep.lines[0].speaker, "host");
  assert.match(ep.lines.at(-1).text, /واژه‌نامه سایت نمونه مالیه/);
  assert.equal(ep.maxSeconds, 80);
});

test("episodes (en): talk keys host/expert map to custom config.hosts keys", () => {
  const t = episodeFromItem(enConfig, "weekly", topicItem, { calendarBit });
  assert.equal(t.slug, "weekly-2026-10-03", "default slug template {series}-{ref}");
  assert.equal(t.lines[0].text, "Hi! This is Two Minutes, from Example Finance. I'm Ada, here with Bob.");
  assert.deepEqual([...new Set(t.lines.map((l) => l.speaker))].sort(), ["ada", "bob"]);
  assert.match(t.lines.at(-1).text, /See you next week, bye!$/);

  const d = episodeFromItem(enConfig, "daily", termItem, 3);
  assert.equal(d.title, "One Minute Glossary, episode 3: IBAN");
  assert.equal(d.summary, "International bank account number.", "no category name → summary without it");
  assert.match(d.lines[0].text, /^Hi! One Minute Glossary, episode 3\. Today's term: IBAN\. What's an IBAN\?$/);
  assert.equal(d.lines[0].speaker, "ada");
});

test("strings are overridable from config.strings.podcast", () => {
  const cfg = { ...enConfig, strings: { podcast: { term: { title: "#{number} {term}" } } } };
  assert.equal(episodeFromItem(cfg, "daily", termItem, 4).title, "#4 IBAN");
  assert.ok(podcastStrings(cfg).term.intro.length, "other keys keep their defaults");
});

test("unknown speakers and non-podcast kinds are rejected", () => {
  assert.throws(() => episodeFromItem(faConfig, "weekly", { ...topicItem, talk: [["narrator", "x"]] }), /unknown speaker/);
  assert.throws(() => episodeFromItem(faConfig, "monthly", { month: "1405-01" }), /no podcast episodes/);
});

test("British English projects: the generated script is rewritten (voice and transcript agree); other projects are untouched", async () => {
  const { episodeFromItem } = await import("../src/index.js");
  const { enConfig, termItem, categories } = await import("./fixtures.mjs");
  const item = { ...termItem, talk: [["host", "What does organize mean for the center?"], ["expert", "It means a license to analyze Rich Authorization Requests."]] };
  const gb = { ...enConfig, tts: { ...enConfig.tts, spelling: { variant: "en-GB", exceptions: [{ phrase: "Rich Authorization Requests", reason: "RFC 9396" }] } } };
  const text = (c) => episodeFromItem(c, "daily", item, { number: 1, categories }).lines.map((l) => l.text).join("\n");
  assert.match(text(gb), /What does organise mean for the centre\?/);
  assert.match(text(gb), /a licence to analyse Rich Authorization Requests\./);
  assert.match(text(enConfig), /What does organize mean for the center\?/);
});

test("an exception scoped to files (an HTTP reason phrase in one script) never exempts the same words in an episode", async () => {
  const { episodeFromItem } = await import("../src/index.js");
  const { enConfig, termItem, categories } = await import("./fixtures.mjs");
  const item = { ...termItem, talk: [["host", "The order was canceled, and an unauthorized payment followed."]] };
  const exceptions = [
    { phrase: "Unauthorized", kind: "protocol", reason: "the HTTP 401 reason phrase in the fixture's console", until: "2099-12-31", files: ["fixtures/console.js"] },
    { phrase: "canceled", kind: "protocol", reason: "a protocol state, everywhere", until: "2099-12-31" },
  ];
  const gb = { ...enConfig, tts: { ...enConfig.tts, spelling: { variant: "en-GB", exceptions } } };
  const text = episodeFromItem(gb, "daily", item, { number: 1, categories }).lines.map((l) => l.text).join("\n");
  assert.match(text, /an unauthorised payment/, "the file-scoped entry does not reach the spoken line");
  assert.match(text, /was canceled,/, "an unscoped entry still holds");
});

test("a series' podcast.strings override the intro, outro and title for that series only; podcast.cps sets its estimate", () => {
  const own = { id: "concepts", kind: "topic", every: "day", podcast: { show: "weekly", maxSeconds: 80, cps: 20, slug: "{series}-{ref}",
    strings: { topic: { intro: [["host", "Concept {number}: {title}."]], outro: [["host", "See you tomorrow."]], title: "{show}, no. {number}: {title}" } } } };
  const cfg = { ...faConfig, series: [...faConfig.series, own] };
  const item = { ...topicItem, number: 12 };
  const ep = episodeFromItem(cfg, own, item);
  assert.equal(ep.lines[0].text.startsWith("Concept ۱۲: Open APIs."), true);
  assert.equal(ep.lines.at(-1).text, "See you tomorrow.");
  assert.equal(ep.title, "دو دقیقه نمونه, no. ۱۲: Open APIs");
  assert.equal(ep.number, 12);
  const weekly = episodeFromItem(cfg, "weekly", topicItem);
  assert.match(weekly.lines[0].text, /^سلام! اینجا دو دقیقه نمونهه/, "other series keep the defaults");
  const chars = ep.lines.reduce((n, l) => n + l.text.length, 0);
  assert.equal(ep.estimatedMs, Math.round(chars / 20 * 1000));
  assert.deepEqual(podcastStrings(cfg).topic.title, "{title}");
  assert.equal(podcastStrings(cfg, own).topic.title, "{show}, no. {number}: {title}");
});
