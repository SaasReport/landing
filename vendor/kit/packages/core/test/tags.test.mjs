// kit.content-tags.v1: the vocabulary schema, the compiled vocabulary, inheritance and the search fold (docs/TAGS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkVocabulary, compileVocabulary, effectiveTags, checkAssignment, foldQuery, matchesQuery, TAG_COLOURS } from "../src/tags.js";
import { defineConfig } from "../src/config.js";
import { checkTopic } from "../src/contracts.js";
import { CATEGORY_ROLES } from "../src/colour.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../schemas/content-tags.schema.json", import.meta.url), "utf8"));
const vocab = () => ({
  schema: "kit.content-tags.v1", locales: ["fa", "en"],
  groups: [{ id: "legal", label: { fa: "حقوقی", en: "Legal" } }, { id: "tech", label: { fa: "فنی", en: "Technical" } }],
  tags: [
    { id: "licensing", label: { fa: "مجوز نرم‌افزار", en: "Software licences" }, group: "legal", colour: "chart1", description: { fa: "مجوزها", en: "Licences" } },
    { id: "api", label: { fa: "رابط برنامه‌نویسی", en: "APIs" }, group: "tech", colour: "chart2", description: { fa: "رابط‌ها", en: "Interfaces" } },
  ],
});

test("the colour roles of the schema are the tone roles of the colour canon (a copy tested against its source)", () => {
  assert.deepEqual([...SCHEMA.$defs.tag.properties.colour.enum].sort(), [...CATEGORY_ROLES].sort());
  assert.deepEqual([...TAG_COLOURS].sort(), [...CATEGORY_ROLES].sort());
});

test("a valid vocabulary has no problems", () => assert.deepEqual(checkVocabulary(vocab()), []));

test("must fail: a literal colour, a missing colour role, an unknown role", () => {
  for (const colour of ["#ff5a00", "rgb(1,2,3)", "orange", "onChart1", undefined]) {
    const v = vocab();
    if (colour === undefined) delete v.tags[0].colour; else v.tags[0].colour = colour;
    assert.ok(checkVocabulary(v).some((p) => /colour/.test(p)), `colour ${colour} is refused`);
  }
});

test("must fail: duplicate id, unknown group, label missing a locale, bad id, extra key", () => {
  let v = vocab(); v.tags.push({ ...v.tags[0] });
  assert.ok(checkVocabulary(v).some((p) => /twice/.test(p)));
  v = vocab(); v.tags[0].group = "nope";
  assert.ok(checkVocabulary(v).some((p) => /group "nope"/.test(p)));
  v = vocab(); delete v.tags[0].label.en;
  assert.ok(checkVocabulary(v).some((p) => /label.*"en"/.test(p)));
  v = vocab(); v.tags[0].id = "Not An Id";
  assert.ok(checkVocabulary(v).length);
  v = vocab(); v.tags[0].extra = 1;
  assert.ok(checkVocabulary(v).length);
});

test("compileVocabulary: labels in the locale, fallback to the first locale, lookup, resolve", () => {
  const fa = compileVocabulary(vocab(), { locale: "fa-IR" });
  assert.equal(fa.get("api").label, "رابط برنامه‌نویسی");
  assert.equal(fa.get("api").groupLabel, "فنی");
  assert.equal(fa.get("api").colour, "chart2");
  const en = compileVocabulary(vocab(), { locale: "en-US" });
  assert.equal(en.get("licensing").label, "Software licences");
  const de = compileVocabulary(vocab(), { locale: "de" });
  assert.equal(de.get("licensing").label, "مجوز نرم‌افزار", "falls back to the first locale of the vocabulary");
  assert.equal(en.get("zzz"), null);
  assert.deepEqual(en.resolve(["api", "zzz", "api"]), { known: [en.get("api")], unknown: ["zzz"] }, "deduplicated, unknown ids reported");
  assert.throws(() => compileVocabulary({ ...vocab(), tags: [] }, { locale: "en" }), /kit\.content-tags\.v1/);
});

test("inheritance: an item's own tags replace the series', otherwise the series' apply", () => {
  assert.deepEqual(effectiveTags(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(effectiveTags(["a", "b"], []), ["a", "b"]);
  assert.deepEqual(effectiveTags(["a", "b"], ["c"]), ["c"]);
  assert.deepEqual(effectiveTags(undefined, undefined), []);
});

test("checkAssignment: undeclared tags, an empty required list, duplicates, non-lists", () => {
  const v = compileVocabulary(vocab(), { locale: "en" });
  assert.deepEqual(checkAssignment(v, "series legal", ["api", "licensing"], { required: true }), []);
  assert.deepEqual(checkAssignment(v, "series legal", ["zzz"], { required: true }), ['series legal: tag "zzz" is not declared in the vocabulary']);
  assert.deepEqual(checkAssignment(v, "series legal", undefined, { required: true }), ["series legal: has no tags (name at least one tag of the vocabulary)"]);
  assert.deepEqual(checkAssignment(v, "item x", undefined, { required: false }), []);
  assert.deepEqual(checkAssignment(v, "post p", ["api", "api"], { required: true }), ['post p: tag "api" is listed twice']);
  assert.deepEqual(checkAssignment(v, "post p", "api", { required: true }), ["post p: tags must be a list of tag ids"]);
});

test("search fold and match: case, Arabic letter variants, ZWNJ, diacritics; every word must match", () => {
  assert.equal(foldQuery("  ك ي  Ábc‌d "), "ک ی abc d");
  assert.ok(matchesQuery("مجوز", ["مجوز نرم‌افزار چیست"]));
  assert.ok(matchesQuery("مجوز نرم افزار", ["مجوز نرم‌افزار چیست"]), "ZWNJ equals a space");
  assert.ok(matchesQuery("APIS open", ["Open", "the apis"]), "every word may occur in a different part");
  assert.ok(!matchesQuery("apis zebra", ["Open", "the apis"]));
  assert.ok(matchesQuery("", ["anything"]), "an empty query matches everything");
});

test("a series that names tags lets its items inherit them (tagsMin 0); without series tags an item must name one", () => {
  const base = { site: { name: "S", url: "https://s.example", locale: "en-US" }, shows: { w: { title: "W" } },
    series: [{ id: "a", kind: "topic", every: "week", on: "mon", podcast: false }, { id: "b", kind: "topic", every: "week", on: "mon", tags: ["x"], podcast: false }] };
  const cfg = defineConfig(base);
  const [a, b] = cfg.series;
  assert.equal(a.contract.tagsMin, 1);
  assert.equal(b.contract.tagsMin, 0);
  const item = { date: "2026-10-05", title: "T", summary: "S", article: "x".repeat(800) };
  assert.ok(checkTopic(item, { series: a, config: cfg }).some((p) => /at least 1 tag/.test(p)));
  assert.ok(!checkTopic(item, { series: b, config: cfg }).some((p) => /at least \d+ tag/.test(p)));
  assert.equal(defineConfig({ ...base, series: [{ ...base.series[1], contract: { tagsMin: 2 } }] }).series[0].contract.tagsMin, 2, "an explicit contract wins");
});
