/**
 * The rule engine: compile rule packs (kit.fa-rules.v1) with a project's classes, then lint a text segment.
 *
 *   const linter = compile([pack, projectPack], { brand: ["کی\u200Cوای\u200Cای"] });
 *   linter.lint(text, { register: "written" }) → [{ rule, severity, layer, match, suggestion, reason, line, index, autofix }]
 *     arabic: "skip" (default; an Arabic quotation is not Persian copy), "skip-broad" (a file mixing fa and ar strings) or
 *     "check" (isArabic in normalize.js)
 *   linter.fix(text, { register })             → text with every autofix rule applied (raw layer, until stable)
 *
 * Pattern tokens: {{fa}} one Persian letter or mark, {{<}} / {{>}} Persian word boundaries (ZWNJ counts as inside a word),
 * {{name}} a class (an alternation of its words, longest first; a space inside a word matches a space or a ZWNJ). A literal
 * space matches a space, a soft line break (U+2028) or U+202F (spaces()).
 * A rule that names a class with no words (a brand list the project did not supply) is inactive.
 * Pure: no I/O, runs in Workers, Node and browsers.
 */
import { normalize, isArabic, FA_LETTERS, FA_MARKS } from "./normalize.js";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (w) => esc(normalize(w)).replace(/ /g, "[ \\u200c]+");
const MACROS = {
  fa: `[${FA_LETTERS}${FA_MARKS}]`,
  "<": `(?<![${FA_LETTERS}${FA_MARKS}\\u200c])`,
  ">": `(?![${FA_LETTERS}${FA_MARKS}\\u200c])`,
};

/** Merge class maps: words are added (a project extends the pack's lexicon). */
export function mergeClasses(...maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m || {})) out[k] = [...new Set([...(out[k] || []), ...v])];
  return out;
}

/** Expand {{tokens}} in a pattern: { source, classes: [names used], empty: [names with no words] }. */
export function expand(pattern, classes) {
  const used = [], empty = [];
  const source = pattern.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
    if (name in MACROS) return MACROS[name];
    if (!(name in classes)) throw new Error(`unknown class {{${name}}}`);
    used.push(name);
    const words = [...classes[name]].sort((a, b) => b.length - a.length);
    if (!words.length) { empty.push(name); return "(?!)"; }
    return `(?:${words.map(word).join("|")})`;
  });
  return { source, classes: used, empty };
}

/**
 * A literal space in a pattern (outside a character class) matches any run-internal space the text can carry: a space, a
 * soft line break (U+2028, a Markdown line break inside a sentence) or a narrow no-break space, so a rule written with " "
 * also matches across those.
 */
export function spaces(source) {
  let out = "", cls = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { out += c + (source[i + 1] ?? ""); i++; continue; }
    if (c === "[") cls = true; else if (c === "]") cls = false;
    out += c === " " && !cls ? "[ \\u2028\\u202f]" : c;
  }
  return out;
}

/** Compile packs (later packs add rules; their classes merge) with extra classes from the project. */
export function compile(packs, extraClasses = {}) {
  const list = Array.isArray(packs) ? packs : [packs];
  const classes = mergeClasses(...list.map((p) => p.classes), extraClasses);
  const rules = [];
  const seen = new Set();
  for (const pack of list) {
    for (const r of pack.rules) {
      if (seen.has(r.id)) throw new Error(`rule ${r.id} is defined twice (pack ${pack.pack})`);
      seen.add(r.id);
      const p = expand(r.pattern, classes);
      const u = r.unless ? expand(r.unless, classes) : null;
      const b = r.unlessBefore ? expand(r.unlessBefore, classes) : null;
      rules.push({
        ...r, pack: pack.pack, inactive: p.empty.length > 0, empty: p.empty,
        re: new RegExp(spaces(p.source), "gu"),
        unlessRe: u ? new RegExp(`^(?:${spaces(u.source)})`, "u") : null,
        beforeRe: b ? new RegExp(`(?:${spaces(b.source)})$`, "u") : null,
        registers: r.registers || ["written", "spoken"],
      });
    }
  }
  return linter(rules, classes);
}

const applies = (r, register) => !r.inactive && r.registers.includes(register);

