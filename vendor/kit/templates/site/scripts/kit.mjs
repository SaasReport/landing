#!/usr/bin/env node
// The kit at t=0 (docs/FRESHNESS.md in SaasReport/kit). Written into a site by `kit source init` from the kit's
// templates/site/scripts/kit.mjs and held to it byte for byte by `kit check canon` (vendor, source mode): never edit by hand.
//
// This repository stores no copy of the kit. Before any use, the kit is brought to kit.canon.json vendor.path (default .kit, ignored
// by git) at its published head (kit.kit-head.v1, the object the kit's own CI writes on every push to main): with vendor.transport
// "archive" (the default) the published archive of that head is fetched over https with no credential and verified by sha256 against
// the head object; with "git" a checkout of the kit repository is fetched to origin/main and verified against the same object. Any
// mismatch, a local edit, an unreachable head: REFUSED. Then the kit's own dependencies are installed from the kit's own lockfile and
// linked into node_modules (@saasreport/*, .bin/kit), and the kit command given runs from it. Nothing is cached across a refusal.
//
//   node scripts/kit.mjs                     ensure (fetch, verify, install, link), print the record (kit.kit-source.v1)
//   node scripts/kit.mjs <kit command...>    ensure, then run the kit CLI with these arguments
//   node scripts/kit.mjs --verify-only       verify what is there (no fetch, no install): what kit check canon does
//
// Zero dependencies and nothing read from the environment but PATH: it runs before anything is installed, and it is the same code the
// kit imports for `kit source` and the canon check (one implementation, two entry points).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "kit.kit-source.v1";
export const DEFAULT_PATH = ".kit";
export const DEFAULT_REPOSITORY = "https://github.com/SaasReport/kit";
// where the kit's CI publishes its head (kit.kit-head.v1): one source, packages/core/registry/kit-head.json; a kit test holds this constant to it,
// because the archive transport reads the head before any kit file exists
export const DEFAULT_HEAD_URL = "https://kit-head.invalid/kit-main.json";
// "archive": the published archive of the head, fetched over https with no credential and verified by sha256 against the head object (the default:
// a site's CI holds no key). "git": a checkout of the kit repository, for a machine that can read it.
export const TRANSPORTS = ["archive", "git"];
export const RECORD = "node_modules/.kit-source-record.json";   // inside the checkout's node_modules: ignored by the kit, so the checkout stays clean
const LOCK_MARK = "node_modules/.kit-source-lockfile.sha256";
// archive transport: which published archive is unpacked here, and the sha256 of every unpacked file (a local edit is refused like a dirty checkout).
// At the root of vendor.path, not under node_modules: npm ci removes node_modules before installing (Codex on #222), so anything there is lost at
// the first install; the manifest leaves these two files out of the tree it describes
const ARCHIVE_MARK = ".kit-archive.json";
const ARCHIVE_MANIFEST = ".kit-archive-manifest.json";
const SHA = /^[0-9a-f]{40}$/;

export class SourceError extends Error {}
const refuse = (why) => { throw new SourceError(`kit at t=0 refused: ${why}`); };

/** kit.canon.json's vendor block in source mode → { path, repository }. Any other mode is refused: this bootstrap serves source mode only. */
export function sourceConfig(canon) {
  const v = canon?.vendor;
  if (!v || typeof v !== "object" || v.mode !== "source") refuse('kit.canon.json vendor.mode is not "source": this repository does not resolve the kit at its head (run kit source init in a repository that should)');
  const path = String(v.path ?? DEFAULT_PATH).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path === "." || path.split("/").includes("..") || path.startsWith("/")) refuse(`vendor.path ${JSON.stringify(v.path)} is not a folder inside the project`);
  const transport = String(v.transport ?? "archive");
  if (!TRANSPORTS.includes(transport)) refuse(`vendor.transport ${JSON.stringify(v.transport)} is neither "archive" (the published archive of the head, no credential) nor "git" (a checkout of the kit repository)`);
  const cfg = { path, repository: String(v.repository ?? DEFAULT_REPOSITORY), transport };
  if (v.head !== undefined) {
    if (typeof v.head !== "string" || !/^(https:|file:)/.test(v.head)) refuse(`vendor.head ${JSON.stringify(v.head)} is not an https: (or a test's file:) URL of the published head object`);
    cfg.head = v.head;
  }
  return cfg;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/**
 * A repository's identity independent of its transport: git@github.com:Owner/kit.git, ssh://git@github.com/Owner/kit, https://github.com/Owner/kit and
 * https://x@github.com/Owner/kit.git are one repository (host/owner/name, lower-cased, no .git); a file: URL or a plain path is its path. actions/checkout
 * with an ssh-key writes the SSH form as origin while kit.canon.json names the https form: the comparison reads the identity, the fetch keeps the remote.
 */
