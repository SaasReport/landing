/**
 * kit check spelling (docs/CONSTITUTION.md): a British English project's content carries no American spelling.
 *
 * kit.canon.json "spelling": { variant: "en-GB", paths, exclude, exceptions: "spelling.exceptions.json" }
 *
 * What is read: the reader-facing text of each file. In .js/.mjs/.cjs only string and template literals (code,
 * comments, object keys and module specifiers are not text); in Markdown and HTML everything outside code and tags;
 * in JSON every string value. The word list and the rules are @saasreport/core/spelling's (the one the podcast pipeline
 * uses): code spans and fences (`canceled`), URLs and the project's exceptions are never flagged.
 *
 * The exceptions file (kit.spelling-exceptions.v1) is the project's one list of names, titles, protocol values and
 * defined terms spelled the American way by their owners. The podcast check reads the same file. Every entry has a
 * reason: an entry that matches nothing in the scanned content is stale and fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { usSpellings, exceptionRe } from "@saasreport/core/spelling";
import { formatProblems } from "@saasreport/core/schema";
import { expand, matchesAny, readText, literals } from "./files.js";

const CODE = /\.(m?js|cjs)$/;
const P = (file, problem) => ({ file, problem });

/** The reader-facing text of one file: [{ line, text }] (line: 1-based, where the text starts). */
export function textsOf(file, src) {
  if (CODE.test(file)) {
    return literals(src).filter((l) => !/\b(import|from|require)\s*\(?\s*$/.test(l.context)).map((l) => ({ line: l.line, text: l.value }));
  }
  if (/\.json$/.test(file)) {
    const out = [];
    const walk = (v) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    let value;
    try { value = JSON.parse(src); } catch (e) { throw new Error(`${file} is not JSON (${e.message}): its text cannot be spell-checked`); }   // never skipped
    walk(value);
    // JSON keeps no positions once parsed: each string is reported at the first line that holds it
    return out.map((text) => { const at = src.indexOf(JSON.stringify(text).slice(1, -1).slice(0, 40)); return { line: at < 0 ? 1 : src.slice(0, at).split("\n").length, text }; });
  }
  // Markdown and HTML: drop scripts, styles, <code>/<pre>, tags and attributes; keep the line breaks
  const text = src.replace(/<(script|style|code|pre)\b[\s\S]*?<\/\1>/gi, blank).replace(/<[^>]*>/g, blank).replace(/\{\{[\s\S]*?\}\}/g, blank);
  return [{ line: 1, text }];
}

/**
 * What in a literal is not prose: an identifier (a literal with no space in lower case, digits and - _ . / :, such as a
 * slug "rich-authorization-request", an enum value "center", an autocomplete token "organization"), HTML tags and
 * their attributes (also attr="…" and CSS declarations left in a fragment), ${…} and {{…}} placeholders, Markdown link targets and site paths (/glossary/<slug>).
 */
export const IDENTIFIER = /^[a-z0-9][a-z0-9_.:/-]*$/;
const blank = (m) => m.replace(/[^\n]/g, " ");
export const strip = (t) => (IDENTIFIER.test(t.trim()) ? "" : t
  .replace(/<[^>]*>/g, blank).replace(/\$\{[^}]*\}/g, blank).replace(/\{\{[^}]*\}\}/g, blank)
  .replace(/[\w-]+=(?:\\?"[^"]*"|'[^']*')/g, blank).replace(/(?<![\w-])[a-z-]+:[^;"'\s]+;/g, blank)
  .replace(/\]\([^)\s]*\)/g, blank).replace(/(?<![\w.])\/[\w.-]+(?:\/[\w.#?=&-]*)*/g, blank));

/** Findings of the declared content: { files, findings: [{ file, line, us, gb }], used: Set(phrase) }. */
export function scanSpelling(root, cfg, exceptions = []) {
  const files = expand(root, cfg.paths).filter((f) => /\.(m?js|cjs|json|md|html?)$/.test(f) && !matchesAny(f, cfg.exclude || []));
  const findings = [], used = new Set();
  for (const f of files) {
    // an entry with `files` holds only there (an HTTP reason phrase in one script), the others everywhere
    const here = exceptions.filter((e) => !e.files || matchesAny(f, e.files));
    for (const { line, text } of textsOf(f, readText(root, f))) {
      const t = strip(text);
      for (const e of here) if (exceptionRe(e).test(t)) used.add(e.phrase);
      for (const w of usSpellings(t, { exceptions: here })) findings.push({ file: f, line: line + w.line - 1, us: w.us, gb: w.gb });
    }
  }
  return { files: files.length, findings, used };
}

/**
 * The exceptions file: { entries, problems, valid }. Validated first: a document off its schema is reported and never
 * used (valid false, no entries), so nothing downstream reads a shape it does not expect. Expired entries reported.
 */
export function loadExceptions(root, path, kit) {
  if (!path) return { entries: [], problems: [], valid: true };   // no exceptions declared: none allowed, the strictest reading
  if (!existsSync(join(root, path))) return { entries: [], problems: [P(path, "spelling exceptions declared but missing")], valid: false };
  let doc;
  try { doc = JSON.parse(readFileSync(join(root, path), "utf8")); } catch (e) { return { entries: [], problems: [P(path, `not JSON: ${e.message}`)], valid: false }; }
  const invalid = kit ? formatProblems(kit.validator.validate(doc, kit.byName("spelling-exceptions"))).map((m) => P(path, m)) : [];
  if (invalid.length) return { entries: [], problems: invalid, valid: false };
  const problems = [];
  return { entries: doc.exceptions, problems, valid: true };
}

/** kit check spelling. */
export function checkSpelling(root, canon, kit) {
  const cfg = canon.spelling;
  if (!cfg) return { ok: false, configured: false, checked: 0, summary: "NOT CONFIGURED", problems: [] };
  const { entries, problems, valid } = loadExceptions(root, cfg.exceptions, kit);
  if (!valid) return { ok: false, configured: true, checked: 0, summary: `${cfg.exceptions}: invalid, nothing scanned`, problems };
  const r = scanSpelling(root, cfg, entries);
  for (const f of r.findings) problems.push(P(`${f.file}:${f.line}`, `American spelling "${f.us}" (British: "${f.gb}"); a name, title or protocol value spelled so by its owner goes in ${cfg.exceptions} with its reason`));
  for (const e of entries) if (!r.used.has(e.phrase)) problems.push(P(cfg.exceptions, `stale exception "${e.phrase}" (matches nothing in the content; remove it)`));
  if (!r.files) problems.push(P(cfg.paths.join(", "), "matches no file"));
  return { ok: !problems.length, configured: true, checked: r.files, summary: `${r.files} file${r.files === 1 ? "" : "s"} (${cfg.variant}); ${r.findings.length} American spelling${r.findings.length === 1 ? "" : "s"}, ${entries.length} exception${entries.length === 1 ? "" : "s"}`, problems };
}
