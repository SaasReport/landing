/**
 * Canonical T=0 remote D1 pre-migration backup gate.
 *
 * Runs from protected production ship AFTER identity/admission/provision and
 * BEFORE the first SQL migration or Worker deployment. A failed export,
 * absent backup binding, unreadable R2 copy or digest mismatch aborts ship.
 * Existing production D1 IDs are preserved; no destructive operation exists.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { readWranglerConfig } from "../wrangler-config.js";

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deny = (why) => { throw new Error(`pre-migration D1 backup refused: ${why}`); };

export function d1BackupPlan(doc, resilience) {
  const out = new Map();
  const declared = new Set((doc.buckets || []).map((b) => b.name));
  for (const d of doc.databases || []) {
    const matches = (resilience?.backups || []).filter((b) =>
      b?.source?.kind === "d1" && b.source.name === d.name &&
      b?.destination?.kind === "r2" && declared.has(b.destination.name));
    if (matches.length !== 1) deny(`${d.name}: expected exactly one project-owned D1 → declared R2 backup mapping, found ${matches.length}`);
    if (!NAME.test(d.name) || !NAME.test(matches[0].destination.name))
      deny(`${d.name}: unsafe database/bucket name`);
    out.set(d.name, matches[0].destination.name);
  }
  return out;
}

export async function snapshotExistingD1({ root, doc, name, bucket, configs, cf, wrangler, tmp, commit, runId, log = () => {} }) {
  if (!SHA.test(commit || "") || !/^\d+$/.test(String(runId || ""))) deny(`${name}: missing T=0 commit or CI run identity`);
  if (!NAME.test(name) || !NAME.test(bucket) || !NAME.test(doc.project)) deny("unsafe project/database/bucket name");
  const physical = await cf.d1Find(name);
  if (!physical?.uuid || !/^[0-9a-f-]{36}$/i.test(physical.uuid)) deny(`${name}: unknown physical D1 ID`);
  const candidates = (configs || []).map((c) => readWranglerConfig(root, c.wrangler).envs[c.env || ""]?.compat).filter(Boolean);
  // Several Workers can share one physical D1 while using different compatibility
  // dates. A snapshot is a read-only export: select the newest declared date,
  // as a deterministic compatible transport profile, not a schema authority.
  if (!candidates.length || candidates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)))
    deny(`${name}: missing or malformed Worker compatibility date`);
  const snapshotDate = [...candidates].sort().at(-1);
  const cfFile = join(tmp, `${name}-snapshot.toml`);
  writeFileSync(cfFile, [
    `name = "${name}-snapshot"`,
    `compatibility_date = "${snapshotDate}"`,
    "[[d1_databases]]",
    'binding = "SNAPSHOT"',
    `database_name = "${name}"`,
    `database_id = "${physical.uuid}"`,
    ""
  ].join("\n"));
  const source = join(tmp, `${name}-before.sql`);
  // Export blocks live D1 queries and requires explicit consent in Wrangler. The guarded, reviewed production workflow already supplied T0 authority; make that intent explicit for headless Actions.
  await wrangler(["d1", "export", name, "--remote", "--skip-confirmation", "--config", cfFile, "--output", source]);
  const bytes = readFileSync(source);
  if (!bytes.length) deny(`${name}: D1 export is empty`);
  const hash = digest(bytes);
  const key = `pre-migration/${doc.project}/${name}/${commit}/${runId}/${hash}.sql`;
  const object = `${bucket}/${key}`;
  await wrangler(["r2", "object", "put", object, "--file", source, "--remote"]);
  const readback = join(tmp, `${name}-from-r2.sql`);
  await wrangler(["r2", "object", "get", object, "--file", readback, "--remote"]);
  const returned = readFileSync(readback);
  if (returned.length !== bytes.length || digest(returned) !== hash)
    deny(`${name}: R2 readback differs from the remote D1 export`);
  const rel = `release/pre-migration-${name}-${runId}-${hash.slice(0, 12)}.json`;
  const proof = {
    schema: "kit.release-d1-before-sql.v1",
    project: doc.project, commit, run_id: String(runId),
    database: { name, uuid: physical.uuid },
    backup: { bucket, key, sha256: hash, bytes: bytes.length, read_back: true },
    migration_applied: false
  };
  // The receipt is independent of the CI runner: durable R2 proof exists at
  // the same T=0 boundary as the backup. A forged acknowledgement or missing
  // manifest read-back cannot turn a Remote D1 SQL mutation green.
  const json = JSON.stringify(proof, null, 2) + "\n";
  const manifest = join(tmp, `${name}-before-receipt.json`);
  writeFileSync(manifest, json);
  const manifestKey = `pre-migration/${doc.project}/${name}/${commit}/${runId}/${hash}.json`;
  const receipt = `${bucket}/${manifestKey}`;
  await wrangler(["r2", "object", "put", receipt, "--file", manifest, "--remote"]);
  const manifestReadback = join(tmp, `${name}-receipt-r2.json`);
  await wrangler(["r2", "object", "get", receipt, "--file", manifestReadback, "--remote"]);
  if (digest(readFileSync(manifestReadback)) !== digest(Buffer.from(json)))
    deny(`${name}: R2 receipt readback differs from immutable pre-SQL evidence`);
  const proofPath = join(root, rel);
  mkdirSync(dirname(proofPath), { recursive: true });
  if (existsSync(proofPath)) {
    if (readFileSync(proofPath, "utf8") !== json)
      deny(`${name}: a previous immutable release proof conflicts with this attempt`);
  } else writeFileSync(proofPath, json, { flag: "wx" });
  log(`T=0 D1 ${name}: immutable pre-SQL backup and receipt verified in R2 (sha256 ${hash})`);
  return proof;
}
