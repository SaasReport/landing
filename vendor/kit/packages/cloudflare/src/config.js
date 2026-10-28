/**
 * Runtime view of the kit config for the Worker.
 *   rawConfig — the @saasreport/core defineConfig() output (passed unchanged to core, podcast, channels, monitor)
 *   config    — the same plus Worker-only options (createKit's third argument) and defaults for a raw config
 * Worker-only options (not part of the core config schema): { share, reactions, events, blog, podcasts, glossary, assets, nav, footer, security,
 *   shell, subscribe, sitemap, llms, api, meta, tags (the content-tag vocabulary, kit.content-tags.v1: docs/TAGS.md) }.
 */
import { slugify } from "./util.js";
import { dateTag, withoutCalendar } from "@saasreport/calendar/instant";

export const FEATURES = ["blog", "podcasts", "glossary", "events", "reactions", "share", "calendar", "feeds", "monitor", "llms", "sitemap", "tags"];
export const SHARE_TARGETS = ["native", "telegram", "whatsapp", "x", "linkedin", "copy"];
const RTL = new Set(["fa", "ar", "he", "ur", "ps", "ckb", "dv", "yi"]);
const PROFILE_WEEKENDS = { bank: [5], government: [4, 5], market: [4, 5] }; // JS weekdays (0 = Sunday), as in @saasreport/core
const RUNTIME_KEYS = ["share", "reactions", "events", "blog", "podcasts", "glossary", "assets", "nav", "footer", "security", "shell", "subscribe", "sitemap", "llms", "api", "meta", "tags"];

/** A BCP 47 tag in its canonical forms: { locale, localeBase, lang } ("en_gb" and "en-gb" are read as "en-GB"). */
export function canonicalLocale(tag) {
  const [canon] = Intl.getCanonicalLocales(String(tag).replace(/_/g, "-"));
  const base = new Intl.Locale(withoutCalendar(canon)).baseName; // never resolve a -u-ca-persian tag through ICU
  return { locale: canon, localeBase: base, lang: base.split("-")[0].toLowerCase() };
}

