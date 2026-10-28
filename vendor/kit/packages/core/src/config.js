/**
 * defineConfig(cfg) → normalized config with defaults filled in. Throws KitConfigError listing every problem.
 * The shape is documented in docs/ARCHITECTURE.md; see README.md for the defaults.
 */
import { dirFor, lang } from "./i18n.js";
import { weekdayIndex } from "./dates.js";
import { rawLocales, rawForLocale } from "./locales.js";
import { resolveCalendarConfig } from "@saasreport/calendar/config";
import { MARKET_IDS, market, weekendOf } from "@saasreport/calendar/markets";

export class KitConfigError extends Error {
  constructor(problems) {
    super(`Invalid kit config (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "KitConfigError";
    this.problems = problems;
  }
}

export const KINDS = ["topic", "report", "term"];
export const EVERY = ["day", "week", "month"];
export const FEATURES = ["blog", "podcasts", "glossary", "events", "reactions", "share", "calendar", "feeds", "monitor", "llms", "sitemap", "tags"];
export const TOP_KEYS = ["site", "brand", "calendar", "hosts", "tts", "speech", "series", "shows", "channels", "features", "monitor", "strings", "paths", "contracts", "sources"];
export const DEFAULT_PATHS = { blog: "/blog/", podcasts: "/podcasts/", glossary: "/glossary/", events: "/events/", calendar: "/calendar/", status: "/status/" };

/** Default contract limits per kind (the values the first consumer ships with). Override per series with `contract: {…}`. */
export const DEFAULT_CONTRACTS = {
  topic: { titleMax: 90, summaryMax: 200, articleMin: 700, articleMax: 1800, talkMin: 800, talkMax: 1050, lineMax: 190, linesMin: 6, linesMax: 10, even: true, tagsMin: 1, speakable: true },
  report: { titleMax: 120, introMin: 150, introMax: 1200 },
  term: { termMax: 60, shortMax: 150, defMin: 250, defMax: 750, talkMin: 420, talkMax: 620, lineMax: 170, linesMin: 4, linesMax: 6, even: true, relatedMax: 5,
    noFigures: true, allowedFigures: "T\\+(\\d+|n)|ISO \\d+", requireEn: false, speakable: true },
};

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; /* Intl refuses it: not a valid time zone */ } };
const validLocale = (l) => { try { return Intl.getCanonicalLocales(l).length === 1; } catch { return false; /* Intl refuses it: not a valid locale tag */ } };
const isISODate = (s) => { const t = Date.parse(`${s}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROFILE_WEEKENDS = { bank: [5], government: [4, 5], market: [4, 5] }; // JS weekdays: 4 = Thursday, 5 = Friday

/** Normalize and validate a kit config. Idempotent. A config with `site.locales` (two or more) is multi-locale (locales.js). */
export function defineConfig(cfg = {}) {
  if (cfg && cfg.__normalized) return cfg;
  if (isObj(cfg) && isObj(cfg.site) && cfg.site.locales != null) return defineMultiLocale(cfg);
  return defineOne(cfg);
}

/**
 * Multi-locale: every locale is validated as its own single-locale config (problems prefixed with "[ar] ");
 * the result is the default locale's config plus site.locales / defaultLocale, the others behind configFor().
 */
function defineMultiLocale(cfg) {
  const list = cfg.site.locales;
  const P = [];
  if (!Array.isArray(list) || !list.length || !list.every((l) => typeof l === "string" && validLocale(l))) P.push(`site.locales must be an array of BCP-47 locale codes, the default first (got ${JSON.stringify(list)})`);
  else if (new Set(list.map((l) => l.toLowerCase())).size !== list.length) P.push("site.locales has a locale twice");
  if (P.length) throw new KitConfigError(P);
  if (list.length === 1) { const { locales: _one, ...site } = cfg.site; return defineOne({ ...cfg, site }); } // one locale = a single-locale site
  const configs = {};
  for (const l of rawLocales(cfg)) {
    try { configs[l] = defineOne(rawForLocale(cfg, l)); }
    catch (e) { if (e instanceof KitConfigError) P.push(...e.problems.map((p) => `[${l}] ${p}`)); else throw e; }
  }
  if (P.length) throw new KitConfigError(P);
  // The root reads as the default locale's config; configFor() hands out each locale's own (the default's included).
  const out = { ...configs[list[0]] };
  Object.defineProperty(out, "__normalized", { value: true });
  Object.defineProperty(out, "__locales", { value: configs });
  return out;
}

function defineOne(cfg) {
  const P = [];
  if (!isObj(cfg)) throw new KitConfigError(["config must be an object"]);
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) P.push(`unknown top-level key "${k}" (expected one of ${TOP_KEYS.join(", ")})`);

  /* site */
  const s = isObj(cfg.site) ? cfg.site : (P.push("site is required ({ name, url, locale, timezone, … })"), {});
  if (typeof s.name !== "string" || !s.name.trim()) P.push("site.name is required");
  let url = typeof s.url === "string" ? s.url.replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^/\s]+/.test(url)) P.push(`site.url must be an absolute http(s) URL (got ${JSON.stringify(s.url)})`);
  const locale = s.locale || "en-US";
  if (!validLocale(locale)) P.push(`site.locale is not a valid BCP-47 locale: ${JSON.stringify(s.locale)}`);
  const L = validLocale(locale) ? lang(locale) : "en";
  const dir = s.dir || dirFor(locale);
  if (!["rtl", "ltr"].includes(dir)) P.push(`site.dir must be "rtl" or "ltr" (got ${JSON.stringify(s.dir)})`);
  const timezone = s.timezone || (L === "fa" ? "Asia/Tehran" : "UTC");
  if (!validTz(timezone)) P.push(`site.timezone is not a valid IANA time zone: ${JSON.stringify(s.timezone)}`);
  const org = isObj(s.org) ? s.org : {};
  if (s.org != null && !isObj(s.org)) P.push("site.org must be an object");
  if (org.sameAs != null && !Array.isArray(org.sameAs)) P.push("site.org.sameAs must be an array of URLs");
  const site = {
    description: "", logo: null, ogImage: null, ...s, url, locale, dir, timezone,
    org: { name: s.name, url: s.root || url, logo: s.logo || null, ...org, sameAs: Array.isArray(org.sameAs) ? org.sameAs : [] },
  };

