/** File helpers for the SDK check (same glob rules as kit check canon: * within a segment, ** across segments). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".wrangler", "dist", "vendor"]);

function walk(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [dir];
  return readdirSync(abs).flatMap((f) => (SKIP.has(f) ? [] : walk(root, dir ? `${dir}/${f}` : f)));
}

const globRe = (g) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

/** Files (relative paths) matching paths, directories or globs under root, sorted, without node_modules/vendor. */
export function expandFiles(root, patterns) {
  const out = new Set();
  for (const p of patterns || []) {
    if (!/[*]/.test(p)) { for (const f of walk(root, p.replace(/\/$/, ""))) out.add(f); continue; }
    const base = p.slice(0, p.search(/[*]/)).replace(/[^/]*$/, "").replace(/\/$/, "");
    const re = globRe(p);
    for (const f of walk(root, base)) if (re.test(f)) out.add(f);
  }
  return [...out].sort();
}

export const readText = (root, f) => readFileSync(join(root, f), "utf8");
export const rel = (root, p) => relative(root, p).split("\\").join("/");

/** Whether a relative path matches any of the globs (a glob without * also matches everything under it). */
export const matchesAny = (f, globs) => (globs || []).some((g) => (/[*]/.test(g) ? globRe(g).test(f) : f === g.replace(/\/$/, "") || f.startsWith(`${g.replace(/\/$/, "")}/`)));
