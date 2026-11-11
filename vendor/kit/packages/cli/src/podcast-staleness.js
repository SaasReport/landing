/**
 * Staleness class `podcast-behind-schedule` (kit check staleness, docs/FRESHNESS.md on the kit-freshness line; docs/PODCASTS.md):
 * the newest item of a series' live feed is older than the series cadence plus its grace. Cadence comes from kit.config.js (series[].every:
 * day, week, month), grace from podcast.config.json (schedule.graceMinutes): no literal lives in a project. A feed that cannot be read, has no
 * item, or a project that declares no grace is an `unreadable` finding, never fresh. 2026-10-14: the daily feeds of three downstream sites were ten
 * days old and every check said green.
 *
 *   podcastBehindSchedule(root, { now, deps: { fetch } }) → { class, checked: boolean, reason?, findings: [finding] }
 *   finding = { class, subject, observed, expected, age_days?, unreadable?, problem }   (the shape of kit.staleness-report.v1 findings)
 *
 * REGISTRATION: kit check staleness lives on branch claude/kit-freshness (not on main when this was written). Once it merges, add
 * PODCAST_BEHIND to its CLASSES and call podcastBehindSchedule from stalenessReport (add the findings, or na(class, reason) when `checked`
 * is false); nothing here depends on that module. test/podcast-staleness.test.mjs holds the must-fail cases.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "./project.js";
import { planner, dates } from "@saasreport/core";

export const PODCAST_BEHIND = "podcast-behind-schedule";
const DAY_MS = 86_400_000;
/** The longest a cadence can be, in days: a month is up to 31 days. The one place the lengths are written. */
export const CADENCE_DAYS = Object.freeze({ day: 1, week: 7, month: 31 });

/** The newest <pubDate> of an RSS document as a Date, or null. */
export function newestItem(xml) {
  const dates = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => Date.parse(/<pubDate>\s*([^<]+?)\s*<\/pubDate>/i.exec(m[0])?.[1])).filter((t) => !Number.isNaN(t));
  return dates.length ? new Date(Math.max(...dates)) : null;
}

