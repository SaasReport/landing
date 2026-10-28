/**
 * kit check staleness (docs/FRESHNESS.md): nothing stale. (`kit check freshness` is the older canon check of generated artefacts and reads nothing outside the repository.) Every artefact names the head it derives from and its age, and every
 * boundary either re-derives from its source or refuses; this is the continuous verifier that proves it.
 *
 *   stalenessReport(root, { now, deps }) → kit.staleness-report.v1
 *
 * Six declared classes of finding (the sixth, scratch-aged, only in --local mode), each judged against one source of truth read at run time:
 *   branch-behind-main    a local branch or worktree that does not contain the remote main's LIVE head (git ls-remote, not a cached ref)
 *   vendor-behind-head    the vendored kit's commit is not the kit's main head (kit-head.json when published, else ls-remote)
 *   registry-fact-stale   a `verified` day in a JSON registry older than its declared max_age_days (or a verified day with no max age)
 *   toolchain-drift       node, npm or git differ from registry/toolchain.json
 *   deploy-behind-main    a Worker of release.json answers a commit on /api/build that is not at or after the last commit on main that touched a
 *                         deployable path (release.json `paths`, else the kit's deploy-shape list): a docs-only merge deploys nothing and is not drift
 *   scratch-aged          --local: an entry of the scratch directory older than the registry's scratch_max_age_days
 * A source that cannot be read is a finding (`unreadable`), never a pass. Every outside read goes through `deps`, so the suite runs
 * with no network: lsRemote(root, remote, branch), branches(root), contains(root, head, sha), kitHead(), versions(), fetch(url).
 */
import { PODCAST_BEHIND, podcastBehindSchedule } from "./podcast-staleness.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatProblems } from "@saasreport/core/schema";
import { CliError } from "./args.js";
import { gitEnv } from "./git.js";
import { loadCanon, bundled } from "./canon/index.js";
import { isSourceMode, kitLocation, manifestPath } from "./vendor-path.js";
import { sourceConfig, sourceState } from "./source-bootstrap.mjs";
import { KIT_REPOSITORY } from "./vendor.js";
import { loadRelease, releaseWorkers, databaseBindings } from "./release/config.js";
import { readServed } from "./release/run.js";
import { alertVariables } from "@saasreport/channels";

/** The alert routes a GitHub runner can reach (email needs the comms Worker's service binding): the one list of check.js's sender and of the workflows' generated env block. */
export const RUNNER_ROUTES = Object.freeze(["telegram", "bale", "webhook"]);
/** The secret names of RUNNER_ROUTES, from the channels' own registry: [{ name, route, optional }]. */
export const routeSecrets = () => RUNNER_ROUTES.flatMap((route) => { const v = alertVariables(route, {}); return [...v.secrets.map((name) => ({ name, route, optional: false })), ...v.optional.map((name) => ({ name, route, optional: true }))]; });

export const CLASSES = ["branch-behind-main", "vendor-behind-head", "registry-fact-stale", "toolchain-drift", "deploy-behind-main", PODCAST_BEHIND, "scratch-aged"];
const SHA = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, env: gitEnv() });
const msg = (e) => String(e.stderr || e.message || e).trim().split("\n")[0];

