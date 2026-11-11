/**
 * release.json (kit.release.v1) and the facts derived from it with the kit's one wrangler reader (docs/RELEASE.md). Every `kit release`
 * command and the canon check `release` read the repository through here: one place that resolves a Worker's name, entry, D1 bindings,
 * migrations directory and build endpoint.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { formatProblems } from "@saasreport/core/schema";
import { readWranglerConfig } from "../wrangler-config.js";

export const RELEASE_FILE = "release.json";
export const BOOTSTRAP_RECEIPT = "release/bootstrap.json";
export const PROVISIONED_FILE = "release/provisioned.json";
/** The placeholder a binding config carries for a D1 the production run creates (wired at run time, recorded by the records PR). */
export const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";
export const DEFAULTS = Object.freeze({ workflow: ".github/workflows/production.yml", drift: ".github/workflows/drift.yml", environment: "production" });
/** The environment secret of the one owner address (the comms config's forms.owner.secret default, kit.forms-config.v1). */
export const OWNER_SECRET = "OPS_NOTIFY_TO";

const rel = (base, p) => normalize(join(dirname(base), p)).split("\\").join("/").replace(/^\.\//, "");

/** { doc, problems } — the file, schema-validated (kit.release.v1). */
export function loadRelease(root, kit, file = RELEASE_FILE) {
  if (!existsSync(join(root, file))) return { doc: null, problems: [{ file, problem: "missing" }] };
  let doc;
  try { doc = JSON.parse(readFileSync(join(root, file), "utf8")); } catch (e) { return { doc: null, problems: [{ file, problem: `not JSON: ${e.message}` }] }; }
  const sp = formatProblems(kit.validator.validate(doc, kit.byName("release")));
  if (sp.length) return { doc: null, problems: sp.map((m) => ({ file, problem: `kit.release.v1: ${m}` })) };
  return { doc: { ...DEFAULTS, ...doc }, problems: [] };
}

/** The environment variables a workflow must pass to every `kit release` step of the run identity (the one source of the refusal text and of the deployer's workflow test). */
export const IDENTITY_ENV = Object.freeze({ local: ["KIT_RELEASE_ENVIRONMENT"], central: ["KIT_RELEASE_ENVIRONMENT", "KIT_RELEASE_SOURCE_REPOSITORY", "KIT_RELEASE_SOURCE_SHA"] });
export const SHA_RE = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Who runs this release and which commit it deploys (docs/RELEASE.md), proven before anything else. Both modes: the run is on main of the
 * repository that runs it, and that repository is one the kit project registry lists for the project (a fork is never a source). Local
 * mode: this repository's own production workflow deploys GITHUB_SHA. Central mode (release.json deployer): only deployer.repository's
 * workflow may run it, its environment is KIT_RELEASE_ENVIRONMENT (the deployer's locked template passes it; it must be
 * deployer.environment), and it deploys KIT_RELEASE_SOURCE_SHA of the registered source KIT_RELEASE_SOURCE_REPOSITORY, checked out at
 * root. Both modes refuse an unset KIT_RELEASE_ENVIRONMENT. These env comparisons are consistency checks, NOT the proof: ref, repository and
 * environment are proven by the workflow being the template byte for byte (kit check release), by guard() reading main's HEAD and the
 * environment's policy from the API, and by the credentials existing only in the GitHub environment (docs/RELEASE.md).
 * → { central, runner, environment, source, commit } or throws.
 */
export function releaseIdentity(doc, env = {}, kit) {
  if (!kit?.registry) throw new Error("releaseIdentity needs the kit project registry: without it the repository check would be skipped");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error(`production changes only from main, so it runs reviewed code (ref: ${env.GITHUB_REF || "(none)"})`);
  const listed = registryProject(kit, doc.project)?.github || [];
  const registered = (repo, what) => { if (!listed.includes(repo)) throw new Error(`${what} ${repo || "(none)"} is not a repository the kit project registry lists for ${doc.project} (${listed.join(", ") || "none"}): a fork or an unregistered repository is never deployed`); };
  if (!doc.deployer) {
    registered(env.GITHUB_REPOSITORY, "this repository");
    if (env.KIT_RELEASE_ENVIRONMENT !== doc.environment) throw new Error(`KIT_RELEASE_ENVIRONMENT is ${env.KIT_RELEASE_ENVIRONMENT || "(not set)"}, release.json says ${doc.environment}: the workflow passes the environment it runs in`);
    return { central: false, runner: env.GITHUB_REPOSITORY, environment: doc.environment, source: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA };
  }
  if (env.GITHUB_REPOSITORY !== doc.deployer.repository) throw new Error(`release.json names ${doc.deployer.repository} as this project's deployer; this run is in ${env.GITHUB_REPOSITORY || "(no repository)"}: production is changed only there`);
  if (env.KIT_RELEASE_ENVIRONMENT !== doc.deployer.environment) throw new Error(`KIT_RELEASE_ENVIRONMENT is ${env.KIT_RELEASE_ENVIRONMENT || "(not set)"}, not the deployer environment release.json names (${doc.deployer.environment}): the deployer's template passes the environment it runs in`);
  if (!SHA_RE.test(env.KIT_RELEASE_SOURCE_SHA || "")) throw new Error("KIT_RELEASE_SOURCE_SHA is not a 40-hex commit: the deployer names the source commit it deploys");
  if (!REPO.test(env.KIT_RELEASE_SOURCE_REPOSITORY || "")) throw new Error("KIT_RELEASE_SOURCE_REPOSITORY is not owner/repo: the deployer names the source repository");
  registered(env.KIT_RELEASE_SOURCE_REPOSITORY, "the source repository");
  return { central: true, runner: env.GITHUB_REPOSITORY, environment: doc.deployer.environment, source: env.KIT_RELEASE_SOURCE_REPOSITORY, commit: env.KIT_RELEASE_SOURCE_SHA };
}

/** The project's registry entry (by key or prefix code), or null. */
export function registryProject(kit, project) {
  return (kit.registry?.projects || []).find((p) => p.key === project || p.prefix === `${project}-` || p.short === `${project}-`) || null;
}

/** The release Workers with their wrangler facts: [{ ...entry, config, facts, name, entryFile, url }]. Throws on an unreadable config. */
export function releaseWorkers(root, doc) {
  return doc.workers.map((w) => {
    const config = readWranglerConfig(root, w.wrangler);
    const facts = config.envs[w.env || ""];
    if (!facts) throw new Error(`${w.wrangler} has no [env.${w.env}] section`);
    return { ...w, config, facts, name: facts.name, entryFile: facts.main ? rel(w.wrangler, facts.main) : null, assetsDir: facts.assets ? rel(w.wrangler, facts.assets) : null };
  });
}

/** The public build URL of a Worker entry, or null when it answers behind another one. workers.dev URLs come from release.json workers_dev. */
export function buildUrl(doc, w) {
  if (w.build) return w.build;
  if (w.workers_dev) return doc.workers_dev ? `https://${w.name}.${doc.workers_dev}.workers.dev/api/build` : null;
  return null;
}

/** The monitor's own status URL, derived (one source: the monitor Worker's name and the account's workers.dev subdomain in release.json). */
export function monitorStatusUrl(root, doc, monitorWrangler, env = "") {
  if (!doc?.workers_dev || !monitorWrangler) return null;
  const facts = readWranglerConfig(root, monitorWrangler).envs[env];
  return facts?.name ? `https://${facts.name}.${doc.workers_dev}.workers.dev/status` : null;
}

/** Every D1 database name → { configs: [{ wrangler, binding, id, migrationsDir }] } over the release Workers. */
export function databaseBindings(workers) {
  const out = new Map();
  for (const w of workers) for (const d of w.facts.d1) {
    if (!d.name) continue;
    if (!out.has(d.name)) out.set(d.name, []);
    out.get(d.name).push({ wrangler: w.wrangler, binding: d.binding, id: d.id, env: w.env || "", migrationsDir: d.migrations ? rel(w.wrangler, d.migrations) : null });
  }
  return out;
}

/** The one migrations directory of a database across its binding configs (none, or exactly one), or an error. */
export function migrationsDirFor(name, bindings) {
  const dirs = [...new Set(bindings.map((b) => b.migrationsDir).filter(Boolean))];
  if (dirs.length > 1) throw new Error(`the configs that bind ${name} name ${dirs.length} migrations directories (${dirs.join(", ")}), not one`);
  return dirs[0] ?? null;
}

export const readJsonIf = (root, file) => (existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), "utf8")) : null);
