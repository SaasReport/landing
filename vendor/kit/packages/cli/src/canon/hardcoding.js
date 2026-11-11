/**
 * The hardcoding scan (docs/CONSTITUTION.md §4): string literals in code that carry a fact owned by config, the content
 * pack, the theme or the environment. Categories:
 *   project-name  a project's name, domain or resource prefix from the registry (packages/core/registry/projects.json)
 *   hex-colour    a #rgb / #rrggbb colour outside the theme token files (exclude them in kit.canon.json)
 *   project-url   an absolute URL on a project's domain
 *   copy-literal  reader-facing words in code: Arabic-script text, or English sentences inside HTML markup
 *   secret        something that looks like a credential (never printed; reported redacted)
 * Comments are not scanned. The package scope "@saasreport/" is the kit's own name, not a project's.
 *
 * Scope, the same for every repository (nothing is excluded per directory):
 *   test files        (test/, __tests__/, *.test.*) assert behaviour and do not ship: not scanned
 *   validated copy   a string that is a value inside data a `schemas` rule of kit.canon.json validates (module + export, loaded and
 *                     checked against its schema) is content, not hardcoding: the copy lives once, in validated data. The same text
 *                     written in code that no validated export holds is a finding
 *   token sources     the files named in canon.tokens.sources are the one place colours are written: no hex-colour findings there
 */
import { expand, matchesAny, readText, literals, isTestFile } from "./files.js";

export const CATEGORIES = ["project-name", "hex-colour", "project-url", "copy-literal", "secret"];
const CODE = /\.(m?js|cjs|ts|tsx|jsx)$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECRETS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["api-key", /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/],
  ["anthropic-or-openai-key", /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** Matchers built from the registry: names, aliases, domains, prefixes (incl. legacy). */
export function registryMatchers(registry) {
  const names = new Set(), domains = new Set(), prefixes = new Set();
  for (const p of registry?.projects || []) {
    names.add(p.name); for (const a of p.aliases || []) names.add(a);
    domains.add(p.domain);
    prefixes.add(p.prefix); if (p.short) prefixes.add(p.short);
  }
  for (const l of registry?.legacy || []) prefixes.add(l.prefix);
  const sortLen = (s) => [...s].sort((a, b) => b.length - a.length);
  return {
    name: new RegExp(`(?<![A-Za-z0-9])(${sortLen(names).map(esc).join("|")})(?![A-Za-z0-9])`),
    domain: new RegExp(`(?<![A-Za-z0-9.-])((?:[a-z0-9-]+\\.)*(?:${sortLen(domains).map(esc).join("|")}))(?![A-Za-z0-9-])`, "i"),
    url: new RegExp(`https?://(?:[a-z0-9-]+\\.)*(?:${sortLen(domains).map(esc).join("|")})(?:[/?#:][^\\s"'\`<>)]*)?`, "i"),
    prefix: new RegExp(`(?<![A-Za-z0-9@/_-])(${sortLen(prefixes).map(esc).join("|")})(?=[a-z0-9{$])`),
  };
}

const ARABIC_WORDS = /[\p{Script=Arabic}][\p{Script=Arabic}‌]*(?:[\s ]+[\p{Script=Arabic}][\p{Script=Arabic}‌]*)+/u;
const HTML_SENTENCE = />\s*([A-Z][a-z’']+(?:[  ][A-Za-z’',.:;!?-]+){3,})\s*</;
const HEX = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** The string a JavaScript literal's source text denotes (\n, \", \uXXXX …): what data holds when it carries the same text. */
export const unescapeJs = (v) => v.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|[\s\S])/g, (m, a, b, c, d) => (b ? String.fromCodePoint(parseInt(b, 16)) : c ? String.fromCharCode(parseInt(c, 16)) : d ? String.fromCharCode(parseInt(d, 16)) : ({ n: "\n", t: "\t", r: "\r", "\n": "" }[a] ?? a)));

/** Findings of one source text: [{ file, line, category, match }]. */
export function scanSource(file, src, matchers, categories = CATEGORIES, { covered = null } = {}) {
  const want = new Set(categories);
  const out = [];
  const lines = src.split("\n");
  // the line the literal sits on; a secret is never printed, so its line has every long token run redacted
  const add = (line, category, match) => { if (want.has(category)) { const text = (lines[line - 1] || "").trim().slice(0, 240); out.push({ file, line, category, match, context: category === "secret" ? text.replace(/[A-Za-z0-9_+/=-]{16,}/g, "<redacted>") : text }); } };
  for (const lit of literals(src)) {
    const v = lit.value.replace(/@saasreport\//g, "");
    if (/\b(import|from|require)\s*\(?\s*$/.test(lit.context)) continue;   // module specifiers
    const url = matchers && v.match(matchers.url);
    if (url) add(lit.line, "project-url", url[0]);
    if (matchers) {
      const m = v.match(matchers.name) || (!url && v.match(matchers.domain)) || v.match(matchers.prefix);
      if (m) add(lit.line, "project-name", m[1] || m[0]);
    }
    for (const h of new Set(v.match(HEX) || [])) add(lit.line, "hex-colour", h.toUpperCase());
    const ar = v.match(ARABIC_WORDS);
    const en = ar ? null : v.match(HTML_SENTENCE);
    if ((ar || en) && !covered?.has(unescapeJs(lit.value))) add(lit.line, "copy-literal", (ar ? ar[0] : en[1]).slice(0, 40));
    for (const [name, re] of SECRETS) if (re.test(v)) add(lit.line, "secret", `<redacted:${name}>`);
  }
  return out;
}

/** Scan the configured paths: { findings, allowed, stale } (stale = allow-list entries that match nothing). */
export function scanHardcoding(root, cfg = {}, { registry, allow = { entries: [] }, covered = () => null, tokenSources = [] } = {}) {
  const matchers = registry ? registryMatchers(registry) : null;
  const categories = cfg.categories?.length ? cfg.categories : CATEGORIES;
  const files = expand(root, cfg.paths || []).filter((f) => CODE.test(f) && !isTestFile(f));
  const all = [];
  for (const f of files) {
    const hexOk = matchesAny(f, tokenSources);
    for (const x of scanSource(f, readText(root, f), matchers, categories, { covered: covered(f) })) if (!(hexOk && x.category === "hex-colour")) all.push(x);
  }
  const entries = (allow.entries || []).map((e) => ({ ...e, used: 0 }));
  const findings = [], allowed = [];
  for (const x of all) {
    const e = entries.find((a) => a.category === x.category && a.file === x.file && a.match === x.match && x.context.includes(a.context));
    if (e) { e.used++; allowed.push({ ...x, reason: e.reason }); } else findings.push(x);
  }
  // colour-literal entries belong to kit check tokens (canon/tokens.js), finding:<class> entries to kit check findings (canon/findings.js), contrast
  // entries to the theme gate (theme-qa.js), not-deployed ones to the resilience scan (wrangler-config.js scanDeployments), project-prefix ones to the
  // value scan of packages/core/scripts/naming-families.mjs; each reports its own stale ones
  const stale = entries.filter((e) => !e.used && e.category !== "colour-literal" && e.category !== "contrast" && e.category !== "not-deployed" && e.category !== "project-prefix" && !e.category.startsWith("finding:"))
   .map(({ used, ...e }) => e);
  return { files: files.length, findings, allowed, stale };
}

/** Counts per category. */
export const countBy = (list, key = "category") => list.reduce((o, x) => ((o[x[key]] = (o[x[key]] || 0) + 1), o), {});
