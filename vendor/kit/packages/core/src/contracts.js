/**
 * Content contracts: every item a series publishes is checked before it can be scheduled.
 *   checkTopic(item, ctx)  — { date, title, summary, tags, related?, article, talk }
 *   checkReport(item, ctx) — { month: "YYYY-MM", title, intro }
 *   checkTerm(term, ctx)   — { slug, term, en?, category, short, definition, related, talk }
 *   checkContent(config, content) — every series, plus uniqueness and cross references.
 * Limits come from the series' `contract` (defaults in DEFAULT_CONTRACTS). All return arrays of problem strings.
 */
import { unspeakable } from "@saasreport/speech";
import { DEFAULT_CONTRACTS, speechOptions } from "./config.js";
import { normalizeContent } from "./content.js";
import { isLocaleRoot, localesOf, configFor, contentFor } from "./locales.js";
import { parseMonthKey, jsWeekday, toDay, ymd, monthLength } from "./dates.js";

const str = (v) => typeof v === "string" && v.trim().length > 0;
const DEFAULT_SPEAKERS = ["host", "expert"];

function limitsOf(ctx, kind) {
  const c = ctx?.series?.contract;
  if (c === false) return null;
  return { ...DEFAULT_CONTRACTS[kind], ...(ctx?.contract || {}), ...(c || {}) };
}
const speakersOf = (ctx) => Object.keys(ctx?.config?.hosts || {}).length ? Object.keys(ctx.config.hosts) : DEFAULT_SPEAKERS;
const speechOf = (ctx) => (ctx?.config ? speechOptions(ctx.config) : { locale: ctx?.locale || "fa" });

/** Talk problems: [[speaker, text], …] (or {speaker, text}) alternating the first two speakers, lengths, speakability. */
export function checkTalk(talk, at, L, ctx) {
  const p = [];
  if (!Array.isArray(talk)) return [`${at}: talk must be an array of [speaker, text] lines`];
  const speakers = speakersOf(ctx);
  const [a, b] = speakers;
  const lines = talk.map((l) => (Array.isArray(l) ? l : [l?.speaker, l?.text]));
  if (lines.length < L.linesMin || lines.length > L.linesMax || (L.even && lines.length % 2)) p.push(`${at}: talk needs ${L.even ? "an even number of" : ""} ${L.linesMin}-${L.linesMax} lines (has ${lines.length})`.replace("  ", " "));
  let alternated = true;
  lines.forEach(([s, x], i) => {
    if (!speakers.includes(s)) p.push(`${at}: talk line ${i + 1} speaker "${s}" is not one of ${speakers.map((k) => `"${k}"`).join(", ")}`);
    if (alternated && b != null && s !== (i % 2 ? b : a)) { p.push(`${at}: talk must alternate "${a}", "${b}", starting with "${a}"`); alternated = false; }
    if (typeof x !== "string" || !x.trim() || x.length > L.lineMax) p.push(`${at}: talk line ${i + 1} empty or longer than ${L.lineMax}`);
    if (L.speakable && typeof x === "string") {
      const left = unspeakable(x, speechOf(ctx));
      if (left) p.push(`${at}: talk line ${i + 1} is not speakable: «${left.slice(0, 30)}»`);
    }
  });
  const chars = lines.reduce((s, [, x]) => s + (typeof x === "string" ? x.length : 0), 0);
  if (chars < L.talkMin || chars > L.talkMax) p.push(`${at}: talk is ${chars} chars (${L.talkMin}-${L.talkMax})`);
  return p;
}

/** True when `iso` is a publishing slot of the series (weekday for weekly, day of month for monthly). */
export function isSlot(config, series, iso) {
  let n; try { n = toDay(iso); } catch { return false; /* not a date: no slot falls on it */ }
  if (series?.every === "week") return jsWeekday(n) === series.on;
  if (series?.every === "month") {
    const { y, m, d } = ymd(config, n), len = monthLength(config, y, m);
    return series.on === -1 ? d === len : d === Math.min(series.on, len);
  }
  return true;
}

