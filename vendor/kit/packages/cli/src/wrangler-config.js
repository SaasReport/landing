/**
 * THE wrangler-config reader of the kit (one source; SPOF review R1). Every other module that needs a Worker's bindings, vars or
 * crons asks this one.
 *
 *   findWranglerConfigs(root)          every wrangler config in a repository, found by CONTENT, not by file name
 *                                      (wrangler.toml, wrangler.production.toml, deploy/**, workers/x/wrangler.staging.jsonc, ...)
 *   readWranglerRaw(path)              the parsed file (TOML, JSON or JSONC)
 *   readWranglerConfig(path)           { file, name, envs: { "": facts, <env>: facts } }: the top level and every [env.*] section
 *   d1Index(configs)                   database_name -> database_id over every config, so a name-only binding resolves
 *   d1Id(d, index)                     the identity of a D1 binding: its database_id, or the id its name resolves to, or null
 *
 * facts = { name, main, compat, d1: [{ binding, name, id, migrations }], r2: [{ binding, bucket }], kv, services, vars, crons, assets }, where assets is the built-assets directory ([assets] directory, or [site] bucket). wrangler does not inherit
 * bindings or vars into an environment; it does inherit triggers, and names the Worker <name>-<env> unless the env names it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { parseToml } from "./toml.js";

// node_modules, .git and caches are not the repository's; vendor/ is a manifest-verified snapshot of the kit (kit check vendor), whose
// starters and examples are the kit's, never this repository's deployment. Nothing else is excluded by path: a config this repository
// does not deploy is named in the reviewed allow-list (canon.allow.json, category "not-deployed"), one instance each (review M8).
const SKIP_DIRS = new Set([".git", "node_modules", ".wrangler", "dist", ".cache", ".kit"]);
const VENDOR = /^(vendor|\.kit|findings)\//;   // .kit: the kit's checkout at its head in source mode (docs/FRESHNESS.md), the kit and not this repository, like a vendored snapshot;   // findings/ holds the finding classes' cases (findings/<class>/must-fail|must-pass): fixtures of other repositories, never this one's deployment
const WRANGLER_NAME = /(^|\/)wrangler(\.[^/]*)?\.(toml|jsonc?)$/;
const NOT_CONFIG = /(^|\/)(package(-lock)?|tsconfig[^/]*|jsconfig)\.json$/;
/** Commands that deploy a Worker or Pages project. */
export const DEPLOY_COMMAND = /\b(wrangler\s+(deploy|publish|versions\s+deploy|pages\s+deploy)|kit\s+deploy)\b/;

function stripJsonc(text) {
  let out = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseWranglerText(text, path = "") {
  return /\.jsonc?$/.test(path) ? JSON.parse(stripJsonc(text)) : parseToml(text);
}
export const readWranglerRaw = (path) => parseWranglerText(readFileSync(path, "utf8"), path);

const WRANGLER_ONLY = ["compatibility_date", "workers_dev", "routes", "route", "triggers", "d1_databases", "r2_buckets", "kv_namespaces", "durable_objects", "services", "assets", "send_email", "browser", "containers", "workflows", "queues"];
const isObj = (o) => Boolean(o && typeof o === "object" && !Array.isArray(o));
/** A parsed object is a Worker config when it is named wrangler.*, or names a Worker or an entry point and has a key only wrangler has. */
export const isWranglerConfig = (o, file = "") => isObj(o) && !("dependencies" in o) && !("devDependencies" in o) && !("scripts" in o)
  && (WRANGLER_NAME.test(file) || ((typeof o.name === "string" || typeof o.main === "string") && WRANGLER_ONLY.some((k) => k in o)));

function walk(root, dir = root, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ continue; }
    if (st.isDirectory()) walk(root, p, out);
    else if (st.size < 512 * 1024) out.push(relative(root, p).split("\\").join("/"));
  }
  return out;
}

/**
 * Everything in a repository that deploys a Worker, read by content (review M8):
 *   configs: wrangler configs (any name; a file named wrangler.* that does not parse is an ERROR, as is any config candidate that does not)
 *   commands: deploy commands in package.json scripts and workflow run steps
 * allow: canon.allow.json entries of category "not-deployed" ({ file, match: the config's name or the command, context, reason }).
 * → { deployed: [files], all: [files], commands: [{ file, match, context }], problems: [{ file, problem }], stale: [entries] }
 */
