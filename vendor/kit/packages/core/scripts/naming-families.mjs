#!/usr/bin/env node
/**
 * Project prefixes have one source: the project registry (packages/core/registry/projects.json). Everything that tells one
 * project's resources from another's is generated from it, never hand-copied:
 *   generated:<name> blocks, in any file, between a start and an end marker in that file's comment syntax (<!--, //, %%, #):
 *     naming-prefixes  the prefix list of the naming constitution (CLAUDE.md)
 *     plugin-prefixes  PREFIXES and FULL_PREFIXES of the standalone plugin checker and its copies
 *     naming-families  the family nodes of the naming diagram (docs/diagrams/naming.mmd)
 * --check also runs a VALUE scan: a bare registry prefix, or two or more registry codes side by side (a list, a map, an alternation,
 * in any formatting), anywhere in the repository outside the registry, generated files and blocks, tests and finding cases, is a copy
 * of the registry and fails, unless canon.allow.json holds a reviewed "project-prefix" entry for that one instance.
 *   node packages/core/scripts/naming-families.mjs          rewrite the generated files and blocks
 *   node packages/core/scripts/naming-families.mjs --check  exit 1 on drift, or a copy the value scan finds (kit check freshness)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../../cli/src/git.js";
import { blocksIn } from "./generated-blocks.mjs";
export { blocksIn };

export const REGISTRY = "packages/core/registry/projects.json";
/** The reviewed exceptions of the value scan: canon.allow.json entries of this category (one instance each, with its reason). */
export const ALLOW_CATEGORY = "project-prefix";
const root = fileURLToPath(new URL("../../../", import.meta.url));

/** family → the prefixes it owns, in registry order: the full prefix, then the short one when it differs. */
export function families(reg) {
  return Object.fromEntries(reg.projects.map((p) => [p.key, [p.prefix, ...(p.short && p.short !== p.prefix ? [p.short] : [])]]));
}
/** Prefixes that contain another family's (one would admit the other's names): [`a ⊂ b`]. Empty for a sound registry. */
export function containment(reg) {
  const all = Object.entries(families(reg)).flatMap(([k, ps]) => ps.map((p) => [k, p])), out = [];
  for (const [k, p] of all) for (const [j, q] of all) if (k !== j && q.startsWith(p)) out.push(`${p} (${k}) is a prefix of ${q} (${j})`);
  return out;
}
/** project code → project key: the short prefix without its dash, the key itself when there is none (the plugin checker's PREFIXES). */
export const codes = (reg) => Object.fromEntries(reg.projects.map((p) => [p.short ? p.short.replace(/-$/, "") : p.key, p.key]));

/** Retired prefixes: never declared, created or modified. */
export const forbidden = (reg) => (reg.legacy || []).map((l) => l.prefix);

