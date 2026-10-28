/**
 * The vendored package graph: ONE resolver that `kit vendor sync` (before it writes anything) and `kit check vendor` /
 * `kit check lockfile` all call, reading the snapshot location from kit.canon.json `vendor.path` (never a literal `vendor/`).
 *
 * A vendored kit is installed through `file:` dependencies. A vendored package that depends on another vendored package
 * (@saasreport/uploads on a Worker handler, say) is resolved from the snapshot only when the root package.json declares it
 * too; otherwise npm asks the public registry and `npm ci` stops with a 404. The graph follows npm's own semantics:
 *
 *   - edges are dependencies, optionalDependencies and peerDependencies (a peer that peerDependenciesMeta marks optional
 *     is not installed); for one name npm's precedence applies: optionalDependencies, then dependencies, then peerDependencies;
 *   - a range is checked against the version actually vendored with the `semver` package (npm's own range grammar);
 *     a vendored package names another by version range only (`workspace:`, `link:` and `file:../` between vendored packages are refused); the root names one by `file:<snapshot dir>`;
 *   - names are matched exactly, scoped or not; two vendored packages with one name are an error;
 *   - an optional edge whose target is not vendored is skipped (npm skips it too); any other edge to a scope the snapshot
 *     vendors, whose package is not vendored, is an error.
 *
 *   - `needed` is the closure of what the root package.json declares: the vendored packages it names (any section, any spec),
 *     then every vendored package those need, and so on. A vendored package nothing declared reaches installs nothing and needs nothing.
 *     Every vendored package is still checked (ranges, locations, missing scope members); only the install closure is rooted.
 *   - unreadable JSON (a vendored package.json, the root's, the lockfile) is a finding, never a crash and never a silent pass.
 *
 *   vendorGraph(root, cfg, { packages? }) → { path, packages: Map(name → { name, version, dir, edges }), root (parsed package.json | null), needed: [{ name, dir, spec, by }], problems }
 *   graphProblems(root, cfg)              → [{ file, problem }]  declarations in package.json and links in package-lock.json, each reported once
 *
 * `packages` lets sync resolve the snapshot it is about to write, from git, before any file exists: [{ dir, pkg }].
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalPath, insidePath, cleanConfig } from "./vendor-path.js";
import semver from "semver";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
/** A JSON file as { value } or { error }: unreadable JSON is a finding of the check that reads it, never a crash and never a silent pass. */
export const readJson = (p) => { try { return { value: read(p) }; } catch (e) { return { error: `not readable JSON (${e.message})` }; } };
const KINDS = ["dependencies", "optionalDependencies", "peerDependencies"];
export { normalPath, insidePath, cleanConfig } from "./vendor-path.js";
/** A spec that names a location instead of a version range. Only file:<snapshot dir> is how this repository installs a vendored package. */
const locationSpec = (s) => /^(file|workspace|link|git\+|git:|github:|https?:)/.test(String(s));

/** The vendored packages on disk: [{ dir, pkg }] for <vendor.path>/packages/*. */
export function packagesOnDisk(root, cfg, problems = []) {
  const vp = normalPath(cfg.path), base = join(root, vp, "packages"), out = [];
  if (!existsSync(base)) return out;
  for (const d of readdirSync(base, { withFileTypes: true })) {
    const f = join(base, d.name, "package.json");
    if (!d.isDirectory() || !existsSync(f)) continue;
    const r = readJson(f);
    if (r.error) problems.push({ file: `${vp}/packages/${d.name}/package.json`, problem: r.error });
    else out.push({ dir: `${vp}/packages/${d.name}`, pkg: r.value });
  }
  return out;
}

