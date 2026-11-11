/**
 * Podcasts: every show in config.shows.
 *   /podcasts/                    index (one section per show)       <show.feed>   RSS 2.0 + iTunes + Podcasting 2.0 per show
 *   /podcasts/<slug>  (+ .md)     episode page with player + transcript
 *   /podcasts/audio/<slug>.mp3    audio from R2 (binding PODCASTS, key podcasts/<slug>.mp3), byte ranges
 *   /api/podcasts                 public JSON (?show=&limit=)
 *   admin (Authorization: Bearer $ADMIN_TOKEN):
 *     POST /api/podcasts/generate {series, ref, force?} | {post: <blog slug>, force?}   GET /api/podcasts/admin   GET /api/podcasts/admin/<slug>
 */
import { podcastRss } from "@saasreport/core";
import { checkEpisodeSpec, checkProvenance, buildProvenance, provenanceProblem } from "@saasreport/core/podcast-provenance";
import { esc, html, json, jsonRes, text, redirect, clampInt, parseJSON, safeEqual } from "../util.js";
import { icon } from "../shell.js";
import { aggregates, reactionsBlock } from "./reactions.js";
import { readJsonBody } from "../body.js";

const COLS = "slug, series, show, number, kind, title, summary, duration_ms, audio_bytes, published_at, updated_at, source_type, source_ref, provenance_json";

/** Published episodes, newest first. `locale`: the locale column's value on a multi-locale site (omitted: every row). */
export async function listEpisodes(env, { show = null, series = null, limit = 50, locale = null } = {}) {
  const where = ["status = 'published'"], binds = [];
  if (show) { where.push("show = ?"); binds.push(show); }
  if (series) { where.push("series = ?"); binds.push(series); }
  if (locale != null) { where.push("locale = ?"); binds.push(locale); }
  const r = await env.DB.prepare(`SELECT ${COLS} FROM podcast_episodes WHERE ${where.join(" AND ")} ORDER BY published_at DESC LIMIT ?`).bind(...binds, limit).all();
  return r.results || [];
}

/** Is speech synthesis usable in this environment? (ttsConfigured from @saasreport/podcast when wired.) */
export function ttsReady(k, env) {
  if (!env.PODCAST_WF) return false;
  if (k.deps.ttsConfigured) return Boolean(k.deps.ttsConfigured(k.rawConfig, env));
  const p = env.TTS_PROVIDER || k.config.tts?.provider;
  if (p === "gemini" || !p) return Boolean(env.GEMINI_API_KEY);
  return Boolean(env.TTS_URL);
}

/**
 * Episode for a series item, glossary categories included (episodeFromItem from @saasreport/podcast when wired; a plain fallback otherwise).
 * In a non-default locale the slug is the stored one ("ar/<slug>").
 */
export function episodeFor(k, series, item, opts = {}) {
  const ep = episodeOne(k, series, item, opts);
  return k.loc?.prefix ? { ...ep, slug: k.dbSlug(ep.slug) } : ep;
}
function episodeOne(k, series, item, { number = null, ref = null } = {}) {
  const raw = (k.rawConfig.series || []).find((x) => x.id === series.id) || series;
  const categories = series.kind === "term" ? k.c.categoriesOf(series.id) : undefined;
  if (k.deps.episodeFromItem) return k.deps.episodeFromItem(k.rawConfig, raw, item, { number, ref: ref ?? undefined, calendarBit: k.calendarBit, categories });
  const r = ref ?? item.date ?? item.slug ?? item.month;
  const lines = (item.talk || []).map((l) => (Array.isArray(l) ? { speaker: l[0], text: l[1] } : l));
  return { slug: `${series.id}-${r}`, kind: series.kind, series: series.id, show: series.podcast?.show || series.id, number, title: item.title || item.term,
    summary: item.summary || item.short || "", lines, source_type: series.kind, source_ref: r };
}

/**
 * Insert (or, with force, re-queue) an episode row and start its PodcastWorkflow run. A re-queue keeps a Persian-gate error
 * ("persian: …"): the script step feeds those findings back to the model (docs/PERSIAN.md).
 * The t=0 rule: the spec must validate (kit.podcast-episode.v1) and the row carries a pipeline provenance record
 * (kit.podcast-provenance.v1); the database refuses a row without one (migration 0008). `provenance` is built by the
 * caller that queued the episode (the scheduled run); there is no default, so no code path can add an episode "by hand".
 */
