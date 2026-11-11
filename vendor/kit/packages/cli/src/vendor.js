/**
 * The kit as a vendored snapshot: a repository that uses the kit keeps a copy of the parts it needs under
 * `vendor.path` (vendor/kit), written by `kit vendor sync` from one commit on the kit's main history, and a manifest
 * (`<path>.manifest.json`, schema vendor-manifest) with the commit and the sha256 of every file. No submodule, no
 * credentials: a fresh clone builds and tests with nothing but the repository itself.
 *
 *   kit.canon.json  "vendor": { "path": "vendor/kit", "include": ["packages", "templates", "LICENSE", "NOTICE"] }
 *
 *   kit vendor sync --source <local kit clone> --commit <sha>   write the snapshot and its manifest
 *   kit vendor check                                            every file matches the manifest (also in kit check canon)
 *
 * The snapshot is generated, never edited by hand: `kit vendor check` fails on a changed, missing or extra file. To
 * change the kit, change it in SaasReport/kit and sync again.
 */
import { graphProblems, vendorGraph, missingDeclarations, normalPath, cleanConfig } from "./vendor-graph.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CliError } from "./args.js";
import { manifestPath } from "./vendor-path.js";
import { gitEnv } from "./git.js";

export const KIT_REPOSITORY = "https://github.com/SaasReport/kit";
export const DEFAULT_INCLUDE = ["packages", "templates", "LICENSE", "NOTICE"];
const SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/vendor-manifest.schema.json";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const norm = (p) => p.split("\\").join("/");
export { manifestPath } from "./vendor-path.js";
const checked = (cfgIn) => { try { return cleanConfig(cfgIn); } catch (e) { throw new CliError(`kit vendor: ${e.message}`, 1); } };

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const selected = (path, include, exclude) => {
  const under = (p, prefix) => p === prefix || p.startsWith(`${prefix.replace(/\/$/, "")}/`);
  return include.some((i) => under(path, i)) && !exclude.some((e) => under(path, e));
};