export async function podcastBehindSchedule(root, { now = new Date(), deps = {} } = {}) {
  const fetchFeed = deps.fetch ?? ((url) => globalThis.fetch(url, { signal: AbortSignal.timeout(15000) }));
  const cfgFile = join(root, "podcast.config.json");
  if (!existsSync(cfgFile)) return { class: PODCAST_BEHIND, checked: false, reason: "no podcast.config.json: this repository publishes no podcast", findings: [] };
  const U = (subject, problem) => ({ class: PODCAST_BEHIND, subject, observed: null, expected: null, unreadable: true, problem });
  let podcast, project;
  try { podcast = JSON.parse(readFileSync(cfgFile, "utf8")); } catch (e) { return { class: PODCAST_BEHIND, checked: true, findings: [U("podcast.config.json", `not JSON (${e.message}): the schedule cannot be read, so the feed is not shown fresh`)] }; }
  try { project = await loadProject(root); } catch (e) { return { class: PODCAST_BEHIND, checked: true, findings: [U("kit.config.js", `cannot be loaded (${e.message}): the series cadence cannot be read, so the feed is not shown fresh`)] }; }
  const grace = podcast.schedule?.graceMinutes;
  const findings = [];
  const site = String(project.config.site.url).replace(/\/$/, "");
  const publishedSeries = project.config.series.filter((x) => x.podcast);
  const schedule = planner(project.config, project.content);
  const showCount = new Map();
  for (const series of publishedSeries) showCount.set(series.podcast.show, (showCount.get(series.podcast.show) || 0) + 1);
  for (const s of publishedSeries) {
    const days = CADENCE_DAYS[s.every];
    if (!days) { findings.push(U(s.id, `series ${s.id} has cadence "${s.every}", which this class has no length for: add it to CADENCE_DAYS`)); continue; }
    if (s.start && Date.parse(`${s.start}T00:00:00Z`) > now.getTime()) continue;   // not started: no item is owed yet
    // Verify the LAST ACTUAL due slot, not merely the last calendar day.
    // A closed weekly series can end on a Thursday but have its final Saturday
    // slot five days earlier; the site's planner supplies the exact timezone-
    // aware publishAt and knows which slots have content to publish.
    let finalDue = null;
    if (s.end) {
      let endDay;
      try { endDay = dates.toDay(s.end); }
      catch { findings.push(U(s.id, `series ${s.id} has invalid end date ${s.end}`)); continue; }
      for (let day = endDay; day >= endDay - 35; day--) {
        const due = schedule.due(day).find((e) => e.series === s.id);
        if (due) { finalDue = due; break; }
      }
      if (!finalDue) { findings.push(U(s.id, `series ${s.id} has an end date but no provable final scheduled podcast slot`)); continue; }
    }
    if (!Number.isInteger(grace)) { findings.push(U(s.id, `podcast.config.json schedule.graceMinutes is not declared: how late the feed of ${s.id} may be is not stated, so it is not shown on time`)); continue; }
    const show = s.podcast.show, url = site + (project.config.shows?.[show]?.feed || `/podcasts/${show}/feed.xml`);
    // A show can carry multiple independent series. Its newest RSS item cannot prove
    // that EACH series published. Query the canonical series-scoped JSON API in this
    // case; fail closed if the API does not prove this series' own published_at.
    const shared = showCount.get(show) > 1;
    const subject = shared ? `${site}/api/podcasts?series=${encodeURIComponent(s.id)}&limit=1` : url;
    let latest;
    try {
      const response = await fetchFeed(subject);
      if (!response.ok) throw new Error(`answered ${response.status}`);
      if (shared) {
        const data = await response.json();
        if (data?.ok !== true || !Array.isArray(data.episodes)) throw new Error("invalid series-scoped API contract");
        const episode = data.episodes[0];
        if (!episode || episode.series !== s.id || !Number.isFinite(Date.parse(episode.published_at))) {
          throw new Error(`no verifiable dated episode for series ${s.id}`);
        }
        latest = new Date(episode.published_at);
      } else latest = newestItem(await response.text());
    } catch (e) { findings.push(U(subject, `${subject} cannot prove the newest ${s.id} episode (${e.message})`)); continue; }
    if (!latest) { findings.push(U(subject, `${subject} has no dated item: no ${s.id} episode is published`)); continue; }
    // When the final slot's grace has elapsed, it must be visible in this
    // series' own latest episode. Merely publishing the previous daily episode
    // inside a cadence window is not proof of the LAST one (Code Review P2).
    if (finalDue && now.getTime() >= Date.parse(finalDue.publishAt) + grace * 60_000) {
      const owed = Date.parse(finalDue.publishAt);
      if (latest.getTime() < owed) findings.push({ class: PODCAST_BEHIND, subject,
        observed: latest.toISOString(), expected: new Date(owed).toISOString(),
        age_days: Math.max(0, Math.floor((now.getTime() - latest.getTime()) / DAY_MS)),
        problem: `the final scheduled ${s.id} episode was due at ${finalDue.publishAt}, but the newest ${s.id} item is from ${latest.toISOString()}: the final episode is missing` });
      continue;  // no future episodes are owed after this last slot
    }
    const limit = days * DAY_MS + grace * 60_000, age = now.getTime() - latest.getTime();
    if (age > limit) findings.push({ class: PODCAST_BEHIND, subject,
      observed: latest.toISOString(), expected: new Date(now.getTime() - limit).toISOString(),
      age_days: Math.floor(age / DAY_MS), problem: `the newest ${s.id} item of ${subject} is from ${latest.toISOString()}, ${(age / DAY_MS).toFixed(1)} days ago; series ${s.id} publishes every ${s.every} and may be ${grace} min late (${(limit / DAY_MS).toFixed(2)} days): the episode is behind schedule` });
  }
  return { class: PODCAST_BEHIND, checked: true, findings };
}