export function repoIdentity(url) {
  const s = String(url ?? "").trim();
  let m = /^([^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(s);                         // scp-like: git@host:owner/name(.git)
  if (m) return `${m[2].toLowerCase()}/${m[3].replace(/^\/+/, "").replace(/\.git\/?$/, "")}`;
  m = /^(?:ssh|git|https?|git\+ssh|git\+https):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s);   // a URL with a host
  if (m) return `${m[1].toLowerCase()}/${m[2].replace(/\.git\/?$/, "").replace(/\/+$/, "")}`;
  if (/^file:\/\//i.test(s)) return `file/${fileURLToPath(s).replace(/\/+$/, "")}`;
  return `file/${s.replace(/\/+$/, "")}`;                                                  // a plain path
}
const sameRepository = (a, b) => repoIdentity(a) === repoIdentity(b);
/**
 * The environment every git call here runs in: the caller's, less git's own repository-local variables (GIT_DIR and the rest, which git exports to
 * the hooks it runs: inside a pre-push hook they would point `git -C .kit` at the pushing repository), and no credential prompt. The same scrub as
 * the kit's packages/cli/src/git.js gitEnv(), written here because this file has no dependency: it runs before the kit exists.
 */
let localVars = null;
export function gitEnv() {
  if (!localVars) {
    try { localVars = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean); }
    catch (e) { if (e.code !== "ENOENT") throw e; localVars = []; /* no git at all: the caller's own git call fails as it would anyway (ENOENT) */ }
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!localVars.includes(k) && !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}
const defaultGit = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv(), maxBuffer: 64 * 1024 * 1024 }).trim();

/** The published head object (kit.kit-head.v1) at `url`: https through fetch; a file: URL (a test's fixture registry) read from disk. */
export async function readHeadDoc(url, { fetch: f = globalThis.fetch } = {}) {
  let text;
  if (url.startsWith("file:")) text = readFileSync(fileURLToPath(url), "utf8");
  else {
    let r;
    try { r = await f(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(15000) }); }
    catch (e) { refuse(`the published kit head ${url} is unreachable (${String(e?.message || e).slice(0, 120)}): a head that cannot be read verifies nothing`); }
    if (!r.ok) refuse(`the published kit head ${url} answered ${r.status}`);
    text = await r.text();
  }
  let doc;
  try { doc = JSON.parse(text); } catch { refuse(`the published kit head ${url} is not JSON`); }
  if (doc?.v !== 1 || !SHA.test(doc?.sha ?? "") || typeof doc?.date !== "string") refuse(`the published kit head ${url} is off its contract (kit.kit-head.v1: v, sha, date)`);
  return doc;
}

/** The checkout's state: { sha, date, clean, remote } or a refusal when it is not a git checkout of the kit. */
export function checkoutState(root, cfg, { git = defaultGit } = {}) {
  const dir = join(root, cfg.path);
  if (!existsSync(join(dir, ".git"))) refuse(`${cfg.path} is not a checkout of the kit (run node scripts/kit.mjs to make it)`);
  const remote = git(dir, ["remote", "get-url", "origin"]);
  if (!sameRepository(remote, cfg.repository)) refuse(`${cfg.path} is a checkout of ${remote}, not of the kit (${cfg.repository})`);
  const sha = git(dir, ["rev-parse", "HEAD"]);
  const dirty = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) refuse(`${cfg.path} has changes of its own (${dirty.split("\n")[0]}${dirty.includes("\n") ? ", ..." : ""}): the kit at its head carries no local edit`);
  return { sha, date: git(dir, ["show", "-s", "--format=%cI", "HEAD"]), remote };
}

/** Every file under dir but node_modules (any level) and the archive's own two records, as path → sha256 (a symlink: "link:" + its target). The archive transport's "git status". */
export function treeManifest(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (name === "node_modules" || (!rel && (name === ARCHIVE_MARK || name === ARCHIVE_MANIFEST))) continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
      else out[r] = sha256(readFileSync(join(dir, r)));
    }
  };
  walk("");
  return out;
}