/** Problems with a topic's `sources`: [{ title, url }] with https URLs, at most 8 ([] when fine). */
export function checkSources(src, at = "?") {
  if (!Array.isArray(src)) return [`${at}: sources must be an array of { title, url }`];
  const p = [];
  if (src.length > 8) p.push(`${at}: at most 8 sources`);
  src.forEach((x, i) => {
    if (!str(x?.title) || /[\[\]]/.test(x.title)) p.push(`${at}: source ${i + 1} needs a title (no square brackets)`);
    let u = null;
    try { u = new URL(x?.url); } catch { /* not a URL: u stays null and is reported below */ }
    if (!u || u.protocol !== "https:" || /[\s()]/.test(x.url)) p.push(`${at}: source ${i + 1} url must be an https URL (no spaces or parentheses)`);
  });
  return p;
}

/** Problems with one topic ([] when it is fine). ctx: { config, series }. */
export function checkTopic(w, ctx = {}) {
  const at = `${ctx.series?.id ? ctx.series.id + " " : ""}${w?.date || "?"}`;
  const L = limitsOf(ctx, "topic");
  const p = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w?.date || "") || Number.isNaN(Date.parse(`${w.date}T00:00:00Z`))) p.push(`${at}: date must be an ISO date (YYYY-MM-DD)`);
  else if (ctx.series && ctx.config && !isSlot(ctx.config, ctx.series, w.date)) p.push(`${at}: date is not a publishing slot of series "${ctx.series.id}"`);
  for (const k of ["title", "summary", "article"]) if (!str(w?.[k])) p.push(`${at}: missing ${k}`);
  if (!L) return p;
  if (w?.tags != null && !Array.isArray(w.tags)) p.push(`${at}: tags must be a list of tag ids`);
  else if (L.tagsMin > 0 && (w?.tags?.length ?? 0) < L.tagsMin) p.push(`${at}: needs at least ${L.tagsMin} tag${L.tagsMin === 1 ? "" : "s"}`);
  if (w?.title?.length > L.titleMax) p.push(`${at}: title longer than ${L.titleMax}`);
  if (w?.summary?.length > L.summaryMax) p.push(`${at}: summary longer than ${L.summaryMax}`);
  const a = w?.article?.length || 0;
  if (a < L.articleMin || a > L.articleMax) p.push(`${at}: article is ${a} chars (${L.articleMin}-${L.articleMax})`);
  if (/https?:|```|<[a-z]/i.test(w?.article || "")) p.push(`${at}: article must not contain raw URLs, code or HTML`);
  if (w?.related != null && typeof w.related !== "string" && !Array.isArray(w.related)) p.push(`${at}: related must be a slug or an array of slugs`);
  if (w?.sources != null) p.push(...checkSources(w.sources, at));
  if (w?.talk != null || ctx.series?.podcast) p.push(...checkTalk(w?.talk || [], at, L, ctx));
  return p;
}

/** Problems with one report theme ([] when it is fine). */
export function checkReport(r, ctx = {}) {
  const at = `${ctx.series?.id ? ctx.series.id + " " : ""}${r?.month || "?"}`;
  const L = limitsOf(ctx, "report");
  const p = [];
  if (!parseMonthKey(r?.month)) p.push(`${at}: month must be "YYYY-MM" in the site's calendar system`);
  for (const k of ["title", "intro"]) if (!str(r?.[k])) p.push(`${at}: missing ${k}`);
  if (!L) return p;
  if (r?.title?.length > L.titleMax) p.push(`${at}: title longer than ${L.titleMax}`);
  const n = r?.intro?.length || 0;
  if (str(r?.intro) && (n < L.introMin || n > L.introMax)) p.push(`${at}: intro is ${n} chars (${L.introMin}-${L.introMax})`);
  return p;
}