/** The outside reads, as git and the machine do them; a test replaces any of them. */
export function defaultDeps() {
  return {
    /** The live sha of refs/heads/<branch> at <remote> (a name or a URL), asked of the remote itself. */
    lsRemote: (root, remote, branch) => {
      const out = git(root, ["ls-remote", remote, `refs/heads/${branch}`]).trim();
      const sha = out.split(/\s+/)[0];
      if (!SHA.test(sha || "")) throw new Error(`${remote} has no refs/heads/${branch}`);
      return sha;
    },
    /** Every local branch and detached worktree: [{ name, sha, path? }]. */
    branches: (root) => {
      const out = [];
      const paths = new Map();
      let cur = null;
      for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
        else if (line.startsWith("branch refs/heads/") && cur) paths.set(line.slice(18), cur.path);
        else if (line === "detached" && cur) out.push({ name: `(detached) ${cur.path}`, sha: cur.sha, path: cur.path });
        else if (line.startsWith("HEAD ") && cur) cur.sha = line.slice(5);
      }
      for (const l of git(root, ["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads"]).split("\n").filter(Boolean)) {
        const [name, sha] = l.split("\t");
        out.push({ name, sha, ...(paths.has(name) ? { path: paths.get(name) } : {}) });
      }
      return out.filter((b) => SHA.test(b.sha || ""));
    },
    /** Whether sha descends from (or is) head. An unknown head object means the branch cannot contain it. */
    contains: (root, head, sha) => {
      try { git(root, ["merge-base", "--is-ancestor", head, sha]); return true; } catch (e) { if (e.status === 1 || e.status === 128) return false; throw e; }
    },
    /** The last commit reachable from head that touched any of paths (null when none did). */
    lastTouching: (root, head, paths) => git(root, ["log", "-1", "--format=%H", head, "--", ...paths]).trim() || null,
    /** A worktree's own HEAD: { sha, branch } (branch null when detached). */
    worktreeState: (dir) => {
      const sha = git(dir, ["rev-parse", "HEAD"]).trim();
      let branch = null;
      try { branch = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || null; } catch (e) { if (e.status !== 1) throw e; /* exit 1 is git's answer for a detached HEAD: no branch */ }
      return { sha, branch };
    },
    /** Every worktree path of every git repository directly under root (a checkout or a linked worktree). */
    discover: (root) => {
      const out = new Set();
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || !existsSync(join(root, e.name, ".git"))) continue;
        for (const line of git(join(root, e.name), ["worktree", "list", "--porcelain"]).split("\n")) if (line.startsWith("worktree ")) out.add(line.slice(9));
      }
      return [...out];
    },
    /**
     * The top-level entries of dir, each with the NEWEST modification time anywhere inside it (a bounded walk that skips .git and node_modules):
     * [{ name, newestMs, truncated }]. truncated: the bound was hit, so newestMs is only a lower bound and the age cannot be judged.
     */
    scratchTree: (dir, { max_entries: maxEntries, max_depth: maxDepth }) => readdirSync(dir).map((name) => {
      let newest = statSync(join(dir, name)).mtimeMs, seen = 0, truncated = false;
      const walk = (p, depth) => {
        let st; try { st = statSync(p); } catch (e) { void e; return; /* an entry that vanished mid-walk has no mtime to count */ }
        newest = Math.max(newest, st.mtimeMs);
        if (!st.isDirectory() || depth >= maxDepth) { truncated = truncated || (st.isDirectory() && depth >= maxDepth); return; }
        for (const child of readdirSync(p)) {
          if (child === ".git" || child === "node_modules") continue;
          if (++seen > maxEntries) { truncated = true; return; }
          walk(join(p, child), depth + 1);
          if (truncated) return;
        }
      };
      walk(join(dir, name), 0);
      return { name, newestMs: newest, truncated };
    }),
    /** Where this runs, by the markers toolchain.json `host` names: "ci" (a GitHub runner), "codespace", else "machine" (a laptop or a bare host). */
    where: (host, env = process.env) => (env[host.ci_env] === "true" ? "ci" : env[host.codespace_env] === "true" ? "codespace" : "machine"),
    /** The kit's main head: { sha, recent? } from the published kit-head object when the registry names one, else ls-remote of the kit repository. */
    kitHead: async ({ root, registryDir, fileName, fetch }) => {
      const f = join(registryDir, fileName);
      if (existsSync(f)) {
        const reg = JSON.parse(readFileSync(f, "utf8"));
        if (typeof reg.url === "string") {
          const r = await fetch(reg.url);
          if (!r.ok) throw new Error(`${reg.url} answered ${r.status}`);
          const j = await r.json();
          if (!SHA.test(j.sha || "")) throw new Error(`${reg.url} carries no sha`);
          return { sha: j.sha, recent: Array.isArray(j.recent) ? j.recent.map((x) => x.sha) : undefined };
        }
      }
      const out = git(root, ["ls-remote", KIT_REPOSITORY, "refs/heads/main"]).trim().split(/\s+/)[0];
      if (!SHA.test(out || "")) throw new Error(`${KIT_REPOSITORY} has no refs/heads/main`);
      return { sha: out };
    },
    /** The versions the machine runs: { node, npm, git, docker } as x.y.z strings (a tool that cannot run is absent). */
    versions: () => {
      const num = (s) => (s || "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      const absent = (e) => { void e; return null; /* a tool that cannot run is absent; the report records it as an unreadable toolchain-drift finding */ };
      let npm = null, gitV = null;
      try { npm = num(execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch (e) { npm = absent(e); }
      try { gitV = num(execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() })); } catch (e) { gitV = absent(e); }
      let docker = null;
      try { docker = num(execFileSync("docker", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch (e) { docker = absent(e); }
      return { node: num(process.version), npm, git: gitV, docker };
    },
    fetch: (url, init) => globalThis.fetch(url, { signal: AbortSignal.timeout(15000), ...init }),
  };
}

const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const validDay = (d) => DAY.test(d) && !Number.isNaN(dayMs(d)) && new Date(dayMs(d)).toISOString().slice(0, 10) === d;
const short = (s) => String(s).slice(0, 12);

function readRegistry(kit, file, schema) {
  const doc = JSON.parse(readFileSync(join(kit.registryDir, file), "utf8"));
  const problems = formatProblems(kit.validator.validate(doc, kit.byName(schema)));
  if (problems.length) throw new CliError(`${file} does not satisfy kit.${schema}.v1: ${problems.slice(0, 4).join("; ")}`, 1);
  return doc;
}

/** Every JSON file under dir (not into node_modules or .git), repository-relative POSIX paths. */
function jsonFiles(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The deployable paths DERIVED from the release Workers: each wrangler config's directory, its entry file's directory (or the file itself at the root), its built-assets directory, each D1 migrations directory, and the always-deployable files. The release's declared `paths` (what the build reads) are added to this set by the caller; neither replaces the other. */
export function deployablePaths(workers, always) {
  const out = new Set(always);
  const dir = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? null : p.slice(0, i); };
  for (const w of workers) {
    for (const f of [w.wrangler, w.entryFile].filter(Boolean)) out.add(dir(f) ?? f);
    if (w.assetsDir) out.add(w.assetsDir);   // the built assets a Worker serves ([assets] directory, [site] bucket)
  }
  for (const list of databaseBindings(workers).values()) for (const b of list) if (b.migrationsDir) out.add(b.migrationsDir);
  return [...out];
}

/** Every object under value with a verification day (a property named in staleness.json verification_days, holding a date): [{ pointer, key, verified, max_age_days? }]. */
function dated(value, names, pointer = "") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...dated(v, names, `${pointer}/${i}`)));
  else if (value && typeof value === "object") {
    // every string under a verification-day name is a claim and is validated (Codex on #148): a prefilter on the date shape let "unknown" or "2026/10/01" pass as fresh
    for (const key of names) if (typeof value[key] === "string") out.push({ pointer: `${pointer}/${key}`, verified: value[key], max_age_days: value.max_age_days });
    for (const [k, v] of Object.entries(value)) out.push(...dated(v, names, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return out;
}

/**
 * The report for the repository at root. `now` is the clock (a Date); `deps` replaces any outside read (see defaultDeps).
 * Never throws for a stale or unreadable source: those are findings. Throws CliError only for a broken kit registry.
 */
export async function stalenessReport(root, { now = new Date(), deps = {}, kit = bundled() } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const reg = readRegistry(kit, "staleness.json", "staleness-registry");
  const pin = readRegistry(kit, "toolchain.json", "toolchain");
  const findings = [], notApplicable = [];
  const add = (f) => findings.push(f);
  const na = (cls, reason) => notApplicable.push({ class: cls, reason });
  const today = now.toISOString().slice(0, 10);

  // the head every other class is judged against, read once, from the remote itself
  const isRepo = existsSync(join(root, ".git"));
  let mainHead = null, headError = null;
  if (isRepo) { try { mainHead = await d.lsRemote(root, reg.remote, reg.main_branch); } catch (e) { headError = msg(e); } }
  let localHead = null;
  if (isRepo) { try { localHead = git(root, ["rev-parse", "HEAD"]).trim(); } catch { localHead = null; /* an empty repository has no HEAD yet; derived_from.local_head is then null by contract */ } }
  if (!SHA.test(localHead || "")) localHead = null;

  // 1. branch-behind-main
  if (!isRepo) na("branch-behind-main", "not a git work tree");
  else if (!mainHead) add({ class: "branch-behind-main", subject: `${reg.remote}/${reg.main_branch}`, observed: null, expected: null, unreadable: true, problem: `the live head of ${reg.remote}/${reg.main_branch} cannot be read (${headError}): staleness cannot be shown, so it is not a pass` });
  else {
    for (const b of await d.branches(root)) {
      if (await d.contains(root, mainHead, b.sha)) continue;
      add({ class: "branch-behind-main", subject: b.path ? `${b.name} (${b.path})` : b.name, observed: b.sha, expected: mainHead, problem: `${b.name} at ${short(b.sha)} does not contain ${reg.remote}/${reg.main_branch} at ${short(mainHead)}: merge or rebase it onto main before more work, or finish and delete it` });
    }
  }

  // 2. vendor-behind-head
  const { canon } = loadCanon(root, kit);
  if (!canon?.vendor) na("vendor-behind-head", "kit.canon.json declares no vendored kit");
  else if (isSourceMode(canon.vendor)) {
    // source mode (the kit at t=0): the checkout at vendor.path is the kit at its head or the gate refused it; here it is read again against the head
    const loc = kitLocation(canon.vendor);
    let state = null;
    try { state = sourceState(root, sourceConfig(canon)); } catch (e) { add({ class: "vendor-behind-head", subject: loc.path, observed: null, expected: null, unreadable: true, problem: `the kit at ${loc.path} cannot be read (${msg(e)}): nothing proves the kit in use is its head` }); }
    if (state) {
      try {
        const head = await d.kitHead({ root, registryDir: kit.registryDir, fileName: reg.kit_head_file, fetch: d.fetch });
        if (state.sha !== head.sha) add({ class: "vendor-behind-head", subject: loc.path, observed: state.sha, expected: head.sha, problem: `the kit's checkout is at ${short(state.sha)} and the kit's main head is ${short(head.sha)}: the next use refuses it (t=0) and moves it to the head` });
      } catch (e) { add({ class: "vendor-behind-head", subject: loc.path, observed: state.sha, expected: null, unreadable: true, problem: `the kit's main head cannot be read (${msg(e)}): nothing proves the kit in use is its head` }); }
    }
  } else {
    const mf = manifestPath(canon.vendor);
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(join(root, mf), "utf8")); } catch (e) { add({ class: "vendor-behind-head", subject: mf, observed: null, expected: null, unreadable: true, problem: `the vendored kit's manifest cannot be read (${msg(e)}): the commit it derives from is unknown` }); }
    if (manifest) {
      const commit = manifest.source?.commit, date = manifest.source?.commit_date;
      const age = date && !Number.isNaN(Date.parse(date)) ? Math.max(0, Math.floor((now - Date.parse(date)) / DAY_MS)) : undefined;
      try {
        const head = await d.kitHead({ root, registryDir: kit.registryDir, fileName: reg.kit_head_file, fetch: d.fetch });
        if (commit !== head.sha) {
          const at = head.recent ? head.recent.indexOf(commit) : -1;
          const lag = at >= 0 ? `${at} commits behind` : head.recent ? `more than ${head.recent.length} commits behind` : "behind";
          add({ class: "vendor-behind-head", subject: mf, observed: commit ?? null, expected: head.sha, ...(age !== undefined ? { age_days: age } : {}), problem: `the vendored kit is at ${short(commit)}, ${lag} the kit's main head ${short(head.sha)}: run kit vendor sync to the head` });
        }
      } catch (e) { add({ class: "vendor-behind-head", subject: mf, observed: commit ?? null, expected: null, unreadable: true, problem: `the kit's main head cannot be read (${msg(e)}): freshness of the vendored kit cannot be shown, so it is not a pass` }); }
    }
  }

  // 3. registry-fact-stale
  const files = reg.registry_dirs.flatMap((dir) => jsonFiles(root, dir));
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; /* not a registry: a JSON file that does not parse carries no dated fact, and the schemas check validates it */ }
    const facts = dated(doc, reg.verification_days);
    for (const fact of facts) {
      const max = fact.max_age_days ?? doc.max_age_days;
      const subject = `${f}#${fact.pointer || "/"}`;
      if (!validDay(fact.verified)) { add({ class: "registry-fact-stale", subject, observed: fact.verified, expected: "YYYY-MM-DD", problem: `${subject} has a verified day that is not a valid date: ${fact.verified}` }); continue; }
      if (!Number.isInteger(max) || max < 1) { add({ class: "registry-fact-stale", subject, observed: fact.verified, expected: null, problem: `${subject} was verified ${fact.verified} but no max_age_days is declared (on the fact or at the top of ${f}): a fact with no declared age can never be stale, so it is refused` }); continue; }
      const age = Math.floor((dayMs(today) - dayMs(fact.verified)) / DAY_MS);
      if (age < 0) add({ class: "registry-fact-stale", subject, observed: fact.verified, expected: today, age_days: 0, problem: `${subject} is verified on ${fact.verified}, a day after today (${today}): a fact is never verified in the future` });
      else if (age > max) add({ class: "registry-fact-stale", subject, observed: fact.verified, expected: max, age_days: age, problem: `${subject} was verified ${age} days ago (${fact.verified}); its declared maximum is ${max}: read it from its source again and update verified` });
    }
  }

  // 4. toolchain-drift: exact pins (registry/toolchain.json), each judged only where it is required (a runner has no codespace's docker)
  const have = await d.versions(), where = await d.where(pin.host);
  for (const [tool, want] of Object.entries(pin.tools)) {
    if (!want.required_on.includes(where)) continue;
    const v = have[tool];
    if (!v) add({ class: "toolchain-drift", subject: tool, observed: null, expected: want.exact, unreadable: true, problem: `${tool} cannot be run on this ${where}, so its version cannot be shown against the pin in registry/toolchain.json` });
    else if (v !== want.exact) add({ class: "toolchain-drift", subject: tool, observed: v, expected: want.exact, problem: `${tool} ${v} is not the pinned ${want.exact} (registry/toolchain.json, required on ${where}): install the pinned version` });
  }

  // 5. deploy-behind-main: the Workers, their wrangler facts, their build endpoints and the served-commit traversal (behind entries included) are release/'s own
  // (loadRelease, releaseWorkers, readServed): one reader, never a parallel one here
  const rf = join(root, reg.release_file);
  if (!existsSync(rf)) na("deploy-behind-main", `no ${reg.release_file}: nothing is deployed from this repository`);
  else {
    const loaded = loadRelease(root, kit, reg.release_file);
    let workers = null, release = loaded.doc;
    if (!release) add({ class: "deploy-behind-main", subject: reg.release_file, observed: null, expected: null, unreadable: true, problem: `${reg.release_file} cannot be read (${loaded.problems.slice(0, 3).map((x) => x.problem).join("; ")}): what is deployed cannot be shown` });
    else { try { workers = releaseWorkers(root, release); } catch (e) { add({ class: "deploy-behind-main", subject: reg.release_file, observed: null, expected: null, unreadable: true, problem: `the Workers of ${reg.release_file} cannot be resolved (${msg(e)}): what is deployed cannot be shown` }); } }
    if (workers) {
      if (!mainHead) add({ class: "deploy-behind-main", subject: reg.release_file, observed: null, expected: null, unreadable: true, problem: `main's live head cannot be read (${headError}): the deployed commit cannot be judged` });
      else {
        // the rule: a Worker is current when its commit is main's head, or is at or after the last commit on main that touched a deployable path. The set is the
        // UNION of the declared and the derived: release.json `paths` (what the build reads, which no config states; required by the schema) plus what the declared
        // configs state (each wrangler config's directory, each entry file's directory, each built-assets directory, each migrations directory) plus the
        // always-deployable files of staleness.json; a docs-only merge touches none, so it cannot make a Worker stale
        const paths = [...new Set([...release.paths, ...deployablePaths(workers, reg.deploy_paths_always)])];
        let base = null, baseError = null;
        try { base = await d.lastTouching(root, mainHead, paths); } catch (e) { baseError = msg(e); }
        const { served, unreadable } = await readServed(release, workers, d.fetch);
        for (const u of unreadable) {
          const name = u.split(":")[0];
          add({ class: "deploy-behind-main", subject: name, observed: null, expected: mainHead, unreadable: true, problem: `${u}: what is live cannot be shown, so it is not a pass` });
        }
        for (const [name, commit] of Object.entries(served)) {
          if (commit === null) { add({ class: "deploy-behind-main", subject: name, observed: null, expected: base ?? mainHead, problem: `${name} serves a version with no commit (deployed from a shell): release it from main` }); continue; }
          if (commit === mainHead) continue;
          if (baseError) { add({ class: "deploy-behind-main", subject: name, observed: commit, expected: mainHead, unreadable: true, problem: `the last deployable commit on main cannot be found (${baseError}): ${name} serving ${short(commit)} cannot be judged` }); continue; }
          if (base && await d.contains(root, base, commit)) continue;
          add({ class: "deploy-behind-main", subject: name, observed: commit, expected: base ?? mainHead, problem: `${name} serves ${short(commit)}, which is before ${base ? `the last commit on main that touched a deployable path (${short(base)})` : `main's head ${short(mainHead)}`}: the deployed Worker is behind main` });
        }
      }
    }
  }

  // 6. podcast-behind-schedule: the newest item of every live feed against the series cadence plus grace (podcast-staleness.js owns the rule)
  const podcast = await podcastBehindSchedule(root, { now, deps: d });
  if (!podcast.checked) na(PODCAST_BEHIND, podcast.reason);
  else for (const f of podcast.findings) add(f);

  na("scratch-aged", "judged only by --local, on the machine whose scratch directory it is");
  const report = {
    schema: "kit.staleness-report.v1",
    mode: "repo",
    ok: findings.length === 0,
    generated_at: now.toISOString(),
    derived_from: { main_head: mainHead, local_head: localHead },
    checked: CLASSES.filter((c) => !notApplicable.some((n) => n.class === c)),
    not_applicable: notApplicable,
    findings,
  };
  return finish(kit, report);
}

const finish = (kit, report) => {
  const bad = formatProblems(kit.validator.validate(report, kit.byName("staleness-report")));
  if (bad.length) throw new CliError(`kit check staleness built a report that is not kit.staleness-report.v1 (a bug): ${bad.slice(0, 3).join("; ")}`, 1);
  return report;
};

/**
 * --local: the machine's own staleness, where worktrees live (docs/FRESHNESS.md). Every worktree in the worktree registry (kit.worktrees.v1,
 * scratch/worktrees.json) must exist, be on its registered branch and contain its repository's live main head; every worktree of a git repository
 * directly under the registry's root must be registered (an unregistered worktree has no owner); every entry of the scratch directory (its newest file) is younger
 * than the registry's scratch_max_age_days by its NEWEST file (a bounded walk; the directory is KIT_SCRATCH or the registry's `scratch`, never the working directory). `registryFile` is relative to cwd unless absolute.
 */
export async function stalenessLocal(cwd, { registryFile, env = {}, now = new Date(), deps = {}, kit = bundled() } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const reg = readRegistry(kit, "staleness.json", "staleness-registry");
  const scratchEnv = env[reg.local.scratch_env] || null;   // the machine declares where its scratch lives; the working directory says nothing about it
  const file = resolve(cwd, registryFile || (scratchEnv ? join(scratchEnv, "worktrees.json") : reg.local.worktree_registry));
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new CliError(`kit check staleness --local: the worktree registry ${file} cannot be read (${msg(e)}): without it no worktree has an owner`, 1); }
  const bad = formatProblems(kit.validator.validate(doc, kit.byName("worktrees")));
  if (bad.length) throw new CliError(`${file} does not satisfy kit.worktrees.v1: ${bad.slice(0, 4).join("; ")}`, 1);
  const findings = [], heads = {};
  const add = (f) => findings.push({ class: "branch-behind-main", ...f });
  const headOf = async (entry) => {
    if (!(entry.repo in heads)) { try { heads[entry.repo] = await d.lsRemote(entry.path, reg.remote, reg.main_branch); } catch (e) { heads[entry.repo] = { error: msg(e) }; } }
    return heads[entry.repo];
  };
  for (const w of doc.worktrees) {
    const subject = `${w.repo}:${w.branch} (${w.path})`;
    if (!existsSync(w.path)) { add({ subject, observed: null, expected: null, problem: `the registered worktree directory is gone (owner ${w.owner}): remove its entry from the registry, or recreate it` }); continue; }
    const head = await headOf(w);
    if (typeof head !== "string") { add({ subject, observed: null, expected: null, unreadable: true, problem: `the live head of ${w.repo} ${reg.remote}/${reg.main_branch} cannot be read (${head.error}): freshness of ${w.path} cannot be shown` }); continue; }
    const st = await d.worktreeState(w.path);
    if (st.branch !== w.branch) { add({ subject, observed: st.branch, expected: w.branch, problem: `${w.path} is on ${st.branch ?? "a detached HEAD"}, the registry says ${w.branch} (owner ${w.owner}): re-register it or switch back` }); continue; }
    if (!(await d.contains(w.path, head, st.sha))) add({ subject, observed: st.sha, expected: head, problem: `${w.branch} at ${short(st.sha)} does not contain ${w.repo} main at ${short(head)} (owner ${w.owner}, last synced to ${short(w.last_sync)}): merge or rebase it onto main before more work, or finish and delete it` });
  }
  const known = new Set(doc.worktrees.map((w) => resolve(w.path)));
  for (const path of await d.discover(doc.root)) if (!known.has(resolve(path))) add({ subject: path, observed: null, expected: null, problem: `${path} is a worktree under ${doc.root} that is not in the worktree registry: it has no owner and no last-sync sha; register it or remove it` });
  const scratch = scratchEnv || doc.scratch || null;
  const checked = ["branch-behind-main"], na = [];
  if (!scratch) na.push({ class: "scratch-aged", reason: `no scratch directory is declared (${reg.local.scratch_env}, or \`scratch\` in the worktree registry)` });
  else {
    checked.push("scratch-aged");
    if (!existsSync(scratch)) findings.push({ class: "scratch-aged", subject: scratch, observed: null, expected: null, unreadable: true, problem: `the declared scratch directory ${scratch} does not exist: its age cannot be shown` });
    else {
      for (const e of await d.scratchTree(scratch, reg.local.scratch_walk)) {
        const path = join(scratch, e.name);
        if (path === file) continue;
        if (e.truncated) { findings.push({ class: "scratch-aged", subject: path, observed: null, expected: null, unreadable: true, problem: `${path} is larger than the bounded walk (${reg.local.scratch_walk.max_entries} entries, ${reg.local.scratch_walk.max_depth} levels): its newest file cannot be found, so its age cannot be shown` }); continue; }
        const age = Math.floor((now.getTime() - e.newestMs) / DAY_MS);
        if (age > reg.local.scratch_max_age_days) findings.push({ class: "scratch-aged", subject: path, observed: age, expected: reg.local.scratch_max_age_days, age_days: age, problem: `nothing in ${path} was modified for ${age} days (its newest file); scratch older than ${reg.local.scratch_max_age_days} days (registry/staleness.json local.scratch_max_age_days) is removed or promoted out of scratch` });
      }
    }
  }
  na.push(...["vendor-behind-head", "registry-fact-stale", "toolchain-drift", "deploy-behind-main"].map((c) => ({ class: c, reason: "judged by the repository run of kit check staleness, not --local" })));
  return finish(kit, {
    schema: "kit.staleness-report.v1", mode: "local", ok: findings.length === 0, generated_at: now.toISOString(),
    derived_from: { main_head: null, local_head: null, heads: Object.fromEntries(Object.entries(heads).filter(([, v]) => typeof v === "string")) },
    checked, not_applicable: na, findings,
  });
}

