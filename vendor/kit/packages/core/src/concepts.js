/**
 * Concept series (docs/CONCEPTS.md): a daily one-minute series whose single source is a schema-validated concept catalogue
 * (kit.concept-catalogue.v1) with a project-owned format (concepts.config.json, kit.concepts-config.v1). Pure and runtime-neutral
 * (Workers, Node): no I/O, a synchronous SHA-256.
 *
 *   approvalHash(config, catalogue, concept)    sha256 of the reviewed fields AND everything served or voiced (what a reviewer signs off)
 *   composeTalk(config, concept)                the two-host script: hook, definition, why it matters, [views], example, takeaway
 *   conceptArticle(config, catalogue, concept)  the written page, built from the same fields
 *   eligibility(concept, config, approvals, o)  may it be scheduled and published? { ok, reasons } (approvals: the verified ledger)
 *   planSchedule({ catalogue, config, approvals, schedule, from, today })   APPENDS the next eligible concepts (never reorders)
 *   conceptItems({ catalogue, config, schedule, approvals })         the topic items the planner publishes (+ the held ones)
 *   conceptSeries(config, schedule)             the kit.config.js series entry
 *   checkCatalogue / checkSchedule              semantic problems the JSON Schemas cannot express
 *   conceptStatus(...)                          counts, held concepts and the runway
 *
 * Nothing here publishes anything by itself: the planner reads the items, the cron queues the episodes (docs/PODCASTS.md).
 */
import { sha256 } from "./sha256.js";
import { canonicalJson } from "./canonical.js";
import { digits, formatJalali } from "@saasreport/format";
import CATALOGUE_SCHEMA from "../schemas/concept-catalogue.schema.json" with { type: "json" };

/** The reviewed fields of a concept (what a reviewer reads); the approval hash covers these AND everything that is served or voiced (approvalHash). */
export const REVIEWED_FIELDS = ["id", "title", "definition", "episode", "sources", "contested", "views"];
/** What an approval attests (approval-ledger.schema.json). */
export const ATTESTS = ["definition-accurate", "sources-read", "positions-fair", "not-a-fatwa"];
const RANK = { intro: 0, intermediate: 1, advanced: 2 };

export { canonicalJson };
/** The caps of the catalogue's text, read from the schema (the one source): the episode title, the one-sentence definition (the summary), the tags. */
export const LIMITS = {
  titleMax: CATALOGUE_SCHEMA.$defs.titleText.additionalProperties.maxLength,
  definitionMax: CATALOGUE_SCHEMA.$defs.definitionText.additionalProperties.maxLength,
  tagsMax: CATALOGUE_SCHEMA.$defs.concept.properties.tags.maxItems,
};
/** Lines of a composed script: eight (hook, definition, why, example, takeaway with the host's questions), ten when contested. */
export const TALK_LINES = { min: 8, max: 10 };

const day = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 864e5);
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const words = (t) => (String(t).trim().match(/\S+/g) || []).length;
/** Spoken size of some texts: words (English) or characters (Persian). */
export const sizeOf = (texts, unit) => texts.reduce((n, t) => n + (unit === "words" ? words(t) : String(t).length), 0);
const variant = (list, key) => list[parseInt(sha256(key).slice(0, 8), 16) % list.length];
const loc = (obj, locale) => obj?.[locale] ?? obj?.[String(locale).split("-")[0]] ?? null;

const hashCache = new WeakMap();
/**
 * What an approval covers: the reviewed fields AND everything that is served or voiced for the concept: the rendered title, summary, tags, article
 * (definition, why, example, views, takeaway, sources, as-of date, glossary and widget links, disclaimer), the spoken script (glue lines included) and
 * the series' intro, outro, title template, glue variants, article labels and show title. Change any of it and the approval no longer matches.
 */
