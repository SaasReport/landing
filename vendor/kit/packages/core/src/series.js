/**
 * Editorial series tooling: topic series written as a season of dated episodes, each with a formal article (the blog
 * post) and a spoken talk (the podcast), optionally gated by review. Generic and config-driven:
 *
 *   const tools = seriesTools({ config, speakers: { n: "host", k: "expert" } });   // or { officialDomains, speech, limits }
 *   tools.checkSeries(items, "wed")   tools.publishable(def)   tools.contentItems(def)   kit series: { end: endOf(def), slug: slugFor(def) }
 *
 * A series definition: { id, weekday ("sun" … "sat"), start (ISO), items, requireReview?, autoPublishCited? }.
 * An item: { date (on the weekday), slug, title, summary, tags[], article, talk: [[speakerKey, line], …],
 *            sources?: [{ title, url, archived? }], citations?: […] (citations.js), review?: { status: "draft" | "reviewed", by?, on? } }
 *
 * The review gate: with `requireReview`, only items whose review.status is "reviewed" publish; with `autoPublishCited` as
 * well, an item whose sources are all official (config `sources.official`) and each backed by a verified citation
 * publishes without that review. Drafts stay out of the content pack, so their dates are skipped (draftDates).
 */
import { unspeakable } from "@saasreport/speech";
import { DEFAULT_CONTRACTS, speechOptions } from "./config.js";
import { checkCitations, officiallyCited, officialDomains, originalUrl, hasOfficialHost } from "./citations.js";

const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DIGIT_SCRIPTS = { fa: ["[۰-۹]", "Persian"], ar: ["[٠-٩]", "Arabic-Indic"] };
const langOf = (l) => String(l || "").toLowerCase().split(/[-_]/)[0];

/** Resolved options: speech { locale, terms }, speakers { contentKey: hostKey }, limits, officialDomains, middle-dot rule. */
function resolve(opts = {}) {
  const config = opts.config;
  const speech = opts.speech ?? (config ? speechOptions(config) : { locale: "en" });
  const hostKeys = Object.keys(config?.hosts || {});
  const speakers = opts.speakers ?? (hostKeys.length >= 2 ? { [hostKeys[0]]: hostKeys[0], [hostKeys[1]]: hostKeys[1] } : { host: "host", expert: "expert" });
  const limits = { ...DEFAULT_CONTRACTS.topic, ...(opts.limits || {}) };
  const script = DIGIT_SCRIPTS[langOf(speech.locale)];
  // «·» next to RTL digits breaks the bidi order: checked for fa and ar unless middleDot: false.
  const middleDot = opts.middleDot === false || !script ? null : { re: new RegExp(`[·]${script[0]}|${script[0]}[·]`), name: script[1] };
  return { speech, speakers, keys: Object.keys(speakers), limits, domains: opts.officialDomains ?? officialDomains(config), middleDot };
}