export async function createEpisode(k, env, { series, ep, publishAt = null, force = false, provenance }) {
  const specProblems = checkEpisodeSpec(ep);
  if (specProblems.length) throw new Error(`episode ${ep?.slug}: spec invalid: ${specProblems.slice(0, 3).join("; ")}`);
  const provProblems = provenance ? checkProvenance(provenance) : ["missing"];
  if (provProblems.length) throw new Error(`episode ${ep.slug}: no valid pipeline provenance record (${provProblems[0]})`);
  const prov = JSON.stringify(provenance);
  const existing = await env.DB.prepare("SELECT slug, status FROM podcast_episodes WHERE slug = ?").bind(ep.slug).first();
  if (existing && !force) return { slug: ep.slug, status: existing.status, created: false };
  const now = k.now().toISOString();
  const script = ep.lines?.length ? JSON.stringify(ep.lines) : null;
  const show = ep.show || series.podcast?.show || series.id;
  if (existing) {
    await env.DB.prepare("UPDATE podcast_episodes SET title = ?, summary = ?, script_json = ?, script_model = ?, status = 'queued', error = CASE WHEN error LIKE 'persian:%' THEN error ELSE NULL END, provenance_json = ?, updated_at = ? WHERE slug = ?")
      .bind(ep.title, ep.summary || "", script, ep.model ?? (script ? "content" : null), prov, now, ep.slug).run();
  } else if (k.loc) {
    await env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, number, kind, title, summary, source_type, source_ref, script_json, script_model, status, published_at, created_at, updated_at, locale, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).bind(ep.slug, ep.series || series.id, show, ep.number ?? null, ep.kind || series.kind, ep.title, ep.summary || "",
      ep.source_type || series.kind, ep.source_ref ?? null, script, ep.model ?? (script ? "content" : null), publishAt, now, now, k.loc.db, prov).run();
  } else {
    await env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, number, kind, title, summary, source_type, source_ref, script_json, script_model, status, published_at, created_at, updated_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).bind(ep.slug, ep.series || series.id, show, ep.number ?? null, ep.kind || series.kind, ep.title, ep.summary || "",
      ep.source_type || series.kind, ep.source_ref ?? null, script, ep.model ?? (script ? "content" : null), publishAt, now, now, prov).run();
  }
  // Workflow instance ids take no "/": a stored "ar/<slug>" becomes "ar-<slug>"; the payload names the locale's config.
  const instance = await env.PODCAST_WF.create({ id: `${ep.slug.replace(/\//g, "-")}-${Date.now().toString(36)}`, params: k.loc ? { slug: ep.slug, locale: k.loc.key } : { slug: ep.slug } });
  await env.DB.prepare("UPDATE podcast_episodes SET workflow_id = ? WHERE slug = ?").bind(instance.id, ep.slug).run();
  return { slug: ep.slug, status: "queued", created: true, workflow_id: instance.id };
}

/** The accepted-origins policy (podcast.config.json "provenance", via createKit options.podcasts.policy). */
export const policyOf = (k) => ({ origins: ["cron", "cron-retry"], ...(k.config.podcasts?.policy?.provenance || {}) });
/** The catch-up settings of the project (podcast.config.json "catchup", via options.podcasts.policy). */
export const catchupOf = (k) => ({ enabled: false, windowDays: 7, ...(k.config.podcasts?.policy?.catchup || {}) });

/** The slug an episode of a due entry gets (episodeFromItem's rule, without building the script). */
function slugOf(k, series, e) {
  const ref = e.key ?? e.item?.date ?? e.item?.slug ?? e.item?.month;
  const slug = String(series.podcast?.slug ?? "{series}-{ref}").replace(/\{(\w+)\}/g, (m, key) => ({ series: series.id, ref })[key] ?? m);
  return k.loc?.prefix ? k.dbSlug(slug) : slug;
}

/**
 * The episode a due (series, day) already has, whatever its name. The day is the SITE-LOCAL day of published_at (the project's timezone, as the
 * planner counts days), never its UTC date. A published row always wins; otherwise the row with the expected slug; otherwise any other row of
 * that series and day (a legacy or renamed one). → { slug, status } | null. `rows`: the series' rows { slug, status, published_at }.
 */
export function existingFor(k, rows, day, slug) {
  const same = rows.filter((r) => r.published_at && k.dayOf(new Date(r.published_at)) === day);
  const exact = rows.find((r) => r.slug === slug);
  const pub = same.find((r) => r.status === "published") || (exact?.status === "published" ? exact : null);
  return pub || exact || same[0] || null;
}

/** The rows of one series (this locale's only) for existingFor. */
async function seriesRows(k, env, seriesId) {
  const r = await env.DB.prepare(`SELECT slug, status, published_at${k.loc ? ", locale" : ""} FROM podcast_episodes WHERE series = ?`).bind(seriesId).all();
  return (r.results || []).filter((x) => (k.loc ? x.locale === k.loc.db : true));
}
export const existingEpisode = async (k, env, series, day, slug) => existingFor(k, await seriesRows(k, env, series.id), day, slug);

/**
 * Every due podcast day from yesterday back `span` days (default: back to the project's first podcast series start) with the state of
 * its episode: [{ day, date, series, slug, state, existing }], newest first. state: "published" | "missing" (no row) | "failed" | "queued" | ...
 * An episode exists for a due day by (series, day), never by the name alone; a published row always wins. The catch-up fills "missing" and
 * "failed" days inside its window (a failed row under another name is re-queued, not twinned); the audit reports every day that is not
 * "published", whatever its age.
 */
