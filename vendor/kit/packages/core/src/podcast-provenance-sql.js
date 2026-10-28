/**
 * The database half of the t=0 rule, generated from the ONE provenance schema (schemas/podcast-provenance.schema.json) and a
 * project's accepted origins (podcast.config.json "provenance.origins"): SQL triggers that validate the WHOLE record on INSERT
 * and on UPDATE of podcast_episodes.provenance_json, so a hand-typed row (`{"v":1,"origin":"manual"}`, an incomplete record, a
 * wrong version, an origin the project does not accept, a trigger that does not belong to the origin) cannot exist.
 *
 *   provenanceMigrationSql({ origins })   the migration file's text (nothing in it is typed by hand per project)
 *   provenanceCondition(schema, origins)  the SQL boolean the triggers check (for tests and tooling)
 *
 * Supported schema keywords: type (incl. unions with null), const, enum, pattern ^[0-9a-f]{N}$, format date and date-time, required,
 * additionalProperties:false (a key whitelist), nested objects with properties, and `x-trigger-by-origin` (origin -> trigger).
 * `kit podcast migrate` writes the file, `kit check podcast` fails when the file on disk differs.
 * Every LIKE/GLOB pattern stays within D1's 50 bytes (core/d1-limits): the generator throws rather than write a trigger D1 cannot run.
 */
import PROVENANCE from "../schemas/podcast-provenance.schema.json" with { type: "json" };
import { patternProblems } from "./d1-limits.js";

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const DATE = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
const SQL_TYPES = { string: "text", integer: "integer", number: "integer','real", object: "object", array: "array", boolean: "true','false", null: "null" };

/** SQL boolean: the value at `path` of the record satisfies `def`. */
function check(def, path, required, origins, root = "NEW.provenance_json") {
  const J = `json_extract(${root}, '${path}')`, T = `json_type(${root}, '${path}')`;
  const parts = [];
  if (def.type) parts.push(`${T} IN (${[].concat(def.type).map((t) => `'${SQL_TYPES[t]}'`).join(", ")})`);
  if (typeof def.const === "number") parts.push(`${T} = 'integer'`);   // json true extracts as 1
  if (def.const !== undefined) parts.push(`${J} = ${typeof def.const === "number" ? def.const : q(def.const)}`);
  if (def.enum) parts.push(`${J} IN (${def.enum.map((v) => (typeof v === "number" ? v : q(v))).join(", ")})`);
  const hex = /^\^\[0-9a-f\]\{(\d+)\}\$$/.exec(def.pattern || "");
  if (hex) parts.push(`length(${J}) = ${hex[1]} AND ${J} NOT GLOB '*[^0-9a-f]*'`);
  else if (def.pattern) throw new Error(`unsupported pattern ${def.pattern}`);
  if (def.format === "date") parts.push(`${J} GLOB '${DATE}' AND length(${J}) = 10`);
  // D1 refuses a LIKE/GLOB pattern over 50 bytes (core/d1-limits): the date and the time are checked as two patterns, never one
  if (def.format === "date-time") parts.push(`substr(${J}, 1, 10) GLOB '${DATE}' AND substr(${J}, 11, 6) GLOB 'T[0-9][0-9]:[0-9][0-9]' AND length(${J}) >= 17`);
  if (def.minimum !== undefined) parts.push(`(${J} IS NULL OR ${J} >= ${def.minimum})`);
  if (def.properties) {
    const keys = Object.keys(def.properties);
    if (def.additionalProperties === false) parts.push(`NOT EXISTS (SELECT 1 FROM json_each(${root}, '${path}') WHERE key NOT IN (${keys.map(q).join(", ")}))`);
    const req = new Set(def.required || []);
    for (const k of keys) parts.push(check(def.properties[k], `${path}.${k}`, req.has(k), origins, root));
  }
  const body = parts.length ? parts.map((x) => `(${x})`).join(" AND ") : "1";
  // a type check on a union with "null" accepts the JSON null; an optional property may be absent (json_type is then NULL)
  return required ? `(${body})` : `(${T} IS NULL OR (${body}))`;
}