/** The unpacked archive's state: { sha, date, remote } or a refusal when vendor.path holds no unpacked archive of the kit, or one edited since. */
export function archiveState(root, cfg) {
  const dir = join(root, cfg.path);
  if (existsSync(join(dir, ".git"))) refuse(`${cfg.path} is a git checkout, but vendor.transport is "archive": remove it, the bootstrap unpacks the published archive there`);
  const markFile = join(dir, ARCHIVE_MARK), manFile = join(dir, ARCHIVE_MANIFEST);
  if (!existsSync(markFile) || !existsSync(manFile)) refuse(`${cfg.path} is not an unpacked archive of the kit (run node scripts/kit.mjs to make it)`);
  const mark = JSON.parse(readFileSync(markFile, "utf8"));
  if (!SHA.test(mark?.sha ?? "") || typeof mark?.date !== "string") refuse(`${cfg.path}/${ARCHIVE_MARK} is off its shape: run node scripts/kit.mjs to unpack the archive again`);
  const want = JSON.parse(readFileSync(manFile, "utf8")), have = treeManifest(dir);
  const changed = Object.keys({ ...want, ...have }).sort().filter((p) => want[p] !== have[p]);
  if (changed.length) refuse(`${cfg.path} has changes of its own (${changed[0]}${changed.length > 1 ? `, ${changed.length - 1} more` : ""}): the kit at its head carries no local edit`);
  return { sha: mark.sha, date: mark.date, remote: mark.url };
}