export function normalizeConfig(input = {}, options = {}) {
  const cfg = input || {};
  const s = cfg.site || {};
  if (!s.url) throw new Error("kit config: site.url is required");
  const url = String(s.url).replace(/\/+$/, "");
  const u = new URL(url);
  // the locale is canonicalised once, here, and every consumer reads these forms: locale (BCP 47 canonical, extensions
  // kept: "en-gb-u-nu-latn" → "en-GB-u-nu-latn") for Intl, localeBase (no extensions: "en-GB") for lookups, lang ("en")
  const { locale, localeBase, lang } = canonicalLocale(s.locale || "en-US");
  const org = { name: s.name, url, logo: s.logo, ...(s.org || {}) };
  org.sameAs = Array.isArray(org.sameAs) ? org.sameAs : [];
  const site = {
    ...s, url, origin: u.origin, host: u.host, locale, localeBase, lang, dir: s.dir || (RTL.has(lang) ? "rtl" : "ltr"),
    timezone: s.timezone || (lang === "fa" ? "Asia/Tehran" : "UTC"), name: s.name || u.host, description: s.description || "", org,
    ogLocale: localeBase.replace("-", "_"), id: s.id || slugify(u.hostname),
  };
  const features = Object.fromEntries(FEATURES.map((f) => [f, cfg.features?.[f] !== false]));
  features.tags = features.tags && options.tags != null;   // the tag pages, chips and filters exist only for a project that declares its vocabulary

  const series = (cfg.series || []).map((x) => ({ ...x, kind: x.kind || "topic", post: x.post ?? x.kind !== "term", glossary: x.glossary ?? x.kind === "term" }));
  const shows = {};
  const showIds = Object.keys(cfg.shows || {});
  for (const [id, sh] of Object.entries(cfg.shows || {})) {
    shows[id] = { description: "", feed: id === showIds[0] ? "/podcasts/feed.xml" : `/podcasts/${id}/feed.xml`, cover: s.logo || null,
      category: "Business", author: org.name || site.name, explicit: false, ...sh, id, title: sh.title || id };
  }
  const c = cfg.calendar || {};
  const system = c.system || (lang === "fa" ? "jalali" : "gregorian");
  const weekend = Array.isArray(c.weekend) ? c.weekend : PROFILE_WEEKENDS[c.weekend] || (system === "jalali" ? PROFILE_WEEKENDS.bank : [0, 6]);
  const holidays = c.holidays === true ? "iran" : c.holidays === false ? "none" : c.holidays || (system === "jalali" ? "iran" : "none");
  // Market holiday feeds (/calendar/<market>.ics): `feeds` lists market ids; by default the site's market profiles.
  // false turns them off. Unknown ids are dropped by the handler (they answer 404).
  const feeds = c.feeds === false ? [] : (Array.isArray(c.feeds) ? c.feeds : Array.isArray(c.profiles) ? c.profiles : Array.isArray(c.markets) ? c.markets : [])
    .map((x) => String(typeof x === "object" && x ? x.id : x).toLowerCase()).filter(Boolean);
  const calendar = { ...c, system, weekend, holidays, feeds: [...new Set(feeds)] };

  const opt = (k) => ({ ...(cfg[k] && typeof cfg[k] === "object" && !Array.isArray(cfg[k]) ? cfg[k] : {}), ...(options[k] || {}) });
  const list = (k, def) => options[k] ?? (Array.isArray(cfg[k]) ? cfg[k] : def);
  return {
    site, features, series, shows, calendar,
    tags: options.tags ?? null,
    brand: { colors: {}, fonts: {}, ...(cfg.brand || {}) },
    hosts: cfg.hosts || {},
    tts: cfg.tts || {},
    channels: cfg.channels || {},
    strings: cfg.strings || {},
    share: { targets: SHARE_TARGETS, ...opt("share") },
    reactions: { cookie: "kit_v", windowMinutes: 10, maxWrites: 60, ratings: ["episode"], ...opt("reactions") },
    events: { rsvp: false, rsvpForm: "event-rsvp", ...opt("events") },   // rsvpForm: the declared form (comms config) the RSVP is delivered as
    // blog.author: the byline of scheduled posts (the organization's editorial team: JSON-LD names the organization).
    blog: { perPage: 12, kinds: ["article", "howto", "analysis", "topic", "report", "snapshot"], ...opt("blog") },
    podcasts: { ...opt("podcasts") },
    glossary: { ...opt("glossary") },
    assets: { base: "/kit", ...opt("assets") },
    nav: list("nav", []),
    footer: { links: [], ...opt("footer") },
    security: { ...opt("security") },
    shell: { robots: "index, follow, max-image-preview:large", head: "", stylesheets: [], scripts: [], fonts: true, og: {}, ...opt("shell") },
    subscribe: options.subscribe ?? cfg.subscribe ?? null,
    sitemap: { extra: [], ...opt("sitemap") },
    llms: { ...opt("llms") },
    api: { ...opt("api") },
    // meta.forms: the project's own forms (/api/forms/<id>) described in GET /api/meta; meta: false turns the endpoint off.
    meta: options.meta === false || cfg.meta === false ? false : { forms: {}, ...opt("meta") },
  };
}
export { RUNTIME_KEYS };

/** Options for @saasreport/calendar (weekday numbers there count from Saturday: 0 = Saturday … 6 = Friday). */
export function calendarOptions(config) {
  return { weekend: config.calendar.weekend.map((d) => (d + 1) % 7), holidays: config.calendar.holidays === "iran" };
}

/**
 * Intl locale string for dates. Jalali sites get the site locale on the Gregorian calendar: Intl only lays out, and
 * kit.js puts the Jalali date in with @saasreport/calendar's arithmetic (ICU's Persian calendar is a day off on Workers in
 * 1405). Every other site keeps its own calendar (ar-SA-u-ca-islamic-umalqura stays Hijri, th-TH stays Buddhist),
 * unless that calendar would be ICU's Persian one, which becomes Gregorian.
 */
export function dateLocale(config) {
  return dateTag(config.site.locale, config.calendar?.system);
}