/** A saved report, validated: what --report alerts from, so an alert never rests on a second read of the world. */
export function loadReport(file, kit = bundled()) {
  let r;
  try { r = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new CliError(`kit check staleness --report: ${file} cannot be read (${msg(e)})`, 1); }
  const bad = formatProblems(kit.validator.validate(r, kit.byName("staleness-report")));
  if (bad.length) throw new CliError(`${file} is not kit.staleness-report.v1: ${bad.slice(0, 3).join("; ")}`, 1);
  return r;
}

/** The alert for a verifier that could not produce or read its report: a crash is never silent (the same route as a finding). */
export function crashAlert(error, { repo = "this repository", day }) {
  return { subject: `${repo}: the staleness verifier crashed`, lines: [String(error?.message || error).slice(0, 500), "No report could be read, so nothing is shown fresh: treat every boundary as unverified until it runs again."], reference: `${day}:crashed`, idempotencyKey: `staleness-crash:${repo}:${day}` };
}

/** The alert a report becomes (for sendAlert): the same text on every route. */
export function stalenessAlert(report, { repo = "this repository" } = {}) {
  const day = report.generated_at.slice(0, 10);
  return {
    subject: `${repo}: ${report.findings.length} staleness finding${report.findings.length === 1 ? "" : "s"}`,
    lines: report.findings.slice(0, 20).map((f) => `${f.class}: ${f.problem}`).concat(report.findings.length > 20 ? [`... and ${report.findings.length - 20} more (the uploaded report lists all)`] : []),
    reference: `${day}:${report.derived_from.main_head ?? "unreadable"}`,
    idempotencyKey: `staleness:${repo}:${day}`,
  };
}
