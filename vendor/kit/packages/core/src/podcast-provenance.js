/**
 * The t=0 rule for podcasts (owner, 2026-10-06: "hand adding not permitted is postfacto, everything must be t=0"):
 * an episode exists only because the pipeline made it, and it can prove it.
 *
 *   checkEpisodeSpec(ep)            → [] | problems   against kit.podcast-episode.v1 (what the cron queues)
 *   checkProvenance(record)         → [] | problems   against kit.podcast-provenance.v1
 *   buildProvenance({...})          → the record the scheduled run writes with the episode row (async: hashes)
 *   withRender(record, render)      → the record plus the render facts the workflow measured
 *   provenanceProblem(row, policy)  → null | why a stored episode row is not acceptable (the monitor and the tests use it)
 *
 * Runtime-neutral (Workers, Node): crypto.subtle for the hashes, no I/O.
 */
import EPISODE from "../schemas/podcast-episode.schema.json" with { type: "json" };
import PROVENANCE from "../schemas/podcast-provenance.schema.json" with { type: "json" };
import { createValidator, formatProblems } from "./schema.js";

const validator = createValidator([EPISODE, PROVENANCE]);

export const PROVENANCE_ORIGINS = PROVENANCE.properties.origin.enum;
export const checkEpisodeSpec = (ep) => formatProblems(validator.validate(ep, EPISODE.$id));
export const checkProvenance = (record) => {
  const problems = formatProblems(validator.validate(record, PROVENANCE.$id));
  for (const f of PROVENANCE["x-required-by-origin"]?.[record?.origin] || []) if (record[f] == null) problems.push(`/${f}: is required for origin "${record.origin}"`);
  for (const [f, origins] of Object.entries(PROVENANCE["x-allowed-only-by-origin"] || {})) if (record?.[f] != null && !origins.includes(record.origin)) problems.push(`/${f}: only origin ${origins.join(", ")} may carry it (got "${record.origin}")`);
  const want = PROVENANCE["x-trigger-by-origin"]?.[record?.origin];
  if (!problems.length && want && record.trigger !== want) problems.push(`/trigger: origin "${record.origin}" goes with trigger "${want}" (got "${record.trigger}")`);
  return problems;
};

/** Stable JSON: keys sorted, so the same spec always hashes the same. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{origin?: "cron"|"cron-retry"|"catchup"|"admin", scheduledAt?: string|number|Date, ep: object, series: string, config?: object, engine?: string, now?: string}} o
 *   config: the part of the config that decides how the episode sounds (tts + pacing); it is hashed, not stored.
 */
export async function buildProvenance({ origin = "cron", scheduledAt, missedDate, ep, series, config, engine = "@saasreport/podcast", now = new Date().toISOString() }) {
  const record = {
    v: 1, origin, trigger: origin === "admin" ? "admin-api" : "scheduled",
    ...(scheduledAt != null ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
    ...(missedDate ? { missed_date: missedDate } : {}),
    series, ref: ep.source_ref ?? null,
    spec_sha256: await sha256Hex({ slug: ep.slug, title: ep.title, summary: ep.summary, lines: ep.lines, source_ref: ep.source_ref }),
    ...(config ? { config_sha256: await sha256Hex(config) } : {}),
    engine, created_at: now,
  };
  const problems = checkProvenance(record);
  if (problems.length) throw new Error(`provenance record invalid: ${problems.join("; ")}`);
  return record;
}

/** The record with the workflow's render facts (provider, model, voices, pacing, measured duration and longest pause). */
export function withRender(record, render) {
  return { ...record, render: { ...(record?.render || {}), ...render } };
}

/** The record the migration gives episodes that predate provenance. */
export const legacyProvenance = (note = "predates the provenance record") => ({ v: 1, origin: "legacy", trigger: "migration", series: "", ref: null, spec_sha256: "0".repeat(64), created_at: "1970-01-01T00:00:00.000Z", note });

/**
 * Why a stored episode row is not acceptable, or null. `policy`: { origins: [...], legacyBefore?: "YYYY-MM-DD" } from podcast.config.json.
 * Used by the monitor (production) and by every site's test.
 */
export function provenanceProblem(row, policy = { origins: ["cron", "cron-retry"] }) {
  const raw = row?.provenance_json ?? row?.provenance;
  if (raw == null || raw === "") return "no provenance record";
  let rec;
  try { rec = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return "provenance record is not JSON"; /* the reason is the problem this check reports */ }
  const problems = checkProvenance(rec);
  if (problems.length) return `provenance record invalid: ${problems[0]}`;
  if (!policy.origins.includes(rec.origin)) return `origin "${rec.origin}" is not accepted (${policy.origins.join(", ")})`;
  if (rec.origin === "legacy") {
    const day = String(row.published_at || "").slice(0, 10);
    if (!policy.legacyBefore || !day || day >= policy.legacyBefore) return `origin "legacy" only for episodes published before ${policy.legacyBefore || "(no legacyBefore set)"}`;
  }
  return null;
}