  /* calendar */
  const c = cfg.calendar == null ? {} : isObj(cfg.calendar) ? cfg.calendar : (P.push("calendar must be an object"), {});
  // The calendar shape of @saasreport/calendar/config ({ systems, primary, profiles: [market ids], digits }): marketCalendar();
  // otherwise the original shape ({ system, weekend, holidays, profiles: { key: weekend } }), unchanged.
  let calendar;
  if (c.systems != null || Array.isArray(c.profiles)) calendar = marketCalendar(c, L, P);
  else {
    const system = c.system || (L === "fa" ? "jalali" : "gregorian");
    if (!["jalali", "gregorian"].includes(system)) P.push(`calendar.system must be "jalali" or "gregorian" (got ${JSON.stringify(c.system)})`);
    const jalali = system === "jalali";
    const holidays = c.holidays ?? (jalali ? "iran" : "none");
    if (!["iran", "none"].includes(holidays)) P.push(`calendar.holidays must be "iran" or "none" (got ${JSON.stringify(c.holidays)})`);
    const weekDays = (w, where) => {
      if (typeof w === "string") { if (PROFILE_WEEKENDS[w]) return PROFILE_WEEKENDS[w]; P.push(`${where} must be "bank", "government", "market" or an array of weekday numbers 0-6 (0 = Sunday)`); return [5]; }
      if (Array.isArray(w) && w.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return [...new Set(w)];
      P.push(`${where} must be "bank", "government", "market" or an array of weekday numbers 0-6 (0 = Sunday)`); return [5];
    };
    const weekendIn = c.weekend ?? (jalali ? "bank" : [0, 6]);
    const weekend = weekDays(weekendIn, "calendar.weekend");
    const profilesIn = c.profiles ?? (holidays === "iran" ? { bank: "bank", government: "government", market: "market" } : { business: weekend });
    const profiles = {};
    if (!isObj(profilesIn)) P.push("calendar.profiles must be an object { key: weekend | { weekend, label } }");
    else for (const [k, v] of Object.entries(profilesIn)) {
      const w = isObj(v) ? v.weekend : v;
      profiles[k] = { key: k, weekend: weekDays(w, `calendar.profiles.${k}`), label: isObj(v) ? v.label : undefined };
    }
    const settlement = c.settlement ?? 1;
    if (!(Number.isInteger(settlement) && settlement >= 0 && settlement <= 10)) P.push("calendar.settlement must be an integer 0-10 (0 hides the T+n column)");
    calendar = { ...c, system, weekend, weekendName: typeof weekendIn === "string" ? weekendIn : null, holidays, profiles, settlement, ahead: c.ahead ?? 30 };
  }
  const jalali = calendar.system === "jalali";

  /* hosts */
  const hostsIn = cfg.hosts ?? { host: { name: L === "fa" ? "میزبان" : "Host", role: "host" }, expert: { name: L === "fa" ? "کارشناس" : "Expert", role: "expert" } };
  if (!isObj(hostsIn) || !Object.keys(hostsIn).length) P.push("hosts must be an object of speakers, e.g. { host: { name, role, voice }, expert: {…} }");
  const hosts = {};
  for (const [k, h] of Object.entries(isObj(hostsIn) ? hostsIn : {})) {
    if (!isObj(h) || typeof h.name !== "string" || !h.name.trim()) P.push(`hosts.${k}.name is required`);
    hosts[k] = { role: "", voice: null, ...(isObj(h) ? h : {}) };
  }

  /* shows */
  const showsIn = cfg.shows ?? {};
  const shows = {};
  if (!isObj(showsIn)) P.push("shows must be an object { key: { title, description, feed, cover, category } }");
  else for (const [k, sh] of Object.entries(showsIn)) {
    if (!isObj(sh)) { P.push(`shows.${k} must be an object`); continue; }
    if (typeof sh.title !== "string" || !sh.title.trim()) P.push(`shows.${k}.title is required`);
    const feed = sh.feed ?? (k === Object.keys(showsIn)[0] ? "/podcasts/feed.xml" : `/podcasts/${k}/feed.xml`);
    if (typeof feed !== "string" || !feed.startsWith("/")) P.push(`shows.${k}.feed must be a site path starting with "/"`);
    shows[k] = { key: k, description: "", cover: site.logo, category: "Business", language: locale, author: site.org.name, explicit: false, type: "episodic", ...sh, feed };
  }

  /* series */
  const series = [];
  const ids = new Set();
  if (!Array.isArray(cfg.series ?? [])) P.push("series must be an array");
  for (const [i, x] of (Array.isArray(cfg.series) ? cfg.series : []).entries()) {
    const at = `series[${i}]${x?.id ? ` (${x.id})` : ""}`;
    if (!isObj(x)) { P.push(`${at} must be an object`); continue; }
    if (typeof x.id !== "string" || !SLUG.test(x.id)) P.push(`${at}.id must be a lowercase slug (a-z, 0-9, -)`);
    else if (ids.has(x.id)) P.push(`${at}.id "${x.id}" is used twice`);
    ids.add(x.id);
    if (!KINDS.includes(x.kind)) P.push(`${at}.kind must be one of ${KINDS.join(", ")} (got ${JSON.stringify(x.kind)})`);
    const every = x.every ?? (x.kind === "term" ? "day" : x.kind === "report" ? "month" : "week");
    if (!EVERY.includes(every)) P.push(`${at}.every must be one of ${EVERY.join(", ")} (got ${JSON.stringify(x.every)})`);
    let on = x.on;
    if (every === "week") {
      on = weekdayIndex(x.on ?? (jalali ? "sat" : "mon"));
      if (on < 0) P.push(`${at}.on must be a weekday ("sat", "sun", … or 0-6 with 0 = Sunday) for a weekly series`);
    } else if (every === "month") {
      on = x.on ?? 1;
      if (!(Number.isInteger(on) && ((on >= 1 && on <= 31) || on === -1))) P.push(`${at}.on must be a day of the month 1-31 (or -1 for the last day) for a monthly series`);
    } else if (x.on != null) P.push(`${at}.on is only for weekly and monthly series`);
    const time = x.at ?? "06:00";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) P.push(`${at}.at must be a local time "HH:MM" (got ${JSON.stringify(x.at)})`);
    for (const k of ["start", "end"]) if (x[k] != null && !isISODate(x[k])) P.push(`${at}.${k} must be an ISO date YYYY-MM-DD (got ${JSON.stringify(x[k])})`);
    if (x.start && x.end && x.end < x.start) P.push(`${at}.end is before start`);
    const rotation = x.kind === "term" ? x.rotation ?? "round-robin" : x.rotation ?? null;
    if (x.kind === "term") {
      if (!["round-robin", "sequential"].includes(rotation)) P.push(`${at}.rotation must be "round-robin" or "sequential"`);
      if (!x.start) P.push(`${at}.start is required for a term series (day 1 of the rotation)`);
    } else if (rotation != null) P.push(`${at}.rotation is only for term series`);
    if (x.source != null && typeof x.source !== "function" && !isObj(x.source) && !Array.isArray(x.source)) P.push(`${at}.source must be a function returning the content module (e.g. () => import("./content/x.js")), or the content itself`);
    let podcast = x.podcast ?? false;
    if (podcast) {
      if (!isObj(podcast)) { P.push(`${at}.podcast must be false or { show, maxSeconds }`); podcast = false; }
      else {
        if (!shows[podcast.show]) P.push(`${at}.podcast.show "${podcast.show}" is not defined in shows`);
        if (podcast.maxSeconds != null && !(podcast.maxSeconds > 0)) P.push(`${at}.podcast.maxSeconds must be a positive number`);
        if (podcast.cps != null && !(podcast.cps > 0)) P.push(`${at}.podcast.cps must be a positive number (characters per second measured for this series; default: speech.cps)`);
        if (podcast.strings != null && !isObj(podcast.strings)) P.push(`${at}.podcast.strings must be an object (the spoken strings of this series, merged over strings.podcast)`);
        podcast = { maxSeconds: every === "day" ? 80 : 150, marginSeconds: 10, ...podcast };
      }
    }
    if (x.contract != null && x.contract !== false && !isObj(x.contract)) P.push(`${at}.contract must be an object of limits or false`);
    if (x.slug != null && typeof x.slug !== "string" && typeof x.slug !== "function") P.push(`${at}.slug must be a template string like "week-{date}" or a function`);
    const empty = x.empty ?? (x.kind === "report" ? "tables" : "skip");
    if (!["skip", "tables"].includes(empty)) P.push(`${at}.empty must be "skip" or "tables"`);
    const tables = x.tables ?? (every === "week" ? "week" : every === "month" && x.kind === "report" ? "month" : false);
    if (![false, "week", "month"].includes(tables)) P.push(`${at}.tables must be false, "week" or "month"`);
    series.push({
      title: x.id, post: x.kind !== "term", glossary: x.kind === "term",
      ...x, every, on, at: time, rotation, podcast, empty, tables,
      slug: x.slug ?? (x.kind === "topic" ? "{id}-{date}" : x.kind === "report" ? "{id}-{month}" : "{id}-{slug}"),
      // a series that names tags (docs/TAGS.md) lets its items inherit them: an item need not name its own, unless the contract says so
      contract: x.contract === false ? false : { ...DEFAULT_CONTRACTS[x.kind], ...(Array.isArray(x.tags) && x.tags.length && DEFAULT_CONTRACTS[x.kind]?.tagsMin != null ? { tagsMin: 0 } : {}), ...(cfg.contracts?.[x.kind] || {}), ...(x.contract || {}) },
    });
  }