/** The published archive the head object names, read (https, or a test's file:) and verified against the size and sha256 the head object states. → Buffer */
export async function readArchive(doc, { fetch: f = globalThis.fetch } = {}) {
  const a = doc.archive;
  if (!a || typeof a.url !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256 ?? "") || !Number.isInteger(a.bytes) || a.bytes < 1) refuse(`the published kit head names no archive of ${doc.sha.slice(0, 12)} (kit.kit-head.v1 archive { url, sha256, bytes }): the kit's CI publishes it with the head; until it does, vendor.transport "git" with a machine that can read the repository is the other way`);
  let buf;
  if (a.url.startsWith("file:")) buf = readFileSync(fileURLToPath(a.url));
  else {
    let r;
    try { r = await f(a.url, { signal: AbortSignal.timeout(180000) }); }
    catch (e) { refuse(`the kit archive ${a.url} is unreachable (${String(e?.message || e).slice(0, 120)})`); }
    if (!r.ok) refuse(`the kit archive ${a.url} answered ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length !== a.bytes) refuse(`the kit archive ${a.url} is ${buf.length} bytes; the head object says ${a.bytes}: not the published archive`);
  const got = sha256(buf);
  if (got !== a.sha256) refuse(`the kit archive ${a.url} has sha256 ${got.slice(0, 16)}…; the head object says ${a.sha256.slice(0, 16)}…: not the published archive`);
  return buf;
}

const defaultTar = (dir, file) => execFileSync("tar", ["-xzf", file, "--strip-components=1", "-C", dir], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
/** Replace what is at vendor.path (node_modules kept) with the published archive of the head object: fetched, verified, unpacked, its manifest and mark written. */
export async function fetchArchive(root, cfg, doc, { fetch, log = () => {}, tar = defaultTar } = {}) {
  const dir = join(root, cfg.path);
  if (existsSync(join(dir, ".git"))) refuse(`${cfg.path} is a git checkout, but vendor.transport is "archive": remove it, the bootstrap unpacks the published archive there`);
  log(`fetching the kit archive of ${doc.sha.slice(0, 12)} (${doc.archive?.url ?? "none published"})`);
  const buf = await readArchive(doc, { fetch });
  const tmp = join(tmpdir(), `kit-archive-${process.pid}-${Date.now()}.tar.gz`);
  writeFileSync(tmp, buf);
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (name !== "node_modules") rmSync(join(dir, name), { recursive: true, force: true });
    tar(dir, tmp);
  } finally { rmSync(tmp, { force: true }); }
  writeFileSync(join(dir, ARCHIVE_MANIFEST), JSON.stringify(treeManifest(dir)));
  writeFileSync(join(dir, ARCHIVE_MARK), `${JSON.stringify({ sha: doc.sha, date: doc.date, url: doc.archive.url, sha256: doc.archive.sha256 }, null, 2)}\n`);
  return doc.sha;
}

/** What is at vendor.path, by transport: archiveState or checkoutState. */
export const sourceState = (root, cfg, deps = {}) => (cfg.transport === "archive" ? archiveState(root, cfg) : checkoutState(root, cfg, deps));

/**
 * The URL of the published head object. Git transport: from the checkout's own registry (one source: packages/core/registry/kit-head.json).
 * Archive transport: vendor.head or the kit's published URL (DEFAULT_HEAD_URL), because the head is read before any kit file exists; the
 * unpacked kit's registry must then name the same URL (verify checks it).
 */
export function headUrlOf(root, cfg) {
  if (cfg.transport === "archive") return cfg.head ?? DEFAULT_HEAD_URL;
  const f = join(root, cfg.path, "packages/core/registry/kit-head.json");
  if (!existsSync(f)) refuse(`${cfg.path} has no packages/core/registry/kit-head.json: not the kit`);
  const url = JSON.parse(readFileSync(f, "utf8")).url;
  if (typeof url !== "string" || !url) refuse("the kit's registry names no published head URL yet: nothing can be verified against");
  return url;
}

/**
 * Verify what is at vendor.path: a clean checkout of the kit whose HEAD is the published head. No fetch, no install. Returns the record
 * (kit.kit-source.v1) or throws SourceError. This is the t=0 gate: kit check canon runs it, and every entry point runs it before the kit.
 */
export async function verify(root, cfg, { git = defaultGit, fetch, now = new Date() } = {}) {
  const state = sourceState(root, cfg, { git });
  const url = headUrlOf(root, cfg);
  const doc = await readHeadDoc(url, { fetch });
  if (cfg.transport === "archive") {
    const reg = join(root, cfg.path, "packages/core/registry/kit-head.json");
    if (!existsSync(reg)) refuse(`${cfg.path} has no packages/core/registry/kit-head.json: not the kit`);
    const own = JSON.parse(readFileSync(reg, "utf8")).url;
    if (typeof own === "string" && own !== url) refuse(`the unpacked kit's registry names ${own} as its published head and this repository read ${url}: one of them moved (kit.canon.json vendor.head, or the kit's registry)`);
  }
  if (doc.sha !== state.sha) {
    // git transport, ahead of the published head (the published commit is an ancestor of HEAD): the kit's CI has not published this head yet; behind it: fetch
    let ahead = false;
    if (cfg.transport === "git") { try { git(join(root, cfg.path), ["merge-base", "--is-ancestor", doc.sha, state.sha]); ahead = true; } catch { ahead = false; /* exit 1: the published commit is not an ancestor, so the checkout is behind, not ahead */ } }
    refuse(`${cfg.path} is at ${state.sha.slice(0, 12)} and the kit's published head is ${doc.sha.slice(0, 12)} (${doc.date}): ${ahead ? "the kit's CI has not published this head yet: wait for it (nothing runs on an unverified kit)" : "run node scripts/kit.mjs to move to the head"}`);
  }
  const lock = join(root, cfg.path, "package-lock.json");
  const mark = join(root, cfg.path, LOCK_MARK);
  const installed = existsSync(mark) && existsSync(lock) && readFileSync(mark, "utf8").trim() === sha256(readFileSync(lock));
  return { schema: SCHEMA, repository: cfg.repository, path: cfg.path, transport: cfg.transport, sha: state.sha, date: state.date, published: { url, sha: doc.sha, date: doc.date }, installed, verified_at: now.toISOString() };
}

