// Concept series (concepts.js): the reviewed-fields hash, the composed script, eligibility, the append-only schedule, the held items, the checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256 } from "../src/sha256.js";
import { approvalHash, canonicalJson, composeTalk, conceptArticle, eligibility, planSchedule, conceptItems, conceptSeries, checkCatalogue, checkSchedule, conceptStatus, reviewState, quoteInText, ATTESTS } from "../src/concepts.js";
import { createValidator, formatProblems } from "../src/schema.js";
import { readFileSync } from "node:fs";
import { config as rawConfig, catalogue, concept } from "./fixtures/concepts.mjs";
import { keys, ledger as newLedger, approve, append, verify, rosterOf } from "./fixtures/ledger.mjs";

const REVIEWER = keys("Dr Reviewer");

const clone = (x) => JSON.parse(JSON.stringify(x));
const here = (p) => new URL(p, import.meta.url);
const schema = (n) => JSON.parse(readFileSync(here(`../schemas/${n}.schema.json`), "utf8"));
// The effective config the CLI loader builds: the file's config plus the registry's facts (kind and review gate), never read from the file.
const config = (over = {}) => { const c = rawConfig(over); return { ...c, kind: "general", gate: { ...c.gate, review: { mode: "none" } } }; };
const shariah = (over = {}) => { const c = rawConfig({ gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" } }, ...over }); return { ...c, kind: "shariah", gate: { ...c.gate, review: { mode: "shariah-ledger", ledger: "shariah-review.json" } } }; };
const hashOf = (cat, c, cfg = config()) => approvalHash(cfg, cat, c);
// A real signed, chained ledger (what `kit shariah approve` writes) approving the current text of each id, VERIFIED (what the gate and the run time consume).
const signed = (cat, ids, over = {}) => { const l = newLedger("shariah"); for (const id of ids) approve(l, REVIEWER, id, hashOf(cat, cat.concepts.find((c) => c.id === id)), over); return l; };
const ledger = (cat, ids, over = {}) => verify(signed(cat, ids, over), rosterOf(REVIEWER));

test("sha256 equals node:crypto for short, block-edge and long inputs, and for UTF-8", async () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "ایران اوپن فاینانس ".repeat(40), "ﷺ £ 日本"]) assert.equal(sha256(s), createHash("sha256").update(s).digest("hex"), s.slice(0, 20));
});