/** Write the snapshot of `cfg.include` at `commit` from the kit clone `source` into root/cfg.path, and its manifest. */
export function syncVendor(root, cfgIn, { source, commit, fetch = true, hooks = {} }) {
  const cfg = checked(cfgIn);
  const include = cfg.include || DEFAULT_INCLUDE;
  const exclude = cfg.exclude || [];
  const git = (...a) => execFileSync("git", ["-C", source, ...a], { maxBuffer: 256 * 1024 * 1024, env: gitEnv() });
  const full = git("rev-parse", `${commit}^{commit}`).toString().trim();
  if (fetch) git("fetch", "-q", "origin", "main");
  try { git("merge-base", "--is-ancestor", full, "origin/main"); } catch { throw new Error(`${full} is not on the kit's main history (origin/main of ${source})`); }
  const date = new Date(git("show", "-s", "--format=%cI", full).toString().trim()).toISOString();
  const tree = git("ls-tree", "-r", full).toString().trim().split("\n").map((l) => {
    const [meta, path] = l.split("\t");
    const [mode, type] = meta.split(" ");
    return { mode, type, path };
  }).filter((e) => e.type === "blob" && selected(e.path, include, exclude));
  for (const i of include) if (!tree.some((e) => selected(e.path, [i], []))) throw new Error(`include "${i}" matches nothing at ${full.slice(0, 12)}`);
  // read everything first: nothing is written until the whole snapshot is known to resolve (a sync that will fail leaves no partial state)
  const blobs = tree.sort((a, b) => a.path.localeCompare(b.path)).map((e) => ({ ...e, buf: git("show", `${full}:${e.path}`) }));
  const packages = blobs.filter((e) => /^packages\/[^/]+\/package\.json$/.test(e.path)).map((e) => ({ dir: `${cfg.path}/${e.path.slice(0, -"/package.json".length)}`.replace(/\/+/g, "/"), pkg: JSON.parse(e.buf.toString("utf8")) }));
  const graph = vendorGraph(root, cfg, { packages });
  if (graph.problems.length) throw new CliError(`the snapshot at ${full.slice(0, 12)} does not resolve, nothing was written:\n${graph.problems.map((x) => `  - ${x.file}: ${x.problem}`).join("\n")}`);
  const pj = join(root, "package.json");
  let rootPkg = null, added = [];
  if (existsSync(pj)) {
    rootPkg = graph.root;   // parsed once by vendorGraph; unreadable JSON stopped the sync above
    const miss = missingDeclarations(rootPkg, graph);
    if (miss.length) {
      rootPkg.dependencies = { ...(rootPkg.dependencies || {}) };
      for (const m of miss) { rootPkg.dependencies[m.name] = m.spec; for (const k of ["devDependencies", "optionalDependencies"]) if (rootPkg[k]) delete rootPkg[k][m.name]; added.push(m.name); }
      rootPkg.dependencies = Object.fromEntries(Object.entries(rootPkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
    }
  }
  const out = join(root, cfg.path), mpath = join(root, manifestPath(cfg));
  const files = blobs.map((e) => ({ path: e.path, sha256: sha256(e.buf), bytes: e.buf.length, ...(e.mode === "100755" ? { executable: true } : {}) }));
  const manifest = {
    $schema: SCHEMA,
    path: cfg.path,
    source: { repository: cfg.repository || KIT_REPOSITORY, ref: "main", commit: full, commit_date: date },
    include,
    ...(exclude.length ? { exclude } : {}),
    generated_by: "kit vendor sync",
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const pkgText = added.length ? `${JSON.stringify(rootPkg, null, 2)}\n` : null;
  // The whole new state (snapshot, manifest, package.json) is built beside the old one; the old state is kept until the last swap
  // succeeds and is put back byte for byte when any step fails. `hooks.step(name)` lets a test fail at every step.
  const stage = `${out}.sync-new`, bak = `${out}.sync-old`;
  const suffix = ".sync-new", mbak = `${mpath}.sync-old`, pbak = `${pj}.sync-old`;
  const has = (f) => existsSync(f);
  const done = [];
  // The undo of a step is registered BEFORE the step runs, and it looks at the disk (what was there before, what moved): whichever
  // rename of a swap fails, the first or the second, the previous state comes back. `hooks.step(name)` fires before a step and
  // `hooks.step("<name>:old-moved")` between the two renames of a swap, so a test can fail anywhere.
  const step = (name, fn, undo) => { if (undo) done.push(undo); hooks.step?.(name); fn((sub) => hooks.step?.(`${name}:${sub}`)); };
  const hadOut = has(out), hadManifest = has(mpath);
  try {
    const leftovers = [bak, mpath + ".sync-old", pj + ".sync-old"].filter(has);
    if (leftovers.length) throw new Error(`a previous sync was interrupted and left its backup (${leftovers.join(", ")}): restore it or delete it, then run sync again`);
    rmSync(stage, { recursive: true, force: true });
    for (const f of [mpath + suffix, pj + suffix]) rmSync(f, { force: true });
    step("stage-snapshot", () => { for (const e of blobs) { const dest = join(stage, e.path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, e.buf); chmodSync(dest, e.mode === "100755" ? 0o755 : 0o644); } });
    step("stage-manifest", () => { mkdirSync(dirname(mpath), { recursive: true }); writeFileSync(mpath + suffix, manifestText); });
    if (pkgText !== null) step("stage-package", () => writeFileSync(pj + suffix, pkgText));
    step("swap-snapshot", (mid) => { if (hadOut) renameSync(out, bak); mid("old-moved"); mkdirSync(dirname(out), { recursive: true }); renameSync(stage, out); },
      () => { if (hadOut) { if (has(bak)) { rmSync(out, { recursive: true, force: true }); renameSync(bak, out); } } else rmSync(out, { recursive: true, force: true }); });
    step("swap-manifest", (mid) => { if (hadManifest) renameSync(mpath, mbak); mid("old-moved"); renameSync(mpath + suffix, mpath); },
      () => { if (hadManifest) { if (has(mbak)) { rmSync(mpath, { force: true }); renameSync(mbak, mpath); } } else rmSync(mpath, { force: true }); });
    if (pkgText !== null) step("swap-package", (mid) => { renameSync(pj, pbak); mid("old-moved"); renameSync(pj + suffix, pj); },
      () => { if (has(pbak)) { rmSync(pj, { force: true }); renameSync(pbak, pj); } });
    hooks.step?.("commit");
  } catch (e) {
    for (const undo of done.reverse()) { try { undo(); } catch { /* best effort: the backups stay beside the files */ } }
    for (const f of [stage, mpath + suffix, pj + suffix]) rmSync(f, { recursive: true, force: true });
    throw new CliError(`kit vendor sync failed at ${e.message ? e.message : e}; the previous snapshot, manifest and package.json are unchanged`, 1);
  }
  rmSync(bak, { recursive: true, force: true }); rmSync(mbak, { force: true }); rmSync(pbak, { force: true });
  return { commit: full, date, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), added };
}

/** Verify root/cfg.path against its manifest: { manifest, problems: [{ file, problem }] }. */
export function checkVendor(root, cfgIn) {
  const problems = [];
  const P = (file, problem) => problems.push({ file, problem });
  let cfg;
  try { cfg = cleanConfig(cfgIn); } catch (e) { P("kit.canon.json", e.message); return { manifest: null, problems }; }
  const mpath = manifestPath(cfg);
  if (!existsSync(join(root, mpath))) { P(mpath, `missing: run kit vendor sync --source <kit clone> --commit <sha>`); return { manifest: null, problems }; }
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, mpath), "utf8")); } catch (e) { P(mpath, `not JSON: ${e.message}`); return { manifest: null, problems }; }
  if (manifest.path !== cfg.path) P(mpath, `path ${manifest.path} differs from kit.canon.json vendor.path ${cfg.path}`);
  const include = cfg.include || DEFAULT_INCLUDE;
  if (JSON.stringify(manifest.include) !== JSON.stringify(include) || JSON.stringify(manifest.exclude || []) !== JSON.stringify(cfg.exclude || [])) {
    P(mpath, "include/exclude differ from kit.canon.json vendor (sync again)");
  }
  // the vendored package graph: every package another one needs is a file: dependency of the root and linked in the lockfile (one resolver, shared with sync)
  for (const x of graphProblems(root, cfg)) P(x.file, x.problem);
  const dir = join(root, cfg.path);
  if (existsSync(join(dir, ".git"))) P(cfg.path, "is a git checkout or submodule; the vendored kit is a plain snapshot (kit vendor sync)");
  const want = new Map((manifest.files || []).map((f) => [f.path, f]));
  const have = listFiles(dir).map((p) => norm(relative(dir, p))).filter((p) => p !== ".git" && !p.startsWith(".git/"));
  for (const p of have) if (!want.has(p)) P(`${cfg.path}/${p}`, "not in the manifest (added by hand?)");
  for (const [p, f] of want) {
    const full = join(dir, p);
    if (!existsSync(full)) { P(`${cfg.path}/${p}`, "missing"); continue; }
    const buf = readFileSync(full);
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) P(`${cfg.path}/${p}`, "differs from the manifest (edited by hand? change the kit and sync)");
  }
  return { manifest, problems };
}

