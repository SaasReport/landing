/**
 * The effective constitution registry: the kit's rules (packages/core/registry/constitution.rules.json) plus the project's own
 * constitution.rules.json (`extends: "kit"`, additions only). Plain JSON, zero dependencies: the hook reads it per call.
 * Validation against the schema is `kit check canon` (enforcement); this module only merges and reports structural conflicts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vendorRoots } from "../vendor-path.js";

export const PROJECT_FILE = "constitution.rules.json";
/** The repository's canon config: its `vendor` block places the snapshot. */
export const CANON_FILE = "kit.canon.json";
const union = (a = [], b = []) => [...a, ...b.filter((x) => !a.includes(x))];
const byId = (a = [], b = []) => [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))];

/**
 * → { registry, problems }. Never throws on a missing or malformed project file: the problem is returned. `vendor` is kit.canon.json's
 * vendor config (absent: the default path): its snapshot and manifest are generated roots, derived here and named nowhere else, and
 * `generated.snapshot` is the snapshot's path.
 */
export function mergeRegistry(kit, own, vendor) {
  const m = mergeOwn(kit, own);
  try { const v = vendorRoots(vendor); m.registry.generated.globs = union(m.registry.generated.globs, v.globs); m.registry.generated.snapshot = v.snapshot; }
  catch (e) { m.problems.push(`kit.canon.json: ${e.message}`); }
  return m;
}

function mergeOwn(kit, own) {
  const problems = [];
  if (!own) return { registry: structuredClone(kit), problems };
  if (own.extends !== "kit") problems.push(`${PROJECT_FILE}: a project registry states "extends": "kit" and only what it adds`);
  const r = structuredClone(kit);
  const ids = new Set(r.rules.map((x) => x.id));
  for (const rule of own.rules || []) { if (ids.has(rule.id)) problems.push(`${PROJECT_FILE}: rule "${rule.id}" already exists in the kit's registry; a project adds rules, it never redefines one`); else { ids.add(rule.id); r.rules.push(rule); } }
  for (const [k, f] of [["generated", ["globs", "markers"]], ["diagrams", ["imageGlobs", "sourceExtensions", "foreignRenderers", "fixtureGlobs"]], ["secrets", ["fileNames", "fileExceptions"]], ["git", ["protectedBranches", "skipHookEnv"]], ["protected", ["globs", "bypassFlags", "bypassEnv", "approvalGlobs", "approvalCommands"]], ["separation", ["deployCommands", "gates", "recipientVars", "ciEnvironmentFor"]]]) for (const x of f) if (own[k]?.[x]) r[k][x] = union(r[k][x], own[k][x]);
  if (own.secrets?.patterns) r.secrets.patterns = byId(r.secrets.patterns, own.secrets.patterns);
  for (const [a, sc] of Object.entries(own.scopes?.agents || {})) { if (a in r.scopes.agents) problems.push(`${PROJECT_FILE}: scope of agent "${a}" is already declared by the kit; a project declares agents the kit does not`); else r.scopes.agents[a] = sc; }
  if (own.tools) { for (const [c, l] of Object.entries(own.tools.classes || {})) r.tools.classes[c] = union(r.tools.classes[c] || [], l); if (own.tools.mcp?.allowServers) r.tools.mcp.allowServers = union(r.tools.mcp.allowServers, own.tools.mcp.allowServers); }
  if (own.actions) r.actions = byId(r.actions, own.actions);
  if (own.advisors) r.advisors = [...(kit.advisors || []), ...own.advisors];
  return { registry: r, problems };
}

export function loadEffective(root, kitRegistryFile) {
  const kit = JSON.parse(readFileSync(kitRegistryFile, "utf8"));
  const file = join(root, PROJECT_FILE);
  let own = null, bad = null;
  if (existsSync(file)) { try { own = JSON.parse(readFileSync(file, "utf8")); } catch (e) { bad = `${PROJECT_FILE}: not JSON (${e.message})`; } }
  let vendor, badCanon = null;
  const canonFile = join(root, CANON_FILE);
  if (existsSync(canonFile)) { try { vendor = JSON.parse(readFileSync(canonFile, "utf8")).vendor; } catch (e) { badCanon = `${CANON_FILE}: not JSON (${e.message})`; } }
  const m = mergeRegistry(kit, own, vendor);
  if (bad) m.problems.push(bad);
  if (badCanon) m.problems.push(badCanon);
  return { ...m, kit, own };
}