/** Clone or fetch the kit at vendor.path and move it to origin/main (hard: the checkout carries no local edit). */
export function fetchHead(root, cfg, { git = defaultGit, log = () => {} } = {}) {
  const dir = join(root, cfg.path);
  if (!existsSync(join(dir, ".git"))) {
    if (existsSync(dir)) refuse(`${cfg.path} exists and is not a checkout: remove it (a vendored snapshot is deleted, never kept beside the source)`);
    mkdirSync(dirname(dir), { recursive: true });
    log(`cloning the kit (${cfg.repository}) at main into ${cfg.path}`);
    git(root, ["clone", "-q", "--branch", "main", "--single-branch", "--depth", "50", cfg.repository, cfg.path]);
  } else {
    const remote = git(dir, ["remote", "get-url", "origin"]);
    if (!sameRepository(remote, cfg.repository)) refuse(`${cfg.path} is a checkout of ${remote}, not of the kit (${cfg.repository})`);
    git(dir, ["fetch", "-q", "--depth", "50", "origin", "main"]);   // through the remote as configured (the SSH form in CI): the identity was compared, the transport is kept
  }
  git(dir, ["checkout", "-q", "--detach", "origin/main"]);
  git(dir, ["reset", "-q", "--hard", "origin/main"]);
  git(dir, ["clean", "-qfd", "-e", "node_modules"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** The kit's own dependencies, from the kit's own lockfile, when the lockfile changed since the last install (or nothing is installed). */
// npm writes its summary ("added N packages", "up to date") to stdout: it goes to stderr here, so that stdout carries only what the kit command
// given prints (a caller parsing `kit release workers --json` through the bootstrap reads the kit's JSON and nothing before it)
export function install(root, cfg, { npm = (cwd, args) => spawnSync("npm", args, { cwd, stdio: ["ignore", 2, 2] }), log = () => {} } = {}) {
  const dir = join(root, cfg.path);
  const lock = join(dir, "package-lock.json");
  if (!existsSync(lock)) refuse(`${cfg.path} has no package-lock.json: not the kit`);
  const want = sha256(readFileSync(lock)), mark = join(dir, LOCK_MARK);
  if (existsSync(join(dir, "node_modules")) && existsSync(mark) && readFileSync(mark, "utf8").trim() === want) return false;
  log("installing the kit's dependencies from its lockfile");
  const r = npm(dir, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  if (r.status !== 0) refuse(`npm ci in ${cfg.path} failed (exit ${r.status})`);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(mark, `${want}\n`);
  return true;
}

/** node_modules/@saasreport → the checkout's workspace packages; node_modules/.bin/kit → the checkout's CLI. A real directory there is a leftover of the snapshot and is refused. */
export function link(root, cfg) {
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, ".bin"), { recursive: true });
  const links = [
    [join(nm, "@saasreport"), relative(nm, join(root, cfg.path, "node_modules", "@saasreport")), "dir"],
    [join(nm, ".bin", "kit"), relative(join(nm, ".bin"), join(root, cfg.path, "packages", "cli", "bin", "kit.js")), "file"],
  ];
  const made = [];
  for (const [at, target, type] of links) {
    let st = null;
    try { st = lstatSync(at); } catch { st = null; /* nothing at that path yet: the link is made below */ }
    if (st && !st.isSymbolicLink()) refuse(`${relative(root, at)} is a real ${st.isDirectory() ? "directory" : "file"}, a leftover of the snapshot (file: dependencies on the vendored kit): remove the @saasreport dependencies from package.json, run npm ci, then run this again`);
    if (st && readlinkSync(at) === target) continue;
    if (st) unlinkSync(at);
    symlinkSync(target, at, type);
    made.push(relative(root, at));
  }
  return made;
}

/** Everything, in order: fetch to the head, verify against the published head, install, link, record. Returns the record. */
export async function ensure(root, cfg, deps = {}) {
  if (cfg.transport === "archive") {
    const doc = await readHeadDoc(headUrlOf(root, cfg), deps);
    let current = false;
    try { current = archiveState(root, cfg).sha === doc.sha; } catch (e) { if (!(e instanceof SourceError)) throw e; current = false; /* not unpacked yet, or edited: unpacked again below */ }
    if (!current) await fetchArchive(root, cfg, doc, deps);
  } else fetchHead(root, cfg, deps);
  const record = await verify(root, cfg, deps);
  record.installed = install(root, cfg, deps) || record.installed || existsSync(join(root, cfg.path, LOCK_MARK));
  record.linked = link(root, cfg);
  const out = join(root, cfg.path, RECORD);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// run directly (through a symlink too: the real path is compared); imported by the kit for `kit source` and the canon check, it runs nothing
const direct = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })();
if (direct) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  try {
    const canon = JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8"));
    const cfg = sourceConfig(canon);
    if (argv[0] === "--verify-only") { const r = await verify(root, cfg); console.log(`kit at head ${r.sha.slice(0, 12)} (${r.date}), verified against ${r.published.url}`); process.exit(0); }
    const record = await ensure(root, cfg, { log: (m) => console.error(`kit: ${m}`) });
    if (!argv.length) { console.log(JSON.stringify(record, null, 2)); process.exit(0); }
    const r = spawnSync(process.execPath, [join(root, cfg.path, "packages", "cli", "bin", "kit.js"), ...argv], { stdio: "inherit", cwd: process.cwd() });
    process.exit(r.status ?? 1);
  } catch (e) {
    if (e instanceof SourceError) { console.error(e.message); process.exit(1); }
    throw e;
  }
}