export function scanDeployments(root, { allow = [] } = {}) {
  const entries = allow.filter((e) => e.category === "not-deployed").map((e) => ({ ...e, used: 0 }));
  const allowed = (file, match, context) => { const e = entries.find((x) => x.file === file && x.match === match && context.includes(x.context)); if (e) e.used++; return Boolean(e); };
  const out = { deployed: [], all: [], commands: [], problems: [], stale: [] };
  for (const f of walk(root)) {
    if (VENDOR.test(f)) continue;
    if (/\.(toml|jsonc?)$/.test(f) && !NOT_CONFIG.test(f)) {
      const text = readFileSync(join(root, f), "utf8");
      const candidate = WRANGLER_NAME.test(f) || /\bcompatibility_date\b/.test(text);
      let o;
      try { o = parseWranglerText(text, f); } catch (e) { if (candidate) out.problems.push({ file: f, problem: `a wrangler config candidate that does not parse: ${e.message}` }); continue; }
      if (!isWranglerConfig(o, f)) continue;
      out.all.push(f);
      const name = typeof o.name === "string" ? o.name : "(no name)";
      if (!allowed(f, name, text)) out.deployed.push(f);
    }
    const base = f.split("/").pop();
    if (base === "package.json") {
      let pkg; try { pkg = JSON.parse(readFileSync(join(root, f), "utf8")); } catch (e) { out.problems.push({ file: f, problem: `not JSON: ${e.message}` }); continue; }
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      for (const [k, cmd] of Object.entries(pkg.scripts || {})) if (DEPLOY_COMMAND.test(String(cmd)) && !allowed(f, String(cmd), `"${k}"`)) out.commands.push({ file: f, match: String(cmd), context: `"${k}"`, config: targetOf(root, dir, String(cmd)) });
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) {
      for (const l of readFileSync(join(root, f), "utf8").split("\n")) { const t = l.trim(); if (!t.startsWith("#") && DEPLOY_COMMAND.test(t) && !allowed(f, DEPLOY_COMMAND.exec(t)[0], t)) out.commands.push({ file: f, match: DEPLOY_COMMAND.exec(t)[0], context: t, config: targetOf(root, "", t) }); }
    }
  }
  // every deploy command maps to the config it deploys (review: generated configs too): an existing config, even under dist/, is a
  // deployed config; one the repository does not hold (built at deploy time) is a problem, since nothing could check what it binds
  for (const c of out.commands) {
    if (c.config === undefined || c.config === null) continue;
    if (!existsSync(join(root, c.config))) { out.problems.push({ file: c.file, problem: `${c.context}: deploys ${c.config}, which is not in the repository (generated at build time?): point the command at the committed source config, or commit the config, so the checks can read what it binds` }); continue; }
    if (VENDOR.test(c.config)) continue;
    if (!out.deployed.includes(c.config)) { out.deployed.push(c.config); if (!out.all.includes(c.config)) out.all.push(c.config); }
  }
  out.stale = entries.filter((e) => !e.used).map(({ used, ...e }) => e);
  out.deployed.sort(); out.all.sort();
  return out;
}

/**
 * The config a deploy command deploys, relative to the root: `-c`/`--config <file>` (relative to the directory the command runs in),
 * else the default wrangler.toml / wrangler.json / wrangler.jsonc of that directory; null for a Pages deploy (no Worker config).
 */
export function targetOf(root, dir, cmd) {
  if (/pages\s+deploy/.test(cmd)) return null;
  const at = (p) => normalize(join(dir, p)).replace(/\\/g, "/").replace(/^\.\//, "");
  const m = /(?:^|\s)(?:-c|--config)(?:\s+|=)(["']?)([^\s"';&|]+)\1/.exec(cmd);
  if (m) return at(m[2]);
  for (const d of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) if (existsSync(join(root, dir, d))) return at(d);
  return at("wrangler.toml");
}

/** The wrangler configs under root (all, or those this repository deploys: not vendored and not in the not-deployed allow-list). */
export function findWranglerConfigs(root, { deployed = false, allow = [] } = {}) {
  const s = scanDeployments(root, { allow });
  return deployed ? s.deployed : s.all;
}

const arr = (v) => (Array.isArray(v) ? v : []);
function factsOf(o, inherited = {}) {
  return {
    name: o.name ?? inherited.name ?? null,
    main: o.main ?? inherited.main ?? null,
    compat: o.compatibility_date ?? inherited.compat ?? null,
    d1: arr(o.d1_databases).map((d) => ({ binding: d.binding, name: d.database_name ?? null, id: d.database_id ?? null, migrations: d.migrations_dir ?? null })),
    r2: arr(o.r2_buckets).map((b) => ({ binding: b.binding, bucket: b.bucket_name ?? null })),
    kv: arr(o.kv_namespaces).map((k) => ({ binding: k.binding, id: k.id ?? null })),
    services: arr(o.services).map((s) => ({ binding: s.binding, service: s.service })),
    vars: o.vars && typeof o.vars === "object" ? o.vars : {},
    crons: o.triggers ? arr(o.triggers.crons) : arr(inherited.crons),
    assets: o.assets?.directory ?? o.site?.bucket ?? inherited.assets ?? null,
  };
}

/** { file, name, envs: { "": facts, production: facts, ... } }. Throws when the file cannot be read. */
export function readWranglerConfig(root, file) {
  const o = readWranglerRaw(join(root, file));
  const top = factsOf(o);
  const envs = { "": top };
  for (const [env, e] of Object.entries(o.env && typeof o.env === "object" ? o.env : {})) envs[env] = factsOf(e, { name: `${top.name}-${env}`, crons: top.crons, main: top.main, compat: top.compat, assets: top.assets });
  return { file, name: top.name, envs };
}

/** database_name -> database_id over every config and env (a name bound to two ids maps to null: ambiguous). */
export function d1Index(configs) {
  const byName = new Map();
  for (const c of configs) for (const f of Object.values(c.envs)) for (const d of f.d1) {
    if (!d.name || !d.id) continue;
    if (byName.has(d.name) && byName.get(d.name) !== d.id) byName.set(d.name, null); else byName.set(d.name, d.id);
  }
  return byName;
}

/** The identity of a D1 binding (its database_id, resolving a name-only binding), or null when it cannot be resolved. */
export const d1Id = (d, index) => d?.id || (d?.name ? index.get(d.name) ?? null : null);
