/**
 * @saasreport/fa-lint — the mechanical Persian check (docs/PERSIAN.md): a JSON-Schema-validated rule pack (kit.fa-rules.v1),
 * a normalizer (ZWNJ, ی/ک, digits, spacing; parts from Virastar, MIT) and the engine behind `kit check persian` and the
 * podcast gate before TTS. Pure and dependency-free: Workers, Node ≥ 20, browsers.
 *
 *   import { persianLinter } from "@saasreport/fa-lint";
 *   const l = persianLinter({ classes: { brand: ["کی\u200Cوای\u200Cای"] } });
 *   l.lint("کی\u200Cوای\u200Cای پروتکل")   // → [{ rule: "fa-brand-before-head", severity: "error", suggestion: "پروتکل کی\u200Cوای\u200Cای", … }]
 */
import KIT_RULES from "../rules/kit.fa-rules.json" with { type: "json" };
import { compile, allowedFinding } from "./lint.js";

export { normalize, hasPersian, isArabic, FA_LETTERS, FA_MARKS, ZWNJ } from "./normalize.js";
export { compile, expand, mergeClasses, checkExamples, allowedFinding, spaces } from "./lint.js";
export { segments, plainText, rewriteSegments, kindOf } from "./extract.js";
export { safeFix, mask, unmask } from "./fix.js";
export { KIT_RULES };

/** The kit's pack plus a project's packs and classes, compiled. */
export const persianLinter = ({ packs = [], classes = {} } = {}) => compile([KIT_RULES, ...packs], classes);

/** One line per finding (every finding is an error: there is no warning level). */
export const formatFinding = (f, where = "") => `${where ? `${where}: ` : ""}${f.severity} ${f.rule}: «${f.match}» → «${f.suggestion}» (${f.context})`;

/**
 * A project's gate for podcast scripts, built from its own persian.config.json and rule packs: the same linter (pack, the
 * project's packs and classes) and the same allow-list as `kit check persian`, so CI and the runtime gate give identical
 * findings for the same script.
 *   const gate = projectGate({ config: persianConfig, packs: [projectPack] });
 *   gate(lines, { file: "podcast:<slug>" }) → { ok, findings, allowed }
 */
export function projectGate({ config = {}, packs = [], linter = null } = {}) {
  const l = linter || persianLinter({ packs, classes: config.classes || {} });
  return (lines, { file = "podcast:script" } = {}) => {
    const findings = [], allowed = [];
    (lines || []).forEach((line, i) => {
      for (const f of l.lint(line?.text ?? "", { register: "spoken" })) {
        const g = { ...f, file, line: i + 1, speaker: line?.speaker ?? null };
        const a = allowedFinding(config.allow, g);
        if (a) allowed.push(a); else findings.push(g);
      }
    });
    return { ok: findings.length === 0, findings, allowed };
  };
}

/**
 * The podcast gate with the kit's pack only (no project config): lint every line of a script (spoken register). → { ok, findings: [{ line, speaker, …finding }] }.
 * ok is false when any finding is an error: the episode is not voiced.
 */
export function checkScript(lines, linter = persianLinter()) {
  const findings = [];
  (lines || []).forEach((l, i) => { for (const f of linter.lint(l?.text ?? "", { register: "spoken" })) findings.push({ ...f, line: i + 1, speaker: l?.speaker ?? null }); });
  return { ok: findings.length === 0, findings };
}
