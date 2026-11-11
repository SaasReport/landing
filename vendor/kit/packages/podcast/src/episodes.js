/**
 * Episodes from content items. Pure: no I/O, no Workers APIs.
 *   topic item → intro + talk (+ calendar bit for weekly series) + outro
 *   term item  → intro ("episode N, today's term") + talk + outro
 * Speaker keys in content ("host"/"expert") are mapped to config.hosts keys.
 */
import { podcastStrings } from "./strings.js";
import { britishSpelling, unscoped } from "@saasreport/core/spelling";
import { mergeTurns, estimateMs } from "./speech.js";
import { hostKeys, speakerKey, showFor, seriesById, maxMsFor, fill, num } from "./config.js";

/** Normalize [["host", text], …] or [{speaker, text}, …] into [{speaker: hostsKey, text}]. */
export function talkLines(config, talk = []) {
  return (talk || []).map((t) => {
    const [speaker, text] = Array.isArray(t) ? t : [t.speaker, t.text];
    return { speaker: speakerKey(config, speaker), text: String(text ?? "").trim() };
  }).filter((l) => l.text);
}

/** Variables shared by every template. */
export function baseVars(config, series) {
  const [h, e] = hostKeys(config);
  const show = showFor(config, series);
  return {
    show: show.short ?? show.title, showTitle: show.title, site: config?.site?.name ?? "",
    host: config?.hosts?.[h]?.name ?? h ?? "", expert: config?.hosts?.[e]?.name ?? e ?? "",
    hostKey: h, expertKey: e, hostRole: config?.hosts?.[h]?.role ?? "", expertRole: config?.hosts?.[e]?.role ?? "",
  };
}

/** Template lines ([[key, tpl], …]) filled with vars. */
export const templateLines = (config, tpls, vars) => talkLines(config, (tpls || []).map(([k, t]) => [k, fill(t, vars)]));

/** Whether a series appends the calendar bit (weekly topic series unless series.podcast.calendar === false). */
export const wantsCalendar = (series) =>
  series?.podcast?.calendar ?? (series?.kind === "topic" && (series?.every === "week" || series?.every === "weekly"));

/**
 * Build an episode from a series item.
 * @param {object} config normalized kit config
 * @param {object|string} series a config.series entry (or its id)
 * @param {object} item content item (topic or term)
 * @param {{number?: number, calendarBit?: Function, categories?: {key: string, name: string}[], ref?: string}} [opts]
 *   calendarBit({config, series, item}) → {lines: [[key, text]]|[{speaker,text}], summary?} | null
 * @returns {{slug, kind, series, show, number, title, summary, lines, source_type, source_ref, maxSeconds, estimatedMs}}
 */
export function episodeFromItem(config, series, item, opts = {}) {
  if (typeof opts === "number") opts = { number: opts };
  const s = typeof series === "string" ? seriesById(config, series) : series;
  if (!s) throw new Error(`unknown series ${series}`);
  if (!item) throw new Error(`series ${s.id}: no item`);
  const S = podcastStrings(config, s), vars = baseVars(config, s);
  const number = opts.number ?? item.number ?? null;
  vars.number = number != null ? num(config, number) : "";
  let lines, title, summary, ref;

  if (s.kind === "topic") {
    const T = S.topic;
    ref = opts.ref ?? item.date ?? item.slug;
    Object.assign(vars, { title: item.title, summary: item.summary ?? "" });
    const bit = wantsCalendar(s) && typeof opts.calendarBit === "function" ? opts.calendarBit({ config, series: s, item }) : null;
    lines = [...templateLines(config, T.intro, vars), ...talkLines(config, item.talk), ...(bit ? talkLines(config, bit.lines) : []), ...templateLines(config, T.outro, vars)];
    title = fill(T.title, vars);
    summary = bit?.summary ? fill(T.summaryWithCalendar, { ...vars, calendar: bit.summary }) : fill(T.summary, vars);
  } else if (s.kind === "term") {
    const T = S.term;
    ref = opts.ref ?? item.slug;
    const cats = opts.categories ?? s.categories ?? [];
    const category = item.categoryName ?? cats.find((c) => c.key === item.category)?.name;
    Object.assign(vars, { term: item.term, short: item.short ?? "", category: category ?? "", title: item.term });
    lines = [...templateLines(config, T.intro, vars), ...talkLines(config, item.talk), ...templateLines(config, T.outro, vars)];
    title = fill(T.title, vars);
    summary = fill(category ? T.summary : T.summaryNoCategory, vars);
  } else {
    throw new Error(`series ${s.id}: kind "${s.kind}" has no podcast episodes`);
  }

  // British English projects (config.tts.spelling.variant): the spoken script is rewritten, so the voice and the transcript agree.
  if (config?.tts?.spelling?.variant === "en-GB") lines = lines.map((l) => ({ ...l, text: britishSpelling(l.text, { exceptions: unscoped(config.tts.spelling.exceptions) }) }));
  lines = mergeTurns(lines);
  const limit = maxMsFor(config, s);
  return {
    slug: fill(s.podcast?.slug ?? "{series}-{ref}", { series: s.id, ref }),
    kind: s.kind, series: s.id, show: showFor(config, s).id, number,
    title, summary, lines,
    source_type: s.kind, source_ref: ref,
    maxSeconds: limit == null ? null : limit / 1000,
    estimatedMs: estimateMs(lines, s.podcast?.cps ?? config?.tts?.charsPerSecond),
  };
}