export function provenanceCondition(schema = PROVENANCE, origins = schema.properties.origin.enum) {
  const bad = origins.filter((o) => !schema.properties.origin.enum.includes(o));
  if (bad.length) throw new Error(`origins not in the provenance schema: ${bad.join(", ")}`);
  const s = structuredClone(schema);
  s.properties.origin = { ...s.properties.origin, enum: origins };
  const byOrigin = s["x-trigger-by-origin"] || {};
  const reqBy = s["x-required-by-origin"] || {}, onlyBy = s["x-allowed-only-by-origin"] || {};
  // per origin: the trigger that belongs to it, the fields it requires (catchup: missed_date) and the fields only another origin may carry
  const pairs = origins.map((o) => `(json_extract(NEW.provenance_json, '$.origin') = ${q(o)} AND json_extract(NEW.provenance_json, '$.trigger') = ${q(byOrigin[o])}${(reqBy[o] || []).map((f) => ` AND json_type(NEW.provenance_json, '$.${f}') IS NOT NULL`).join("")}${Object.entries(onlyBy).filter(([, allowed]) => !allowed.includes(o)).map(([f]) => ` AND json_type(NEW.provenance_json, '$.${f}') IS NULL`).join("")})`);
  const obj = check({ type: "object", required: s.required, properties: s.properties, additionalProperties: s.additionalProperties }, "$", true, origins);
  return `${obj} AND (${pairs.join(" OR ")})`;
}

const REFUSED = "podcast episode without a valid pipeline provenance record (t=0 rule)";

function triggersBody(origins, schema) {
  const cond = provenanceCondition(schema, origins);
  const when = `WHEN NEW.provenance_json IS NULL OR NOT COALESCE(CASE WHEN json_valid(NEW.provenance_json) AND json_type(NEW.provenance_json) = 'object' THEN (${cond}) ELSE 0 END, 0)   -- NULL (a missing field) is a refusal`;
  const abort = `BEGIN SELECT RAISE(ABORT, ${q(REFUSED)}); END;`;
  // the triggers run on D1: a pattern D1 refuses would abort EVERY insert (2026-10-07: no cron episode on any site), so it is never generated
  const tooLong = patternProblems(when);
  if (tooLong.length) throw new Error(`provenance triggers: ${tooLong.map((p) => `${p.op} pattern of ${p.bytes} bytes`).join(", ")} (D1 allows 50; core/d1-limits)`);
  return `CREATE TRIGGER IF NOT EXISTS podcast_provenance_insert BEFORE INSERT ON podcast_episodes\n${when}\n${abort}\nCREATE TRIGGER IF NOT EXISTS podcast_provenance_update BEFORE UPDATE OF provenance_json ON podcast_episodes\n${when}\n${abort}\n`;
}
const needOrigins = (origins) => { if (!Array.isArray(origins) || !origins.length) throw new Error("provenanceMigrationSql: origins are required (podcast.config.json provenance.origins)"); };

/** The first migration: the column, the legacy backfill and the triggers (`*_podcast_provenance.sql`). */
export function provenanceMigrationSql({ origins, schema = PROVENANCE } = {}) {
  needOrigins(origins);
  return `-- @saasreport/cloudflare: the t=0 rule for podcasts. GENERATED by \`kit podcast migrate\` from kit.podcast-provenance.v1 and the
-- provenance.origins of podcast.config.json (${origins.join(", ")}). Never hand-edited, \`kit check podcast\` compares it with the generator.
-- Every episode row carries a pipeline provenance record, and the database validates the WHOLE record on insert and on update:
-- version, origin (only the accepted ones), the trigger that belongs to the origin, series, ref, spec hash, timestamps, no unknown keys.
-- A hand-typed record, an incomplete one or one from another origin cannot be stored. Rows that exist when this migration runs get
-- origin "legacy" (they predate the record).
ALTER TABLE podcast_episodes ADD COLUMN provenance_json TEXT;
UPDATE podcast_episodes SET provenance_json = json_object('v', 1, 'origin', 'legacy', 'trigger', 'migration', 'series', series, 'ref', source_ref,
  'spec_sha256', '0000000000000000000000000000000000000000000000000000000000000000', 'created_at', created_at,
  'note', 'predates the provenance record') WHERE provenance_json IS NULL;
${triggersBody(origins, schema)}`;
}

/**
 * A later migration (\`*_podcast_provenance_triggers.sql\`) that replaces the triggers when the schema or the project's origins change
 * (a D1 migration that was applied is never edited): DROP and CREATE, nothing else. The highest-numbered one is what the gate compares.
 */
export function provenanceTriggersSql({ origins, schema = PROVENANCE } = {}) {
  needOrigins(origins);
  return `-- @saasreport/cloudflare: podcast provenance triggers, replaced. GENERATED by \`kit podcast migrate\` from kit.podcast-provenance.v1 and the
-- provenance.origins of podcast.config.json (${origins.join(", ")}). Never hand-edited. Same rule as the first provenance migration:
-- the database validates the whole record on insert and on update (now with the catchup origin and its missed_date).
DROP TRIGGER IF EXISTS podcast_provenance_insert;
DROP TRIGGER IF EXISTS podcast_provenance_update;
${triggersBody(origins, schema).replaceAll("CREATE TRIGGER IF NOT EXISTS", "CREATE TRIGGER")}`;
}
