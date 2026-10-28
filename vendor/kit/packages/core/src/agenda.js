/**
 * agenda(config, content, { from, days }) → { markdown, problems, stats, items }
 * A dry run of everything the daily cron will publish: walks every day, builds every post, checks every
 * slot has content, every talk is speakable and alternates, and every episode fits its show's time budget.
 *   opts.episode(series, entry) → [{speaker, text}]  (optional) the exact episode lines, e.g. from @saasreport/podcast;
 *   by default the item's talk is used.
 */
import { estimateMs, unspeakable } from "@saasreport/speech";
import { defineConfig, speechOptions } from "./config.js";
import { planner } from "./planner.js";
import { isLocaleRoot, localesOf, configFor, contentFor } from "./locales.js";
import { buildPost } from "./reports.js";
import { toDay, iso, dayLabel, localDay } from "./dates.js";
import { digits, fill, strings } from "./i18n.js";
import * as C from "@saasreport/calendar";

const bad = (s) => /undefined|NaN|null|\[object/.test(String(s ?? ""));
const talkLines = (item) => (item?.talk || []).map((l) => (Array.isArray(l) ? { speaker: l[0], text: l[1] } : { speaker: l.speaker, text: l.text }));

export function agenda(config, content, opts = {}) {
  config = defineConfig(config);
  // A multi-locale site: one agenda per locale (each in its own language), problems prefixed "[ar] ";
  // opts.episode(series, entry, locale) builds that locale's episode.
  if (isLocaleRoot(config)) {
    const parts = localesOf(config).map((l) => ({ l, r: agenda(configFor(config, l), contentFor(config, content, l), { ...opts, episode: opts.episode ? (s, e) => opts.episode(s, e, l) : null }) }));
    return { markdown: parts.map((x) => x.r.markdown).join("\n---\n\n"), problems: parts.flatMap((x) => x.r.problems.map((p) => `[${x.l}] ${p}`)),
      stats: Object.fromEntries(parts.map((x) => [x.l, x.r.stats])), items: parts.flatMap((x) => x.r.items.map((i) => ({ ...i, locale: x.l }))), locales: Object.fromEntries(parts.map((x) => [x.l, x.r])) };
  }
  return agendaOne(config, content, opts);
}

function agendaOne(config, content, { from, days = 371, episode = null, now } = {}) {
  const plan = planner(config, content);
  const str = strings(config), f = (k, v) => fill(str[k], v);
  const start = from != null ? toDay(from) : localDay(config.site.timezone, now);
  const sp = speechOptions(config), cps = config.speech.cps;
  const problems = [], slugs = new Set(), items = [];
  const stats = { from: iso(start), to: iso(start + days - 1), days, series: {}, total: 0, episodes: 0, problems: 0 };
  for (const s of config.series) stats.series[s.id] = { kind: s.kind, every: s.every, title: s.title, items: 0, missing: 0, posts: 0, episodes: 0, seconds: { min: null, max: null, avg: null } };
  const secs = Object.fromEntries(config.series.map((s) => [s.id, []]));

  for (let d = start; d < start + days; d++) {
    for (const e of plan.slotsOn(d)) {
      const s = config.series.find((x) => x.id === e.series), st = stats.series[s.id];
      if (e.missing) {
        st.missing++;
        if (e.kind === "term") { problems.push(`${s.id} ${e.date}: no term left in the rotation (day ${e.number})`); continue; }
        problems.push(`${s.id} ${e.key}: no scheduled ${e.kind === "topic" ? "topic" : "theme"}`);
        if (s.empty !== "tables") continue;
      }
      if (slugs.has(e.slug)) problems.push(`duplicate slug ${e.slug}`);
      slugs.add(e.slug);
      st.items++;
      const row = { ...e, title: null, summary: null, lines: null, ms: null };
      if (s.post) {
        const post = buildPost(plan, e);
        if (post) {
          st.posts++;
          row.title = post.title; row.summary = post.summary;
          if (bad(post.title) || bad(post.summary) || bad(post.body_md)) problems.push(`${e.slug}: bad text (undefined/NaN/null in the post)`);
          if (s.tables && post.body_md.length < 400) problems.push(`${e.slug}: body too short`);
        }
      }
      if (!row.title && e.item) { row.title = e.item.title ?? e.item.term; row.summary = e.item.summary ?? e.item.short ?? e.item.intro; }
      if (s.podcast && e.item) {
        const lines = episode ? episode(s, e) : talkLines(e.item);
        if (lines && lines.length) {
          const ms = estimateMs(lines, s.podcast.cps ?? cps);
          const budget = (s.podcast.maxSeconds - (s.podcast.marginSeconds ?? 10)) * 1000;
          if (ms > budget) problems.push(`${e.slug}: about ${Math.round(ms / 1000)} s, over the ${s.podcast.maxSeconds} s budget (with margin)`);
          for (const l of lines) { const left = unspeakable(l.text, sp); if (left) problems.push(`${e.slug}: unspeakable «${left.slice(0, 40)}»`); }
          for (let i = 1; i < lines.length; i++) if (lines[i].speaker === lines[i - 1].speaker && !episode) problems.push(`${e.slug}: same speaker twice`);
          for (const l of lines) if (!config.hosts[l.speaker] && !episode) problems.push(`${e.slug}: unknown speaker "${l.speaker}"`);
          if (lines.some((l) => bad(l.text) || !String(l.text || "").trim())) problems.push(`${e.slug}: bad or empty line`);
          row.lines = lines; row.ms = ms;
          st.episodes++; stats.episodes++; secs[s.id].push(Math.round(ms / 1000));
        }
      }
      items.push(row);
      stats.total++;
    }
  }
  for (const [id, xs] of Object.entries(secs)) if (xs.length) stats.series[id].seconds = { min: Math.min(...xs), max: Math.max(...xs), avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) };
  stats.problems = problems.length;

  /* markdown */
  const long = (n) => dayLabel(config, n);
  const clock = (ms) => { const x = Math.round((ms || 0) / 1000); return digits(config, `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`); };
  const col = (k) => str[`agendaCol_${k}`];
  const weekHolidays = (n) => { if (config.calendar.holidays !== "iran") return []; const r = []; for (let d = n; d < n + 7; d++) for (const h of C.holidaysOn(d)) r.push(`${long(d)}: ${h.title}${h.status === "predicted" ? str.predictedShort : ""}`); return r; };
  const md = [`# ${f("agendaTitle", { site: config.site.name })}`, ``, f("agendaRange", { from: long(start), to: long(start + days - 1) }), ``];
  for (const s of config.series) {
    const st = stats.series[s.id];
    md.push(f("agendaSeriesLine", { title: s.title, n: digits(config, st.items) }) + (st.episodes ? f("agendaEpisodes", { n: digits(config, st.episodes) }) : "") + (st.missing ? f("agendaMissing", { n: digits(config, st.missing) }) : ""));
  }
  md.push(``);
  for (const s of config.series) {
    const rows = items.filter((x) => x.series === s.id);
    md.push(`## ${s.title}`, ``);
    if (s.kind === "term") {
      md.push(`| ${col("n")} | ${col("date")} | ${col("term")} | ${col("category")} | ${col("duration")} |`, `| --- | --- | --- | --- | --- |`,
        ...rows.map((x) => `| ${digits(config, x.number)} | ${long(x.day)} | ${x.item.term}${x.item.en ? ` (${x.item.en})` : ""} | ${x.category?.name || x.item.category} | ${x.ms != null ? clock(x.ms) : "—"} |`));
    } else if (s.kind === "report" && s.every === "month") {
      md.push(`| ${col("date")} | ${col("title")} | ${col("summary")} |`, `| --- | --- | --- |`,
        ...rows.map((x) => `| ${long(x.day)} | ${x.title ?? str.missingItem} | ${x.summary ?? "—"} |`));
    } else {
      const hol = s.every === "week" && config.calendar.holidays === "iran";
      md.push(`| ${[col("n"), col("date"), col("title"), ...(hol ? [col("holidays")] : []), ...(s.podcast ? [col("audio")] : [])].join(" | ")} |`,
        `| ${["---", "---", "---", ...(hol ? ["---"] : []), ...(s.podcast ? ["---"] : [])].join(" | ")} |`,
        ...rows.map((x, i) => `| ${[digits(config, i + 1), long(x.day), x.title ?? str.missingItem, ...(hol ? [weekHolidays(x.day).join(str.listSep) || "—"] : []),
          ...(s.podcast ? [x.lines ? f("agendaAudio", { lines: digits(config, x.lines.length), clock: clock(x.ms) }) : "—"] : [])].join(" | ")} |`));
    }
    md.push(``);
  }
  md.push(`## ${str.agendaProblems}`, ``, ...(problems.length ? problems.map((p) => `- ${p}`) : [str.agendaNoProblems]), ``);
  return { markdown: md.join("\n"), problems, stats, items };
}