/** The generated blocks this generator owns: name → (registry) → the lines between the markers (indented like the start marker). */
export const BLOCKS = {
  "naming-prefixes": (reg) => [`${reg.projects.map((p) => (p.short && p.short !== p.prefix ? `\`${p.prefix}\`/\`${p.short}\`` : `\`${p.prefix}\``)).join(", ")} (a project with one prefix has no short form).`],
  "plugin-prefixes": (reg) => [
    "/** Each project's code (its short prefix without the dash, or its key when it has none), in registry order. */",
    `export const PREFIXES = [${Object.keys(codes(reg)).map((c) => JSON.stringify(c)).join(", ")}];`,
    "/** Each code's full project prefix, without the dash: either may name a resource such as an MCP server. */",
    `export const FULL_PREFIXES = { ${reg.projects.map((p) => `${p.short ? p.short.replace(/-$/, "") : p.key}: ${JSON.stringify(p.prefix.replace(/-$/, ""))}`).join(", ")} };`,
  ],
  "naming-families": (reg) => reg.projects.map((p, i) => `q --> f${i}("${p.prefix}*${p.short && p.short !== p.prefix ? ` or ${p.short}*` : ""}")`),
};
/** The text with every block this generator owns rewritten from the registry; blocks of other generators are left as they are. */
export function renderBlocks(text, reg) {
  let out = "", at = 0;
  for (const b of blocksIn(text)) {
    if (!BLOCKS[b.name]) continue;
    out += text.slice(at, b.start) + BLOCKS[b.name](reg).map((l) => `${b.indent}${l}\n`).join("");
    at = b.end;
  }
  return out + text.slice(at);
}

/** The files the value scan reads. */
const TEXT = /\.(m?js|cjs|ts|tsx|jsx|json|md|mmd|sh|ya?ml|toml|html|css|txt)$/;
/** The reviewed allow-list quotes each instance it allows. */
const ALLOW_FILE = "canon.allow.json";
/** Tests and finding cases may pin registry values on purpose (a test that pins a wrong one fails by itself); the allow-list quotes. */
const NOT_SCANNED = (f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.[a-z]+$/.test(f) || f.startsWith("findings/") || f === REGISTRY || f === ALLOW_FILE;

/**
 * Every generated file's text: → { <repo-relative path>: text }. `files` and `read` give the files whose blocks are rewritten. A file whose
 * blocks cannot be read (unclosed, nested, a name twice) is left out and its problem, with its path, goes to `problems`.
 */
export function render(reg, read = () => null, files = [], problems = []) {
  const out = {};
  for (const f of files) {
    if (f in out || !TEXT.test(f)) continue;
    const text = read(f);
    if (text == null || !/generated:/.test(text)) continue;
    let blocks;
    try { blocks = blocksIn(text); } catch (e) { problems.push(`${f}: ${e.message}`); continue; }
    if (blocks.some((b) => BLOCKS[b.name])) out[f] = renderBlocks(text, reg);
  }
  return out;
}

/** The value scan's patterns: bare prefixes (not followed by a name), one code token, and two code tokens with only separators between. */
export function valuePatterns(reg) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), byLen = (xs) => [...new Set(xs)].sort((a, b) => b.length - a.length);
  const pre = byLen(Object.values(families(reg)).flat()), code = `(?:${byLen([...Object.keys(codes(reg)), ...reg.projects.map((p) => p.key)]).map(esc).join("|")})`;
  const tok = `(?<![A-Za-z0-9_@.-])${code}(?![A-Za-z0-9_.-])`;
  return {
    prefix: new RegExp(`(?<![A-Za-z0-9_@/.-])(?:${pre.map(esc).join("|")})(?![A-Za-z0-9_])`, "g"),
    token: new RegExp(tok, "g"),
    codes: new RegExp(`${tok}[\\s|,'"\`:()\\[\\]{}\\\\/^$?*+]*${tok}`, "g"),
  };
}

/**
 * Copies of the registry in one text: [{ line, match, context }]. Blocks a known generator owns (`owned(name)`) are blanked first, line
 * numbers kept; any other block is read like the rest of the text. Every bare
 * prefix is a copy; a run of codes is a copy when it names at least two different codes.
 */
