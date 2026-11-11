/**
 * kit publish <series> <ref> [--force] [--url <site>] [--dry-run] [--locale ar]   (a locale's API is under its prefix: <site>/ar/api/…)
 *   POST <site>/api/podcasts/generate {series, ref, force} — queues the episode (PodcastWorkflow) on the live site.
 * kit status [slug] [--url <site>] [--json]
 *   GET <site>/api/podcasts/admin[/<slug>] — episodes and their states, or one episode with its workflow status.
 * Auth: KIT_ADMIN_TOKEN (the Worker's ADMIN_TOKEN secret). Site: --url, else KIT_SITE_URL, else config.site.url.
 */
import { CliError } from "../args.js";
import { loadProject, runtime, projectFor } from "../project.js";
import { findEntry } from "./render.js";

// The site's origin, plus the locale prefix (/ar) for --locale on a multi-locale site.
const siteUrl = (io, project, flags) => `${String(flags.url || io.env.KIT_SITE_URL || project.root?.config.site.url || project.config.site.url).replace(/\/+$/, "")}${project.base || ""}`;
function token(io) {
  const t = io.env.KIT_ADMIN_TOKEN;
  if (!t) throw new CliError("KIT_ADMIN_TOKEN is not set (the value of the Worker's ADMIN_TOKEN secret)");
  return t;
}

async function call(io, url, init) {
  let res;
  try { res = await io.fetch(url, init); }
  catch (e) { throw new CliError(`cannot reach ${url}: ${e?.cause?.code || e?.message || e}`); }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, error: `HTTP ${res.status}`, detail: text.slice(0, 200) }; }
  return { status: res.status, body };
}

export async function publish(io, { _: [seriesId, ref], flags }) {
  const project = projectFor(await loadProject(io.cwd, flags), flags.locale);
  const rt = runtime(project);
  const { series, entry } = findEntry(project, rt, seriesId, ref);
  if (!series.podcast) throw new CliError(`series "${series.id}" has no podcast`);
  const ep = rt.episode(series, entry);
  const url = `${siteUrl(io, project, flags)}/api/podcasts/generate`;
  const body = { series: series.id, ref: String(ref), force: Boolean(flags.force) };
  if (flags["dry-run"]) {
    io.out(`dry run: POST ${url}`);
    io.out(`  authorization: Bearer $KIT_ADMIN_TOKEN`);
    io.out(`  ${JSON.stringify(body)}`);
    io.out(`  → ${ep.slug}: ${ep.title} (${ep.lines.length} turns)`);
    return 0;
  }
  const r = await call(io, url, { method: "POST", headers: { authorization: `Bearer ${token(io)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.body.ok) {
    const hint = { unauthorized: "check KIT_ADMIN_TOKEN", tts_not_configured: "set the TTS secrets on the Worker (e.g. GEMINI_API_KEY)",
      item_not_found: "the deployed content differs from this checkout; deploy first" }[r.body.error];
    io.err(`publish failed (${r.status}): ${r.body.error}${r.body.detail ? `: ${r.body.detail}` : ""}${hint ? ` — ${hint}` : ""}`);
    return 1;
  }
  const b = r.body;
  io.out(b.created ? `queued ${b.slug}${b.workflow_id ? ` (workflow ${b.workflow_id})` : ""}` : `${b.slug} already exists (status ${b.status}); use --force to render it again`);
  return 0;
}

export async function status(io, { _: [slug], flags }) {
  const project = projectFor(await loadProject(io.cwd, flags), flags.locale);
  const base = siteUrl(io, project, flags);
  const url = `${base}/api/podcasts/admin${slug ? `/${encodeURIComponent(slug)}` : ""}`;
  const r = await call(io, url, { headers: { authorization: `Bearer ${token(io)}` } });
  if (!r.body.ok) { io.err(`status failed (${r.status}): ${r.body.error}${r.body.detail ? `: ${r.body.detail}` : ""}`); return 1; }
  if (flags.json) { io.out(JSON.stringify(r.body, null, 1)); return 0; }
  if (slug) {
    const e = r.body.episode;
    io.out(`${e.slug} (${e.series}/${e.show}): ${e.status}${e.error ? ` — ${e.error}` : ""}`);
    if (e.duration_ms) io.out(`  duration ${Math.round(e.duration_ms / 1000)} s, ${e.audio_bytes || 0} bytes, script ${e.script_model || "?"}`);
    if (e.published_at) io.out(`  published ${e.published_at}`);
    if (r.body.workflow) io.out(`  workflow ${e.workflow_id}: ${r.body.workflow.status || JSON.stringify(r.body.workflow)}`);
    return 0;
  }
  io.out(`${base}: speech ${r.body.tts_configured ? "configured" : "NOT configured"}, ${r.body.episodes.length} recent episodes`);
  for (const e of r.body.episodes) io.out(`  ${e.status.padEnd(10)} ${e.slug}  (${e.series}, ${e.updated_at})${e.error ? ` — ${e.error}` : ""}`);
  return 0;
}
