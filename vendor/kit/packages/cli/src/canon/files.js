/** Files for the canon checks: globs, directory walks and the string literals of JavaScript sources. */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// .kit: the checkout of the kit at its head in source mode (docs/FRESHNESS.md), the kit and not the site, exactly like a vendored snapshot
const SKIP = new Set(["node_modules", ".git", ".wrangler", "vendor", ".kit"]);
const posix = (p) => p.split(sep).join("/");

/** Glob → RegExp over posix paths: ** any depth, * within a segment, ? one character, {a,b} alternatives. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = glob.indexOf("}", i); re += `(?:${glob.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const isGlob = (p) => /[*?{]/.test(p);

/** Every file under dir (posix paths relative to root), skipping node_modules, .git, .wrangler, vendor and .kit (the kit's source checkout). */
export function walk(root, dir = ".") {
  const out = [];
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) return [posix(relative(root, abs))];
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    if (d.name === "worktrees" && posix(relative(root, abs)).endsWith(".claude")) continue;   // agents' worktrees: other checkouts, never this repository's files
    const p = join(abs, d.name);
    if (d.isDirectory()) out.push(...walk(root, relative(root, p)));
    else if (d.isFile()) out.push(posix(relative(root, p)));
  }
  return out.sort();
}

/** Expand paths and globs (relative to root) to existing files. A plain directory means every file under it. */
export function expand(root, patterns = []) {
  const files = new Set();
  for (const p of patterns) {
    if (!isGlob(p)) { for (const f of walk(root, p)) files.add(f); continue; }
    const base = p.split("/").filter((s, i, a) => !a.slice(0, i + 1).some(isGlob)).join("/") || ".";
    const re = globRe(p.replace(/^\.\//, ""));
    for (const f of walk(root, base)) if (re.test(f)) files.add(f);
  }
  return [...files].sort();
}

/** Test files assert behaviour and do not ship: out of scope of the hardcoding scan, for every repository alike. */
export const isTestFile = (f) => /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/.test(f);

export const matchesAny = (file, globs = []) => globs.some((g) => (isGlob(g) ? globRe(g) : new RegExp(`^${g.replace(/[.+^$()|[\]\\*?{}]/g, "\\$&")}(/|$)`)).test(file));

export const readText = (root, file) => readFileSync(join(root, file), "utf8");

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)\s*$/;

/**
 * The string and template literals of a JavaScript source, comments and regex literals skipped:
 * [{ value, line, kind: "string" | "template", context, start, end }] (context: up to 40 characters before the literal on its line;
 * start/end: the value's offsets in src, so a fixer can rewrite it in place).
 * A template literal's ${…} expressions are kept in its value as written.
 */
export function literals(src) {
  const out = [];
  let i = 0, line = 1, prev = "\n";
  const n = src.length;
  const ctx = (at) => { const s = src.lastIndexOf("\n", at - 1) + 1; return src.slice(Math.max(s, at - 40), at); };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; prev = "\n"; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
    if (c === "/" && (REGEX_BEFORE.has(prev) || REGEX_KEYWORDS.test(src.slice(Math.max(0, i - 12), i)))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") { if (src[j] === "\\") { j += 2; continue; } if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) break; j++; }
      if (src[j] === "/") { j++; while (/[a-z]/i.test(src[j] || "")) j++; i = j; prev = "/"; continue; }
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i, startLine = line;
      let j = i + 1, depth = 0, val = "";
      while (j < n) {
        const d = src[j];
        if (d === "\\") { val += src.slice(j, j + 2); if (src[j + 1] === "\n") line++; j += 2; continue; }
        if (d === "\n") { if (c !== "`") break; line++; }
        if (c === "`" && d === "$" && src[j + 1] === "{") { depth++; val += "${"; j += 2; continue; }
        if (c === "`" && depth && d === "}") { depth--; val += d; j++; continue; }
        if (d === c && !depth) break;
        val += d; j++;
      }
      out.push({ value: val, line: startLine, kind: c === "`" ? "template" : "string", context: ctx(start), start: start + 1, end: j });
      i = j + 1; prev = "a"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
