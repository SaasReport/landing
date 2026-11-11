// Podcasts on a multi-locale site: per-locale voices, Arabic episode strings and speech, one workflow class for every locale.
import test from "node:test";
import assert from "node:assert/strict";
import { defineConfig, configFor, contentFor, checkTalk } from "@saasreport/core";
import { episodeFromItem, voiceFor, geminiRequest, podcastWorkflowClass, podcastStrings } from "../src/index.js";
import { bilingualConfig, bilingualContent } from "../../core/test/fixtures/bilingual.mjs";

const root = defineConfig(bilingualConfig());
const en = configFor(root, "en"), ar = configFor(root, "ar");
const content = bilingualContent();

test("voices per locale: tts.voices keyed by locale (resolved per locale, or read directly)", () => {
  assert.deepEqual([voiceFor(en, "host"), voiceFor(en, "expert")], ["Kore", "Charon"]);
  assert.deepEqual([voiceFor(ar, "host"), voiceFor(ar, "expert")], ["Despina", "Algenib"]);
  // A config passed without resolving: the table of the config's language.
  const raw = { site: { locale: "ar-SA" }, tts: { voices: { en: { host: "Kore" }, ar: { host: "Despina" } } }, hosts: { host: { voice: { en: "a", ar: "b" } }, expert: { voice: { en: "c", ar: "d" } } } };
  assert.equal(voiceFor(raw, "host"), "Despina");
  assert.equal(voiceFor(raw, "expert"), "d");
  assert.equal(voiceFor({ site: { locale: "fa-IR" }, tts: { voices: { niloofar: "Sulafat" } } }, "niloofar"), "Sulafat", "single-locale configs as before");
});

test("Arabic episodes: Arabic intro/outro strings and host names; the Gemini request is read in Arabic", () => {
  const ep = episodeFromItem(ar, "weekly", contentFor(root, content, "ar").weekly[0], { number: 1 });
  assert.equal(ep.slug, "week-2026-10-04");
  assert.deepEqual(ep.lines.slice(0, 3).map((l) => l.text), ["مرحبًا! معكم الأسبوعية من التمويل النموذجي. أنا لينا، ومعي عمر.", "أهلًا بالجميع!", "موضوعنا اليوم الصكوك وكيف تعمل."]);
  assert.match(ep.lines.at(-1).text, /نلقاكم الأسبوع المقبل/);
  const term = episodeFromItem(ar, "daily", contentFor(root, content, "ar").daily.terms[0], { number: 2, categories: [{ key: "basics", name: "الأساسيات" }] });
  assert.match(term.title, /^مصطلح كل يوم، الحلقة [2٢]: الصكوك$/); // digits as Intl formats "ar"
  assert.equal(term.summary, "شهادات ملكية في أصل. (الأساسيات)");
  const body = geminiRequest(ar, ep.lines);
  // The transport can contain numeric model versions and audio sample rates.
  // Check only the transcript for numerical pronunciation, never schema metadata.
  const transcript = (body.input?.[0]?.content || body.contents?.[0]?.parts || []).map((p) => p.text).join("\n");
  assert.match(transcript, /اثنا عشر بالمئة في ألفين وخمسة وعشرين|اثنا عشر بالمئة في ألفان وخمسة وعشرون/);
  assert.match(transcript, /إيه بي آي/);
  assert.doesNotMatch(transcript, /\\d/, "spoken digits must be verbalised");
  assert.match(JSON.stringify(body), /Despina/);
  assert.equal(podcastStrings(en).term.title, "{show}, episode {number}: {term}");
});

test("checkTalk uses the item's locale: Arabic digits, percent and acronyms are speakable in ar", () => {
  const L = { ...ar.series[0].contract };
  const talk = contentFor(root, content, "ar").weekly[0].talk;
  assert.deepEqual(checkTalk(talk, "ar weekly", L, { config: ar }), []);
  assert.deepEqual(checkTalk(content.en.weekly[0].talk, "en weekly", { ...en.series[0].contract }, { config: en }), []);
});

test("one workflow class for every locale: the payload's locale picks the config and content", async () => {
  const seen = [];
  class Base { constructor(env) { this.env = env; } }
  const fake = (name) => ({ config: name === "ar" ? ar : en, content: async () => { seen.push(name); return null; } });
  const W = podcastWorkflowClass(Base, { ...fake("en"), locales: { en: fake("en"), ar: fake("ar") } });
  const step = { do: async (name, o, fn) => (typeof o === "function" ? o() : fn()) };
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ slug: "ar/week-2026-10-04", source_type: "topic", series: "weekly" }), run: async () => ({}) }) }) }, PODCASTS: {} };
  for (const payload of [{ slug: "ar/week-2026-10-04", locale: "ar" }, { slug: "week-2026-10-04", locale: "en" }, { slug: "week-2026-10-04" }]) {
    await new W(env).run({ payload }, step).catch(() => {});   // the fake bindings end the run early; the test asserts the locale each run chose
  }
  assert.deepEqual(seen, ["ar", "en", "en"]);
});
