/**
 * The daily cron: planner.due(today) → upsert posts → queue podcast episodes → announce on channels.
 * Idempotent: posts are upserted by slug (channel state is never reset), an existing episode is not re-queued, except one whose
 * render failed: the next scheduled run re-queues it (origin "cron-retry"), so a bad night heals without anyone touching it.
 * Every episode is queued with its provenance record (core/podcast-provenance): the cron is the only way an episode comes to exist.
 */
import { effectiveTags } from "@saasreport/core/tags";
import { episodeFor, queueEpisode, ttsReady, catchupOf, missingDays, existingEpisode } from "./handlers/podcasts.js";

export const POST_UPSERT = `INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, author, source, status, published_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(slug) DO UPDATE SET series = excluded.series, kind = excluded.kind, title = excluded.title, summary = excluded.summary, body_md = excluded.body_md,
  tags = excluded.tags, author = excluded.author, source = excluded.source, status = excluded.status, published_at = excluded.published_at, updated_at = excluded.updated_at`;

export const postValues = (p, now = new Date().toISOString()) => [p.slug, p.series ?? null, p.kind, p.title, p.summary || "", p.body_md || "", JSON.stringify(p.tags || []),
  p.author ?? null, p.source || "auto", p.status || "published", p.published_at, now];

/** The same upsert on a multi-locale site: the row also carries its locale ("" for the default locale). */
export const POST_UPSERT_LOCALE = `INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, author, source, status, published_at, updated_at, locale)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(slug) DO UPDATE SET series = excluded.series, kind = excluded.kind, title = excluded.title, summary = excluded.summary, body_md = excluded.body_md,
  tags = excluded.tags, author = excluded.author, source = excluded.source, status = excluded.status, published_at = excluded.published_at, updated_at = excluded.updated_at,
  locale = excluded.locale`;

/** A topic's article with its sources line (the same shape as @saasreport/core's articleMd, English label). */
const withSources = (it) => (Array.isArray(it.sources) && it.sources.length
  ? `${String(it.article || "").trim()}\n\n**Sources:** ${it.sources.map((x) => `[${x.title}](${x.url})`).join(", ")}` : it.article);

/** Post for a planner entry without @saasreport/core (no calendar tables). */
function plainPost(e) {
  const it = e.item;
  if (!it) return null;
  const base = { slug: e.slug, series: e.series, kind: e.kind, published_at: e.publishAt, source: "auto" };
  if (e.kind === "topic") return { ...base, title: it.title, summary: it.summary, body_md: withSources(it), tags: it.tags };
  if (e.kind === "report") return { ...base, title: it.title, summary: it.summary || String(it.intro || "").slice(0, 200), body_md: it.intro, tags: it.tags };
  return { ...base, title: it.term, summary: it.short, body_md: it.definition, tags: [] };
}

/**
 * The spoken calendar segment appended to weekly topic episodes (passed to @saasreport/podcast as `calendarBit`).
 * The generic segment says the business days of the site's weekend profile and the week's holidays (strings `calbit.*`).
 * A project replaces it with its own: `series[].podcast.calendarBit` in kit.config.js (used by the Worker and the CLI)
 * or `calendarBit` in createKit's options (all series). The hook gets
 *   { item, series, config, calendar (the @saasreport/calendar module), t, day (day number of item.date), fallback() }
 * and returns { lines: [[speakerKey, text]] | [{speaker, text}], summary? } or null (no segment).
 */
export function makeCalendarBit(k, custom = null) {
  const C = k.deps.calendar;
  if (!C) return undefined;
  const fallback = ({ item }) => {
    if (!item?.date) return null;
    const start = Math.floor(Date.parse(`${item.date}T00:00:00Z`) / 864e5);
    const o = { weekend: k.config.calendar.weekend.map((d) => (d + 1) % 7), holidays: k.config.calendar.holidays === "iran" };
    let n = 0;
    const hol = [];
    for (let d = start; d < start + 7; d++) {
      if (C.isBusinessDay(d, o)) n++;
      if (o.holidays) for (const h of C.holidaysOn(d)) hol.push(h.title);
    }
    const t = k.t, list = [...new Set(hol)].join(t("calbit.sep"));
    return { lines: [["host", t("calbit.q")], ["expert", t("calbit.a", { n, holidays: list ? t("calbit.holidays", { list }) : "" })]], summary: t("calbit.summary", { n }) };
  };
  return (ctx = {}) => {
    const hook = ctx.series?.podcast?.calendarBit || (k.config.series.find((s) => s.id === ctx.series?.id)?.podcast?.calendarBit) || custom;
    if (typeof hook !== "function") return fallback(ctx);
    const day = ctx.item?.date ? Math.floor(Date.parse(`${ctx.item.date}T00:00:00Z`) / 864e5) : null;
    return hook({ ...ctx, config: ctx.config || k.rawConfig, calendar: C, t: k.t, day, fallback: () => fallback(ctx) });
  };
}

