/**
 * kit check tokens (docs/CONSTITUTION.md): the project's colours live in its token sources only. A token's hex written
 * anywhere else (a brand guide's swatch, a notification example, a content pack's category colour) is a second copy of
 * the fact that silently goes stale when the token changes; the page reads the token instead.
 *
 * kit.canon.json "tokens": { module, export?, sources: [tokens.js, brand.json], paths, exclude?, ignore? }
 *
 * Colour canon (docs/COLOUR.md), universal: beyond the token values above, NO colour literal (hex, rgb()/hsl() and the like,
 * a named colour on a colour property) is written outside the token sources in `paths` (source) and `generated` (built
 * output: the site, its CSS, SVG, scripts) except as the value of a --c-<role> custom property; paint with var(--c-role)
 * and color-mix(in srgb, var(--c-role) N%, transparent). A reviewed exception is an entry of canon.allow.json (category
 * "colour-literal", file, match, context, reason: one instance each, no wildcard); an entry that matches nothing is stale and fails. Every var(--c-x) used is
 * declared as --c-x somewhere in the scanned CSS.
 *
 * Every #RRGGBB / #RGB in the scanned files (comments included: a comment that names a colour goes stale the same way)
 * is compared with the token values, case-insensitively. White and black are tokens like any other colour: there is no
 * ignore list, and a literal white or black is a colour literal that the colour canon refuses like any other.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { expand, isTestFile, matchesAny, readText } from "./files.js";
import { scanColour, roleProblems, COLOUR_FILES } from "./colour.js";

const HEX = /(?<![\w&#])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])/g;
const P = (file, problem) => ({ file, problem });
const full = (h) => (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).toUpperCase();

/**
 * A diagram's theme line (the Mermaid init line, classDef, style, linkStyle) in a .mmd or Markdown file: its hex values are the theme,
 * which Mermaid cannot read from a stylesheet. They are derived from the tokens (docs/diagrams/theme.init, checked against them
 * below) and every diagram's line is checked equal to the theme by kit diagrams check, so they cannot go stale.
 */
