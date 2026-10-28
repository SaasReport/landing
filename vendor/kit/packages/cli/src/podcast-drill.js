/**
 * kit podcast drill: the publish drill (docs/PODCASTS.md, "the publish chain"). Generates today's episode of one declared series in DRY mode
 * (no provider call: a fixture answers the TTS request and every other outbound request is refused) through the code path the daily cron uses,
 * and asserts the row, the audio, the feed item and the page. Root cause it removes (2026-10-14): the daily podcasts of three sites stopped
 * on 3-5 October and nothing proved, before or after a deploy, that "the cron makes an episode and the site shows it" still held.
 *
 * "The same code path" is literal: the child process (podcast-drill/run.mjs) imports the project's OWN Worker module (wrangler.toml `main`) and
 * calls its scheduled() handler, whose workflow class runs the episode, on a fresh local D1 built from the project's own migrations under D1's
 * limits (d1-local.js). Only the bindings and the TTS answer are substituted (podcast-drill/fixtures.js).
 *
 *   podcastDrill(root, { series, at, proof, env, kit }) → { ok, proof (the document, kit.podcast-drill.v1), file }
 *   declaredSeries(root) → [{ id, show, every }]   the project's podcast series (kit.config.js), the subjects its drills must cover
 *   defaultAt(root, series) → ISO   the pinned clock: now (daily), or the next day the planner publishes an item of the series (weekly, monthly)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatProblems } from "@saasreport/core/schema";
import { planner, localDay } from "@saasreport/core";
import { loadProject } from "./project.js";
import { bundled } from "./bundled.js";

const HERE = fileURLToPath(new URL("./podcast-drill/", import.meta.url));
/** The drill's parameters (packages/core/registry/podcast-drill-config.json, schema podcast-drill-config): child environment, search horizon, hours, time limit. */
export const DRILL = Object.freeze(JSON.parse(readFileSync(new URL("../../core/registry/podcast-drill-config.json", import.meta.url), "utf8")));
const TIMEOUT_MS = DRILL.timeoutMs;

/** Every podcast series of kit.config.js (daily, weekly, monthly): the subjects the publish drills must cover. */
export async function declaredSeries(root) {
  const { config } = await loadProject(root);
  return config.series.filter((s) => s.podcast).map((s) => ({ id: s.id, show: s.podcast.show, every: s.every }));
}

/**
 * The pinned clock of a drill: now for a daily series (due every day), and for a weekly or monthly one the next day (from today, site time) the
 * planner says the series publishes an item, at midday UTC of that day, so the cron's own `due(day)` finds it. A series with no item left in the
 * horizon (DRILL.horizonDays) has none to drill: that is an error, the content ran out.
 */
export async function defaultAt(root, series, now = new Date()) {
  const { config, content } = await loadProject(root);
  const s = config.series.find((x) => x.id === series);
  if (!s?.podcast || s.every === "day") return now.toISOString();
  const plan = planner(config, content);
  const tz = config.site.timezone, dayOf = (d) => localDay(tz, d), today = dayOf(now);
  for (let day = today; day < today + DRILL.horizonDays; day++) {
    if (!plan.due(day).some((e) => (e.series?.id ?? e.series) === series && e.item)) continue;
    for (const hour of DRILL.hoursUtc) { const at = new Date(day * 86_400_000 + hour * 3_600_000); if (dayOf(at) === day) return at.toISOString(); }
  }
  throw new Error(`series ${series} has no item due in the next ${DRILL.horizonDays} days: its content ran out, so there is no episode to drill`);
}

/**
 * The publish drills a repository owes: one per podcast series, and only where the repository publishes podcasts (podcast.config.json).
 * → { ids: [series id], problem: string | null }. A kit.config.js that cannot be loaded is a problem, never "no series": the drills a
 * repository owes cannot be waived by breaking the file that lists them.
 */
export async function publishDrillNeeds(root) {
  if (!existsSync(join(root, "podcast.config.json"))) return { ids: [], problem: null };
  try { return { ids: (await declaredSeries(root)).map((x) => x.id), problem: null }; } catch (e) { return { ids: [], problem: `podcast.config.json is here but kit.config.js cannot be loaded (${e.message}), so the publish drills this repository owes cannot be listed` }; }
}

/** What the child may see of the parent's environment: the registry's allow-list (process basics and the test-run's guards), nothing else. The child imports
 *  the PROJECT's Worker code, so no provider key, token or deploy credential of the parent reaches it, NODE_OPTIONS (a preload) is not passed, and HOME is a
 *  fresh directory the caller owns; the only key the child sees is the fixture the run itself hands the Worker's env. */
export const CHILD_ENV = DRILL.childEnv;
export const childEnv = (env, home) => ({ ...Object.fromEntries(CHILD_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])), HOME: home, NODE_ENV: "production" });

export const proofPath = (series, date) => `resilience/drills/publish-${series}-${date}.json`;

export function podcastDrill(root, { series, at = new Date().toISOString(), proof = null, env = process.env, kit = bundled(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!series) throw new Error("kit podcast drill needs --series <id>");
  if (Number.isNaN(Date.parse(at))) throw new Error(`--at ${at} is not a date-time`);
  const dir = mkdtempSync(join(tmpdir(), "kit-podcast-drill-"));
  mkdirSync(join(dir, "home"));
  const out = join(dir, "proof.json");
  try {
    const arg = JSON.stringify({ root: resolve(root), series, at, out, commit: /^[0-9a-f]{40}$/.test(env.GITHUB_SHA || "") ? env.GITHUB_SHA : null });
    const r = spawnSync(process.execPath, ["--no-warnings", "--conditions=workerd", "--import", join(HERE, "register.mjs"), join(HERE, "run.mjs"), arg], { cwd: resolve(root), encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20, env: childEnv(env, join(dir, "home")) });
    let doc;
    try { doc = JSON.parse(readFileSync(out, "utf8")); } catch {
      const why = r.error ? r.error.message : `exit ${r.status}${r.signal ? `, ${r.signal}` : ""}: ${String(r.stderr || r.stdout).trim().split("\n").slice(-6).join(" | ")}`;
      throw new Error(`the drill wrote no proof (${why})`);
    }
    const bad = formatProblems(kit.validator.validate(doc, kit.byName("podcast-drill")));
    if (bad.length) throw new Error(`the drill's proof is not kit.podcast-drill.v1: ${bad.slice(0, 3).join("; ")}`);
    const file = proof ?? proofPath(series, at.slice(0, 10));
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), `${JSON.stringify(doc, null, 2)}\n`);
    return { ok: doc.ok === true, proof: doc, file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