/** Problems with one item of a series published on `weekday` ("sun" … "sat"). */
export function checkEpisode(x, weekday, opts = {}) {
  const o = opts.__resolved ? opts : resolve(opts), L = o.limits, [a, b] = o.keys;
  const p = [], at = x?.slug || x?.date || "?";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x?.date || "") || new Date(`${x.date}T00:00:00Z`).getUTCDay() !== WEEKDAY[weekday]) p.push(`${at}: date must be a ${weekday} (YYYY-MM-DD)`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x?.slug || "")) p.push(`${at}: slug must be latin kebab-case`);
  for (const k of ["title", "summary", "article"]) if (typeof x?.[k] !== "string" || !x[k].trim()) p.push(`${at}: missing ${k}`);
  if (!Array.isArray(x?.tags) || !x.tags.length) p.push(`${at}: missing tags`);
  if (x?.title?.length > L.titleMax) p.push(`${at}: title longer than ${L.titleMax}`);
  if (x?.summary?.length > L.summaryMax) p.push(`${at}: summary longer than ${L.summaryMax}`);
  const len = x?.article?.length || 0;
  if (len < L.articleMin || len > L.articleMax) p.push(`${at}: article is ${len} chars (${L.articleMin}-${L.articleMax})`);
  if (/https?:|```|<[a-z]/i.test(x?.article || "")) p.push(`${at}: article must not contain raw URLs, code or HTML (put links in sources)`);
  if (o.middleDot && o.middleDot.re.test(`${x?.title}${x?.summary}${x?.article}`)) p.push(`${at}: no «·» next to ${o.middleDot.name} digits`);
  const talk = x?.talk || [];
  if (talk.length < L.linesMin || talk.length > L.linesMax || talk.length % 2) p.push(`${at}: talk needs an even number of lines, ${L.linesMin}-${L.linesMax}`);
  talk.forEach(([s, t], i) => {
    if (s !== (i % 2 ? b : a)) p.push(`${at}: talk must alternate "${a}"/"${b}", starting with "${a}"`);
    if (typeof t !== "string" || !t.trim() || t.length > L.lineMax) p.push(`${at}: talk line ${i + 1} empty or longer than ${L.lineMax}`);
    const left = unspeakable(t || "", o.speech);
    if (left) p.push(`${at}: talk line ${i + 1} is not speakable: «${left.slice(0, 30)}»`);
  });
  const chars = talk.reduce((s, [, t]) => s + (t?.length || 0), 0);
  if (chars < L.talkMin || chars > L.talkMax) p.push(`${at}: talk is ${chars} chars (${L.talkMin}-${L.talkMax})`);
  for (const s of x?.sources || []) if (!s?.title || !/^https:\/\//.test(s?.url || "")) p.push(`${at}: every source needs a title and an https url`);
  if (x?.review && !["draft", "reviewed"].includes(x.review.status)) p.push(`${at}: review.status must be draft or reviewed`);
  return p;
}

/** Problems with a whole series: every item valid, dates exactly one week apart, slugs unique. */
export function checkSeason(items, weekday, opts = {}) {
  const o = opts.__resolved ? opts : { ...resolve(opts), __resolved: true };
  const p = items.flatMap((x) => checkEpisode(x, weekday, o));
  const slugs = new Set();
  items.forEach((x, i) => {
    if (slugs.has(x.slug)) p.push(`${x.slug}: duplicate slug`); slugs.add(x.slug);
    if (i && (new Date(x.date) - new Date(items[i - 1].date)) / 864e5 !== 7) p.push(`${x.slug}: dates must be consecutive weeks`);
  });
  return p;
}

/** Last scheduled date of a series (its season ends there; an empty series ends the day before it starts). */
export const endOf = (s) => (s.items.length ? s.items[s.items.length - 1].date : new Date(Date.parse(s.start) - 864e5).toISOString().slice(0, 10));

/** Kit slug for a date: the item's own slug (readable URLs), falling back to "<id>-<date>". */
export const slugFor = (s) => ({ date }) => s.items.find((x) => x.date === date)?.slug || `${s.id}-${date}`;

/** Reviewed by a person, or (autoPublishCited) official sources each backed by a verified citation. */
export const approved = (s, x, domains = []) => x.review?.status === "reviewed" || (s.autoPublishCited === true && officiallyCited(x, domains));

/** The items a series may publish (review gate applied). */
export const publishable = (s, domains = []) => s.items.filter((x) => !s.requireReview || approved(s, x, domains));

/** Dates a review-gated series skips on purpose (items still in draft). */
export const draftDates = (s, domains = []) => (s.requireReview ? s.items.filter((x) => !approved(s, x, domains)).map((x) => x.date) : []);

/** The content-pack shape the kit reads for a topic series (review gate applied, talk speakers mapped to host keys). */
export const contentItems = (s, { domains = [], speakers = null } = {}) => publishable(s, domains).map(({ date, slug, title, summary, tags, article, talk, sources }) => ({
  date, slug, title, summary, tags, sources,
  article,
  talk: talk.map(([k, t]) => [speakers?.[k] ?? k, t]),
}));

/** Problems across series definitions ([] when fine): each season and its citations, prefixed with the series id. */
export const checkSeries = (defs, opts = {}) => {
  const o = { ...resolve(opts), __resolved: true };
  return defs.flatMap((s) => [...checkSeason(s.items, s.weekday, o), ...s.items.flatMap(checkCitations)].map((m) => `${s.id}: ${m}`));
};

/**
 * Every helper bound to one project's options: { config? (kit config: speech, hosts, sources.official), speech?, speakers?
 * ({ contentKey: hostKey }, the first two in order are who opens and who answers), limits?, officialDomains?, middleDot? }.
 */
export function seriesTools(opts = {}) {
  const o = { ...resolve(opts), __resolved: true };
  return {
    options: o,
    checkItem: (x, weekday) => checkEpisode(x, weekday, o),
    checkSeries: (items, weekday) => checkSeason(items, weekday, o),
    checkAll: (defs) => checkSeries(defs, o),
    endOf, slugFor,
    approved: (s, x) => approved(s, x, o.domains),
    publishable: (s) => publishable(s, o.domains),
    draftDates: (s) => draftDates(s, o.domains),
    contentItems: (s) => contentItems(s, { domains: o.domains, speakers: o.speakers }),
    OFFICIAL_DOMAINS: o.domains, originalUrl, checkCitations,
    hasOfficialHost: (u) => hasOfficialHost(u, o.domains),
    officiallyCited: (x) => officiallyCited(x, o.domains),
  };
}