/** The names a root package.json declares, in any section: the roots of the install. */
const declaredNames = (pkg) => new Set(["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg?.[k] || {})));

/** The edges of one package under npm's precedence: Map(name → { range, kind }). */
export function edgesOf(pkg) {
  const out = new Map();
  const peerOptional = pkg.peerDependenciesMeta || {};
  for (const kind of ["peerDependencies", "dependencies", "optionalDependencies"]) {   // later wins: optional > dependencies > peer
    for (const [name, range] of Object.entries(pkg[kind] || {})) {
      if (kind === "peerDependencies" && peerOptional[name]?.optional) continue;
      out.set(name, { range, kind });
    }
  }
  return out;
}

export function vendorGraph(root, cfgIn, { packages } = {}) {
  let cfg;
  try { cfg = cleanConfig(cfgIn); } catch (e) { return { path: "", packages: new Map(), root: null, needed: [], problems: [{ file: "kit.canon.json", problem: e.message }] }; }
  const problems = [], P = (file, problem) => { if (!problems.some((x) => x.file === file && x.problem === problem)) problems.push({ file, problem }); };
  const list = packages || packagesOnDisk(root, cfg, problems);
  const byName = new Map();
  for (const { dir, pkg } of list) {
    if (!pkg.name) continue;   // an unnamed package cannot be depended on
    if (byName.has(pkg.name)) { P(`${dir}/package.json`, `${pkg.name} is vendored twice (${byName.get(pkg.name).dir} and ${dir}): one name, one package`); continue; }
    byName.set(pkg.name, { name: pkg.name, version: pkg.version, dir, pkg, edges: edgesOf(pkg) });
  }
  const scopes = new Set([...byName.keys()].filter((n) => n.startsWith("@")).map((n) => n.split("/")[0]));
  // the root: what the project declares decides what is installed; a vendored package the project does not declare, and no declared one needs, is not
  let rootPkg = null;
  const pj = join(root, "package.json");
  if (existsSync(pj)) {
    const r = readJson(pj);
    if (r.error) { if (byName.size) P("package.json", r.error); } else rootPkg = r.value;
  }
  const reach = new Set(), queue = [...declaredNames(rootPkg)].filter((n) => byName.has(n));
  const roots = new Set(queue);
  while (queue.length) for (const name of byName.get(queue.pop()).edges.keys()) if (byName.has(name) && !reach.has(name)) { reach.add(name); queue.push(name); }
  const needed = new Map();
  for (const p of byName.values()) {
    for (const [name, { range, kind }] of p.edges) {
      const t = byName.get(name);
      if (!t) {
        if (scopes.has(name.split("/")[0]) && kind !== "optionalDependencies") P(`${p.dir}/package.json`, `${p.name} depends on ${name}, which is not in the vendored packages (${cfg.path}/packages): vendor the kit snapshot that contains it`);
        continue;
      }
      if (locationSpec(range)) P(`${p.dir}/package.json`, `${p.name}: ${kind}.${name} is "${range}", a location: a vendored package depends on another by version range (the root installs both from the snapshot with file:${t.dir})`);
      else if (semver.validRange(range) === null) P(`${p.dir}/package.json`, `${p.name}: ${kind}.${name} is "${range}", not a version range npm understands`);
      else if (!semver.satisfies(t.version, range)) P(`${p.dir}/package.json`, `${p.name} needs ${name}@${range} but the vendored ${name} is ${t.version}`);   // npm's own prerelease rule: 1.0.0-beta.1 does not satisfy ^1.0.0
      if (!roots.has(p.name) && !reach.has(p.name)) continue;   // an edge of a package nothing installed reaches installs nothing
      if (!needed.has(name)) needed.set(name, { name, dir: t.dir, spec: `file:${t.dir}`, by: [] });
      needed.get(name).by.push(p.name);
    }
  }
  return { path: cfg.path, packages: byName, root: rootPkg, needed: [...needed.values()], problems };
}

/** file:./vendor/kit/packages/a and file:vendor/kit/packages/a/ name one directory: compare them as paths. */
const normalSpec = (s) => (/^file:/.test(String(s)) ? `file:${normalPath(String(s).slice(5))}` : String(s));

/** The sections of a root package.json that declare a name → [{ kind, spec }] (npm's precedence picks one; two different specs are a conflict). */
const declarations = (pkg, name) => ["optionalDependencies", "dependencies", "devDependencies"].filter((k) => pkg[k]?.[name] !== undefined).map((kind) => ({ kind, spec: pkg[kind][name] }));

/** What `kit vendor sync` adds to package.json: the file: dependencies of the vendored packages that are needed but not declared as file: of the snapshot. */
export function missingDeclarations(rootPkg, graph) {
  const out = [];
  for (const n of graph.needed) {
    const d = declarations(rootPkg, n.name);
    if (!d.length || d.some((x) => normalSpec(x.spec) !== n.spec)) out.push({ ...n, declared: d.map((x) => x.spec).join(", ") || undefined });
  }
  return out;
}

/** Problems of the root package.json declarations and of the lockfile links, from the vendored graph on disk. Each reported once. */
export function graphProblems(root, cfgIn) {
  let cfg;
  try { cfg = cleanConfig(cfgIn); } catch (e) { return [{ file: "kit.canon.json", problem: e.message }]; }
  const g = vendorGraph(root, cfg);
  const problems = [...g.problems], P = (file, problem) => { if (!problems.some((x) => x.file === file && x.problem === problem)) problems.push({ file, problem }); };
  if (!g.packages.size || !existsSync(join(root, "package.json"))) return problems;
  const rootPkg = g.root;   // read once by vendorGraph; unreadable is already one of its problems
  if (!rootPkg) return problems;
  for (const m of missingDeclarations(rootPkg, g)) P("package.json", `${m.name} is needed by the vendored ${[...new Set(m.by)].join(", ")} but ${m.declared === undefined ? "not declared" : `declared as "${m.declared}"`}: declare "${m.name}": "${m.spec}" in dependencies (kit vendor sync adds it; npm would ask the public registry and npm ci fails with a 404)`);
  // the vendored packages the project installs: declared by the root as file: of the snapshot, or needed by one that is
  const installed = new Set(g.needed.map((n) => n.name));
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [name, spec] of Object.entries(rootPkg[kind] || {})) if (g.packages.has(name) && normalSpec(spec) === `file:${g.packages.get(name).dir}`) installed.add(name);
  const lp = join(root, "package-lock.json");
  if (!existsSync(lp)) return problems;
  const lr = readJson(lp);
  if (lr.error) { P("package-lock.json", lr.error); return problems; }
  const lock = lr.value;
  const entries = lock.packages || {};
  for (const name of [...installed].sort()) {
    const p = g.packages.get(name);
    const link = entries[`node_modules/${name}`];
    if (!link || !link.link || link.resolved !== p.dir) { P("package-lock.json", `${name} is not linked to ${p.dir} in the lockfile (run npm install --package-lock-only)`); continue; }
    const e = entries[p.dir];
    if (!e) { P("package-lock.json", `${p.dir} has no entry in the lockfile (run npm install --package-lock-only)`); continue; }
    if (e.version !== p.version) P("package-lock.json", `${p.dir}: version is "${p.version}" in package.json but ${e.version === undefined ? "missing" : `"${e.version}"`} in the lockfile (run npm install --package-lock-only)`);
    for (const kind of KINDS) {
      const want = p.pkg[kind] || {}, have = e[kind] || {};
      for (const k of new Set([...Object.keys(want), ...Object.keys(have)])) if (want[k] !== have[k]) P("package-lock.json", `${p.dir}: ${kind}.${k} is ${want[k] === undefined ? "not in package.json" : `"${want[k]}" in package.json`} but ${have[k] === undefined ? "missing" : `"${have[k]}"`} in the lockfile (run npm install --package-lock-only)`);
    }
  }
  return problems;
}
