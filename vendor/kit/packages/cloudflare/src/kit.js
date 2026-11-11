/**
 * buildKit(config, content, options) — the runtime with every dependency injected (options.deps). A multi-locale config
 * (site.locales) gets one runtime per locale behind a router (multi.js).
 * `@saasreport/cloudflare` (src/index.js) wires the sibling packages; tests and custom setups can call this directly.
 *
 * deps: { loadContent, planner, buildPost (core; defineConfig and the web helpers are imported directly) · calendar (the @saasreport/calendar module) ·
 *         episodeFromItem, createPodcastWorkflow, ttsConfigured (podcast) · announcePending (channels) }
 */
import { defineConfig, isLocaleRoot, org as orgNode, website, graph, crumbs } from "@saasreport/core";
import { normalizeConfig, dateLocale } from "./config.js";
import { formatJalali } from "@saasreport/calendar/instant";
import { translator } from "./strings.js";
import { createShell } from "./shell.js";
import { createContent } from "./content.js";
import { createBlog } from "./handlers/blog.js";
import { createEvents } from "./handlers/events.js";
import { createPodcasts, episodeFor } from "./handlers/podcasts.js";
import { createGlossary } from "./handlers/glossary.js";
import { handleReactions } from "./handlers/reactions.js";
import { createCalendar, createMarketFeeds } from "./handlers/calendar.js";
import { createDiscovery } from "./handlers/discovery.js";
import { createTwins } from "./twins.js";
import { createTags, createTagPages } from "./tags.js";
import { compileVocabulary } from "@saasreport/core/tags";
import { createMeta } from "./handlers/meta.js";
import { readMonitorStatus, healthResponse, STATUS_TIMEOUT_MS } from "./health.js";
import { createFormDeliveries } from "./handlers/form-deliveries.js";
import { createScheduler, makeCalendarBit, CATCHUP } from "./scheduled.js";
import { buildMultiKit } from "./multi.js";
import { esc, html, json, redirect, digitsFor, dayNumber } from "./util.js";
import { LOCALE_DIGITS, localizeHtml, localizeMarkdown } from "@saasreport/format";

/** The vocabulary document, wrapped so the multi-locale `localize` leaves its { fa: …, en: … } label maps alone (a class instance is kept as it is). */
class TagsOption { constructor(doc) { this.doc = doc; } }

export function buildKit(config, content = {}, options = {}) {
  const rawConfig = (options.deps?.defineConfig || defineConfig)(config);
  if (isLocaleRoot(rawConfig)) return buildMultiKit(rawConfig, content, options.tags != null ? { ...options, tags: new TagsOption(options.tags) } : options, buildLocaleKit);
  return buildLocaleKit(rawConfig, content, options);
}

/**
 * One locale's runtime (the whole site when it has one language). On a multi-locale site (multi.js) `options.locale`
 * is { key, base, prefix, db, multi: true }: pages link under `base` ("/ar"), rows carry `locale = db` and slugs of a
 * non-default locale are stored as `prefix + slug` ("ar/week-2026-10-05") so they stay unique in D1 and R2.
 */
