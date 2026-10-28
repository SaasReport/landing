/**
 * The seal of the ONE build (docs/RELEASE.md, rule tested-artefact-deployed). `kit release build` runs release.json build.run exactly once,
 * before the tests, and writes .release/seal.json: the sha256 of every file under build.artifact. `kit release ship` re-reads the tree
 * before EACH Worker deploy and refuses when anything differs, so the deployed artefact is the tested one: a test that rebuilds to a
 * different output, or a step that rebuilds after the tests (SaasReport's `npm test && npm run stamp && wrangler deploy`), cannot reach production.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const SEAL_FILE = ".release/seal.json";

function files(root, rel) {
  const full = join(root, rel);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [rel];
  const out = [];
  for (const f of readdirSync(full).sort()) out.push(...files(root, `${rel}/${f}`));
  return out;
}

/** { files: { path: sha256 }, sha256 } of every file under `paths` (sorted, so the digest is stable). */
export function treeDigest(root, paths) {
  const map = {};
  for (const p of paths) for (const f of files(root, p.replace(/\/+$/, ""))) map[relative(root, join(root, f)).split("\\").join("/")] = createHash("sha256").update(readFileSync(join(root, f))).digest("hex");
  const sha256 = createHash("sha256").update(JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  return { files: map, sha256 };
}

/** Write the seal of the artefact (after the one build). An artefact path that holds no file is a build that produced nothing: refused. */
export function writeSeal(root, artifact, { commit = null, build } = {}) {
  const empty = artifact.filter((p) => !files(root, p.replace(/\/+$/, "")).length);
  if (empty.length) throw new Error(`the build produced nothing under ${empty.join(", ")} (release.json build.artifact): nothing to seal`);
  const d = treeDigest(root, artifact);
  const seal = { v: 1, commit, build, artifact, sha256: d.sha256, files: d.files };
  mkdirSync(dirname(join(root, SEAL_FILE)), { recursive: true });
  writeFileSync(join(root, SEAL_FILE), `${JSON.stringify(seal, null, 2)}\n`);
  return seal;
}

/**
 * Problems when the artefact on disk is not the sealed one (no seal: the build step did not run → refused). `commit`: the seal must be
 * of this commit; `sha256`: the digest the build step reported (SEAL_SHA256, a step output): the file on disk must carry it, so a reseal
 * between the build step and ship (a test that rebuilds, a script that runs `kit release build` again) is refused.
 */
export function sealProblems(root, artifact, { commit = null, sha256 = null } = {}) {
  const f = join(root, SEAL_FILE);
  if (!existsSync(f)) return [`no seal (${SEAL_FILE}): \`kit release build\` runs the one build before the tests; nothing is deployed without it`];
  let seal;
  try { seal = JSON.parse(readFileSync(f, "utf8")); } catch (e) { return [`${SEAL_FILE} is not JSON: ${e.message}`]; }
  if (JSON.stringify(seal.artifact) !== JSON.stringify(artifact)) return [`the seal covers ${JSON.stringify(seal.artifact)}, release.json build.artifact is ${JSON.stringify(artifact)}`];
  if (commit && seal.commit !== commit) return [`the seal is of ${seal.commit || "no commit"}, this run deploys ${commit}: the build step sealed another commit`];
  if (sha256 && seal.sha256 !== sha256) return [`the seal on disk (${String(seal.sha256).slice(0, 12)}) is not the one the build step reported (${String(sha256).slice(0, 12)}): the artefact was resealed after the build step`];
  const now = treeDigest(root, artifact);
  if (now.sha256 === seal.sha256) return [];
  const changed = [], all = new Set([...Object.keys(seal.files || {}), ...Object.keys(now.files)]);
  for (const p of [...all].sort()) if (seal.files?.[p] !== now.files[p]) changed.push(`${p} (${!seal.files?.[p] ? "added" : !now.files[p] ? "removed" : "changed"})`);
  return [`the artefact changed after the sealed build (a rebuild after the tests?): ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""}. What is deployed must be what was tested`];
}
