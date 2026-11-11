/**
 * The lockfile check: `npm ci` (what CI runs) fails when package-lock.json does not satisfy package.json. The commonest
 * way is a new workspace package, or a changed dependency, without `npm install --package-lock-only`. This reads the two
 * files and says which package and dependency drifted, so the failure is found locally by `npm test`, not on the runners.
 *
 *   lockfileProblems(root, { vendor? }) → [{ file, problem }]   ([] when the lockfile satisfies the root and every workspace;
 *                                       with the `vendor` config of kit.canon.json, the vendored package graph is checked too)
 */
import { graphProblems, readJson } from "../vendor-graph.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEPS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Workspace directories of a package.json (`packages/*` style patterns; a literal directory is taken as is). */
function workspaceDirs(root, pkg) {
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const out = [];
  for (const pattern of ws) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      if (existsSync(join(root, base))) for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory() && existsSync(join(root, base, d.name, "package.json"))) out.push(`${base}/${d.name}`);
    } else if (existsSync(join(root, pattern, "package.json"))) out.push(pattern);
  }
  return out;
}

export function lockfileProblems(root, { vendor } = {}) {
  const problems = [], P = (file, problem) => problems.push({ file, problem });
  if (vendor) problems.push(...graphProblems(root, vendor));   // the vendored graph: one resolver, shared with kit vendor sync and kit check vendor
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "package-lock.json"))) return problems;
  const once = (file, problem) => { if (!problems.some((x) => x.file === file && x.problem === problem)) problems.push({ file, problem }); };
  const [rp, lp] = [readJson(join(root, "package.json")), readJson(join(root, "package-lock.json"))];
  if (rp.error) once("package.json", rp.error);
  if (lp.error) once("package-lock.json", lp.error);   // the vendored graph reports it too: one finding
  if (rp.error || lp.error) return problems;
  const pkg = rp.value, lock = lp.value;
  const fix = "run `npm install --package-lock-only` and commit package-lock.json (npm ci fails on this)";
  const entries = lock.packages || {};
  const compare = (dir, p) => {
    const e = entries[dir];
    if (!e) { P("package-lock.json", `${p.name || dir || "the root package"} (${dir || "."}) is not in the lockfile: ${fix}`); return; }
    for (const kind of DEPS) for (const [name, spec] of Object.entries(p[kind] || {})) {
      if ((e[kind] || {})[name] !== spec) P("package-lock.json", `${dir || "root"}: ${kind}.${name} is "${spec}" in package.json but ${(e[kind] || {})[name] === undefined ? "missing" : `"${e[kind][name]}"`} in the lockfile: ${fix}`);
    }
    for (const kind of DEPS) for (const name of Object.keys(e[kind] || {})) if ((p[kind] || {})[name] === undefined) P("package-lock.json", `${dir || "root"}: ${kind}.${name} is in the lockfile but no longer in package.json: ${fix}`);
  };
  compare("", pkg);
  for (const dir of workspaceDirs(root, pkg)) {
    const wr = readJson(join(root, dir, "package.json"));
    if (wr.error) { once(`${dir}/package.json`, wr.error); continue; }
    const wp = wr.value;
    compare(dir, wp);
    if (wp.name && !entries[`node_modules/${wp.name}`]) P("package-lock.json", `workspace ${wp.name} has no link entry node_modules/${wp.name}: ${fix}`);
  }
  return problems;
}