test("the fixtures validate against the four schemas", async () => {
  const v = createValidator(["concept-catalogue", "concept-schedule", "concepts-config", "approval-ledger"].map(schema));
  const id = (n) => schema(n).$id;
  assert.deepEqual(formatProblems(v.validate(catalogue(), id("concept-catalogue"))), []);
  assert.deepEqual(formatProblems(v.validate(rawConfig(), id("concepts-config"))), []);
  assert.deepEqual(formatProblems(v.validate({ $schema: "x", series: "s", entries: [] }, id("concept-schedule"))), []);
  assert.deepEqual(formatProblems(v.validate(newLedger("shariah"), id("approval-ledger"))), []);
  // contested without views, unverified without a reason, an approval without attestations are refused
  const bad = catalogue([concept("a", "sales", { contested: true }), concept("b", "sales", { accuracy: { status: "unverified", checked: "2026-10-07" } })]);
  const p = formatProblems(v.validate(bad, id("concept-catalogue"))).join("\n");
  assert.match(p, /\/concepts\/0.*views/); assert.match(p, /\/concepts\/1\/accuracy.*reason/);
  assert.match(formatProblems(v.validate({ ...newLedger("shariah"), entries: [{ seq: 1, id: "a", sha256: "a".repeat(64), status: "approved", by: "X Y", at: "2026-10-07T10:00:00Z", prev: "b".repeat(64) }] }, id("approval-ledger"))).join(), /sig/);
  // the file cannot say what kind of series it is, or switch the review gate: the kit registry does (ROOT A)
  assert.match(formatProblems(v.validate({ ...rawConfig(), kind: "general" }, id("concepts-config"))).join(), /unknown property|kind/);
  assert.match(formatProblems(v.validate({ ...rawConfig(), gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" }, review: { mode: "none" } } }, id("concepts-config"))).join(), /unknown property|review/);
});

test("the approval hash covers every string that is served or voiced for the concept (ROOT G), and nothing else, in any key order", () => {
  const cfg = config(), cat = catalogue(), c = cat.concepts[0], h = approvalHash(cfg, cat, c);
  const hashWith = (cfg2, cat2 = cat, c2 = c) => approvalHash(cfg2, cat2, c2);
  assert.equal(hashWith(cfg, cat, { ...c, related: ["salam"], difficulty: "advanced" }), h, "related and difficulty are not served");
  // the reviewed fields
  assert.notEqual(hashWith(cfg, cat, { ...c, definition: { "en-GB": "Another sentence entirely." } }), h);
  assert.notEqual(hashWith(cfg, cat, { ...c, episode: { ...c.episode, why: "Different reason that matters more." } }), h);
  assert.notEqual(hashWith(cfg, cat, { ...c, sources: [{ ...c.sources[0], quote: "A different quote of at least twenty characters." }] }), h);
  // what is served or voiced around them: tags, glossary and widget links and the widget's label, the title
  assert.notEqual(hashWith(cfg, cat, { ...c, tags: ["a"] }), h, "tags are served");
  assert.notEqual(hashWith(cfg, cat, { ...c, glossary: "murabaha" }), h, "the glossary link is served");
  assert.notEqual(hashWith(cfg, cat, { ...c, widget: { scenario: "x", label: { "en-GB": "a widget" } } }), h, "the widget and its label are served");
  assert.notEqual(hashWith(cfg, cat, { ...c, title: { "en-GB": "A different title" } }), h);
  // the catalogue's as-of date is in the article
  assert.notEqual(hashWith(cfg, { ...cat, asOf: "2026-10-06" }), h);
  // the series' own strings: host glue lines, intro, outro, title template, article labels, disclaimer, show title
  const s = cfg.strings, set = (strings, series = cfg.series) => ({ ...cfg, strings: { ...s, ...strings }, series });
  assert.notEqual(hashWith(set({ glue: { ...s.glue, why: ["A new question?", "Another new one?", "A third new one?"] } })), h, "glue lines are voiced");
  assert.notEqual(hashWith(set({ glue: { ...s.glue, views: ["Changed?", "Changed too?", "And this?"] } })), h, "even the glue of a beat this concept does not use is part of the approved script text");
  assert.notEqual(hashWith(set({ intro: [["host", "A different welcome."]] })), h, "the intro is voiced");
  assert.notEqual(hashWith(set({ outro: [["host", "A different goodbye."]] })), h, "the outro is voiced");
  assert.notEqual(hashWith(set({ title: "{title} ({number})" })), h, "the episode title template is served");
  assert.notEqual(hashWith(set({ article: { ...s.article, disclaimer: "Not education, not a ruling." } })), h, "the disclaimer is served");
  assert.notEqual(hashWith(set({ article: { ...s.article, why: "A new label." } })), h, "the article labels are served");
  assert.notEqual(hashWith(set({}, { ...cfg.series, title: "A New Show" })), h, "the show title is served");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

test("the script has the five beats, with the views beat for a contested concept, and the glue is stable per concept", async () => {
  const cfg = config(), cat = catalogue();
  const plain = composeTalk(cfg, cat.concepts[0]);
  assert.deepEqual(plain.map((l) => l[0]), ["amina", "yusuf", "amina", "yusuf", "amina", "yusuf", "amina", "yusuf"]);
  assert.equal(plain[0][1], "What is murabaha, really?");
  assert.equal(plain[7][1], cat.concepts[0].episode.takeaway);
  assert.deepEqual(composeTalk(cfg, cat.concepts[0]), plain, "deterministic");
  const contested = composeTalk(cfg, cat.concepts.find((c) => c.contested));
  assert.equal(contested.length, 10);
  assert.ok(cfg.strings.glue.views.includes(contested[4][1]));
  assert.equal(contested[5][1].startsWith("views0"), true);
  const verb = new Set(cat.concepts.map((c) => composeTalk(cfg, c)[2][1]));
  assert.ok(verb.size > 1, "the glue varies across concepts");
});

test("the article carries the definition, the sources (document and section), the as-of date, the links and the disclaimer", async () => {
  const cfg = config(), cat = catalogue();
  const k = { ...cat.concepts[0], glossary: "murabaha", widget: { scenario: "murabaha-cashflow", label: { "en-GB": "the murabaha cash flow" } } };
  const a = conceptArticle(cfg, cat, k);
  assert.match(a, /^One sentence that defines murabaha\./);
  assert.match(a, /- A Standard Setter, Standard number 8, para 8/);
  assert.match(a, /Facts as of 7 October 2026\./);
  assert.match(a, /\[Title of murabaha\]\(\/glossary\/murabaha\/\)/);
  assert.match(a, /\[the murabaha cash flow\]\(\/lab\/#murabaha-cashflow\)/);
  assert.match(a, /Education, not a ruling\./);
  const t = conceptArticle(cfg, catalogue([{ ...catalogue().concepts.find((c) => c.contested) }]), catalogue().concepts.find((c) => c.contested));
  assert.match(t, /- Position A: Permitted when/);
});

test("eligibility: unverified concepts wait outside the verified prefix; with a ledger only an approved, unchanged concept", async () => {
  const cat = catalogue(), cfg = config(), by = (id) => cat.concepts.find((c) => c.id === id);
  assert.equal(eligibility(by("murabaha"), cfg, null, { position: 1, catalogue: cat }).ok, true);
  assert.match(eligibility(by("gharar"), cfg, null, { position: 2, catalogue: cat }).reasons.join(), /inside the verified prefix/);
  assert.equal(eligibility(by("gharar"), cfg, null, { position: 3, catalogue: cat }).ok, true);
  const s = shariah(), el = (c, ap, pos = 1, k = cat) => eligibility(c, s, ap, { position: pos, catalogue: k });
  assert.match(eligibility(by("gharar"), s, await ledger(cat, []), { position: 9, catalogue: cat }).reasons.join(), /never schedules an unverified/);
  assert.match(el(by("murabaha"), await ledger(cat, [])).reasons.join(), /review: unreviewed/);
  const okL = signed(cat, ["murabaha"]), ok = await verify(okL, rosterOf(REVIEWER));
  assert.equal(el(by("murabaha"), ok).ok, true);
  const edited = { ...by("murabaha"), definition: { "en-GB": "An edited sentence after the approval." } };
  assert.equal(reviewState(edited, ok, hashOf(cat, edited)).state, "changed");
  assert.match(el(edited, ok).reasons.join(), /review: changed/);
  for (const status of ["rejected", "withdrawn"]) { const l = signed(catalogue(), ["murabaha"]); append(l, REVIEWER, { id: "murabaha", sha256: okL.entries[0].sha256, status, statement: "Not approved, with a reason." }); assert.equal(reviewState(by("murabaha"), await verify(l, rosterOf(REVIEWER)), hashOf(cat, by("murabaha"))).state, status); }
  const partial = newLedger("shariah"); append(partial, REVIEWER, { id: "murabaha", sha256: hashOf(cat, by("murabaha")), status: "approved", attests: ["sources-read"], statement: "Only read the sources." });
  assert.equal(reviewState(by("murabaha"), await verify(partial, rosterOf(REVIEWER)), hashOf(cat, by("murabaha"))).state, "incomplete");
  const bl = newLedger("shariah", 1); append(bl, null, { id: "murabaha", sha256: hashOf(cat, by("murabaha")), status: "baseline" });
  assert.equal(reviewState(by("murabaha"), await verify(bl, rosterOf(REVIEWER)), hashOf(cat, by("murabaha"))).state, "baseline", "a baseline is never an approval");
  // identity: a ledger that does not verify approves nothing, whatever it says
  const forged = clone(okL); forged.entries[0].statement = "Edited after the signature.";
  const fv = await verify(forged, rosterOf(REVIEWER));
  assert.equal(reviewState(by("murabaha"), fv, hashOf(cat, by("murabaha"))).state, "invalid");
  assert.match(el(by("murabaha"), fv).reasons.join(), /review: invalid/);
  assert.equal(el(by("murabaha"), await verify(okL, [])).ok, false, "an EMPTY roster approves nothing");
});

test("planSchedule: order.first, theme round-robin, easier first, prerequisites first, consecutive dates", async () => {
  const cat = catalogue(), cfg = config({ order: { strategy: "theme-round-robin", first: ["ijara"], themeOrder: ["sales", "leases", "risk"] } });
  const r = planSchedule({ catalogue: cat, config: cfg, from: null, today: "2026-10-20" });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.added.map((a) => a.id), ["ijara", "murabaha", "sukuk-ijara", "tawarruq", "salam", "gharar", "istisna"]);
  assert.equal(r.added[0].date, "2026-11-01");
  assert.deepEqual(r.added.map((a) => a.order), r.added.map((_, i) => i + 1));
  // prerequisites: istisna (needs salam) and sukuk-ijara (needs ijara) never come before them
  const pos = (id) => r.added.findIndex((a) => a.id === id);
  assert.ok(pos("salam") < pos("istisna") && pos("ijara") < pos("sukuk-ijara"));
  // gharar is unverified: not inside the first 2, allowed after
  assert.ok(pos("gharar") >= 2);
  assert.deepEqual(checkSchedule(r.schedule, cat, cfg, null), []);
  // dates are consecutive
  for (let i = 1; i < r.added.length; i++) assert.equal((Date.parse(r.added[i].date) - Date.parse(r.added[i - 1].date)) / 864e5, 1);
  assert.equal(r.schedule.entries[0].assigned_on, "2026-10-20");
});

test("planSchedule appends only: running it again adds nothing, a new approval is appended after the last day, nothing moves", async () => {
  const cat = catalogue(), cfg = shariah({ order: { strategy: "catalogue" } });
  let r = planSchedule({ catalogue: cat, config: cfg, approvals: await ledger(cat, ["murabaha", "salam"]), today: "2026-10-20" });
  assert.deepEqual(r.added.map((a) => a.id), ["murabaha", "salam"]);
  const first = JSON.stringify(r.schedule.entries);
  r = planSchedule({ catalogue: cat, config: cfg, approvals: await ledger(cat, ["murabaha", "salam"]), schedule: r.schedule, today: "2026-10-21" });
  assert.deepEqual(r.added, []);
  assert.equal(JSON.stringify(r.schedule.entries), first);
  const more = await ledger(cat, ["murabaha", "salam", "ijara", "tawarruq"]);
  r = planSchedule({ catalogue: cat, config: cfg, approvals: more, schedule: r.schedule, today: "2026-10-22" });
  assert.deepEqual(r.added.map((a) => [a.id, a.date, a.order]), [["ijara", "2026-11-03", 3], ["tawarruq", "2026-11-04", 4]]);
  assert.equal(JSON.stringify(r.schedule.entries.slice(0, 2)), first);
  // unapproved concepts are listed as waiting, with the reason
  assert.match(r.waiting.find((w) => w.id === "istisna").reasons.join(), /review: unreviewed/);
  // a gap needs a reason and is recorded
  const gap = planSchedule({ catalogue: cat, config: cfg, approvals: await ledger(cat, ["murabaha", "salam", "ijara", "tawarruq", "istisna"]), schedule: r.schedule, from: "2026-11-10", today: "2026-11-09" });
  assert.match(gap.problems.join(), /--allow-gap/);
  const ok = planSchedule({ catalogue: cat, config: cfg, approvals: await ledger(cat, ["murabaha", "salam", "ijara", "tawarruq", "istisna"]), schedule: r.schedule, from: "2026-11-10", allowGap: "approvals came late", today: "2026-11-09" });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.schedule.gaps, [{ from: "2026-11-05", to: "2026-11-09", reason: "approvals came late" }]);
  assert.deepEqual(checkSchedule(ok.schedule, cat, cfg, await ledger(cat, ["murabaha", "salam", "ijara", "tawarruq", "istisna"])), []);
});

test("conceptItems: only eligible concepts become items; an edited approved concept is held (fail closed) and its slot stays", async () => {
  const cat = catalogue(), cfg = shariah({ order: { strategy: "catalogue" } }), approvals = await ledger(cat, ["murabaha", "salam", "ijara"]);
  const { schedule } = planSchedule({ catalogue: cat, config: cfg, approvals, today: "2026-10-20" });
  let r = conceptItems({ catalogue: cat, config: cfg, schedule, approvals });
  assert.deepEqual(r.items.map((i) => i.slug), ["murabaha", "salam", "ijara"]);
  assert.deepEqual(r.items.map((i) => i.number), [1, 2, 3]);
  assert.equal(r.items[0].date, "2026-11-01");
  assert.equal(r.items[0].talk.length, 8);
  assert.deepEqual(r.items[0].sources, [{ title: "A Standard Setter: Standard number 8", url: "https://example.org/standards/8" }]);
  const edited = catalogue(catalogue().concepts.map((c) => (c.id === "salam" ? { ...c, definition: { "en-GB": "A sentence edited after the approval." } } : c)));
  r = conceptItems({ catalogue: edited, config: cfg, schedule, approvals });
  assert.deepEqual(r.items.map((i) => i.slug), ["murabaha", "ijara"]);
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-01", "2026-11-03"], "the held day stays empty: no later concept moves into it");
  assert.match(r.held[0].reasons.join(), /review: changed/);
  // an empty ledger publishes nothing at all
  assert.deepEqual(conceptItems({ catalogue: cat, config: cfg, schedule, approvals: await verify(newLedger("shariah"), rosterOf(REVIEWER)) }).items, []);
  assert.deepEqual(conceptItems({ catalogue: cat, config: cfg, schedule, approvals: null }).items, []);
});

test("conceptSeries: a daily topic series from the first to the last scheduled day, with the project's strings and measured rate", async () => {
  const cat = catalogue(), cfg = config();
  const { schedule } = planSchedule({ catalogue: cat, config: cfg, today: "2026-10-20" });
  const s = conceptSeries(cfg, schedule);
  assert.equal(s.kind, "topic"); assert.equal(s.every, "day");
  assert.equal(s.start, "2026-11-01"); assert.equal(s.end, schedule.entries.at(-1).date);
  assert.equal(s.slug({ date: "2026-11-01" }), "ijara".length ? schedule.entries[0].id : "");
  assert.equal(s.podcast.cps, 17.4); assert.equal(s.podcast.strings.topic.title, cfg.strings.title);
  const empty = conceptSeries(cfg, { entries: [] });
  assert.equal(empty.end, "2026-10-31", "an empty series ends the day before it starts");
});

test("checkCatalogue: links, prerequisites, sources, accuracy dates, size, wording", async () => {
  const cfg = config();
  assert.deepEqual(checkCatalogue(catalogue(), cfg), []);
  const p = (concepts, c = cfg) => checkCatalogue(catalogue(concepts), c).join("\n");
  assert.match(p([concept("a", "sales"), concept("a", "sales")]), /duplicate id/);
  assert.match(p([concept("a", "nowhere")]), /theme "nowhere"/);
  assert.match(p([concept("a", "sales", { related: ["ghost"] })]), /related "ghost"/);
  assert.match(p([concept("a", "sales", { prerequisites: ["b"] }), concept("b", "sales", { prerequisites: ["a"] })]), /prerequisite cycle/);
  assert.match(p([concept("a", "sales", { sources: [{ ...concept("a", "sales").sources[0], kind: "secondary" }] })]), /at least one primary source/);
  assert.match(p([concept("a", "sales", { accuracy: { status: "verified", checked: "2026-10-09", by: "x" } })]), /after the catalogue's asOf/);
  assert.match(p([concept("a", "sales")], config({ format: { ...cfg.format, body: { min: 100, max: 130 } } })), /the talk is \d+ words \(100-130\)/);
  assert.match(p([concept("a", "sales", { episode: { ...concept("a", "sales").episode, hook: "Do all scholars agree on this?  Yes, all scholars agree." } })]), /no single position is presented as universal/);
  assert.match(p([concept("a", "sales", { contested: true, views: [{ label: "Same", position: "A position that is long enough." }, { label: "same", position: "Another position long enough." }], episode: { ...concept("a", "sales").episode, views: "x".repeat(30) } })]), /two views carry the same label/);
  assert.match(p([concept("a", "sales"), concept("b", "sales", { sources: [{ ...concept("a", "sales").sources[0], document: "Another title for the same URL" }] })]), /described differently/);
  assert.match(checkCatalogue({ ...catalogue(), series: "other" }, cfg).join(), /series "other"/);
  assert.match(checkCatalogue(catalogue(), config({ order: { strategy: "catalogue", first: ["nope"] } })).join(), /order.first/);
  // everything spoken must fit a minute
  assert.match(checkCatalogue(catalogue(), config({ format: { ...cfg.format, total: { max: 60 } } })).join(), /everything spoken is \d+ words/);
});

test("checkSchedule: unknown id, repeated id, a skipped day, an unverified concept in the prefix, no ledger entry", async () => {
  const cat = catalogue(), cfg = config();
  const e = (id, date, order) => ({ id, date, order, sha256: "a".repeat(64), assigned_on: "2026-10-20" });
  const s = (entries, gaps) => ({ series: cfg.series.id, entries, ...(gaps ? { gaps } : {}) });
  assert.match(checkSchedule(s([e("ghost", "2026-11-01", 1)]), cat, cfg).join(), /not in the catalogue/);
  assert.match(checkSchedule(s([e("murabaha", "2026-11-01", 1), e("murabaha", "2026-11-02", 2)]), cat, cfg).join(), /scheduled twice/);
  assert.match(checkSchedule(s([e("murabaha", "2026-11-01", 1), e("salam", "2026-11-03", 2)]), cat, cfg).join(), /1 day\(s\) skipped/);
  assert.match(checkSchedule(s([e("murabaha", "2026-11-01", 1), e("gharar", "2026-11-02", 2)]), cat, cfg).join(), /inside the verified prefix/);
  assert.match(checkSchedule(s([e("murabaha", "2026-11-02", 1)]), cat, cfg).join(), /series starts on 2026-11-01/);
  assert.match(checkSchedule(s([e("istisna", "2026-11-01", 1)]), cat, cfg).join(), /prerequisite salam/);
  assert.match(checkSchedule(s([e("murabaha", "2026-11-01", 1)]), cat, shariah(), await verify(newLedger("shariah"), rosterOf(REVIEWER))).join(), /no entry in shariah-review\.json/);
});

test("conceptStatus: counts, held, waiting and the runway", async () => {
  const cat = catalogue(), cfg = shariah({ order: { strategy: "catalogue" } }), approvals = await ledger(cat, ["murabaha", "salam"]);
  const { schedule } = planSchedule({ catalogue: cat, config: cfg, approvals, today: "2026-10-20" });
  const st = conceptStatus({ catalogue: cat, config: cfg, schedule, approvals, today: "2026-10-30" });
  assert.equal(st.concepts, 7); assert.equal(st.verified, 6); assert.equal(st.scheduled, 2); assert.equal(st.published, 2);
  assert.equal(st.runway, 3); assert.equal(st.runwayOk, false);
  assert.deepEqual(st.review, { approved: 2, unreviewed: 5, changed: 0, other: 0 });
});

test("quoteInText ignores whitespace, case, quote marks, dashes and soft hyphens", async () => {
  assert.ok(quoteInText("The board of directors has ultimate responsibility", "…the board\nof  directors has ultimate­ responsibility for…"));
  assert.ok(quoteInText("banks’ third-party risk", "Banks' third–party risk"));
  assert.equal(quoteInText("a passage that is not there", "some other text"), false);
});

import { LIMITS, TALK_LINES } from "../src/concepts.js";

test("ROOT 4: what the docs claim is enforced: a generic 'scholars' label, too few concepts, an undated schedule, and the caps come from the schema", async () => {
  const cfg = config(), tw = catalogue().concepts.find((c) => c.contested);
  const withLabel = (label) => catalogue(catalogue().concepts.map((c) => (c.id === "tawarruq" ? { ...c, views: [{ ...c.views[0], label }, c.views[1]] } : c))); void tw;
  for (const bad of ["Scholars", "some scholars", "The majority", "Contemporary jurists", "Others", "Classical Muslim scholars"]) assert.match(checkCatalogue(withLabel(bad), cfg).join(), /names no holder/, bad);
  for (const ok of ["AAOIFI Shariah Board", "Hanafi school", "Malaysia Securities Commission", "OIC International Islamic Fiqh Academy"]) assert.doesNotMatch(checkCatalogue(withLabel(ok), cfg).join(), /names no holder/, ok);
  assert.match(checkCatalogue(catalogue(), config({ minConcepts: 8 })).join(), /7 concepts, fewer than the 8/);
  assert.throws(() => planSchedule({ catalogue: catalogue(), config: cfg }), /today \(YYYY-MM-DD\) is required/);
  assert.throws(() => conceptStatus({ catalogue: catalogue(), config: cfg, schedule: { entries: [] } }), /today/);
  const a = planSchedule({ catalogue: catalogue(), config: cfg, today: "2026-10-20" }), b = planSchedule({ catalogue: catalogue(), config: cfg, today: "2026-10-20" });
  assert.deepEqual(a.schedule, b.schedule, "same inputs, same schedule");
  const schema = JSON.parse(readFileSync(here("../schemas/concept-catalogue.schema.json"), "utf8"));
  assert.equal(LIMITS.titleMax, schema.$defs.titleText.additionalProperties.maxLength);
  assert.equal(LIMITS.definitionMax, 200);
  const s = conceptSeries(cfg, a.schedule);
  assert.equal(s.contract.titleMax, LIMITS.titleMax); assert.equal(s.contract.summaryMax, LIMITS.definitionMax);
  assert.equal(s.contract.linesMin, TALK_LINES.min); assert.equal(s.contract.linesMax, TALK_LINES.max);
  assert.equal(composeTalk(cfg, catalogue().concepts[0]).length, TALK_LINES.min);
  assert.equal(composeTalk(cfg, catalogue().concepts.find((c) => c.contested)).length, TALK_LINES.max);
  // an over-long definition is the schema's to refuse
  const v = createValidator(["concept-catalogue"].map(schema0));
  assert.match(formatProblems(v.validate(catalogue([concept("a", "sales", { definition: { "en-GB": "x".repeat(201) } })]), schema0("concept-catalogue").$id)).join(), /at most 200/);
});
const schema0 = (n) => JSON.parse(readFileSync(new URL(`../schemas/${n}.schema.json`, import.meta.url), "utf8"));

test("run time: every scheduled entry is verified and served (no window: a stale or unverified window cannot hide a withdrawal)", async () => {
  const cat = catalogue(), cfg = shariah({ order: { strategy: "catalogue" } }), approvals = await ledger(cat, ["murabaha", "salam", "ijara"]);
  const { schedule } = planSchedule({ catalogue: cat, config: cfg, approvals, today: "2026-10-20" });
  const r = conceptItems({ catalogue: cat, config: cfg, schedule, approvals });
  assert.deepEqual(r.items.map((i) => i.slug), ["murabaha", "salam", "ijara"]);
});

test("a Persian as-of date is Solar Hijri from the calendar package, in Persian digits", async () => {
  const cfg = config({ locale: "fa", titleLocales: ["fa"], strings: { ...config().strings, article: { ...config().strings.article, asOf: "{date}" } } });
  const cat = { ...catalogue(), locale: "fa" };
  const a = conceptArticle(cfg, cat, concept("x", "sales", { definition: { fa: "تعریف یک جمله‌ای." } }));
  assert.match(a, /۱۵ مهر ۱۴۰۵/);
  assert.doesNotMatch(a, /2026|۲۰۲۶/);
});