  /* features, monitor, channels, misc */
  const features = Object.fromEntries(FEATURES.map((f) => [f, true]));
  if (cfg.features != null) {
    if (!isObj(cfg.features)) P.push("features must be an object of booleans");
    else for (const [k, v] of Object.entries(cfg.features)) {
      if (!FEATURES.includes(k)) P.push(`features.${k} is unknown (expected ${FEATURES.join(", ")})`);
      else if (typeof v !== "boolean") P.push(`features.${k} must be true or false`);
      else features[k] = v;
    }
  }
  const monitor = { at: "06:15", journeys: [], ...(isObj(cfg.monitor) ? cfg.monitor : {}) };
  if (cfg.monitor != null && !isObj(cfg.monitor)) P.push("monitor must be an object");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(monitor.at)) P.push(`monitor.at must be "HH:MM"`);
  if (!Array.isArray(monitor.journeys)) P.push("monitor.journeys must be an array");
  if (cfg.strings != null && !isObj(cfg.strings)) P.push("strings must be an object of UI strings");
  if (cfg.channels != null && !isObj(cfg.channels)) P.push("channels must be an object");
  if (cfg.paths != null && !isObj(cfg.paths)) P.push("paths must be an object");
  const speech = { locale: locale, terms: [], defaults: true, cps: 11, ...(isObj(cfg.speech) ? cfg.speech : {}) };
  if (cfg.speech != null && !isObj(cfg.speech)) P.push("speech must be an object { terms, defaults, cps }");
  if (!(speech.cps > 0)) P.push("speech.cps must be a positive number (characters per second)");

  // sources.official: the domains whose publications count as official (series review gate, citations.js).
  const sources = { official: [], ...(isObj(cfg.sources) ? cfg.sources : {}) };
  if (cfg.sources != null && !isObj(cfg.sources)) P.push("sources must be an object { official: [domains] }");
  else if (!Array.isArray(sources.official) || !sources.official.every((d) => typeof d === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) P.push("sources.official must be an array of domain names (e.g. \"regulator.example\")");

  if (P.length) throw new KitConfigError(P);
  const out = {
    site, calendar, hosts, shows, series, features, monitor, speech, ...(cfg.sources != null ? { sources } : {}),
    brand: { colors: {}, fonts: {}, ...(isObj(cfg.brand) ? cfg.brand : {}) },
    tts: isObj(cfg.tts) ? { ...cfg.tts } : { provider: null },
    channels: isObj(cfg.channels) ? { ...cfg.channels } : {},
    strings: isObj(cfg.strings) ? { ...cfg.strings } : {},
    paths: { ...DEFAULT_PATHS, ...(isObj(cfg.paths) ? cfg.paths : {}) },
  };
  Object.defineProperty(out, "__normalized", { value: true });
  return out;
}