function buildLocaleKit(config, content = {}, options = {}) {
  const { deps = {}, now, storage, calendarBit, persian: persianProject = null, locale: loc = null, ...runtime } = options;
  if (runtime.tags instanceof TagsOption) runtime.tags = runtime.tags.doc;
  const rawConfig = (deps.defineConfig || defineConfig)(config);
  const cfg = normalizeConfig(rawConfig, runtime);
  const t = translator(cfg);

  /** The kit context shared by every handler. */
  const k = { config: cfg, rawConfig, content, deps, t, d: digitsFor(cfg.site.lang) };
  /** The content-tag vocabulary in this locale (docs/TAGS.md), or null: no vocabulary, no tag feature. An invalid one throws here. */
  k.tags = cfg.features.tags ? compileVocabulary(cfg.tags, { locale: cfg.site.localeBase }) : null;
  k.tagsUi = createTags(k);
  /** Locale of this runtime: null on a single-locale site (no locale column is read or written, paths and slugs as they are). */
  k.loc = loc;
  const base = loc?.base || "", prefix = loc?.prefix || "";
  /** A site path in this locale ("/blog/" → "/ar/blog/"); absolute URLs come from k.abs (site.url carries the base). */
  k.href = base ? (path) => (typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? `${base}${path}` : path) : (path) => path;
  /** Stored slug ↔ URL slug ("ar/week-…" ↔ "week-…"); identity outside a non-default locale. */
  k.dbSlug = prefix ? (s) => `${prefix}${s}` : (s) => s;
  k.urlSlug = prefix ? (s) => (String(s).startsWith(prefix) ? String(s).slice(prefix.length) : s) : (s) => s;
  /** SQL filter on the locale column: ["", []] on a single-locale site, [" AND locale = ?", [db]] otherwise. */
  k.where = (col = "locale") => (loc ? [` AND ${col} = ?`, [loc.db]] : ["", []]);
  k.now = () => (typeof now === "function" ? now() : new Date());
  k.dayOf = (date) => dayNumber(date, cfg.site.timezone);
  k.today = () => k.dayOf(k.now());
  k.abs = (path) => (/^https?:\/\//.test(path) ? path : `${cfg.site.url}${path.startsWith("/") ? "" : "/"}${path}`);
  const locale = dateLocale(cfg), tz = cfg.site.timezone;
  const fmt = (o) => { try { return new Intl.DateTimeFormat(locale, { timeZone: tz, ...o }); } catch { return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }); } };
  const O = { date: { day: "numeric", month: "long", year: "numeric" }, when: { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }, time: { hour: "2-digit", minute: "2-digit" } };
  // Dates in the site's digits whatever the runtime's ICU does (@saasreport/format, CONSTITUTION.md §7).
  // Solar Hijri day/month/year come from @saasreport/calendar's arithmetic, the one source for the calendar: runtime ICU
  // puts Nowruz 1405 a day early (Workers rendered 2026-10-03 as 12 Mehr, not 11). Intl supplies layout, weekday, time.
  const jalali = cfg.calendar?.system === "jalali";
  const formatter = (o) => (jalali ? (x) => formatJalali(x, { locale, timeZone: tz, ...o }) : ((f) => (x) => f.format(x))(fmt(o)));
  const safe = (f) => (iso) => { const x = new Date(iso); return Number.isNaN(+x) ? "" : k.d(f(x)); };
  const F = { date: formatter(O.date), when: formatter(O.when), time: formatter(O.time) };
  k.fmtDate = safe(F.date); k.fmtWhen = safe(F.when); k.fmtTime = safe(F.time);
  k.fmtPart = (iso, o) => safe(formatter(o))(iso);
  k.orgRef = () => ({ "@id": `${cfg.site.root || cfg.site.url}/#org` }); // one organization for every locale (site.root)
  k.graph = (...nodes) => graph(orgNode(rawConfig), website(rawConfig), ...nodes);
  k.crumbs = (items) => crumbs(rawConfig, items);
  const shell = createShell(k);
  k.page = shell.page;
  /** Public JSON payloads pass through options.api[name](payload, { url, env, k }) (e.g. to keep an existing API contract). */
  k.api = async (name, payload, ctx) => (typeof cfg.api[name] === "function" ? await cfg.api[name](payload, { ...ctx, k }) : payload);
  k.hero = shell.hero; k.pageTitle = shell.pageTitle; k.itemTitle = shell.itemTitle; k.subscribe = shell.subscribeBox;
  k.notFound = () => html(k.page({ title: `${t("notFound.title")} | ${cfg.site.name}`, path: "/404", robots: "noindex, follow",
    body: `<section class="hero wrap"><h1>${esc(t("notFound.title"))}</h1><p>${esc(t("notFound.body"))}</p><div class="hero__act"><a class="btn btn--primary" href="${k.href("/")}">${esc(t("nav.home"))}</a></div></section>` }), 404, { "cache-control": "no-store" });
  k.c = createContent(k);
  k.calendarBit = makeCalendarBit(k, calendarBit);
  /** The episode the cron, the admin API and the workflow build for a series item (also used by the CLI). */
  k.episodeFor = (series, item, opts) => episodeFor(k, series, item, opts);

  const f = cfg.features;
  const podcasts = createPodcasts(k);
  const twins = createTwins(k);
  k.twins = twins;
  const blog = createBlog(k);
  const tagPages = k.tags ? createTagPages(k, k.tagsUi, { podcasts, blog }) : null;
  const H = {
    blog,
    tags: tagPages,
    events: createEvents(k),
    podcasts,
    glossary: createGlossary(k, { player: podcasts.player }),
    calendar: deps.calendar ? createCalendar(k) : null,
    feeds: createMarketFeeds(k),
    discovery: createDiscovery(k, { podcasts, twins, tagPages }),
  };
  H.meta = createMeta(k);
  H.deliveries = createFormDeliveries(k);   // GET /api/forms/deliveries[/<ref>]: the form-delivery ledger (docs/FORMS.md), always on
  // GET /api/status is the MONITOR's document (kit.monitor-status.v1), served by the monitor Worker itself (GET /status) and reached
  // through a service binding (default MONITOR; config.monitor.statusBinding). The site Worker never binds the monitor's D1: a watched
  // Worker that could write the monitor's rows could forge its own "passing" (review H2). Without the binding, or when the monitor
  // does not answer, the answer is 503 with a reason code, never a guess.
  const statusBinding = rawConfig.monitor?.statusBinding || "MONITOR";
  const STATUS_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
  const unavailable = (reason) => new Response(JSON.stringify({ ok: false, status: "unknown", reason }), { status: 503, headers: STATUS_HEADERS });
  // bounded (config.monitor.statusTimeoutMs, default 5 s): a hung monitor answers 503 "timeout", never holds the site's request (one reader, ./health.js)
  const monitorRead = (env) => readMonitorStatus(env, { binding: statusBinding, timeoutMs: rawConfig.monitor?.statusTimeoutMs ?? STATUS_TIMEOUT_MS });
  const status = async (env) => {
    const r = await monitorRead(env);
    if (!r.ok && !r.text) return unavailable(r.reason);
    return new Response(r.text, { status: r.status, headers: STATUS_HEADERS });
  };

  /** [feature, path test, handler] in routing order. */
  const ROUTES = [
    ["blog", (p) => /^\/blog(\/|$)|^\/api\/blog(\/|$)/.test(p), (r, e, u) => H.blog.handle(r, e, u)],
    ["tags", (p) => /^\/tags(\/|$)|^\/api\/tags(\/|$)/.test(p), (r, e, u) => H.tags?.handle(r, e, u)],
    ["events", (p) => /^\/events(\/|$)|^\/api\/events(\/|$)|^\/api\/forms\/event-rsvp$/.test(p), (r, e, u, c) => H.events.handle(r, e, u, c)],
    ["podcasts", (p) => /^\/podcasts?(\/|$)|^\/api\/podcasts(\/|$)/.test(p), (r, e, u) => H.podcasts.handle(r, e, u)],
    ["glossary", (p) => /^\/(glossary|taxonomy)(\/|$)|^\/api\/glossary(\/|$)/.test(p), (r, e, u) => H.glossary.handle(r, e, u)],
    ["reactions", (p) => p === "/api/reactions", (r, e, u) => handleReactions(k, r, e, u)],
    ["calendar", (p) => /^\/api\/calendar(\/|$)|^\/calendar\.ics$|^\/mcp$/.test(p), (r, e, u) => H.calendar?.handle(r, e, u)],
    ["feeds", (p) => /^\/calendar\/[^/]+\.ics$/.test(p), (r, e, u) => H.feeds.handle(r, u)],
    ["monitor", (p) => p === "/api/status", (r, e) => status(e)],
  ];

  // Persian digits in every page, twin and llms.txt this Worker renders (CONSTITUTION.md §7): numbers are formatted with
  // @saasreport/format where they are produced, and the finished text passes the same rules once more on the way out
  // (content from the database included). Static assets are checked at build time (kit check digits) and pass as they are.
  const localeDigits = Boolean(LOCALE_DIGITS[cfg.site.lang]);
  async function localized(res, p) {
    if (!localeDigits || !res || res.status === 304 || !res.body) return res;
    const type = res.headers.get("content-type") || "";
    const kind = /text\/html/.test(type) ? "html" : /text\/(markdown|plain)/.test(type) && /\.(md|txt)$/.test(p) ? "md" : null;
    if (!kind) return res;
    const body = await res.text();
    const out = kind === "html" ? localizeHtml(body, cfg.site.lang) : localizeMarkdown(body, cfg.site.lang, { persianLinesOnly: /\.txt$/.test(p) });
    const headers = new Headers(res.headers);
    headers.delete("content-length"); headers.delete("etag");
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  }

  async function fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (cfg.site.host && url.host === `www.${cfg.site.host}`) { url.host = cfg.site.host; return redirect(url.toString()); }
    try {
      // derived from the monitor, never a constant (kit.health.v1, ./health.js): 200 only while the monitor reads passing
      if (p === "/api/health") return healthResponse(env, { component: cfg.site.id, binding: statusBinding, timeoutMs: rawConfig.monitor?.statusTimeoutMs ?? STATUS_TIMEOUT_MS });
      const d = await localized(await H.discovery.handle(request, env, url), p);
      if (d) return d;
      if (p === "/api/meta") { const m = H.meta.handle(request); if (m) return m; }
      if (p.startsWith("/api/forms/deliveries")) { const r = await H.deliveries.handle(request, env, url); if (r) return r; }
      // A static page's twin (/<path>/index.md, listed in llms.txt) wins over a feature route that owns the same prefix
      // (/blog/index.md, /glossary/index.md, /podcasts/index.md); posts and episodes keep their /<slug>.md twins.
      if (p.endsWith("/index.md") && env.ASSETS?.fetch) {
        const t = await twins.serve(request, env, url);
        if (t && (t.ok || t.status === 304)) return t;
      }
      for (const [feature, test, handler] of ROUTES) {
        if (!test(p)) continue;
        if (!f[feature]) return p.startsWith("/api/") || p === "/mcp" ? json({ ok: false, error: "not_found" }, 404) : localized(k.notFound(), p);
        const r = await localized(await handler(request, env, url, ctx), p);
        if (r) return r;
        break;
      }
      if (p.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);
      if (env.ASSETS?.fetch) return (await twins.serve(request, env, url)) || env.ASSETS.fetch(request);
      return localized(k.notFound(), p);
    } catch (e) {
      console.error("[kit] error", p, String(e?.stack || e));
      return p.startsWith("/api/") || p === "/mcp" ? json({ ok: false, error: "internal" }, 500) : html(`<!doctype html><title>500</title><h1>500</h1>`, 500, { "cache-control": "no-store" });
    }
  }

  const scheduler = createScheduler(k);
  let PodcastWorkflow;
  if (deps.createPodcastWorkflow) {
    // A Persian site's podcast gate comes from the project's own persian.config.json (docs/PERSIAN.md). Built without it, the
    // brand rule is inactive and reviewed false positives block episodes: refuse to build, `persian: false` opts out on purpose.
    if (persianProject == null && /^fa\b/i.test(String(rawConfig.site?.locale || "")) && rawConfig.features?.podcasts) {
      throw new Error("createKit: a Persian (fa) site with podcasts needs the `persian` option: { config: <persian.config.json>, packs: [] }, the same config `kit check persian` reads (docs/PERSIAN.md); pass persian: false to opt out");
    }
    const workflowContent = async (row) => {
      const s = cfg.series.find((x) => x.id === row.series);
      if (!s) return null;
      const plan = await k.c.plan();
      const e = plan?.find ? plan.find(s.id, row.source_ref) : null;
      const item = e?.item || (await k.c.items(s.id)).find((x) => x.slug === row.source_ref || x.date === row.source_ref);
      return item ? episodeFor(k, s, item, { number: row.number ?? e?.number ?? null, ref: row.source_ref }).lines : null;
    };
    // persian: the project's persian.config.json and packs, so the gate before TTS matches kit check persian (docs/PERSIAN.md)
    k.workflowOptions = { config: rawConfig, content: workflowContent, storage, calendarBit: k.calendarBit, persian: persianProject };
    if (!loc) PodcastWorkflow = deps.createPodcastWorkflow(k.workflowOptions); // multi.js builds one for every locale
  }

  return {
    fetch,
    scheduled: scheduler.scheduled,
    runDaily: scheduler.runDaily,
    [CATCHUP]: scheduler[CATCHUP],   // private to scheduled(): the multi-locale router reads it by this module-private symbol
    PodcastWorkflow,
    config: cfg,
    handlers: { ...Object.fromEntries(Object.entries(H).map(([n, h]) => [n, h?.handle])), reactions: (r, e, u) => handleReactions(k, r, e, u), status },
    discovery: H.discovery,
    twins,
    meta: H.meta,
    /** Market holiday feeds this site serves: [{ market, path, url, webcal }] (empty when the "feeds" feature is off). */
    calendarFeeds: () => (cfg.features.feeds ? H.feeds.list() : []),
    context: k,
  };
}
