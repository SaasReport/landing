/**
 * kit check findings (docs/CONSTITUTION.md §10, zero post-facto). The finding-class registry (@saasreport/core
 * registry/finding-classes.json, shipped with the kit like the project registry) lists every class of finding a review or
 * CI run has made; each class declares its rule as a contract (detect) that the engine (engine.js) runs at t=0 with canonical
 * parsers only. Every repository that runs the kit gets them.
 *
 *   1. Every class has a gate, and every gate a class: a class nothing enforces, or a gate with no class, fails.
 *   2. In the repository that owns the registry (the kit), every gate is proven on its cases: it reports at least one
 *      finding on every findings/<class>/must-fail/<case>/ and none on every must-pass case. A gate that lets its real
 *      case through fails.
 *   3. Every gate runs on the repository itself. A finding fails unless canon.allow.json names that one instance
 *      (category "finding:<class>", file, match, context, reason); an entry that matches nothing is stale and fails.
 *
 * The cases live in the kit (findings/<class>/) and are proven there; a site runs the gates on itself.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatProblems } from "@saasreport/core/schema";
import { walk } from "./files.js";
import { runDetectors } from "./engine.js";
import { CLI_BOOLEAN, parseArgs } from "../args.js";
import { bundled } from "../bundled.js";
import { deriveTable } from "../commands/derive-table.js";
import { gitEnv } from "../git.js";
import { repoSnapshotRoots } from "../vendor-path.js";

const P = (file, problem) => ({ file, problem });
const REGISTRY = "packages/core/registry/finding-classes.json";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, env: gitEnv() });
const NOT_A_REPO = /not a git repository/i;
// git ls-files -s -z: one NUL-terminated record per entry, the path never quoted (a path with other than ASCII is quoted
// without -z, and a quoted path matches nothing). A case's .git-index is the same form; anything else (the newline form
// read as one record) is an error, never a misread index.
const RECORD = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/;
const entries = (text, from) => {
  if (text && !text.endsWith("\0")) throw new Error(`${from} is not in git ls-files -s -z form: its records are not NUL-terminated`);
  return text.split("\0").slice(0, -1).map((l) => {
    const m = RECORD.exec(l);
    if (!m) throw new Error(`${from} has a record git ls-files -s -z does not write: ${JSON.stringify(l.slice(0, 120))}`);
    return { mode: m[1], path: m[2] };
  });
};

/** A repository path as git compares it: no leading ./, no trailing /, no surrounding quotes. */
const normalPath = (p) => String(p).trim().replace(/^(["'])(.*)\1$/, "$2").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
/** An agent worktree directory at any depth, in any case (a case-insensitive file system makes them one directory). */
const WORKTREES = /(^|\/)\.claude\/worktrees(\/|$)/i;

/** Where root stands in git: "top" (the top of a work tree), "inside" (a directory inside one), or "none". */
function gitPlace(root) {
  try { return statSync(git(root, ["rev-parse", "--show-toplevel"]).trim()).ino === statSync(root).ino ? "top" : "inside"; }
  catch (e) {
    if (e.code === "ENOENT") throw new Error("git is not installed: the stray-gitlink gate needs it");
    if (NOT_A_REPO.test(String(e.stderr))) return "none";
    throw new Error(`git cannot read ${root}: ${String(e.stderr || e.message).trim()}`);
  }
}

/** Whether git ignores path under root's own .gitignore, asked of git itself (in a scratch repository when root has none). */
function ignoredByGit(root, place, path) {
  let dir = root, scratch = null;
  if (place === "none" || existsSync(join(root, ".git-index"))) {
    scratch = mkdtempSync(join(tmpdir(), "kit-ignore-"));
    git(scratch, ["init", "-q"]);
    if (existsSync(join(root, ".gitignore"))) copyFileSync(join(root, ".gitignore"), join(scratch, ".gitignore"));
    dir = scratch;
  }
  try { git(dir, ["check-ignore", "-q", "--no-index", path]); return true; }
  catch (e) { if (e.status === 1) return false; throw new Error(`git check-ignore failed: ${String(e.stderr || e.message).trim()}`); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * The git view of root for the stray-gitlink contract: { index: [{ mode, path }], modules: [paths], ignored(path) }, read
 * with git itself: an index git cannot read is an error, never an empty index. A case directory (it holds a .git-index
 * fixture) is the real finding's index as it was; a directory inside a work tree reads that tree's index for its own paths.
 */
function gitViewOf(root) {
  const place = gitPlace(root);
  const fixture = existsSync(join(root, ".git-index"));
  let index;
  if (fixture && place !== "top") index = entries(readFileSync(join(root, ".git-index"), "utf8"), join(root, ".git-index"));
  else if (place === "none") index = [];   // no repository: nothing is committed, so no gitlink can be
  else {
    try { index = entries(git(root, ["ls-files", "-s", "-z"]), `git ls-files of ${root}`); }
    catch (e) { throw new Error(`git cannot read the index of ${root}: ${String(e.stderr || e.message).trim()}`); }
  }
  // .gitmodules as git parses it, and as committed: in a work tree the index's copy (:.gitmodules), which is what a checkout
  // reads; a fixture or a directory outside git reads the file. Each submodule is { path, url }: a path without a url fails
  // a checkout the same way ("No url found for submodule path").
  const modules = [];
  // in a work tree only the committed copy counts: an uncommitted .gitmodules on disk is not what CI checks out
  const tracked = place !== "none" && index.some((e) => e.path === ".gitmodules");
  const source = place === "none" || (fixture && place !== "top") ? (existsSync(join(root, ".gitmodules")) ? ["-f", join(root, ".gitmodules")] : null) : tracked ? ["--blob", ":.gitmodules"] : null;
  if (source) {
    let records = [];
    // --list --null: each record is key NL value NUL, as git writes it; the subsection (the submodule's name) may hold dots
    try { records = git(root, ["config", ...source, "--list", "--null"]).split("\0").filter(Boolean); }
    catch (e) { throw new Error(`.gitmodules cannot be read: ${String(e.stderr || e.message).trim()}`); }
    const byName = new Map();
    for (const rec of records) {
      const nl = rec.indexOf("\n");
      const key = nl < 0 ? rec : rec.slice(0, nl), value = nl < 0 ? "" : rec.slice(nl + 1);
      if (!key.startsWith("submodule.")) continue;
      const dot = key.lastIndexOf(".");
      const name = key.slice("submodule.".length, dot), field = key.slice(dot + 1);
      if (field !== "path" && field !== "url") continue;
      byName.set(name, { ...(byName.get(name) || {}), [field]: value });
    }
    for (const v of byName.values()) if (v.path) modules.push({ path: normalPath(v.path), url: v.url || null });
  }
  return { index, modules, ignored: (path) => ignoredByGit(root, place, path) };
}

/**
 * The command table of the kit CLI this repository runs: its own or the vendored one (table.js), read from the vendored
 * kit's own dispatchers when it is too old to ship a table (commands/derive-table.js), or the running CLI's when the kit is
 * installed as a package. null: a vendored kit whose CLI cannot be read.
 */
async function commandTableOf(root) {
  const snaps = repoSnapshotRoots(root).map((r) => r.snapshot);
  for (const f of ["packages/cli/src/commands/table.js", ...snaps.map((s) => `${s}/packages/cli/src/commands/table.js`)]) {
    if (existsSync(join(root, f))) return (await import(pathToFileURL(join(root, f)).href)).COMMAND_TABLE;
  }
  for (const base of ["packages/cli/src", ...snaps.map((s) => `${s}/packages/cli/src`)]) {
    if (!existsSync(join(root, base, "index.js"))) continue;
    return deriveTable((p) => (existsSync(join(root, base, p)) ? readFileSync(join(root, base, p), "utf8") : null));
  }
  if (snaps.some((s) => existsSync(join(root, s)))) return null;
  return (await import("../commands/table.js")).COMMAND_TABLE;
}

/** Whether a kit call or an npm run names something that exists: null, or { match, problem }. */
async function memberCheck(root, files, read) {
  const table = await commandTableOf(root);
  const entry = (n) => (table && Object.hasOwn(table, n) ? (Array.isArray(table[n]) ? { subs: table[n] } : table[n]) : null);
  return (set, rest, file) => {
    if (set === "kit-commands") {
      if (!table) return { match: "COMMAND_TABLE", problem: "the kit CLI this repository runs has no readable command table (re-vendor the kit)" };
      const [cmd, sub] = parseArgs(rest, { boolean: CLI_BOOLEAN })._.map(String);   // the CLI's own argument parser
      if (!cmd) return null;
      const e = entry(cmd);
      if (!e) return { match: `kit ${cmd}`, problem: `"kit ${cmd}" is not a command of this repository's kit` };
      if (sub && e.subs.length && !e.subs.includes(sub)) return { match: `kit ${cmd} ${sub}`, problem: `"kit ${cmd} ${sub}" is not a command of this repository's kit (${cmd}: ${[...new Set(e.subs)].join(", ")})` };
      return null;
    }
    if (set !== "package-scripts") throw new Error(`unknown membership dataset "${set}"`);
    const script = rest.find((w) => !w.startsWith("-"));
    const pkg = /(^|\/)package\.json$/.test(file) ? file : "package.json";
    if (!script) return null;
    if (!files.includes(pkg)) return { match: `npm run ${script}`, problem: `npm run ${script} runs against ${pkg}, which this repository does not have` };
    let scripts;
    try { scripts = JSON.parse(read(pkg)).scripts || {}; } catch (e) { return { match: pkg, problem: `${pkg} is not JSON (${e.message})` }; }
    return Object.hasOwn(scripts, script) ? null : { match: `npm run ${script}`, problem: `${pkg} has no script "${script}"` };
  };
}

/** The registry a gate runs from when none is given: the one this kit ships. */
const shipped = () => bundled().findingClasses.registry;

/** Run one class's contract over a tree (engine.js): [{ file, line, match, context, problem }]. `today` (YYYY-MM-DD) is the builtin a contract binds; when omitted it is the UTC date of `now` (the clock a test injects; the machine's clock by default). */
export async function runGate(id, root, files = walk(root), registry = shipped(), { today, now } = {}) {
  const cls = registry.classes.find((c) => c.id === id);
  if (!cls) throw new Error(`no finding class "${id}" in the registry`);
  const cache = new Map();
  const read = (f) => { if (!cache.has(f)) cache.set(f, readFileSync(join(root, f), "utf8")); return cache.get(f); };
  const kit = bundled();
  const ctx = {
    root, files, read, registry, today, now,
    validate: (value, schema) => kit.validator.validate(value, schema),
    git: (probes) => {
      const view = gitViewOf(root);
      const module = (path) => view.modules.find((m) => m.path === normalPath(path));
      return {
        gitlinks: view.index.filter((e) => e.mode === "160000").map((e) => ({ path: e.path, registered: Boolean(module(e.path)), has_url: Boolean(module(e.path)?.url) })),
        tracked_worktrees: view.index.filter((e) => WORKTREES.test(e.path)).map((e) => e.path),
        ignored: Object.fromEntries(probes.map((p) => [p, view.ignored(p)])),
      };
    },
    member: cls.detect.some((d) => d.member) ? await memberCheck(root, files, read) : null,
  };
  return runDetectors(cls, ctx);
}

/** The id git gives a file's bytes (git hash-object), computed here so the check needs no git and no network. */
const blobId = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

/**
 * A must-fail case is the real finding: its source.json (kit.finding-case.v1) accounts for every file in it, each either the
 * very blob it names (hashed here) or derived as it says.
 */
function caseProvenance(root, dir, kit) {
  const rel = (f) => `${dir.slice(root.length + 1)}/${f}`, out = [];
  if (!existsSync(join(dir, "source.json"))) return [P(rel("source.json"), "a must-fail case without its provenance: source.json (kit.finding-case.v1) names the repository, commit and finding, and the blob of every file, so the case is the real finding and not a sample")];
  let src;
  try { src = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")); } catch (e) { return [P(rel("source.json"), `not JSON: ${e.message}`)]; }
  const bad = formatProblems(kit.validator.validate(src, kit.byName("finding-case")));
  if (bad.length) return bad.map((m) => P(rel("source.json"), m));
  const listed = new Set(src.files.map((f) => f.path));
  for (const f of walk(dir).filter((x) => x !== "source.json")) if (!listed.has(f)) out.push(P(rel(f), "a file of the case that source.json does not account for: name its blob, or say how it was derived"));
  for (const f of src.files) {
    if (!existsSync(join(dir, f.path))) { out.push(P(rel(f.path), "named in source.json but missing")); continue; }
    if (f.blob && blobId(readFileSync(join(dir, f.path))) !== f.blob) out.push(P(rel(f.path), `is not blob ${f.blob} (${src.repo}@${src.commit}:${f.source}): a must-fail case is the real file, byte for byte`));
  }
  return out;
}

const caseDirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : []);

export async function checkFindings(root, canon, kit) {
  // the kit itself: its own registry (the file being changed) and its cases; any other repository: the registry its kit ships
  const own = existsSync(join(root, REGISTRY)) && existsSync(join(root, "findings"));
  const reg = { file: REGISTRY, own };
  const registry = own ? JSON.parse(readFileSync(join(root, REGISTRY), "utf8")) : kit.findingClasses.registry;
  const problems = formatProblems(kit.validator.validate(registry, kit.byName("finding-class"))).map((m) => P(reg.file, m));
  if (problems.length) return { ok: false, configured: true, checked: 0, summary: reg.file, problems };
  const ids = registry.classes.map((c) => c.id);

  // 2. the cases: proven where the registry lives
  if (reg.own) {
    for (const c of registry.classes) {
      const dir = join(root, c.cases);
      const fail = caseDirs(join(dir, "must-fail")), pass = caseDirs(join(dir, "must-pass"));
      if (!fail.length) problems.push(P(c.cases, `class "${c.id}" has no must-fail case: the real finding it was cut from goes in ${c.cases}/must-fail/`));
      if (!pass.length) problems.push(P(c.cases, `class "${c.id}" has no must-pass case`));
      for (const d of fail) problems.push(...caseProvenance(root, d, kit));
      for (const d of fail) {
        const found = await runGate(c.id, d, walk(d).filter((f) => f !== "source.json"), registry);
        let expect = [];
        try { expect = JSON.parse(readFileSync(join(d, "source.json"), "utf8")).expect || []; } catch (e) { if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; }   // a missing or broken source.json is reported by caseProvenance
        for (const x of expect) if (found.length && !found.some((f) => String(f.match).includes(x))) problems.push(P(d.slice(root.length + 1), `the ${c.id} gate refuses the case, but not for the finding it was cut from ("${x}"): it reported ${found.map((f) => f.match).join("; ").slice(0, 200)}`));
      }
      for (const d of fail) if (!(await runGate(c.id, d, walk(d).filter((f) => f !== "source.json"), registry)).length) problems.push(P(d.slice(root.length + 1), `the ${c.id} gate lets its must-fail case through`));
      for (const d of pass) for (const f of await runGate(c.id, d, walk(d), registry)) problems.push(P(`${d.slice(root.length + 1)}/${f.file}`, `the ${c.id} gate refuses its must-pass case: ${f.problem}`));
    }
  }

  // 3. the repository itself, with the reviewed allow-list
  const allowFile = canon.hardcoding?.allow || "canon.allow.json";
  const allow = existsSync(join(root, allowFile)) ? (JSON.parse(readFileSync(join(root, allowFile), "utf8")).entries || []).filter((e) => e.category.startsWith("finding:")) : [];
  const used = new Set();
  const files = walk(root).filter((f) => !f.startsWith("findings/"));
  for (const id of ids) {
    for (const f of await runGate(id, root, files, registry)) {
      // one entry, one instance: an entry already spent on an earlier instance does not cover the next one
      const i = allow.findIndex((e, j) => !used.has(j) && e.category === `finding:${id}` && e.file === f.file && e.match === f.match && (f.context || "").includes(e.context));
      if (i >= 0) { used.add(i); continue; }
      problems.push(P(f.line ? `${f.file}:${f.line}` : f.file, `${id}: ${f.problem} (${f.match})`));
    }
  }
  allow.forEach((e, i) => { if (!used.has(i)) problems.push(P(allowFile, `stale allow entry (${e.category}, ${e.file}, ${e.match}): it matches nothing; remove it`)); });
  return { ok: !problems.length, configured: true, checked: files.length, summary: `${ids.length} classes, ${files.length} files`, problems };
}
