import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gitEnv } from "./git.js";
import { createValidator } from "@saasreport/core/schema";
import { trustedApprovals } from "@saasreport/core/approvals";
import { ownerKeysFromGithub } from "@saasreport/core/trust";
import { TEST } from "./test-seam.js";
import { readTrustRecords } from "./trust-records.js";

const originSlug = (cwd) => { const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", env: gitEnv() }); const m = r.status === 0 && /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout); return m ? m[1] : null; };

const KEY_CACHE = new Map();   // in memory only: a file cache would be writable by whoever can write the environment, and believed on a 304
/**
 * The trust context, from OUTSIDE the repository: the owner is PINNED by KIT_OWNER (a GitHub org/repo Actions variable in CI, a Worker binding at run time,
 * the owner's own environment locally); the owner's keys are their published GitHub SSH signing keys, fetched with the token of the environment that runs the check
 * (KIT_GITHUB_TOKEN or GITHUB_TOKEN; 60 requests an hour without one, 5000 with) and cached in memory by ETag; GitHub is DISCOVERY only: KIT_OWNER_KEYS pins the owner's key fingerprints (SHA256:..., comma separated), and without pins a key added in the last 7 days is refused; the repository is GITHUB_REPOSITORY (set by Actions).
 * KIT_TRUST_PIN (JSON, per project: { "<project>": { "minSeq": N, "verifier": { url, publicKey, required }, "witness": { url, publicKey } } }) pins, next to KIT_OWNER, the lowest record seq and the
 * verifier and witness the owner requires, so a repository record can only add requirements, never drop them. Nothing in the working tree can supply any of it. Fails closed: a missing piece, a 403/429 or an unreachable GitHub leaves nothing trusted, with the reason.
 * AUTHORITY: this runs inside a process whose environment (KIT_OWNER, NODE_OPTIONS, the fetch implementation, the code itself) the agent that runs it controls, so its
 * answer is authoritative only when the SAME checks run in the remote verifier (core/verifier.js) with its own pinned owner and credential; `--verifier-url` calls it.
 */
export function trustContext({ env = process.env, fetch: fetchFn = globalThis.fetch, cwd = process.cwd(), seam = {} } = {}) {
  let keys = null;
  let trustPins = seam.pin ?? null; if (!trustPins && env.KIT_TRUST_PIN) { try { trustPins = JSON.parse(env.KIT_TRUST_PIN); } catch { trustPins = { __invalid: true }; /* an unparsable pin is marked invalid; pinFor() turns it into a refusal, never into no pin */ } }
  const owner = seam.owner ?? env.KIT_OWNER ?? null, token = env.KIT_GITHUB_TOKEN || env.GITHUB_TOKEN || null;
  const pins = seam.pins ?? String(env.KIT_OWNER_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);   // SHA256:... fingerprints of the owner's SSH signing keys; GitHub is discovery only
  return {
    owner,
    pinFor: (project) => (trustPins?.__invalid ? { minSeq: "KIT_TRUST_PIN is not valid JSON" } : (seam.pin ? seam.pin : trustPins?.[project]) ?? null),   // validated against kit.trust-pin.v1 where it is used: unset, {} or null is a problem, never "no pin"   // outside the repo, next to KIT_OWNER: { minSeq, verifier, witness } per project
    repo: seam.repo ?? env.GITHUB_REPOSITORY ?? originSlug(cwd),
    async keys() {
      if (seam.ownerKeys) return { keys: seam.ownerKeys };
      if (!owner) return { keys: [] };
      if (!keys) keys = ownerKeysFromGithub(owner, fetchFn, { token, pins, cache: { get: (o) => KEY_CACHE.get(o), set: (o, e) => KEY_CACHE.set(o, e) } }).then((k) => ({ keys: k }), (e) => ({ keys: [], error: e.message }));
      return keys;
    },
  };
}

/** The bundled schemas of @saasreport/core: { dir, registryDir, index, registry, findingClasses, trust, approvals(project), validator, byName(name) → schema }. */
export function bundled({ registry: override = null, trust: trustOverride = null, io = null } = {}) {
  let core = fileURLToPath(new URL("../../core/", import.meta.url));
  if (!existsSync(join(core, "schemas", "index.json"))) core = dirname(createRequire(import.meta.url).resolve("@saasreport/core/package.json"));
  const dir = join(core, "schemas");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const schemas = index.schemas.map((e) => ({ ...e, path: join(dir, e.file), schema: JSON.parse(readFileSync(join(dir, e.file), "utf8")) }));
  const validator = createValidator(schemas.map((s) => s.schema));
  const registry = override || JSON.parse(readFileSync(join(core, "registry", "projects.json"), "utf8"));
  const tdir = join(core, "registry", "trust");
  const trust = trustOverride || { records: existsSync(tdir) ? readTrustRecords({ files: readdirSync(tdir), read: (f) => readFileSync(join(tdir, f), "utf8") }) : [] };   // the one reader (trust-records.js): an unreadable file is a corrupted set, never skipped
  const seam = io?.[TEST] || {};
  const ctx = trustContext({ env: io?.env || process.env, fetch: io?.fetch || globalThis.fetch, cwd: io?.cwd || process.cwd(), seam });
  const cache = new Map();
  /** What the owner signed for a project (a promise, memoised): { project, known, concepts, shariah, persian, problems }. */
  const approvals = (project) => { if (!cache.has(project)) cache.set(project, ctx.keys().then(({ keys: ownerKeys, error }) => trustedApprovals(trust, project, { owner: ctx.owner, ownerKeys, ownerKeysError: error, pin: ctx.pinFor(project), repo: ctx.repo, now: Date.now(), nowSource: "this machine's clock (not authoritative: configure the witness, whose clock is)" }))); return cache.get(project); };
  const findingClasses = { file: join(core, "registry", "finding-classes.json"), registry: JSON.parse(readFileSync(join(core, "registry", "finding-classes.json"), "utf8")) };
  return { dir, registryDir: join(core, "registry"), index, schemas, registry, findingClasses, trust, approvals, validator, byName: (n) => schemas.find((s) => s.name === n)?.schema };
}

/** The bundled schemas, registry and trust for a command: tests inject through the module-private seam; nothing else can change them. */
export const kitFor = (io) => { const s = io?.[TEST] || {}; return bundled({ registry: s.registry ?? null, trust: s.trust ?? null, io }); };