export function approvalHash(config, catalogue, concept) {
  let m = hashCache.get(catalogue);
  if (!m) { m = new WeakMap(); hashCache.set(catalogue, m); }
  const cm = m.get(config) || new Map();
  m.set(config, cm);
  if (!cm.has(concept)) {
    const it = conceptItem(config, catalogue, concept, { date: "0000-00-00", order: 0 });
    const served = { title: it.title, summary: it.summary, tags: it.tags, article: it.article, talk: it.talk, sources: it.sources };
    const templates = { intro: config.strings.intro, outro: config.strings.outro, title: config.strings.title, glue: config.strings.glue, article: config.strings.article, show: config.series.title };
    cm.set(concept, sha256(canonicalJson({ fields: Object.fromEntries(REVIEWED_FIELDS.filter((k) => concept?.[k] !== undefined).map((k) => [k, concept[k]])), served, templates })));
  }
  return cm.get(concept);
}

/**
 * The review state of a concept from a VERIFIED ledger (`approvals` = the result of verifyLedger: the chain, every signature, the roster's evolution and the
 * veto rules already checked): approved only when the ledger verified, the subject's effective entry is an approval whose hash equals the concept's
 * approval hash and it carries every attestation. A ledger that does not verify approves nothing ("invalid").
 */
export function reviewState(concept, approvals, hash) {
  if (!approvals || !approvals.ok) return { state: "invalid", entry: null, problems: approvals?.problems || ["no ledger"] };
  const st = approvals.subjects.get(concept.id);
  if (!st) return { state: "unreviewed", entry: null };
  if (st.status === "rejected" || st.status === "withdrawn" || st.status === "baseline") return { state: st.status, entry: st.entry };
  if (st.sha256 !== hash) return { state: "changed", entry: st.entry };
  if (!ATTESTS.every((a) => (st.entry.attests || []).includes(a))) return { state: "incomplete", entry: st.entry };
  return { state: "approved", entry: st.entry };
}

/**
 * May this concept be scheduled and published?
 *   accuracy: verified always; unverified only when gate.accuracy.unverified is "after-prefix" and the position is beyond
 *             gate.accuracy.minVerifiedPrefix (the first N episodes are always verified);
 *   review:   with mode "shariah-ledger" (the registry says the project's series is Shariah) only an approved concept (the default policy: nothing unapproved
 *             is scheduled). `approvals` is the verified ledger (await verifyLedger first).
 */
