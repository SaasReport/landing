import { digits, formatNumber } from "@saasreport/format";
import { formatJalali } from "@saasreport/calendar/instant";
/**
 * Message builders for posts, events and podcast episodes. Pure: everything project-specific comes from the
 * config (site name/url/locale/timezone, calendar system, config.strings.channels, config.channels.paths).
 *
 * Templates use {placeholders}; placeholder values are HTML-escaped, the template itself is trusted HTML
 * (Telegram's HTML subset). A plain-text rendering is produced alongside for email/webhooks.
 */

export const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const unescHtml = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]);
export const toPlain = (html) => unescHtml(String(html).replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();

export const DEFAULT_STRINGS = {
  fa: {
    post: "<b>{title}</b>\n\n{summary}\n\n{tags}",
    episode: "<b>پادکست: {title}</b>\n🎧 {minutes}\n\n{summary}\n\n{tags}",
    event: "<b>رویداد: {title}</b>\n🗓 {when}\n📍 {where}\n\n{summary}\n\n{tags}",
    postButton: "خواندن مطلب",
    episodeButton: "شنیدن قسمت",
    eventButton: "ثبت‌نام",
    minutes: "{n} دقیقه",
    online: "برخط",
    tbd: "اعلام می‌شود",
    tags: { post: "", episode: "پادکست", event: "رویداد" },
    kinds: { article: "مقاله", howto: "راهنما", analysis: "تحلیل", snapshot: "نمای خودکار", report: "گزارش", topic: "مقاله" },
  },
  en: {
    post: "<b>{title}</b>\n\n{summary}\n\n{tags}",
    episode: "<b>Podcast: {title}</b>\n🎧 {minutes}\n\n{summary}\n\n{tags}",
    event: "<b>Event: {title}</b>\n🗓 {when}\n📍 {where}\n\n{summary}\n\n{tags}",
    postButton: "Read the post",
    episodeButton: "Listen",
    eventButton: "Register",
    minutes: "{n} min",
    online: "Online",
    tbd: "To be announced",
    tags: { post: "", episode: "podcast", event: "event" },
    kinds: { article: "article", howto: "howto", analysis: "analysis", snapshot: "snapshot", report: "report", topic: "article" },
  },
};

export const DEFAULT_PATHS = { post: "/blog/{slug}", event: "/events/{slug}", episode: "/podcasts/{slug}" };

const lang = (config) => (String(config?.site?.locale || "en").toLowerCase().startsWith("fa") ? "fa" : "en");

/** Locale defaults merged with config.strings.channels (one level deep for tags/kinds). */
export function channelStrings(config = {}) {
  const base = DEFAULT_STRINGS[lang(config)];
  const over = config.strings?.channels || {};
  return { ...base, ...over, tags: { ...base.tags, ...(over.tags || {}) }, kinds: { ...base.kinds, ...(over.kinds || {}) } };
}

export const fill = (tpl, vars, esc = escHtml) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));

const hashtag = (s) => String(s || "").trim().replace(/[\s\-\u200c]+/g, "_").replace(/[^\p{L}\p{M}\p{N}_]/gu, "");

/** Hashtags: the per-kind tag, then config.channels.hashtags (default: the site name as a hashtag; false disables). */
function tags(config, first) {
  const cfg = config.channels?.hashtags;
  const extra = cfg === false ? [] : Array.isArray(cfg) ? cfg : typeof cfg === "string" ? [cfg] : [config.site?.name].filter(Boolean);
  return [first, ...extra].map(hashtag).filter(Boolean).map((t) => `#${t}`).join(" ");
}

const siteUrl = (config) => String(config.site?.url || "").replace(/\/+$/, "");
const absolute = (config, u) => (!u ? undefined : /^https?:\/\//.test(u) ? u : `${siteUrl(config)}${u.startsWith("/") ? "" : "/"}${u}`);
const linkFor = (config, kind, row) => absolute(config, fill((config.channels?.paths || {})[kind] || DEFAULT_PATHS[kind], { slug: row.slug }, (s) => encodeURIComponent(String(s))));

/** Human date-time of an ISO instant in the site's locale, calendar system and timezone (Solar Hijri by arithmetic). */
export function formatWhen(config, iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const locale = config.site?.locale || "en-US", timeZone = config.site?.timezone || "UTC";
  const options = { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" };
  const text = config.calendar?.system === "jalali"
    ? formatJalali(d, { locale, timeZone, ...options })
    : new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(d);
  return digits(text, config.site?.locale || "en");
}

// Numbers and digits: @saasreport/format, the kit's one formatter (CONSTITUTION.md §7).
const num = (config, n) => formatNumber(n, config.site?.locale || "en");

function build(config, kind, row, vars, button) {
  const s = channelStrings(config);
  const text = fill(s[kind], vars).replace(/\n{3,}/g, "\n\n").trim();
  const url = linkFor(config, kind, row);
  return {
    kind, title: row.title, subject: toPlain(fill(s[kind].split("\n")[0], vars)), text, plain: toPlain(text),
    button: url ? { label: button, url } : undefined,
    photo: absolute(config, row.cover || row.image || row.og_image || undefined),
    params: { ...vars, url, site_name: config.site?.name || "" },
  };
}

/** Blog post row: { slug, title, summary, kind?, cover? }. */
export function postMessage(config, row) {
  const s = channelStrings(config);
  const tag = s.kinds[row.kind] ?? s.tags.post;
  return build(config, "post", row, { title: row.title, summary: row.summary || "", tags: tags(config, tag) }, s.postButton);
}

/** Podcast episode row: { slug, title, summary, duration_ms, audio? }. */
export function episodeMessage(config, row) {
  const s = channelStrings(config);
  const minutes = fill(s.minutes, { n: num(config, Math.max(1, Math.round((row.duration_ms || 0) / 60000))) }, String);
  const m = build(config, "episode", row, { title: row.title, summary: row.summary || "", minutes, tags: tags(config, s.tags.episode) }, s.episodeButton);
  const audio = absolute(config, row.audio || row.audio_url);
  return audio ? { ...m, audio } : m;
}

/** Event row: { slug, title, summary, starts_at, format?, location? }. `when` overrides the formatted start. */
export function eventMessage(config, row, when) {
  const s = channelStrings(config);
  const where = row.format === "online" ? s.online : row.location || s.tbd;
  return build(config, "event", row, {
    title: row.title, summary: row.summary || "", when: when ?? formatWhen(config, row.starts_at), where, tags: tags(config, s.tags.event),
  }, s.eventButton);
}

export const BUILDERS = { post: postMessage, event: eventMessage, episode: episodeMessage };