const themeLine = (file, line) => /\.(mmd|md)$/i.test(file) && /^\s*(%%\{init:|classDef\s|style\s|linkStyle\s)/.test(line);

/** { "#RRGGBB": ["color.ok", …] } from a tokens object (nested colour groups included). */
export function tokenColours(tokens) {
  const out = {};
  const walk = (v, path) => {
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) (out[v.toUpperCase()] ||= []).push(path);
    else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(tokens?.color || {}, "color");
  return out;
}

/** Findings: [{ file, line, hex, tokens }]. */
export function scanTokenLiterals(root, cfg, colours) {
  const files = expand(root, cfg.paths).filter((f) => !isTestFile(f) && !matchesAny(f, [...cfg.sources, ...(cfg.exclude || [])]) && /\.(m?js|cjs|ts|json|html?|css|md|mmd|svg|txt|toml)$/.test(f));
  const findings = [];
  for (const f of files) {
    readText(root, f).split("\n").forEach((l, i) => {
      if (themeLine(f, l)) return;
      for (const m of l.matchAll(HEX)) {
        const hex = `#${full(m[1])}`;
        if (colours[hex]) findings.push({ file: f, line: i + 1, hex: m[0], tokens: colours[hex] });
      }
    });
  }
  return { files: files.length, scannedFiles: files, findings };
}

/** The colour-literal findings of `files` ([{ file, line, literal, kind }]), allow-list applied: { findings, allowed, stale }. */
export function colourFindings(root, files, allow = [], alsoUsed = new Set()) {
  const all = [];
  for (const f of files) for (const l of scanColour(f, readText(root, f))) all.push({ file: f, ...l });
  const used = new Set(alsoUsed), findings = [], allowed = [];
  for (const f of all) {
    const idx = allowedAt(root, allow, f.file, f.line, f.literal);
    if (idx >= 0) { used.add(idx); allowed.push(f); } else findings.push(f);
  }
  return { findings, allowed, stale: allow.filter((_, i) => !used.has(i)) };
}

/** The allow-list entry (index) that excuses this instance: the same file, literal and a piece of its line; -1 for none. */
const allowedAt = (root, allow, file, line, literal) => {
  const ctx = (readText(root, file).split("\n")[line - 1] || "").trim();
  return allow.findIndex((e) => e.file === file && e.match.toLowerCase() === literal.toLowerCase() && ctx.includes(e.context));
};

/** Indexes of the allow-list entries that excuse a token's value written at that instance (they are in use, not stale). */
const excusedByDup = (root, dups, allow) => new Set(dups.map((f) => allowedAt(root, allow, f.file, f.line, f.hex)).filter((i) => i >= 0));

/** kit check tokens. */
export async function checkTokenLiterals(root, canon) {
  const cfg = canon.tokens;
  if (!cfg) return { ok: false, configured: false, checked: 0, summary: "NOT CONFIGURED", problems: [] };
  let tokens;
  try { const mod = await import(pathToFileURL(resolve(root, cfg.module)).href); tokens = mod[cfg.export || "default"]; } catch (e) { return { ok: false, configured: true, checked: 0, summary: cfg.module, problems: [P(cfg.module, `cannot load the tokens: ${e.message}`)] }; }
  const colours = tokenColours(tokens);
  if (!Object.keys(colours).length) return { ok: false, configured: true, checked: 0, summary: cfg.module, problems: [P(cfg.module, "exports no colour tokens ({ color: { name: \"#RRGGBB\" } })")] };
  const r = scanTokenLiterals(root, cfg, colours);
  const allowFile = cfg.allow || "canon.allow.json";
  let allow = [];
  if (existsSync(resolve(root, allowFile))) { try { const all = JSON.parse(readFileSync(resolve(root, allowFile), "utf8")).entries || []; allow = all.filter((e) => e.category === "colour-literal"); } catch { /* the hardcoding check reports an unreadable allow-list */ } }
  // a reviewed exception also covers a token's value written at that instance
  const excused = (f) => allowedAt(root, allow, f.file, f.line, f.hex) >= 0;
  const dup = r.findings.filter((f) => !excused(f));
  const problems = dup.map((f) => P(`${f.file}:${f.line}`, `${f.hex} is ${f.tokens.join(", ")}: read the token (one source per fact), never its value`));

  // colour canon: no literal at all outside the token sources and the --c-* role declarations
  const skip = [...cfg.sources, ...(cfg.exclude || [])];
  const srcFiles = expand(root, cfg.paths).filter((f) => !isTestFile(f) && !matchesAny(f, skip) && COLOUR_FILES.test(f));
  const genFiles = expand(root, cfg.generated || []).filter((f) => !matchesAny(f, skip) && COLOUR_FILES.test(f));
  const scanned = [...new Set([...srcFiles, ...genFiles])];
  const named = (f) => (colours[f.literal.toUpperCase().replace(/^%23/, "#")] || []);
  const lit = colourFindings(root, scanned, allow, excusedByDup(root, r.findings, allow));
  for (const f of lit.findings) {
    const same = named(f);
    problems.push(P(`${f.file}:${f.line}`, `colour literal ${f.literal} (${f.kind})${same.length ? ` is ${same.join(", ")}` : ""}: paint with var(--c-<role>) or color-mix(in srgb, var(--c-<role>) N%, transparent); declare a colour only as a --c-<role> property in the token sources (docs/COLOUR.md)`));
  }
  for (const e of lit.stale) problems.push(P(allowFile, `stale colour-literal allow-list entry (matches nothing; remove it): ${e.file} "${e.match}" (${e.context})`));
  for (const u of roleProblems(scanned.map((file) => ({ file, text: readText(root, file) })))) problems.push(P(`${u.file}:${u.line}`, `${u.name} is used but no stylesheet declares it as a colour role`));
  return { ok: !problems.length, configured: true, checked: new Set([...r.scannedFiles, ...scanned]).size, summary: `${r.files} file${r.files === 1 ? "" : "s"}; ${Object.keys(colours).length} token colours, ${r.findings.length} token literal${r.findings.length === 1 ? "" : "s"}; colour canon: ${scanned.length} file${scanned.length === 1 ? "" : "s"}, ${lit.findings.length} literal${lit.findings.length === 1 ? "" : "s"}, ${lit.allowed.length} allowed`, problems };
}