function matchesIn(r, text) {
  const out = [];
  r.re.lastIndex = 0;
  for (const m of text.matchAll(r.re)) {
    const end = m.index + m[0].length;
    if (r.unlessRe && r.unlessRe.test(text.slice(end, end + 200))) continue;
    if (r.beforeRe && r.beforeRe.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
    out.push(m);
  }
  return out;
}

/** The rule's fix with $& and $1…$9 taken from the match (lookarounds keep their context). */
const suggest = (r, m) => r.fix.replace(/\$(&|[1-9])/g, (_, k) => (k === "&" ? m[0] : m[Number(k)] ?? ""));

function linter(rules, classes) {
  /** Findings in one text segment. line: 0-based line offset of the match inside the segment. */
  function lint(text, { register = "written", only = null, arabic = "skip" } = {}) {
    const raw = String(text ?? "");
    if (arabic !== "check" && isArabic(raw, { broad: arabic === "skip-broad" })) return [];
    const norm = normalize(raw);
    const out = [];
    for (const r of rules) {
      if (!applies(r, register) || (only && !only.includes(r.id))) continue;
      const t = r.on === "raw" ? raw : norm;
      for (const m of matchesIn(r, t)) {
        out.push({
          rule: r.id, severity: r.severity, layer: r.layer, match: m[0], suggestion: suggest(r, m), reason: r.reason,
          index: m.index, line: (t.slice(0, m.index).match(/[\n\u2028]/g) || []).length, autofix: Boolean(r.autofix && r.on === "raw"),
          context: t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ").trim(),
        });
      }
    }
    // one place, one finding: two rules that flag the same text with the same fix (the list comma and the clause comma) report once, the first rule in pack order
    return out.filter((f, i) => !out.slice(0, i).some((g) => g.index === f.index && g.match === f.match && g.suggestion === f.suggestion));
  }
  /** Apply every autofix rule (raw layer) until the text stops changing. */
  function fix(text, { register = "written", arabic = "skip" } = {}) {
    let t = String(text ?? "");
    if (arabic !== "check" && isArabic(t, { broad: arabic === "skip-broad" })) return t;
    for (let pass = 0; pass < 5; pass++) {
      const before = t;
      for (const r of rules) {
        if (!r.autofix || r.on !== "raw" || !applies(r, register)) continue;
        const ms = matchesIn(r, t);
        for (const m of ms.reverse()) t = t.slice(0, m.index) + suggest(r, m) + t.slice(m.index + m[0].length);
      }
      if (t === before) break;
    }
    return t;
  }
  return { rules, classes, lint, fix };
}

/**
 * Run every rule's examples: each fail example must produce that rule's finding, each pass example must not, and a
 * recorded correction's before/after must be among them. → [problem strings] ([] = the pack proves itself).
 */
export function checkExamples(packs, extraClasses = {}) {
  const list = Array.isArray(packs) ? packs : [packs];
  const problems = [];
  const l = compile(list, mergeClasses(...list.map((p) => p.exampleClasses), extraClasses));
  for (const r of l.rules) {
    if (r.inactive) { problems.push(`${r.id}: inactive in its own examples (class ${r.empty.join(", ")} has no words; add exampleClasses)`); continue; }
    // every register the rule applies to (written copy and spoken scripts)
    for (const reg of r.registers) {
      for (const s of r.examples.fail) if (!l.lint(s, { register: reg, only: [r.id] }).length) problems.push(`${r.id} (${reg}): fail example passes: «${s}»`);
      for (const s of r.examples.pass) {
        const f = l.lint(s, { register: reg, only: [r.id] });
        if (f.length) problems.push(`${r.id} (${reg}): pass example fails on «${f[0].match}»: «${s}»`);
      }
    }
    const reg = r.registers[0];
    if (r.source.before && !r.examples.fail.includes(r.source.before)) problems.push(`${r.id}: source.before is not a fail example`);
    if (r.source.after && !r.examples.pass.includes(r.source.after)) problems.push(`${r.id}: source.after is not a pass example`);
    if (r.autofix) {
      for (const s of r.examples.fail) {
        const fixed = l.fix(s, { register: reg });
        if (l.lint(fixed, { register: reg, only: [r.id] }).length) problems.push(`${r.id}: autofix does not fix «${s}» (→ «${fixed}»)`);
      }
    }
  }
  return problems;
}

/**
 * A reviewed allow entry (persian.config.json "allow") covering a finding: same file, rule and matched text, and its context is in
 * the finding's context: one INSTANCE, never every occurrence in a file. A podcast script is built from the sources, so an entry
 * also covers the same place in a built script (file "podcast:<slug>"). The same function decides in CI (kit check persian) and
 * at runtime (the podcast gate).
 */
export const allowedFinding = (allow, f) => (allow || []).find((a) => (a.file === f.file || String(f.file || "").startsWith("podcast:")) && a.rule === f.rule && a.match === f.match && typeof a.context === "string" && String(f.context || "").includes(a.context));