export function eligibility(concept, config, approvals, { position = null, catalogue } = {}) {
  const reasons = [], g = config.gate;
  if (concept.accuracy?.status !== "verified") {
    if (g.accuracy.unverified === "never") reasons.push("accuracy: unverified (this project never schedules an unverified concept)");
    else if (position != null && position <= g.accuracy.minVerifiedPrefix) reasons.push(`accuracy: unverified, and position ${position} is inside the verified prefix (${g.accuracy.minVerifiedPrefix})`);
  } else if (position != null && position <= g.accuracy.minVerifiedPrefix && !(concept.sources || []).some((s) => s.kind === "primary")) reasons.push("accuracy: no primary source");
  if (g.review.mode === "shariah-ledger") {
    const hash = approvalHash(config, catalogue, concept), { state } = reviewState(concept, approvals, hash);
    if (state !== "approved") reasons.push(`review: ${state} (needs the signed approval of a roster member in ${g.review.ledger}, approval hash ${hash.slice(0, 12)})`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** The two-host script of a concept: hook, definition, why it matters, [views when contested], example, takeaway. */
export function composeTalk(config, concept) {
  const { host: H, expert: E } = config.speakers, g = config.strings.glue, b = concept.episode, id = concept.id;
  const lines = [[H, b.hook], [E, b.definition], [H, variant(g.why, `${id}:why`)], [E, b.why]];
  if (concept.contested) lines.push([H, variant(g.views || g.example, `${id}:views`)], [E, b.views]);
  lines.push([H, variant(g.example, `${id}:example`)], [E, b.example], [H, variant(g.takeaway, `${id}:takeaway`)], [E, b.takeaway]);
  return lines;
}

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
const dateText = (d, locale) => {
  if (String(locale).split("-")[0] === "fa") return digits(formatJalali(`${d}T00:00:00Z`, { locale: "fa", dateStyle: "long" }), "fa");   // Solar Hijri by the calendar package, never Gregorian digits in Persian
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
};

/** The written page: the definition, why, example, [views], takeaway, sources (document and section), the as-of date, the glossary and widget links. */
export function conceptArticle(config, catalogue, c) {
  const A = config.strings.article, L = config.locale, out = [loc(c.definition, L), ""];
  out.push(`**${A.why}** ${c.episode.why}`, "");
  out.push(`**${A.example}** ${c.episode.example}`, "");
  if (c.contested) out.push(`**${A.views}** ${c.episode.views}`, "", ...c.views.map((v) => `- ${v.label}: ${v.position}${v.basis ? ` (${v.basis})` : ""}`), "");
  out.push(`**${A.takeaway}** ${c.episode.takeaway}`, "");
  out.push(`**${A.sources}**`, ...c.sources.map((s) => `- ${s.publisher}, ${s.document}, ${s.section}`), "");
  out.push(fill(A.asOf, { date: dateText(catalogue.asOf, L) }));
  const links = config.links || {};
  if (c.glossary && links.glossary) out.push("", fill(A.glossary, { title: loc(c.title, L), href: fill(links.glossary, { slug: c.glossary }) }));
  if (c.widget && links.widget) out.push("", fill(A.widget, { label: loc(c.widget.label, L) || loc(c.title, L), href: fill(links.widget, { scenario: c.widget.scenario }) }));
  if (A.disclaimer) out.push("", A.disclaimer);
  return out.join("\n");
}

/** Distinct sources as the kit's `sources` ([{ title, url }]). */
const sourceLinks = (c) => { const seen = new Set(); return c.sources.filter((s) => !seen.has(s.url) && seen.add(s.url)).map((s) => ({ title: `${s.publisher}: ${s.document}`.replace(/[[\]]/g, ""), url: s.url })); };

/** One planner item (kind topic) of a scheduled concept. */
export function conceptItem(config, catalogue, concept, entry) {
  const L = config.locale, theme = catalogue.themes.find((t) => t.id === concept.theme);
  return {
    date: entry.date, slug: concept.id, number: entry.order,
    title: loc(concept.title, L), summary: loc(concept.definition, L),
    tags: [...new Set([loc(theme?.title, L), ...(concept.tags || [])].filter(Boolean))].slice(0, 5),
    article: conceptArticle(config, catalogue, concept), talk: composeTalk(config, concept), sources: sourceLinks(concept),
  };
}

/** The items the planner publishes for a schedule, and the scheduled concepts that are held back and why (fail closed). `approvals` is the verified ledger: `await verifyLedger(...)` first (the Worker does it once and memoizes). */
export function conceptItems({ catalogue, config, schedule, approvals = null }) {
  const by = new Map(catalogue.concepts.map((c) => [c.id, c]));
  const items = [], held = [];
  for (const e of schedule?.entries || []) {
    const c = by.get(e.id);
    if (!c) { held.push({ id: e.id, date: e.date, reasons: ["not in the catalogue any more"] }); continue; }
    const el = eligibility(c, config, approvals, { position: e.order, catalogue });
    if (!el.ok) { held.push({ id: e.id, date: e.date, reasons: el.reasons }); continue; }
    items.push(conceptItem(config, catalogue, c, e));
  }
  return { items, held };
}

/** The kit.config.js series entry of the concept series (a daily topic series with the project's format). */
export function conceptSeries(config, schedule) {
  const s = config.series, f = config.format, entries = schedule?.entries || [];
  const first = entries[0]?.date ?? s.start, last = entries.length ? entries[entries.length - 1].date : iso(day(s.start) - 1);
  const byDate = new Map(entries.map((e) => [e.date, e.id]));
  return {
    id: s.id, title: s.title, kind: "topic", every: "day", at: s.at, start: first, end: last, postKind: "article",
    slug: ({ date }) => byDate.get(date) || `${s.id}-${date}`,
    contract: { titleMax: LIMITS.titleMax, summaryMax: LIMITS.definitionMax, articleMin: f.articleMin ?? 400, articleMax: f.articleMax ?? 2400, linesMin: TALK_LINES.min, linesMax: TALK_LINES.max, lineMax: f.lineMax ?? 240, talkMin: 1, talkMax: (f.lineMax ?? 240) * TALK_LINES.max, even: true, tagsMin: 1, speakable: true },
    podcast: {
      show: s.show, maxSeconds: s.maxSeconds, marginSeconds: s.marginSeconds ?? 8, slug: "{series}-{ref}", cps: f.cps,
      strings: { topic: { intro: config.strings.intro, outro: config.strings.outro, title: config.strings.title } },
    },
  };
}

/** A view's label must name who holds the position, not "scholars" in general. */
const GENERIC_HOLDER = /^(?:the |some |many |most |other |several |certain |various |a number of )?(?:classical |contemporary |modern |muslim |islamic |shariah |sharia )*(?:scholars?|jurists?|fuqaha|ulama|authorities|experts|opinions?|views?|people|others|majority|minority|some|many|most)(?: of (?:islam|the (?:past|present)))?$/i;

/** Problems with a catalogue the JSON Schema cannot express (ids, links, sources, accuracy, views, format, lint). [] when fine. */
export function checkCatalogue(catalogue, config) {
  const p = [], L = config.locale, ids = new Set(), themes = new Set(catalogue.themes.map((t) => t.id)), unit = config.format.unit;
  if (catalogue.concepts.length < config.minConcepts) p.push(`the catalogue has ${catalogue.concepts.length} concepts, fewer than the ${config.minConcepts} this series requires (concepts.config.json minConcepts)`);
  if (catalogue.series !== config.series.id) p.push(`catalogue series "${catalogue.series}" is not the config's "${config.series.id}"`);
  if (catalogue.locale !== L) p.push(`catalogue locale "${catalogue.locale}" is not the config's "${L}"`);
  const docs = new Map();
  for (const t of catalogue.themes) for (const l of config.titleLocales) if (!loc(t.title, l)) p.push(`theme ${t.id}: title needs ${l}`);
  const forbid = (config.lint?.forbid || []).map((f) => ({ re: new RegExp(f.pattern, "i"), reason: f.reason }));
  for (const c of catalogue.concepts) {
    const at = `concept ${c.id}`;
    if (ids.has(c.id)) p.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (!themes.has(c.theme)) p.push(`${at}: theme "${c.theme}" is not in themes`);
    for (const l of config.titleLocales) { if (!c.title?.[l]) p.push(`${at}: title needs ${l}`); if (!c.definition?.[l]) p.push(`${at}: definition needs ${l}`); }
    if (c.contested && !c.views) p.push(`${at}: contested needs views`);
    if (!c.contested && c.views) p.push(`${at}: views without contested: true`);
    if (c.contested) {
      for (const v of c.views) if (GENERIC_HOLDER.test(v.label.trim())) p.push(`${at}: view label "${v.label}" names no holder: say which body, school or jurisdiction holds the position ("scholars" alone is refused)`);
      if (new Set(c.views.map((v) => v.label.trim().toLowerCase())).size < c.views.length) p.push(`${at}: two views carry the same label`);
      for (const v of c.views) if (v.source != null && !c.sources[v.source]) p.push(`${at}: view "${v.label}" cites source ${v.source}, which does not exist`);
    }
    if (c.accuracy.checked > catalogue.asOf) p.push(`${at}: checked ${c.accuracy.checked} is after the catalogue's asOf ${catalogue.asOf}`);
    if (c.accuracy.status === "verified") {
      if (!c.sources.some((s) => s.kind === "primary")) p.push(`${at}: verified needs at least one primary source`);
      for (const [i, s] of c.sources.entries()) {
        if (s.retrieved > catalogue.asOf) p.push(`${at}: source ${i + 1} retrieved ${s.retrieved} is after asOf`);
        if (s.retrieved > c.accuracy.checked) p.push(`${at}: source ${i + 1} retrieved ${s.retrieved} is after the accuracy check ${c.accuracy.checked}`);
      }
    }
    for (const s of c.sources) {
      const k = docs.get(s.url);
      if (k && (k.document !== s.document || (k.sha256 && s.sha256 && k.sha256 !== s.sha256))) p.push(`${at}: ${s.url} is described differently elsewhere (document title or sha256 differ)`);
      else if (!k) docs.set(s.url, s);
    }
    for (const r of [...(c.related || []), ...(c.prerequisites || [])]) if (r === c.id) p.push(`${at}: relates to itself`);
    // size and wording of the spoken script
    const talk = composeTalk(config, c), texts = talk.map((l) => l[1]);
    const body = sizeOf(texts, unit), wrap = sizeOf([...config.strings.intro, ...config.strings.outro].map((l) => fill(l[1], { show: config.series.title, number: "000", title: loc(c.title, L), host: "", expert: "" })), unit);
    const F = config.format;
    if (body < F.body.min || body > F.body.max) p.push(`${at}: the talk is ${body} ${unit} (${F.body.min}-${F.body.max})`);
    if (body + wrap > F.total.max || (F.total.min && body + wrap < F.total.min)) p.push(`${at}: everything spoken is ${body + wrap} ${unit} (${F.total.min ?? 0}-${F.total.max}): it must fit a minute`);
    if (F.lineMax) texts.forEach((t, i) => { if (t.length > F.lineMax) p.push(`${at}: talk line ${i + 1} is ${t.length} characters (at most ${F.lineMax})`); });
    const all = [loc(c.title, L), loc(c.definition, L), ...texts, ...(c.views || []).map((v) => `${v.label} ${v.position} ${v.basis || ""}`)].join("\n");
    for (const f of forbid) if (f.re.test(all)) p.push(`${at}: ${f.reason} (matches /${f.re.source}/i)`);
  }
  const by = new Map(catalogue.concepts.map((c) => [c.id, c]));
  for (const c of catalogue.concepts) {
    for (const r of c.related || []) if (!by.has(r)) p.push(`concept ${c.id}: related "${r}" is not a concept`);
    for (const r of c.prerequisites || []) if (!by.has(r)) p.push(`concept ${c.id}: prerequisite "${r}" is not a concept`);
  }
  // prerequisite cycles
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { p.push(`prerequisite cycle: ${[...path, id].join(" > ")}`); return; }
    state.set(id, 1);
    for (const r of by.get(id)?.prerequisites || []) if (by.has(r)) visit(r, [...path, id]);
    state.set(id, 2);
  };
  for (const c of catalogue.concepts) visit(c.id, []);
  for (const id of config.order.first || []) if (!by.has(id)) p.push(`order.first: "${id}" is not a concept`);
  for (const id of config.order.themeOrder || []) if (!themes.has(id)) p.push(`order.themeOrder: "${id}" is not a theme`);
  return p;
}

/** Problems with a schedule against its catalogue and config: order, dates, gaps, unknown ids, the verified prefix, the series start. */
export function checkSchedule(schedule, catalogue, config, approvals = null) {
  const p = [], by = new Map(catalogue.concepts.map((c) => [c.id, c])), seen = new Set(), E = schedule.entries;
  if (schedule.series !== config.series.id) p.push(`schedule series "${schedule.series}" is not "${config.series.id}"`);
  if (E.length && E[0].date !== config.series.start) p.push(`the first entry is on ${E[0].date}, but the series starts on ${config.series.start}`);
  const gaps = schedule.gaps || [];
  E.forEach((e, i) => {
    const c = by.get(e.id), at = `schedule ${e.date} ${e.id}`;
    if (!c) p.push(`${at}: not in the catalogue (a scheduled concept is never deleted: withdraw it in the review ledger instead)`);
    if (seen.has(e.id)) p.push(`${at}: scheduled twice`);
    seen.add(e.id);
    if (e.order !== i + 1) p.push(`${at}: order ${e.order}, expected ${i + 1}`);
    if (i) {
      const prev = E[i - 1];
      if (e.date <= prev.date) p.push(`${at}: date does not follow ${prev.date}`);
      else if (day(e.date) - day(prev.date) > 1 && !gaps.some((g) => g.from === iso(day(prev.date) + 1) && g.to === iso(day(e.date) - 1))) p.push(`${at}: ${day(e.date) - day(prev.date) - 1} day(s) skipped after ${prev.date} without a recorded gap`);
    }
    if (c) {
      for (const r of c.prerequisites || []) { const j = E.findIndex((x) => x.id === r); if (j < 0 || j > i) p.push(`${at}: prerequisite ${r} is not scheduled before it`); }
      if (e.order <= config.gate.accuracy.minVerifiedPrefix && c.accuracy.status !== "verified") p.push(`${at}: position ${e.order} is inside the verified prefix (${config.gate.accuracy.minVerifiedPrefix}) but the concept is unverified`);
      if (config.gate.accuracy.unverified === "never" && c.accuracy.status !== "verified") p.push(`${at}: unverified, and this project never schedules an unverified concept`);
      if (config.gate.review.mode === "shariah-ledger" && approvals?.ok && !approvals.subjects.has(e.id)) p.push(`${at}: scheduled with no entry in ${config.gate.review.ledger} (nothing is scheduled before a reviewer has looked at it)`);
    }
  });
  for (const g of gaps) if (!(g.from <= g.to)) p.push(`gap ${g.from}..${g.to}: from is after to`);
  return p;
}

/**
 * Appends the next eligible concepts to a schedule. Never reorders or removes an entry, so no day changes meaning.
 * Order: `order.first` ids, then rounds over the themes (themeOrder, else the catalogue's), the easier concept first inside a
 * theme; a concept whose prerequisites are not placed yet waits for a later round. Dates are consecutive: the first on
 * series.start, each next the day after the last. `from` (a later date) leaves a gap, allowed only with `allowGap` (the reason).
 * → { schedule, added: [{ id, date, order }], waiting: [{ id, reasons }], problems }
 */
export function planSchedule({ catalogue, config, approvals = null, schedule = null, from = null, allowGap = null, today }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || "")) throw new Error("planSchedule: today (YYYY-MM-DD) is required: the schedule never reads the clock, so the same inputs always give the same schedule");
  const sched = { $schema: schedule?.$schema ?? "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/concept-schedule.schema.json", series: config.series.id, entries: [...(schedule?.entries || [])], ...(schedule?.gaps?.length ? { gaps: [...schedule.gaps] } : {}) };
  const problems = [], by = new Map(catalogue.concepts.map((c) => [c.id, c])), placed = new Set(sched.entries.map((e) => e.id));
  const added = [], themes = config.order.themeOrder?.length ? config.order.themeOrder : catalogue.themes.map((t) => t.id);
  const idx = new Map(catalogue.concepts.map((c, i) => [c.id, i]));
  const pool = catalogue.concepts.filter((c) => !placed.has(c.id));
  const groups = config.order.strategy === "catalogue" ? [pool] : themes.map((t) => pool.filter((c) => c.theme === t).sort((a, b) => RANK[a.difficulty] - RANK[b.difficulty] || idx.get(a.id) - idx.get(b.id)));
  const ready = (c, pos) => (c.prerequisites || []).every((r) => placed.has(r)) && eligibility(c, config, approvals, { position: pos, catalogue }).ok;
  const take = (c) => { placed.add(c.id); added.push(c); for (const g of groups) { const i = g.indexOf(c); if (i >= 0) g.splice(i, 1); } };
  for (const id of config.order.first || []) { const c = by.get(id); if (c && !placed.has(id) && ready(c, sched.entries.length + added.length + 1)) take(c); }
  for (let progress = true; progress;) {
    progress = false;
    for (const g of groups) {
      const c = g.find((x) => ready(x, sched.entries.length + added.length + 1));
      if (c) { take(c); progress = true; }
    }
  }
  let date;
  const last = sched.entries[sched.entries.length - 1];
  if (!last) date = from ?? config.series.start;
  else {
    date = iso(day(last.date) + 1);
    if (from && day(from) > day(date)) {
      if (!allowGap) problems.push(`--from ${from} would leave ${day(from) - day(date)} day(s) with no episode after ${last.date}; pass --allow-gap "<reason>" to record the gap`);
      else { sched.gaps = [...(sched.gaps || []), { from: date, to: iso(day(from) - 1), reason: allowGap }]; date = from; }
    }
  }
  if (!last && date !== config.series.start) problems.push(`the first entry must be on the series start ${config.series.start} (got ${date})`);
  if (problems.length) return { schedule, added: [], waiting: [], problems };
  const assigned = today;
  for (const c of added) {
    sched.entries.push({ id: c.id, date, order: sched.entries.length + 1, sha256: approvalHash(config, catalogue, c), assigned_on: assigned });
    date = iso(day(date) + 1);
  }
  const waiting = catalogue.concepts.filter((c) => !placed.has(c.id)).map((c) => ({ id: c.id, reasons: [...(c.prerequisites || []).filter((r) => !placed.has(r)).map((r) => `prerequisite ${r} is not scheduled`), ...eligibility(c, config, approvals, { position: sched.entries.length + 1, catalogue }).reasons] }));
  return { schedule: sched, added: sched.entries.slice(sched.entries.length - added.length).map((e) => ({ id: e.id, date: e.date, order: e.order })), waiting, problems };
}