export async function dueEpisodes(k, env, { today = k.today(), span = null } = {}) {
  const out = [];
  if (!k.config.features.podcasts) return out;
  const starts = k.config.series.filter((s) => s.podcast && s.start).map((s) => Math.floor(Date.parse(`${s.start}T00:00:00Z`) / 864e5));
  const back = span ?? (starts.length ? Math.min(Math.max(today - Math.min(...starts), 0), 1500) : 7);
  const all = (await env.DB.prepare(`SELECT slug, status, series, published_at${k.loc ? ", locale" : ""} FROM podcast_episodes`).all()).results || [];
  const bySeries = new Map();
  for (const r of all) if (!k.loc || r.locale === k.loc.db) { if (!bySeries.has(r.series)) bySeries.set(r.series, []); bySeries.get(r.series).push(r); }
  for (let d = today - 1; d >= today - back; d--) {
    for (const e of await k.c.due(d)) {
      const series = k.config.series.find((x) => x.id === (e.series?.id || e.series));
      if (!series?.podcast || !e.item) continue;
      const slug = slugOf(k, series, e);
      const found = existingFor(k, bySeries.get(series.id) || [], d, slug);
      out.push({ day: d, date: new Date(d * 864e5).toISOString().slice(0, 10), series: series.id, slug, state: found?.status ?? "missing", existing: found?.slug ?? null });
    }
  }
  return out;
}
/** Days the catch-up may fill: no row, or a failed render. */
export const missingDays = async (k, env, opts) => (await dueEpisodes(k, env, opts)).filter((m) => m.state === "missing" || m.state === "failed");

/** Every published episode's provenance verdict, not just the newest page: { published, unaccepted, problems: [{slug, problem}] (first 20) }. */
async function auditProvenance(k, env, policy, loc) {
  const r = await env.DB.prepare(`SELECT slug, published_at, provenance_json FROM podcast_episodes WHERE status = 'published'${loc != null ? " AND locale = ?" : ""}`).bind(...(loc != null ? [loc] : [])).all();
  const rows = r.results || [], problems = [], catchup = [];
  for (const e of rows) { const problem = provenanceProblem(e, policy); if (problem) problems.push({ slug: e.slug, problem }); if (originOf(e) === "catchup") catchup.push(e.slug); }
  // Every due day without a PUBLISHED episode, whatever its state or age, back to the project's podcast start: the catch-up window limits the
  // automatic retries, never what the audit (and so the monitor) can see.
  const missing = (await dueEpisodes(k, env)).filter((m) => m.state !== "published");
  return { published: rows.length, unaccepted: problems.length, problems: problems.slice(0, 20), catchup: { count: catchup.length, slugs: catchup.slice(0, 20) },
    missing: missing.slice(0, 20), missing_count: missing.length, catchup_window_days: catchupOf(k).windowDays };
}
const originOf = (e) => { try { return JSON.parse(e.provenance_json || "null")?.origin ?? null; } catch { return null; /* a provenance record that is not JSON has no origin; its check reports it */ } };

/** The part of the config that decides how an episode sounds: hashed into the provenance record. */
export const soundOf = (k) => ({ tts: k.rawConfig.tts ?? null, hosts: k.rawConfig.hosts ?? null, language: k.rawConfig.site?.locale ?? null });

/**
 * Queue one episode as the pipeline: validates the spec, writes the provenance record. `origin` "cron" for a fresh episode,
 * "cron-retry" when the scheduled run re-queues one whose render failed, "catchup" when the scheduled run fills a past day (missedDate), "admin" for the (policy-gated) admin route.
 */
export async function queueEpisode(k, env, { series, ep, publishAt = null, origin = "cron", scheduledAt = null, missedDate = null, force = false }) {
  const provenance = await buildProvenance({ origin, scheduledAt: origin === "admin" ? undefined : scheduledAt ?? k.now(), missedDate: origin === "catchup" ? missedDate : undefined, ep, series: series.id, config: soundOf(k), engine: "@saasreport/cloudflare scheduled" });
  return createEpisode(k, env, { series, ep, publishAt, force, provenance });
}

