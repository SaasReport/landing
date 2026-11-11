#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance.
/**
 * upstream-sync: report what upstream Forge changed since the origin of the port, for a person to review.
 * It NEVER applies anything: it writes nothing under packages/forge, and refuses an --out path there.
 *
 *   node packages/forge/scripts/upstream-sync.mjs --source <clone of the upstream repository> [--ref main] [--out file]
 *   node packages/forge/scripts/upstream-sync.mjs --github [--ref main] [--out file]     (GitHub's compare API;
 *                                                                                        GITHUB_TOKEN if set)
 *   --origin <ORIGIN.json>   another origin record (default: packages/forge/ORIGIN.json; for tests)
 *
 * The report (Markdown, stdout or --out): the origin commit and the reviewed ref; every upstream file under
 * origin.path that changed, classified against ORIGIN.json:
 *   ported       → the port file to update by hand, and the upstream diff
 *   not ported   → the recorded reason (does it still hold?), and the diff
 *   new          → not in ORIGIN.json: decide to port it or record why not
 * With --source it also checks that every file at the origin commit still has the sha256 ORIGIN.json records.
 *
 * Exit: 0 nothing changed upstream, 3 changes to review, 1 an error. To take a change: port it by hand, move
 * origin.commit and the sha256s in ORIGIN.json in the same reviewed commit, run npm test, regenerate every SDK.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Classify upstream changes against the origin record.
 * @param {object} origin ORIGIN.json
 * @param {{ status: "modified" | "added" | "deleted" | "renamed", file: string, from?: string, patch?: string }[]} changes
 *   paths relative to origin.path
 */