const LATEST = 1e6; // a day number far ahead: a market's current (latest) weekend rule

/**
 * The market calendar shape: resolveCalendarConfig (@saasreport/calendar/config) validates systems, primary, profiles and digits,
 * and its fields are merged in (the market ids as `markets`, the first as `profile`). The fields the reports and the Worker
 * read keep their meaning: `system` (whose months: jalali when it is the primary system, else gregorian), `weekend` (config,
 * else the first market's current weekend), `holidays` ("iran" with the ir market), `profiles` ({ id: { key, weekend, label } }
 * per market, for the business-day counts of the reports).
 */
function marketCalendar(c, L, P) {
  const r = resolveCalendarConfig(c, { locale: L });
  P.push(...r.problems);
  const known = r.profiles.filter((id) => MARKET_IDS.includes(id));
  let weekend = c.weekend ?? (known[0] ? [...weekendOf(known[0], LATEST)] : [0, 6]);
  if (typeof weekend === "string" && PROFILE_WEEKENDS[weekend]) weekend = PROFILE_WEEKENDS[weekend];
  if (!(Array.isArray(weekend) && weekend.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) { P.push("calendar.weekend must be an array of weekday numbers 0-6 (0 = Sunday)"); weekend = [0, 6]; }
  const holidays = c.holidays ?? (known.includes("ir") ? "iran" : "none");
  if (!["iran", "none"].includes(holidays)) P.push(`calendar.holidays must be "iran" or "none" (got ${JSON.stringify(c.holidays)})`);
  const profiles = {};
  for (const id of known) { const m = market(id); profiles[id] = { key: id, weekend: [...weekendOf(id, LATEST)], label: m.name?.[L] || m.name?.en || id }; }
  if (!known.length) profiles.business = { key: "business", weekend, label: undefined };
  const settlement = c.settlement ?? 1;
  if (!(Number.isInteger(settlement) && settlement >= 0 && settlement <= 10)) P.push("calendar.settlement must be an integer 0-10 (0 hides the T+n column)");
  const { profiles: _ids, ...rest } = c;
  return { ...rest, systems: r.systems, primary: r.primary, secondary: r.secondary, markets: r.profiles, profile: r.profile, digits: r.digits,
    system: r.primary === "jalali" ? "jalali" : "gregorian", weekend: [...new Set(weekend)], weekendName: typeof c.weekend === "string" ? c.weekend : null,
    holidays, profiles, settlement, ahead: c.ahead ?? 30 };
}

/** A series by id (throws when unknown). */
export function seriesById(config, id) {
  const s = config.series.find((x) => x.id === id);
  if (!s) throw new Error(`unknown series "${id}"`);
  return s;
}
/** Options for @saasreport/speech from a config. */
export const speechOptions = (config) => ({ locale: config.speech?.locale || config.site?.locale, terms: config.speech?.terms, defaults: config.speech?.defaults !== false });