export function copiesIn(text, reg, owned = (name) => Boolean(BLOCKS[name])) {
  let t = text;
  for (const b of blocksIn(text).reverse()) if (owned(b.name)) t = t.slice(0, b.start) + t.slice(b.start, b.end).replace(/[^\n]/g, " ") + t.slice(b.end);
  const { prefix, token, codes: run } = valuePatterns(reg), out = [], lines = text.split("\n");
  const at = (i, match) => { const line = t.slice(0, i).split("\n").length; out.push({ line, match: match.replace(/\s+/g, " "), context: (lines[line - 1] || "").trim() }); };
  for (const m of t.matchAll(prefix)) at(m.index, m[0]);
  for (const m of t.matchAll(run)) if (new Set(m[0].match(token)).size > 1) at(m.index, m[0]);
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Everything that differs from the registry. `files` lists the repository's tracked text files; `read(rel)` gives one's text or null.
 * `generated` lists the outputs of the repository's freshness generators (kit.canon.json): such a file without generated: blocks is
 * not scanned (its generator's check owns it); a file with blocks has only its blocks skipped. `allow` holds canon.allow.json's entries.
 */
export function check(reg, read, files, { generated = [], allow = [], foreign = [] } = {}) {
  const problems = [];
  const out = render(reg, read, files, problems);
  for (const [f, text] of Object.entries(out)) if (read(f) !== text) problems.push(`${f}: stale (node packages/core/scripts/naming-families.mjs)`);
  for (const c of containment(reg)) problems.push(`${REGISTRY}: ${c}; one would admit the other's names`);
  // the value scan
  const isOutput = (f) => f in out || generated.some((g) => f === g || f.startsWith(`${g.replace(/\/$/, "")}/`));
  const entries = allow.filter((e) => e.category === ALLOW_CATEGORY).map((e) => ({ ...e, used: 0 }));
  for (const f of files) {
    if (!TEXT.test(f) || NOT_SCANNED(f)) continue;
    const text = read(f);
    if (text == null) continue;
    let copies;
    try {
      const blocks = blocksIn(text);
      if (isOutput(f) && !blocks.length) continue;      // a whole generated file: its generator's check owns it
      // a block is skipped only when its owner is known: this generator (its blocks are rewritten and compared above), or a freshness
      // generator of kit.canon.json that declares the block in its outputs; any other block hides nothing
      const owned = (name) => Boolean(BLOCKS[name]) || foreign.some((x) => (x.outputs || []).includes(f) && (x.blocks || []).includes(name));
      for (const b of blocks) if (!owned(b.name)) problems.push(`${f}: generated:${b.name} is no known generator's block in this file (declare it in kit.canon.json freshness "blocks", or remove the markers)`);
      copies = copiesIn(text, reg, owned);
    } catch (e) { if (!problems.includes(`${f}: ${e.message}`)) problems.push(`${f}: ${e.message}`); continue; /* render() may have reported it already */ }
    for (const c of copies) {
      // one entry allows one instance: a second copy matching the same entry is a finding
      const e = entries.find((a) => !a.used && a.file === f && a.match === c.match && c.context.includes(a.context));
      if (e) { e.used++; continue; }
      problems.push(`${f}:${c.line}: "${c.match}" copies the project registry (${REGISTRY}): generate it (a generated: block or a generator's output), point at the registry, or add one reviewed "${ALLOW_CATEGORY}" entry to canon.allow.json`);
    }
  }
  for (const e of entries) if (!e.used) problems.push(`canon.allow.json: stale "${ALLOW_CATEGORY}" entry (matches nothing; remove it): ${e.file} "${e.match}"`);
  return problems;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const read = (f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return null; /* absent: reported as stale */ } };
  const reg = JSON.parse(read(REGISTRY));
  const files = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", env: gitEnv() }).split("\n").filter(Boolean);
  const canonOf = (f) => { try { return JSON.parse(read(f) || "{}"); } catch (e) { console.error(`${f}: ${e.message}`); process.exit(1); } };
  const foreign = canonOf("kit.canon.json").freshness || [];
  const generated = foreign.flatMap((x) => x.outputs || []);
  const allow = canonOf("canon.allow.json").entries || [];
  if (process.argv.includes("--check")) {
    const problems = check(reg, read, files, { generated, allow, foreign });
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log("ok: naming families and generated blocks = registry; no copy of it anywhere else");
  } else {
    const unread = [], out = render(reg, read, files, unread);
    if (unread.length) { console.error(unread.join("\n")); process.exit(1); }   // write nothing while a block cannot be read
    for (const [f, text] of Object.entries(out)) if (read(f) !== text) { writeFileSync(join(root, f), text); console.log(`${f}: written from the registry`); }
  }
}