/** Module-private key of the catch-up function: the multi-locale router imports it, nothing else does (it is not an export of the package). */
export const CATCHUP = Symbol("kit.catchup");

export function createScheduler(k) {
  const { config } = k;

  /**
   * Run the daily publishing for a day number (default: today in site.timezone). `announce: false` skips the channels
   * (a multi-locale site announces once, after every locale has published).
   */
  async function run(env, { day = k.today(), announce = true, scheduledAt = null, origin = "cron", missedDate = null, only = null } = {}) {
    const report = { day, posts: [], episodes: [], skipped: [], errors: [], channels: null };
    const plan = await k.c.plan();
    const entries = await k.c.due(day);
    const tts = config.features.podcasts && ttsReady(k, env);
    for (const e of entries) {
      const series = config.series.find((s) => s.id === (e.series?.id || e.series));
      if (!series) { report.skipped.push({ slug: e.slug, reason: "unknown series" }); continue; }
      if (!only && series.post && config.features.blog) {   // a catch-up (`only`) never touches posts: an edited or unpublished past post stays as it is
        try {
          const built = k.deps.buildPost ? k.deps.buildPost(plan, e) : plainPost(e);
          const post = built && k.loc?.prefix ? { ...built, slug: k.dbSlug(built.slug) } : built;
          if (post) {
            // with a tag vocabulary a post carries the tags of its item, else of its series (docs/TAGS.md), never the display tags the report builders add
            // ("weekly", a glossary category name, ...): a tag outside the vocabulary cannot exist
            const values = postValues({ series: series.id, author: config.blog.author ?? null, ...post, ...(config.features.tags ? { tags: effectiveTags(series.tags, e.item?.tags) } : {}) }, k.now().toISOString());
            await (k.loc ? env.DB.prepare(POST_UPSERT_LOCALE).bind(...values, k.loc.db) : env.DB.prepare(POST_UPSERT).bind(...values)).run();
            report.posts.push(post.slug);
          }
        } catch (err) { report.errors.push({ slug: e.slug, step: "post", error: String(err?.message || err).slice(0, 300) }); }
      }
      if (series.podcast && config.features.podcasts && e.item) {
        if (!tts) { report.skipped.push({ slug: e.slug, reason: "tts_not_configured" }); continue; }
        try {
          const ep = episodeFor(k, series, e.item, { number: e.number ?? null, ref: e.key ?? null });
          if (only && !only.has(ep.slug)) continue;   // a catch-up renders only the missed episode
          const at = scheduledAt ?? k.now();
          const publishAt = e.publishAt || null;
          // The day may already have its episode under another name (a legacy or renamed row): (series, day) decides, a published row always wins.
          const found = await existingEpisode(k, env, series, day, ep.slug);
          if (found?.status === "published") continue;                                  // nothing to do: no retry, no second row
          let r;
          if (found && found.slug !== ep.slug) {
            if (found.status !== "failed") continue;                                     // queued, rendering or in review under another name: leave it
            // a failed row under another name is re-queued itself (cron-retry), never twinned
            r = await queueEpisode(k, env, { series, ep: { ...ep, slug: found.slug }, publishAt, origin: origin === "admin" ? "admin" : "cron-retry", scheduledAt: at, force: true });
          } else {
            // origin "admin": a person ran the day through an admin route (a project's own); the record says so and a policy rejects it.
            r = await queueEpisode(k, env, { series, ep, publishAt, origin, scheduledAt: at, missedDate });
            if (!r.created && r.status === "failed") r = await queueEpisode(k, env, { series, ep, publishAt, origin: origin === "admin" ? "admin" : "cron-retry", scheduledAt: at, force: true });
          }
          if (r.created) report.episodes.push(r.slug);
        } catch (err) { report.errors.push({ slug: e.slug, step: "episode", error: String(err?.message || err).slice(0, 300) }); }
      }
    }
    if (announce && !only && k.deps.announcePending) {   // a catch-up announces nothing
      try { report.channels = await k.deps.announcePending(env, k.rawConfig, { when: (row) => k.fmtWhen(row.starts_at) }); }
      catch (err) { report.errors.push({ step: "channels", error: String(err?.message || err).slice(0, 300) }); }
    }
    console.log("[kit] daily", JSON.stringify({ day, posts: report.posts, episodes: report.episodes, errors: report.errors.length }));
    // every error with its step and message, at error level: a count alone hid a week of refused episode inserts (D1's 50-byte GLOB
    // limit, 2026-10-07..13, "errors":2 every day and no cause in any log)
    for (const e of report.errors) console.error("[kit] daily error", JSON.stringify({ day, ...e }));
    return report;
  }

  /**
   * The ONE entry point of the daily run, used by the cron and by an admin route alike: today's (or a given day's) publishing AND the catch-up
   * window (`report.catchup`: one report per filled day, oldest first, [] when none was missed or catch-up is off). A missed day is therefore
   * filled whoever starts the run: before, only scheduled() filled it, so the admin run-daily route and run-daily.yml left a missed day open.
   * The catch-up records (origin "catchup", missed_date) are still made only here: a caller cannot ask for origin "catchup", missedDate or
   * `only`, and `catchup: false` skips the window (the multi-locale router runs it itself, after every locale has published).
   */
  async function runDaily(env, opts = {}) {
    if (opts.origin === "catchup" || opts.missedDate != null || opts.only != null) throw new Error('runDaily: origin "catchup", missedDate and only belong to the catch-up window the run itself makes, never asked for');
    if (opts.origin != null && opts.origin !== "cron" && opts.origin !== "admin") throw new Error(`runDaily: unknown origin "${opts.origin}"`);
    const { catchup: withCatchup = true, ...rest } = opts;
    const report = await run(env, rest);
    if (withCatchup) report.catchup = await catchup(env, { today: rest.day ?? k.today(), scheduledAt: rest.scheduledAt ?? null });
    return report;
  }

  /**
   * Sanctioned catch-up (podcast.config.json "catchup": enabled, windowDays): past days inside the window that have no episode are
   * rendered by this scheduled run, ONLY the missed podcast episode (no posts written, nothing announced), with origin "catchup" and the
   * missed date in the provenance record. It is private to scheduled(): no route, option or public method starts it (a symbol the multi-locale
   * router imports, not an export of the package). Returns one report per filled day (oldest first).
   */
  async function catchup(env, { today = k.today(), scheduledAt = null } = {}) {
    const c = catchupOf(k);
    if (!c.enabled || !config.features.podcasts || !ttsReady(k, env)) return [];
    const byDay = new Map();
    for (const m of await missingDays(k, env, { today, span: c.windowDays })) { if (!byDay.has(m.day)) byDay.set(m.day, { date: m.date, slugs: new Set() }); byDay.get(m.day).slugs.add(m.slug); }
    const reports = [];
    for (const [day, { date, slugs }] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) reports.push({ date, ...(await run(env, { day, announce: false, scheduledAt, origin: "catchup", missedDate: date, only: slugs })) });
    return reports;
  }

  // A rejected insert or unconfigured TTS is a failed Cron, not a green invocation with a buried error count.
  function scheduled(event, env, ctx) {
    const when = event?.scheduledTime ? new Date(event.scheduledTime) : k.now();
    const p = runDaily(env, { day: k.dayOf(when), scheduledAt: when }).then((report) => {
      const failures = (r) => [
        ...(r.errors || []).map((e) => `${e.step || "unknown"}:${e.slug || ""}: ${e.error || "unknown error"}`),
        ...(r.skipped || []).filter((e) => ["tts_not_configured", "unknown series"].includes(e.reason))
          .map((e) => `${e.slug}: ${e.reason}`),
      ];
      const all = [...failures(report), ...(report.catchup || []).flatMap((r) => failures(r).map((e) => `${r.date}: ${e}`))];
      if (all.length) {
        console.error("[kit] scheduled publishing failed", JSON.stringify({ day: report.day, failures: all }));
        throw new Error(`scheduled publishing failed (${all.length}): ${all.slice(0, 3).join("; ")}`);
      }
      return report;
    });
    // A catch here would hide the failure from the platform and make the next monitor the first witness (post-facto).
    ctx?.waitUntil?.(p);
    return p;
  }

  return { runDaily, scheduled, [CATCHUP]: catchup };
}
