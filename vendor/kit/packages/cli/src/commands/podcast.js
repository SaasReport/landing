/**
 * kit podcast migrate [--check]
 *   Keeps the D1 provenance triggers (the t=0 rule) in step with kit.podcast-provenance.v1 and the project's podcast.config.json
 *   provenance.origins, APPEND-ONLY: when the newest provenance migration is not what the generator makes now, a NEW numbered
 *   <n>_podcast_provenance_triggers.sql (drop and recreate the triggers) is written; an existing migration is never rewritten (D1 would
 *   not re-run it). podcast.migrations.lock.json records every file's sha256; `kit check podcast` fails on any change to a recorded file.
 *   --check writes nothing and exits 1 when a new migration is needed.
 * kit podcast drill --series <id> [--at <ISO date-time>] [--proof <file>]
 *   The publish drill (docs/PODCASTS.md): today's episode of the series generated in dry mode (a fixture answers the TTS request, every other
 *   outbound request is refused) through the project's own Worker, its scheduled handler and its workflow, on a fresh local D1 built from its
 *   migrations; asserts the row, the audio, the feed item and the page; writes the proof (kit.podcast-drill.v1, default
 *   resilience/drills/publish-<series>-<date>.json). Exit 1 when any check fails (the proof is written either way). Under `kit release drills`
 *   the proof path is KIT_DRILL_PROOF and the day KIT_DRILL_DATE.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../args.js";
import { CONFIG_FILE } from "../podcast-check.js";
import { migrate, migrationProblems } from "../podcast-migrations.js";
import { podcastDrill, defaultAt } from "../podcast-drill.js";

async function drill(io, flags) {
  const series = flags.series ?? io.env.KIT_DRILL_SUBJECT;
  if (!series) throw new CliError("kit podcast drill needs --series <id>");
  const now = io.env.KIT_DRILL_DATE ? new Date(`${io.env.KIT_DRILL_DATE}T${new Date().toISOString().slice(11)}`) : new Date();
  const at = flags.at ? String(flags.at) : await defaultAt(io.cwd, String(series), now);
  const proof = flags.proof ? String(flags.proof) : io.env.KIT_DRILL_PROOF || null;
  const r = podcastDrill(io.cwd, { series: String(series), at, proof, env: io.env });
  for (const c of r.proof.checks) io[c.ok ? "out" : "err"](`${c.ok ? "ok" : "FAIL"} ${c.id}: ${c.detail}`);
  io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} podcast drill ${series}: ${r.ok ? `${r.proof.slug} generated in dry mode, published and served` : "the publish chain is broken"}; proof ${r.file}`);
  return r.ok ? 0 : 1;
}

export async function podcast(io, { _: [sub = "migrate"] = [], flags }) {
  if (sub === "drill") return drill(io, flags);
  if (sub !== "migrate") throw new CliError(`kit podcast: unknown subcommand "${sub}" (migrate, drill)`);
  if (flags.file) throw new CliError("kit podcast migrate no longer takes --file: migrations are append-only, the next number is chosen for you");
  const cfg = join(io.cwd, CONFIG_FILE);
  if (!existsSync(cfg)) throw new CliError(`no ${CONFIG_FILE} in ${io.cwd}`);
  const origins = JSON.parse(readFileSync(cfg, "utf8"))?.provenance?.origins;
  if (flags.check) {
    const problems = migrationProblems(io.cwd, origins);
    for (const p of problems) io.err(`  - ${p}`);
    io[problems.length ? "err" : "out"](problems.length ? "kit podcast migrate --check: a migration is needed or a recorded one changed" : "ok: the provenance migrations are current and untouched");
    return problems.length ? 1 : 0;
  }
  const r = migrate(io.cwd, origins);
  if (r.adopted.length) io.out(`recorded in ${"podcast.migrations.lock.json"}: ${r.adopted.join(", ")}`);
  io.out(r.created ? `wrote migrations/${r.created} (origins: ${origins.join(", ")}); apply it with npm run db:migrate:remote before deploying` : "up to date: no new migration needed");
  return 0;
}
