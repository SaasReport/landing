/**
 * kit render <series> <ref> [--json] [--speakable] [--locale ar]
 * Prints the episode script the Worker would send to TTS for a series item (a date for topic series, a month key for
 * reports, a term slug or entry slug for term series), with the estimated duration against the show's limit.
 * Local only: no network, no bindings. Exit 1 when the item does not exist or the estimate is over the limit.
 */
import { speakable, estimateMs } from "@saasreport/speech";
import { speechOptions } from "@saasreport/core";
import { CliError } from "../args.js";
import { loadProject, runtime, projectFor } from "../project.js";

const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The planner entry for a series and a reference, or a CliError that says what exists. */
export function findEntry(project, rt, seriesId, ref) {
  const s = project.config.series.find((x) => x.id === seriesId);
  if (!s) throw new CliError(`unknown series "${seriesId}" (series: ${project.config.series.map((x) => x.id).join(", ")})`);
  if (!ref) throw new CliError(`which item? e.g. kit render ${s.id} ${s.kind === "term" ? "<term slug>" : s.kind === "report" ? "<YYYY-MM>" : "<YYYY-MM-DD>"}`);
  const e = rt.plan.find(s.id, String(ref));
  if (!e || !e.item) throw new CliError(`${s.id}: nothing scheduled for "${ref}"`);
  return { series: s, entry: e };
}

export async function render(io, { _: [seriesId, ref], flags }) {
  const project = projectFor(await loadProject(io.cwd, flags), flags.locale);
  const rt = runtime(project);
  const { series, entry } = findEntry(project, rt, seriesId, ref);
  if (!series.podcast) throw new CliError(`series "${series.id}" has no podcast (set series.podcast in kit.config.js)`);
  const ep = rt.episode(series, entry);
  const cps = series.podcast.cps ?? project.config.speech.cps;
  const ms = estimateMs(ep.lines, cps);
  const limit = series.podcast.maxSeconds;
  const sp = speechOptions(project.config);
  if (flags.json) {
    io.out(JSON.stringify({ ...ep, date: entry.date, publishAt: entry.publishAt, estimatedMs: ms, maxSeconds: limit,
      spoken: flags.speakable ? ep.lines.map((l) => ({ speaker: l.speaker, text: speakable(l.text, sp) })) : undefined }, null, 1));
  } else {
    const name = (k) => project.config.hosts[k]?.name || k;
    const show = project.config.shows[series.podcast.show]?.title || series.podcast.show;
    io.out(`${ep.slug} · ${show} · ${entry.date} ${series.at} ${project.config.site.timezone}${ep.number != null ? ` · #${ep.number}` : ""}`);
    io.out(`${ep.title}`);
    io.out(`${ep.summary}`);
    io.out("");
    for (const l of ep.lines) io.out(`${name(l.speaker)}: ${flags.speakable ? speakable(l.text, sp) : l.text}`);
    io.out("");
    const chars = ep.lines.reduce((n, l) => n + l.text.length, 0);
    io.out(`${ep.lines.length} turns, ${chars} characters, about ${clock(ms)} at ${cps} characters/s (limit ${clock(limit * 1000)})`);
  }
  if (ms > limit * 1000) { io.err(`over the ${limit} s limit: the workflow would park this episode for review`); return 1; }
  return 0;
}