/** Problems with one glossary term ([] when it is fine). ctx: { config, series, categories }. */
export function checkTerm(t, ctx = {}) {
  const at = `${ctx.series?.id ? ctx.series.id + " " : ""}${t?.slug || "?"}`;
  const L = limitsOf(ctx, "term");
  const p = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t?.slug || "") || t.slug.length > 60) p.push(`${at}: slug must be lowercase latin words joined by - (at most 60)`);
  for (const k of ["term", "short", "definition"]) if (!str(t?.[k])) p.push(`${at}: missing ${k}`);
  if (t?.en != null && typeof t.en !== "string") p.push(`${at}: en must be a string`);
  if (ctx.categories && !ctx.categories.some((c) => c.key === t?.category)) p.push(`${at}: category "${t?.category}" is not defined`);
  if (!L) return p;
  if (L.requireEn && !str(t?.en)) p.push(`${at}: missing en`);
  if (t?.term?.length > L.termMax) p.push(`${at}: term longer than ${L.termMax}`);
  if (t?.short?.length > L.shortMax) p.push(`${at}: short longer than ${L.shortMax}`);
  const d = t?.definition?.length || 0;
  if (d < L.defMin || d > L.defMax) p.push(`${at}: definition is ${d} chars (${L.defMin}-${L.defMax})`);
  if (L.noFigures) {
    const allowed = L.allowedFigures ? new RegExp(L.allowedFigures, "g") : null;
    const FIG = /[0-9۰-۹٪%]/;
    for (const k of ["definition", "short"]) {
      let text = String(t?.[k] || "").replace(/\]\(\/[^)]*\)/g, "]()");
      if (allowed) text = text.replace(allowed, "");
      if (FIG.test(text)) p.push(`${at}: ${k} contains a figure («${text.match(FIG)[0]}»); definitions carry no numbers`);
    }
  }
  if (/https?:|```|<[a-z]|^#/im.test(t?.definition || "")) p.push(`${at}: definition must not contain URLs, code, HTML or headings`);
  if (!Array.isArray(t?.related) || t.related.length > L.relatedMax) p.push(`${at}: related must be an array of up to ${L.relatedMax} slugs`);
  if (t?.talk != null || ctx.series?.podcast) p.push(...checkTalk(t?.talk || [], at, L, ctx));
  return p;
}

/** Every problem across the content pack: items, duplicates, cross references ([] when all is fine). */
export function checkContent(config, content) {
  // A multi-locale site: every locale's pack against that locale's config (speech, hosts, limits), problems prefixed "[ar] ".
  if (isLocaleRoot(config)) return localesOf(config).flatMap((l) => checkContent(configFor(config, l), contentFor(config, content, l)).map((x) => `[${l}] ${x}`));
  const norm = normalizeContent(config, content);
  const p = [];
  for (const series of config.series) {
    const c = norm[series.id];
    if (!c) { p.push(`${series.id}: no content (content.${series.id} is missing)`); continue; }
    const ctx = { config, series, categories: c.categories };
    if (series.kind === "topic") {
      const seen = new Set();
      for (const w of c.items) { p.push(...checkTopic(w, ctx)); if (seen.has(w?.date)) p.push(`${series.id} ${w?.date}: two topics for the same date`); seen.add(w?.date); }
    } else if (series.kind === "report") {
      const seen = new Set();
      for (const r of c.items) { p.push(...checkReport(r, ctx)); if (seen.has(r?.month)) p.push(`${series.id} ${r?.month}: two themes for the same month`); seen.add(r?.month); }
    } else {
      if (!c.categories.length) p.push(`${series.id}: a term series needs categories: [{ key, name }]`);
      const keys = new Set();
      for (const cat of c.categories) {
        if (!str(cat?.key) || !str(cat?.name)) p.push(`${series.id}: every category needs a key and a name`);
        if (keys.has(cat?.key)) p.push(`${series.id}: duplicate category "${cat?.key}"`);
        keys.add(cat?.key);
      }
      const slugs = new Set(), names = new Set();
      for (const t of c.items) {
        p.push(...checkTerm(t, ctx));
        if (slugs.has(t?.slug)) p.push(`${series.id} ${t?.slug}: duplicate slug`);
        slugs.add(t?.slug);
        if (names.has(t?.term)) p.push(`${series.id} ${t?.slug}: duplicate term «${t?.term}»`);
        names.add(t?.term);
      }
      for (const t of c.items) for (const r of Array.isArray(t?.related) ? t.related : []) if (!slugs.has(r)) p.push(`${series.id} ${t.slug}: related «${r}» is not in the glossary`);
    }
  }
  return p;
}