/** Counts, held concepts, what waits for approval or verification, and the runway after `today`. */
export function conceptStatus({ catalogue, config, schedule, approvals = null, today }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || "")) throw new Error("conceptStatus: today (YYYY-MM-DD) is required");
  const { items, held } = conceptItems({ catalogue, config, schedule, approvals });
  const placed = new Set((schedule?.entries || []).map((e) => e.id));
  const pending = catalogue.concepts.filter((c) => !placed.has(c.id)).map((c) => ({ id: c.id, ...eligibility(c, config, approvals, { catalogue }) }));
  const last = schedule?.entries?.length ? schedule.entries[schedule.entries.length - 1].date : null;
  const runway = last && today ? Math.max(0, day(last) - day(today)) : 0;
  const verified = catalogue.concepts.filter((c) => c.accuracy.status === "verified").length;
  const states = { approved: 0, unreviewed: 0, changed: 0, other: 0 };
  if (config.gate.review.mode === "shariah-ledger") for (const c of catalogue.concepts) { const s = reviewState(c, approvals, approvalHash(config, catalogue, c)).state; states[s in states ? s : "other"]++; }
  return { concepts: catalogue.concepts.length, verified, unverified: catalogue.concepts.length - verified, scheduled: (schedule?.entries || []).length, published: items.length, held, ready: pending.filter((x) => x.ok).length, waiting: pending.filter((x) => !x.ok), runway, runwayOk: runway >= config.runwayDays, last, review: states };
}

const NORM_MAP = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-", " ": " ", "­": "", "ﬁ": "fi", "ﬂ": "fl", "…": "..." };
/** A text reduced for comparing a quote with extracted document text: quotes and dashes unified, soft hyphens and every whitespace removed, case folded. */
export const squash = (t) => String(t).replace(/[‘’“”–—− ­ﬁﬂ…]/g, (c) => NORM_MAP[c]).replace(/\s+/g, "").toLowerCase();
/** Is `quote` a passage of `text` (the text of the document the source names)? */
export const quoteInText = (quote, text) => squash(text).includes(squash(quote));