export function classify(origin, changes) {
  const ported = new Map(origin.ported.map((f) => [f.upstream, f]));
  const notPorted = new Map(origin.not_ported.map((f) => [f.upstream, f]));
  return changes.map((c) => {
    const key = ported.has(c.file) || notPorted.has(c.file) ? c.file : c.from ?? c.file;
    if (ported.has(key)) return { ...c, kind: "ported", port: ported.get(key).port };
    if (notPorted.has(key)) return { ...c, kind: "not ported", reason: notPorted.get(key).reason };
    return { ...c, kind: "new" };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

/** The Markdown report. */
export function report(origin, ref, resolved, items, integrity = []) {
  const o = origin.origin;
  const lines = [
    `# Upstream Forge changes for review`,
    "",
    `Origin: \`${o.repository}\` \`${o.path}\` at \`${o.commit}\` (${o.date}). Reviewed: \`${ref}\`${resolved ? ` = \`${resolved}\`` : ""}.`,
    "",
    "Nothing has been applied. Port what applies by hand, then move `origin.commit` and the sha256s in",
    "`packages/forge/ORIGIN.json` in the same reviewed commit, run `npm test` and regenerate every SDK.",
    "",
  ];
  if (integrity.length) lines.push("## Origin integrity", "", ...integrity.map((p) => `- ${p}`), "");
  if (!items.length) {
    lines.push("No upstream changes under the origin path.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`## ${items.length} changed file${items.length === 1 ? "" : "s"}`, "", "| Upstream file | Change | Ours | Action |", "|---|---|---|---|");
  for (const i of items) {
    const ours = i.kind === "ported" ? `\`${i.port}\`` : i.kind === "not ported" ? "not ported" : "not in ORIGIN.json";
    const action = i.kind === "ported" ? "review the diff; port what applies" : i.kind === "not ported" ? `check the reason still holds: ${i.reason}` : "port it, or record it in not_ported with a reason";
    lines.push(`| \`${i.file}\`${i.from && i.from !== i.file ? ` (from \`${i.from}\`)` : ""} | ${i.status} | ${ours} | ${action.replace(/\|/g, "\\|")} |`);
  }
  for (const i of items.filter((x) => x.patch)) lines.push("", `### ${i.file}`, "", "```diff", i.patch.trimEnd(), "```");
  return `${lines.join("\n")}\n`;
}

// git exports GIT_DIR and the rest to its hooks: git runs here without git's own repository-local variables (its list, git
// rev-parse --local-env-vars), so -C names the repository read. The same rule as gitEnv in @saasreport/cli (finding class
// git-env-inherited); forge has no dependencies, so it asks git itself.
let local = null;
export function localEnvVars() {
  if (local) return local;
  try { local = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`git rev-parse --local-env-vars failed: ${String(e.stderr || e.message).trim()}`); local = []; }
  return local;
}
export function gitEnv(env = process.env) {
  const vars = localEnvVars();
  const out = { ...env };
  for (const k of vars) delete out[k];
  if (vars.includes("GIT_CONFIG_COUNT")) for (const k of Object.keys(out)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k];
  return out;
}
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
const STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified" };

/** Changes from a local clone (git diff origin..ref under origin.path), and the integrity of the origin files. */
export function fromClone(origin, source, ref) {
  const o = origin.origin;
  try { git(source, ["cat-file", "-e", `${o.commit}^{commit}`]); } catch { throw new Error(`${source} does not have the origin commit ${o.commit} (fetch it first)`); }
  const resolved = git(source, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const base = o.path.replace(/\/$/, "");
  const integrity = [];
  for (const f of [...origin.ported, ...origin.not_ported]) {
    let buf;
    try { buf = execFileSync("git", ["-C", source, "show", `${o.commit}:${base}/${f.upstream}`], { maxBuffer: 64 * 1024 * 1024, env: gitEnv() }); } catch { integrity.push(`\`${f.upstream}\`: missing at the origin commit`); continue; }
    if (sha256(buf) !== f.sha256) integrity.push(`\`${f.upstream}\`: differs from the sha256 ORIGIN.json records at the origin commit`);
  }
  const changes = [];
  for (const line of git(source, ["diff", "--name-status", "-M", o.commit, resolved, "--", base]).split("\n").filter(Boolean)) {
    const [code, a, b] = line.split("\t");
    const rel = (p) => p.slice(base.length + 1);
    const status = STATUS[code[0]] ?? "modified";
    const file = rel(b ?? a);
    const patch = git(source, ["diff", "-M", o.commit, resolved, "--", ...(b ? [a, b] : [a])]);
    changes.push({ status, file, ...(b ? { from: rel(a) } : {}), patch });
  }
  return { resolved, changes, integrity };
}

/** Changes from GitHub's compare API (no clone). */
export async function fromGitHub(origin, ref, fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN) {
  const o = origin.origin;
  const res = await fetchImpl(`https://api.github.com/repos/${o.repository}/compare/${o.commit}...${encodeURIComponent(ref)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "kit-forge-upstream-sync", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub compare ${o.repository} ${o.commit.slice(0, 12)}...${ref}: HTTP ${res.status}`);
  const data = await res.json();
  const base = `${o.path.replace(/\/$/, "")}/`;
  const changes = (data.files || []).filter((f) => f.filename.startsWith(base) || f.previous_filename?.startsWith(base)).map((f) => ({
    status: f.status === "removed" ? "deleted" : f.status === "renamed" ? "renamed" : f.status === "added" ? "added" : "modified",
    file: f.filename.startsWith(base) ? f.filename.slice(base.length) : f.filename,
    ...(f.previous_filename ? { from: f.previous_filename.slice(base.length) } : {}),
    ...(f.patch ? { patch: `--- a/${f.previous_filename ?? f.filename}\n+++ b/${f.filename}\n${f.patch}` } : {}),
  }));
  return { resolved: data.commits?.at(-1)?.sha ?? null, changes, integrity: [] };
}

function args(argv) {
  const a = { ref: "main", github: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--github") a.github = true;
    else if (["--source", "--ref", "--out", "--origin"].includes(k)) a[k.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.github && !a.source) throw new Error("usage: upstream-sync.mjs --source <upstream clone> | --github [--ref main] [--out file] [--origin ORIGIN.json]");
  return a;
}

/** An --out path inside packages/forge is refused: the script reports, it never writes into the port. */
export function guardOut(out) {
  const target = resolve(out);
  let probe = dirname(target);
  while (!existsSync(probe)) probe = dirname(probe);
  const real = resolve(realpathSync(probe), target.slice(probe.length + 1));
  const pkg = realpathSync(PACKAGE_DIR).replace(/\/$/, "");
  if (real === pkg || real.startsWith(`${pkg}${sep}`)) throw new Error(`--out ${out} is inside packages/forge: upstream-sync only reports, it never writes into the port`);
  return target;
}

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let a;
  try {
    a = args(argv);
    const out = a.out ? guardOut(a.out) : null;
    const origin = JSON.parse(readFileSync(a.origin ?? new URL("../ORIGIN.json", import.meta.url), "utf8"));
    const r = a.github ? await fromGitHub(origin, a.ref) : fromClone(origin, a.source, a.ref);
    const items = classify(origin, r.changes);
    const text = report(origin, a.ref, r.resolved, items, r.integrity);
    if (out) writeFileSync(out, text); else io.out(text);
    io.err(`upstream-sync: ${items.length} upstream change${items.length === 1 ? "" : "s"} since ${origin.origin.commit.slice(0, 12)}${r.integrity.length ? `, ${r.integrity.length} integrity problem${r.integrity.length === 1 ? "" : "s"}` : ""}; nothing applied\n`);
    return items.length || r.integrity.length ? 3 : 0;
  } catch (e) {
    io.err(`upstream-sync: ${e.message}\n`);
    return 1;
  }
}

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) process.exitCode = await main();