export function createPodcasts(k) {
  const { t, d, config } = k;
  const shows = Object.values(config.shows);
  const H = k.href, u = (e) => k.urlSlug(e.slug), loc = k.loc?.db ?? null;
  const clock = (ms) => { const s = Math.round((ms || 0) / 1000); return d(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`); };
  const speaker = (key) => config.hosts?.[key]?.name || key;
  const showOf = (e) => config.shows[e.show] || config.shows[e.series] || shows[0] || null;
  const coverOf = (sh) => (sh?.cover1400 ? k.abs(sh.cover1400) : sh?.cover ? k.abs(sh.cover) : config.site.ogImage ? k.abs(config.site.ogImage) : null);
  const P = config.podcasts;
  /** Duration as a clock (1:36) or, for shows with duration: "minutes", as whole minutes (podcasts.minutes). */
  const length = (e, sh = showOf(e)) => (sh?.duration === "minutes" ? t("podcasts.minutes", { n: Math.max(1, Math.round((e.duration_ms || 0) / 60000)) }) : clock(e.duration_ms));
  const badge = (sh, cls = "") => (sh?.badge ? `<span class="kb${sh.badgeClass ? ` ${esc(sh.badgeClass)}` : ""}${cls}">${esc(sh.badge)}</span>` : "");
  const feedLabel = (sh) => (t.opt("podcasts.feedOf", { short: sh.short ?? sh.title, show: sh.title }) || t("podcasts.feed"));
  const ogOf = (o) => (o?.image ? { image: o.image, ...(o.alt ? { alt: o.alt } : {}) } : {});

  const player = (e, { big = false, title = !big } = {}) => `
<div class="pp${big ? " pp--big" : ""}" data-pp data-duration="${e.duration_ms || 0}">
  <button class="pp__play" type="button" aria-label="${esc(`${t("podcasts.play")} ${e.title}`)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M8 5.5v13l10.5-6.5z"/><path class="i-pause" d="M7.5 5h3v14h-3zM13.5 5h3v14h-3z"/></svg></button>
  <div class="pp__main">
    ${title ? `<a class="pp__title" href="${H("/podcasts/")}${esc(u(e))}">${esc(e.title)}</a>` : ""}
    <div class="pp__rail"><span class="pp__fill"></span><span class="pp__knob"></span><input class="pp__seek" type="range" min="0" max="1000" value="0" step="1" aria-label="${esc(t("podcasts.seek"))}"></div>
    <div class="pp__row">
      <span class="pp__time"><span class="pp__cur">${d("0:00")}</span> / <span class="pp__dur">${clock(e.duration_ms)}</span></span>
      <span class="pp__ctl">
        <button type="button" class="pp__btn" data-skip="-15" aria-label="${esc(t("podcasts.back"))}">−${d(15)}</button>
        <button type="button" class="pp__btn" data-skip="15" aria-label="${esc(t("podcasts.fwd"))}">+${d(15)}</button>
        <button type="button" class="pp__btn pp__rate" aria-label="${esc(t("podcasts.rate"))}">${d(1)}×</button>
        <a class="pp__btn" href="${H("/podcasts/audio/")}${esc(u(e))}.mp3" download aria-label="${esc(t("podcasts.download"))}">${icon("down")}</a>
      </span>
    </div>
  </div>
  <audio preload="none" src="${H("/podcasts/audio/")}${esc(u(e))}.mp3"></audio>
</div>`;

  const T = k.tagsUi?.on ? k.tagsUi : null;
  /** An episode card. With tags on, `tags` (ids) are its chips and `data-tags` / `data-q` feed the browser filter (assets/tags.js). */
  const card = (e, { tags = null } = {}) => `<article class="epcard"${T && tags ? ` data-slug="${esc(u(e))}" data-show="${esc(e.show || "")}" data-tags="${esc(tags.join(" "))}" data-q="${esc(T.parts(e, tags).join(" "))}"` : ""}>
  <span class="epcard__no" aria-hidden="true">${e.number ? d(e.number) : ""}</span>
  <div class="epcard__body">${badge(showOf(e))}<h3><a href="${H("/podcasts/")}${esc(u(e))}">${esc(e.title)}</a></h3><p>${esc(e.summary)}</p>
    <span class="meta">${icon("cal")}${esc(t("podcasts.cardMeta", { date: k.fmtDate(e.published_at), duration: length(e) }))}</span>
    ${T && tags ? T.chips(tags, { cls: "tags--sm" }) : ""}
    ${player(e, { title: false })}</div></article>`;

  const feedLinks = (sh) => `<div class="links">
  <a class="btn btn--ghost btn--sm" href="${esc(H(sh.feed))}">${icon("rss")}${esc(feedLabel(sh))}</a>
  <button class="btn btn--ghost btn--sm" type="button" data-copy-url="${esc(k.abs(sh.feed))}">${icon("copy")}${esc(t("podcasts.copyFeed"))}</button>
</div>`;

  const seriesLd = (sh) => ({ "@type": "PodcastSeries", "@id": k.abs(`/podcasts/#${sh.id}`), name: sh.title, description: sh.description, url: k.abs(`/podcasts/#${sh.id}`),
    webFeed: k.abs(sh.feed), inLanguage: config.site.localeBase, ...(coverOf(sh) ? { image: coverOf(sh) } : {}), author: k.orgRef(), publisher: k.orgRef() });

  /** One show's section: its latest card, then the rest. `rows` already carry `.tags` when tags are on. */
  const section = (sh, rows, { filtered = false } = {}) => {
    const cardOf = (e) => card(e, { tags: T ? e.tags : null });
    const [latest, ...rest] = rows;
    return `<section class="wrap podshow" id="${esc(sh.id)}" data-show="${esc(sh.id)}">
  <h2 class="sec">${esc(sh.heading ?? sh.title)}${sh.cadence ? ` <small>${esc(sh.cadence)}</small>` : ""}</h2>
  ${sh.description ? `<p class="lead">${esc(sh.description)}</p>` : ""}${feedLinks(sh)}${sh.more || ""}
  ${latest ? `${cardOf(latest)}${rest.length ? `<div class="eplist">${rest.map(cardOf).join("")}</div>` : ""}` : filtered ? "" : sh.empty ? `<div class="empty empty--box"><b>${esc(t("podcasts.empty"))}</b><p>${esc(sh.empty)}</p></div>` : `<p class="empty empty--box">${esc(t("podcasts.empty"))}</p>`}
</section>`;
  };

  async function index(env, url) {
    let sections, bar = "", scripts = ["podcast.js"], lists;
    if (T) {
      // Every published episode with its tags: the server filters first and limits after, so a filter reaches every episode of a show.
      const filter = T.parseFilter(url);
      const all = await listEpisodes(env, { limit: T.MAX_ROWS, locale: loc });
      const tagMap = await T.episodeTags(env, all);
      const rows = all.map((e) => ({ ...e, tags: tagMap.get(e.slug) || [] }));
      const hit = T.matching(rows, filter, (e) => e.tags).filter((e) => !filter.show || e.show === filter.show);
      const on = T.active(filter);
      const byShow = (sh) => hit.filter((e) => e.show === sh.id);
      lists = shows.map((sh) => (on ? byShow(sh) : byShow(sh).slice(0, sh.limit || 30)));
      const truncated = !on && shows.some((sh) => byShow(sh).length > (sh.limit || 30));
      const present = [...new Set(rows.flatMap((e) => e.tags))].filter((id) => k.tags.has(id)).sort((a, b) => k.tags.tags.findIndex((x) => x.id === a) - k.tags.tags.findIndex((x) => x.id === b));
      bar = T.bar({ path: "/podcasts/", filter, tagIds: present, catalogue: !on && !truncated, toggles: [{ param: "show", label: t("tags.shows"), items: shows.map((sh) => [sh.id, sh.short ?? sh.title]) }] });
      sections = shows.map((sh, i) => (filter.show && filter.show !== sh.id) || (on && !lists[i].length) ? "" : section(sh, lists[i], { filtered: on })).filter(Boolean).join("\n");
      const none = !lists.some((l) => l.length) && on;
      sections += `\n<div class="wrap"><p class="empty empty--box" data-tags-none${none ? "" : " hidden"}>${esc(t("tags.none"))}</p></div>`;
      scripts = ["podcast.js", "tags.js"];
    } else {
      lists = await Promise.all(shows.map((sh) => listEpisodes(env, { show: sh.id, limit: sh.limit || 30, locale: loc })));
      sections = shows.map((sh, i) => section(sh, lists[i])).join("\n");
    }
    const lead = P.lead || t("podcasts.lead");
    const cover = P.cover ? `<img class="hero__cover" src="${esc(P.cover.src)}"${P.cover.width ? ` width="${esc(P.cover.width)}"` : ""}${P.cover.height ? ` height="${esc(P.cover.height)}"` : ""} alt="${esc(P.cover.alt || "")}">` : "";
    const hero = k.hero("podcasts", { lead });
    const body = `${cover ? hero.replace('<section class="hero wrap">', '<section class="hero hero--cover wrap"><div>').replace(/<\/section>$/, `</div>\n  ${cover}</section>`) : hero}\n${bar}\n${sections}`;
    const jsonld = k.graph(...shows.map(seriesLd), k.crumbs([[t("nav.home"), "/"], [t("podcasts.title"), "/podcasts/"]]));
    return html(k.page({ title: k.pageTitle("podcasts", t("podcasts.title")), description: t.opt("podcasts.description") || lead, path: "/podcasts/", body, active: "podcasts", jsonld, placement: "podcasts", og: ogOf(P.og),
      head: shows.map((sh) => `<link rel="alternate" type="application/rss+xml" title="${esc(sh.title)}" href="${esc(H(sh.feed))}">`).join(""), scripts }));
  }

  const getEpisode = (env, slug) => env.DB.prepare("SELECT * FROM podcast_episodes WHERE slug = ? AND status = 'published'").bind(slug).first();

  async function episodePage(env, slug) {
    const e = await getEpisode(env, slug);
    if (!e) return null;
    const lines = parseJSON(e.script_json, []);
    const sh = showOf(e);
    const url = k.abs(`/podcasts/${u(e)}`);
    const g = await k.c.glossary();
    const term = g && e.series === g.series.id ? g.bySlug.get(e.source_ref) : null;
    // The written version: the post the episode was made from (article episodes), or the post of the same slug (a topic's post).
    const fromPost = e.source_type === "post";
    const post = !term && config.features.blog ? await env.DB.prepare("SELECT slug, title FROM posts WHERE slug IN (?, ?) AND status = 'published' ORDER BY slug = ? DESC LIMIT 1")
      .bind(fromPost ? e.source_ref : e.slug, e.source_ref || e.slug, fromPost ? e.source_ref : e.slug).first() : null;
    const tagIds = T ? (await T.episodeTags(env, [e])).get(e.slug) || [] : [];
    const item = `episode:${e.slug}`;
    const agg = config.features.reactions ? (await aggregates(env, [item]))[item] : undefined;
    const speakers = [...new Set(lines.map((l) => l.speaker))].map((s) => config.hosts?.[s]).filter(Boolean);
    // podcasts.term / podcasts.post / podcasts.article may contain HTML; {term} and {title} are links, {name}, {slug} plain (escaped).
    const about = term && config.features.glossary ? `<p class="note">${t("podcasts.term", { term: `<a href="${H("/glossary/")}${esc(term.slug)}">${esc(term.term || term.name)}</a>`, name: esc(term.term || term.name), slug: esc(term.slug) })}</p>`
      : post ? `<p class="note">${t(fromPost && t.has("podcasts.article") ? "podcasts.article" : "podcasts.post", { title: `<a href="${H("/blog/")}${esc(k.urlSlug(post.slug))}">${esc(post.title)}</a>`, name: esc(post.title), slug: esc(k.urlSlug(post.slug)) })}</p>` : "";
    const body = `
<article class="wrap post">
  <nav class="crumbs" aria-label="${esc(t("crumbs"))}"><a href="${H("/podcasts/")}">${esc(t("podcasts.title"))}</a><span>/</span>${P.crumbShow === false ? `<span>${esc(t("podcasts.episode", { n: e.number || "" }))}</span>` : sh ? `<a href="${H("/podcasts/")}#${esc(sh.id)}">${esc(sh.title)}</a>` : ""}</nav>
  <header class="post__head">${sh?.badge ? badge(sh) : e.number ? `<span class="kb">${esc(t("podcasts.episode", { n: e.number }))}</span>` : ""}<h1>${esc(e.title)}</h1><p class="lead">${esc(e.summary)}</p>
    <div class="meta"><span>${icon("cal")}<time datetime="${esc(e.published_at)}">${esc(k.fmtDate(e.published_at))}</time></span><span>${icon("clock")}${length(e, sh)}</span>${speakers.length ? `<span>${speakers.map((h) => esc(h.role ? `${h.name} (${h.role})` : h.name)).join(t("podcasts.speakerSep"))}</span>` : ""}</div></header>
  ${T ? T.chips(tagIds) : ""}
  ${player(e, { big: true })}
  <div class="post__grid">
    <div class="post__body">
      <h2 class="sec">${esc(t("podcasts.transcript"))}</h2>
      <ol class="tscript" data-transcript>${lines.map((l) => `<li data-start="${l.start_ms ?? ""}" class="tscript__l" data-speaker="${esc(l.speaker)}"><b>${esc(speaker(l.speaker))}</b><p>${esc(l.text)}</p></li>`).join("")}</ol>
      ${reactionsBlock(k, { item, url, title: e.title, agg })}
    </div>
    <aside class="aside"><b>${esc(t("podcasts.about"))}</b>${about}<p class="note">${esc(t("podcasts.aiVoices"))}</p>${sh ? feedLinks(sh) : ""}</aside>
  </div>
</article>`;
    const audio = k.abs(`/podcasts/audio/${u(e)}.mp3`);
    const og = P.itemOg || P.og;
    const ld = { "@type": "PodcastEpisode", "@id": `${url}#episode`, name: e.title, description: e.summary, url, datePublished: e.published_at, ...(e.number ? { episodeNumber: e.number } : {}),
      inLanguage: config.site.localeBase, timeRequired: `PT${Math.max(1, Math.round((e.duration_ms || 0) / 60000))}M`,
      associatedMedia: { "@type": "MediaObject", contentUrl: audio, encodingFormat: "audio/mpeg" },
      ...(sh ? { partOfSeries: { "@type": "PodcastSeries", "@id": k.abs(`/podcasts/#${sh.id}`), name: sh.title, webFeed: k.abs(sh.feed) } } : {}),
      ...(term ? { about: { "@type": "DefinedTerm", "@id": k.abs(`/glossary/${term.slug}#term`), name: term.term || term.name } } : {}),
      ...(tagIds.length ? { keywords: T.labelList(tagIds).join(t("blog.keywordSep")) } : {}),
      ...(og?.image ? { image: k.abs(og.image) } : {}), publisher: k.orgRef(), transcript: lines.map((l) => `${speaker(l.speaker)}: ${l.text}`).join("\n") };
    const epTitle = sh?.itemTitle ? String(sh.itemTitle).replace(/\{(\w+)\}/g, (m, key) => ({ title: e.title, show: sh.title, short: sh.short ?? sh.title, term: term ? term.term || term.name : e.title, site: config.site.name })[key] ?? m)
      : `${e.title} | ${sh ? sh.title : config.site.name}`;
    return html(k.page({ title: epTitle, description: e.summary, path: `/podcasts/${u(e)}`, body, active: "podcasts",
      jsonld: k.graph(ld, k.crumbs([[t("nav.home"), "/"], [t("podcasts.title"), "/podcasts/"], [e.title, `/podcasts/${u(e)}`]])),
      og: { type: "article", title: e.title, ...(og?.image ? { image: og.image } : {}), published: e.published_at, section: t.opt("podcasts.section") || sh?.title, audio, ...(tagIds.length ? { tags: T.labelList(tagIds) } : {}) },
      head: `${tagIds.length ? `<meta name="kit:tags" content="${esc(tagIds.join(" "))}">` : ""}${sh ? `<link rel="alternate" type="application/rss+xml" title="${esc(sh.title)}" href="${esc(H(sh.feed))}">` : ""}<link rel="alternate" type="text/markdown" title="Markdown" href="${H("/podcasts/")}${esc(u(e))}.md">`,
      scripts: ["podcast.js"] }));
  }

  /** The Markdown twin of an episode; `tagIds` (resolved by the caller: episodeTags) go into the front matter. */
  function episodeMd(e, tagIds = []) {
    const lines = parseJSON(e.script_json, []);
    return `---
title: ${JSON.stringify(e.title)}
type: podcast episode${e.number ? ` ${e.number}` : ""}
published: ${e.published_at}
url: ${k.abs(`/podcasts/${u(e)}`)}
audio: ${k.abs(`/podcasts/audio/${u(e)}.mp3`)}
voices: synthetic (AI-generated speech)
${T ? T.front(tagIds) : ""}---

# ${e.title}

> ${e.summary}

## ${config.llms.transcriptHeading ?? t("podcasts.transcript")}

${lines.map((l) => `**${speaker(l.speaker)}:** ${l.text}`).join("\n\n")}
`;
  }

  async function feed(env, sh) {
    const eps = await listEpisodes(env, { show: sh.id, limit: 500, locale: loc });
    const show = { ...sh, key: sh.id, page: `/podcasts/#${sh.id}`, cover: sh.cover || config.site.ogImage || null };
    const tagMap = T ? await T.episodeTags(env, eps) : new Map();
    const body = await podcastRss(k.rawConfig, show, eps.map((e) => ({ ...e, url: `/podcasts/${u(e)}`, audio_url: `/podcasts/audio/${u(e)}.mp3`, ...(T ? { categories: T.labelList(tagMap.get(e.slug) || []) } : {}) })), { ownerEmail: sh.email || sh.ownerEmail || env.PODCAST_OWNER_EMAIL });
    return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=600", "access-control-allow-origin": "*" } });
  }

  async function audio(request, env, slug) {
    if (!env.PODCASTS) return null;
    const key = `podcasts/${slug}.mp3`;
    const head = await env.PODCASTS.head(key);
    if (!head) return null;
    const size = head.size;
    const base = { "content-type": "audio/mpeg", "accept-ranges": "bytes", ...(head.httpEtag ? { etag: head.httpEtag } : {}), "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" };
    const m = (request.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
      const obj = request.method === "HEAD" ? null : await env.PODCASTS.get(key, { range: { offset: start, length: end - start + 1 } });
      return new Response(obj?.body ?? null, { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
    }
    const obj = request.method === "HEAD" ? null : await env.PODCASTS.get(key);
    return new Response(obj?.body ?? null, { headers: { ...base, "content-length": String(size) } });
  }

  /* ---------------------------------------------------------------- admin */
  // Daemon-owned ADMIN_TOKEN and independently provisioned optional PODCAST_ADMIN_TOKEN
  // are two distinct, auditable authorities. A generated daemon token must never
  // silently shadow a caller-provisioned key used by the Kit CLI.
  const authorized = async (request, env) => {
    const presented = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!presented) return false;
    // safeEqual hashes asynchronously. An unawaited Promise is truthy and
    // would silently authorize any non-empty bearer; do not coerce it.
    const [daemon, operator] = await Promise.all([
      safeEqual(presented, env.ADMIN_TOKEN),
      safeEqual(presented, env.PODCAST_ADMIN_TOKEN),
    ]);
    return daemon || operator;
  };

  /** {item, number, ref, publishAt} for a series and a reference (date, month key, term slug or entry slug). */
  async function findItem(series, ref) {
    const plan = await k.c.plan();
    if (plan?.find) {
      const e = plan.find(series.id, ref);
      if (e?.item) return { item: e.item, number: e.number ?? null, ref: e.key ?? null, publishAt: e.publishAt };
    }
    const items = await k.c.items(series.id);
    const hit = items.find((x) => x && (x.slug === ref || x.date === ref || x.month === ref));
    return hit ? { item: hit, number: series.kind === "term" ? items.indexOf(hit) + 1 : null, ref: hit.date ?? hit.slug ?? hit.month } : null;
  }

  async function admin(request, env, p) {
    if (!(await authorized(request, env))) return json({ ok: false, error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (p === "/api/podcasts/generate") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      // Owner rule (t=0): episodes are made by the scheduled run only. A project's podcast.config.json says "manual": false (the only
      // value kit.podcast-config.v1 allows) and passes it as createKit options.podcasts.policy; sites without a policy keep the route,
      // and what it makes carries origin "admin", which the monitor and the tests reject.
      if (k.config.podcasts?.policy?.manual === false) return json({ ok: false, error: "manual_generation_disabled", hint: "episodes are generated by the cron (docs: t=0 rule)" }, 403);
      if (!ttsReady(k, env)) return json({ ok: false, error: "tts_not_configured" }, 409);
      const { value: parsed, response: refused } = await readJsonBody(request, { fallback: {} });
      if (refused) return refused;
      const body = parsed ?? {};
      // { post: "<slug>" }: the audio version of a published blog post (script drafted by Workers AI in the workflow).
      if (body.post != null) {
        if (!k.deps.articleEpisode || !config.features.blog) return json({ ok: false, error: "articles_not_supported" }, 422);
        const post = await env.DB.prepare("SELECT slug, title, summary FROM posts WHERE slug = ? AND status = 'published'").bind(k.dbSlug(String(body.post))).first();
        if (!post) return json({ ok: false, error: "post_not_found" }, 422);
        const a = k.deps.articleEpisode(k.rawConfig, k.loc?.prefix ? { ...post, slug: k.urlSlug(post.slug) } : post);
        const ep = k.loc?.prefix ? { ...a, slug: k.dbSlug(a.slug), source_ref: post.slug } : a;
        const series = config.series.find((s) => s.id === ep.series && s.podcast);
        if (!series) return json({ ok: false, error: "no_article_series" }, 422);
        return json({ ok: true, ...(await queueEpisode(k, env, { series, ep, force: body.force === true, origin: "admin" })) });
      }
      const series = config.series.find((s) => s.id === body.series && s.podcast);
      if (!series) return json({ ok: false, error: "unknown_series", series: config.series.filter((s) => s.podcast).map((s) => s.id) }, 422);
      const found = await findItem(series, String(body.ref || ""));
      if (!found) return json({ ok: false, error: "item_not_found" }, 422);
      let ep;
      try { ep = episodeFor(k, series, found.item, { number: found.number, ref: found.ref }); } catch (e) { return json({ ok: false, error: "script_failed", detail: String(e?.message || e) }, 422); }
      return json({ ok: true, ...(await queueEpisode(k, env, { series, ep, publishAt: found.publishAt || null, force: body.force === true, origin: "admin" })) });
    }
    const m = p.match(/^\/api\/podcasts\/admin\/([a-z0-9-]{1,90})$/);
    if (m && request.method === "GET") {
      const ep = await env.DB.prepare("SELECT slug, series, show, status, error, workflow_id, script_model, duration_ms, audio_bytes, published_at, updated_at FROM podcast_episodes WHERE slug = ?").bind(k.dbSlug(m[1])).first();
      if (!ep) return json({ ok: false, error: "not_found" }, 404);
      let workflow = null;
      if (ep.workflow_id && env.PODCAST_WF) workflow = await env.PODCAST_WF.get(ep.workflow_id).then((i) => i.status()).catch((err) => ({ error: String(err) }));
      return json({ ok: true, episode: ep, workflow });
    }
    if (p === "/api/podcasts/admin" && request.method === "GET") {
      const [lw, lb] = k.where();
      const rows = (await env.DB.prepare(`SELECT slug, series, show, status, error, updated_at FROM podcast_episodes${lw ? ` WHERE${lw.slice(4)}` : ""} ORDER BY updated_at DESC LIMIT 50`).bind(...lb).all()).results || [];
      return json({ ok: true, tts_configured: ttsReady(k, env), episodes: rows });
    }
    return json({ ok: false, error: "not_found" }, 404);
  }

  async function handle(request, env, url) {
    const p = url.pathname;
    if (p === "/api/podcasts/generate" || p.startsWith("/api/podcasts/admin")) return admin(request, env, p);
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (p === "/podcasts" || p === "/podcast" || p === "/podcast/") return redirect(`${H("/podcasts/")}${url.search}`);
    if (p === "/podcasts/") return index(env, url);
    const sh = shows.find((s) => s.feed === p || `/podcasts/${s.id}/feed.xml` === p);
    if (sh) return feed(env, sh);
    if (p === "/api/podcasts") {
      const show = config.shows[url.searchParams.get("show")] ? url.searchParams.get("show") : null;
      const series = config.series.some((x) => x.id === url.searchParams.get("series")) ? url.searchParams.get("series") : null;
      const limit = clampInt(url.searchParams.get("limit"), 1, 50, 10);
      let eps = await listEpisodes(env, { show, series, limit: T ? T.MAX_ROWS : limit, locale: loc });
      const tagMap = T ? await T.episodeTags(env, eps) : new Map();
      if (T) eps = T.matching(eps, T.parseFilter(url), (e) => tagMap.get(e.slug) || []).slice(0, limit);
      return jsonRes(await k.api("podcasts", { ok: true, shows: shows.map((s) => ({ id: s.id, title: s.title, description: s.description, feed: k.abs(s.feed), url: k.abs(`/podcasts/#${s.id}`) })),
        episodes: eps.map((e) => ({ slug: u(e), show: e.show, series: e.series, number: e.number, title: e.title, summary: e.summary, duration_ms: e.duration_ms,
          published_at: e.published_at, published_label: k.fmtDate(e.published_at), url: k.abs(`/podcasts/${u(e)}`), audio: k.abs(`/podcasts/audio/${u(e)}.mp3`),
          ...(T ? { tags: tagMap.get(e.slug) || [], tag_labels: T.labelList(tagMap.get(e.slug) || []) } : {}),
          origin: originOf(e), provenance_problem: provenanceProblem(e, policyOf(k)) })),
        audit: await auditProvenance(k, env, policyOf(k), loc) }, { url, env, rows: eps, show, series }));
    }
    let m = p.match(/^\/podcasts\/audio\/([a-z0-9-]{1,90})\.mp3$/);
    if (m) return (await audio(request, env, k.dbSlug(m[1]))) || new Response("not found", { status: 404 });
    m = p.match(/^\/podcasts\/([a-z0-9-]{1,90})\.md$/);
    if (m) { const e = await getEpisode(env, k.dbSlug(m[1])); return e ? text(episodeMd(e, T ? (await T.episodeTags(env, [e])).get(e.slug) : []), "text/markdown", 3600, { "x-robots-tag": "noindex" }) : k.notFound(); }
    m = p.match(/^\/podcasts\/([a-z0-9-]{1,90})\/?$/);
    if (m) return (await episodePage(env, k.dbSlug(m[1]))) || k.notFound();
    return null;
  }

  return { handle, player, card, episodeMd, listEpisodes };
}