/**
 * The vendored files that carry TRUST (the ledger and trust verifiers, the signature code, the owner-signed records) are compared with the upstream kit repository at the manifest's commit.
 * The manifest is agent-editable, so it is not trusted about WHERE or WHICH: the upstream repository and a minimum commit are PINNED outside it (pins = { repository, minCommit }, from
 * KIT_UPSTREAM_REPO and KIT_UPSTREAM_MIN_COMMIT, next to KIT_OWNER); the manifest's commit must descend from (or be) the minimum, so an old commit with weaker files is refused; and the upstream
 * tree at that commit is listed, so EVERY trust file it has must be in the manifest (a dropped file is not an unchecked file). Needs the network; an unreachable upstream FAILS.
 */
export const TRUST_FILES = /^packages\/(core\/(registry\/trust\/.*|registry\/projects\.json|src\/(ledger|trust|approvals|witness|verifier|verdict|scope|ed25519|canonical|sha256)\.js|schemas\/(approval-ledger|trust-record)\.schema\.json)|cli\/src\/(ledger-io|bundled|test-seam|concepts|content-state)\.js|cli\/src\/commands\/(ledger|persian|shariah|trust)\.js|cli\/src\/canon\/(persian|index)\.js)$/;
export async function upstreamProblems(root, cfg, fetchFn = globalThis.fetch, pins = {}) {
  const { manifest, problems } = checkVendor(root, cfg);
  if (!manifest) return problems;
  return compareUpstream(manifest, manifestPath(cfg), fetchFn, pins);
}
export async function compareUpstream(manifest, mpath, fetchFn = globalThis.fetch, pins = {}) {
  const repo = String(manifest.source?.repository || "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""), commit = manifest.source?.commit;
  if (!pins.repository || !/^[0-9a-f]{40}$/.test(pins.minCommit || "")) return [{ file: mpath, problem: "no pinned upstream: KIT_UPSTREAM_REPO and KIT_UPSTREAM_MIN_COMMIT (outside the manifest and the repository) must pin the kit repository and a minimum commit; the manifest cannot say where it comes from" }];
  if (repo.toLowerCase() !== pins.repository.toLowerCase()) return [{ file: mpath, problem: `the manifest's repository ${repo} is not the pinned upstream ${pins.repository}` }];
  if (!/^[0-9a-f]{40}$/.test(commit || "")) return [{ file: mpath, problem: "the manifest names no full commit: the upstream check cannot run" }];
  const out = [], get = async (url) => { try { return await fetchFn(url); } catch (e) { throw new Error(`upstream is unreachable (${e.message})`); } };
  try {
    if (commit !== pins.minCommit) {
      const c = await get(`https://api.github.com/repos/${repo}/compare/${pins.minCommit}...${commit}`);
      if (!c.ok) return [{ file: mpath, problem: `the commit cannot be compared with the pinned minimum (${c.status}): refused` }];
      if (!["ahead", "identical"].includes((await c.json()).status)) return [{ file: mpath, problem: `the manifest's commit ${commit.slice(0, 12)} does not descend from the pinned minimum ${pins.minCommit.slice(0, 12)}: an older or unrelated commit is refused` }];
    }
    // a commit "from" the pinned repository can still be a FORK's (GitHub serves any fork commit under the parent's name): the pinned branch must contain it
    const branch = pins.branch || "main";
    const b = await get(`https://api.github.com/repos/${repo}/compare/${commit}...${encodeURIComponent(branch)}`);
    if (!b.ok) return [{ file: mpath, problem: `the commit cannot be compared with the pinned branch ${branch} (${b.status}): refused` }];
    if (!["ahead", "identical"].includes((await b.json()).status)) return [{ file: mpath, problem: `the manifest's commit ${commit.slice(0, 12)} is not on the pinned branch ${branch} of ${repo} (a fork's or an unmerged commit): refused` }];
    const tr = await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`);
    if (!tr.ok) return [{ file: mpath, problem: `the upstream tree at ${commit.slice(0, 12)} cannot be listed (${tr.status}): refused` }];
    const tj = await tr.json();
    if (tj.truncated) return [{ file: mpath, problem: "the upstream tree is too large to list: refused (a check that cannot run is not a pass)" }];
    const inManifest = new Map((manifest.files || []).map((f) => [f.path, f]));
    for (const e of tj.tree || []) if (e.type === "blob" && TRUST_FILES.test(e.path) && !inManifest.has(e.path)) out.push({ file: e.path, problem: "is a trust file upstream but is not in the manifest: the same set of trust files is required" });
    for (const f of manifest.files || []) {
      if (!TRUST_FILES.test(f.path)) continue;
      const r = await get(`https://raw.githubusercontent.com/${repo}/${commit}/${f.path}`);
      if (!r.ok) { out.push({ file: f.path, problem: `not found upstream at ${repo}@${commit.slice(0, 12)} (${r.status})` }); continue; }
      const got = createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex");
      if (got !== f.sha256) out.push({ file: f.path, problem: `differs from ${repo}@${commit.slice(0, 12)}: the vendored trust file is not the upstream's` });
    }
  } catch (e) { return [{ file: mpath, problem: `${e.message}: refused` }]; }
  return out;
}
