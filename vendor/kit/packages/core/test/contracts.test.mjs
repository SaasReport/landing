import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, checkTopic, checkReport, checkTerm, checkContent } from "../src/index.js";
import { faConfig, enConfig, topicFa, topicEn, termFa, termEn, talkFa } from "./helpers.mjs";

const fa = defineConfig(faConfig());
const ctx = (id, c = fa) => ({ config: c, series: c.series.find((s) => s.id === id) });

test("topic contract: slot date, lengths, talk alternation and speakability", () => {
  assert.deepEqual(checkTopic(topicFa("2026-10-03"), ctx("weekly")), []);
  const p = checkTopic(topicFa("2026-10-04", { title: "x".repeat(91), article: "کوتاه https://x.y", tags: [],
    talk: [["expert", "سلام API"], ["host", "عدد 12 و abc"], ["guest", ""]] }), ctx("weekly"));
  for (const re of [/not a publishing slot/, /title longer than 90/, /article is \d+ chars/, /raw URLs/, /at least 1 tag/, /talk needs an even number of 6-10 lines/,
    /must alternate "host", "expert"/, /speaker "guest" is not one of/, /line 3 empty/, /talk is \d+ chars/])
    assert.ok(p.some((x) => re.test(x)), `${re}\n${p.join("\n")}`);
  // "abc" is spelled letter by letter, digits become words: both lines are speakable
  assert.equal(p.some((x) => /not speakable/.test(x)), false);
  assert.ok(checkTopic(topicFa("2026-10-03", { talk: talkFa(8, 110).map(([s, t], i) => [s, i ? t : t + " Kubernetes12"]) }), ctx("weekly")).length === 0);
});

test("contract limits are configurable per series (and can be switched off)", () => {
  const c = defineConfig(faConfig([{ id: "weekly", kind: "topic", on: "sat", contract: { articleMin: 10, titleMax: 5 } }, { id: "free", kind: "topic", every: "day", contract: false }]));
  const t = topicFa("2026-10-03", { article: "کوتاه اما کافی" });
  assert.deepEqual(checkTopic(t, ctx("weekly", c)), ["weekly 2026-10-03: title longer than 5"]);
  assert.deepEqual(checkTopic({ date: "2026-10-04", title: "t", summary: "s", article: "a" }, ctx("free", c)), []);
});

test("report contract", () => {
  assert.deepEqual(checkReport({ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }, ctx("monthly")), []);
  const p = checkReport({ month: "1405-13", title: "", intro: "کوتاه" }, ctx("monthly"));
  assert.ok(p.some((x) => /month must be "YYYY-MM"/.test(x)) && p.some((x) => /missing title/.test(x)) && p.some((x) => /intro is 5 chars/.test(x)));
});

test("term contract: no figures except allowed notation, related, category", () => {
  const cats = [{ key: "a", name: "A" }];
  const c = { ...ctx("daily"), categories: cats };
  assert.deepEqual(checkTerm(termFa("t-one", "a"), c), []);
  const p = checkTerm(termFa("Bad Slug", "zz", { definition: "نرخ ۲۳٪ است. ".repeat(30), related: "x" }), c);
  for (const re of [/slug must be lowercase/, /category "zz" is not defined/, /contains a figure/, /related must be an array/]) assert.ok(p.some((x) => re.test(x)), `${re}\n${p.join("\n")}`);
  assert.deepEqual(checkTerm(termFa("t-two", "a", { definition: "تسویه T+1 طبق ISO 20022 ".repeat(15) }), c), []);
});

test("checkContent: every series, duplicates and related terms", () => {
  const content = {
    weekly: [topicFa("2026-10-03"), topicFa("2026-10-03")],
    monthly: [{ month: "1405-08", title: "آ", intro: "مقدمه ".repeat(40) }],
    daily: { categories: [{ key: "a", name: "A" }], terms: [termFa("x", "a", { related: ["y", "nope"] }), termFa("y", "a"), termFa("y", "a")] },
  };
  const p = checkContent(fa, content);
  assert.ok(p.some((x) => /two topics for the same date/.test(x)));
  assert.ok(p.some((x) => /y: duplicate slug/.test(x)));
  assert.ok(p.some((x) => /related «nope» is not in the glossary/.test(x)));
  assert.ok(checkContent(fa, {}).some((x) => /weekly: no content/.test(x)));
});

test("English content is checked with the English speech pack", () => {
  const en = defineConfig(enConfig());
  const c = { config: en, series: en.series[0] };
  assert.deepEqual(checkTopic(topicEn("2026-10-05"), c), []);
  assert.deepEqual(checkTerm(termEn("t", "a"), { config: en, series: en.series[2] }), []);
});

test("topic sources: https links with titles, at most 8, kept out of the article", () => {
  const src = [{ title: "Open Source Initiative", url: "https://opensource.org/licenses/MIT" }];
  assert.deepEqual(checkTopic(topicFa("2026-10-03", { sources: src }), ctx("weekly")), []);
  const bad = [{ title: "", url: "https://a.b" }, { title: "x", url: "http://a.b" }, { title: "[x]", url: "https://a.b/(y)" }];
  const p = checkTopic(topicFa("2026-10-03", { sources: bad }), ctx("weekly"));
  for (const re of [/source 1 needs a title/, /source 2 url must be an https URL/, /source 3 needs a title/, /source 3 url must be/]) assert.ok(p.some((x) => re.test(x)), `${re}\n${p.join("\n")}`);
  assert.ok(checkTopic(topicFa("2026-10-03", { sources: "x" }), ctx("weekly")).some((x) => /sources must be an array/.test(x)));
  assert.ok(checkTopic(topicFa("2026-10-03", { sources: Array(9).fill(src[0]) }), ctx("weekly")).some((x) => /at most 8 sources/.test(x)));
});
