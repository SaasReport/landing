/**
 * The Persian gate before TTS (docs/PERSIAN.md): on a Persian site (site.locale fa) every script is linted with the kit's
 * Persian rule pack (@saasreport/fa-lint, spoken register) before a single second of audio is synthesised. A script with an
 * error is not voiced: the episode fails with the findings in its error ("persian: …"), the cron re-queues it, and a model
 * script (an article episode) is rewritten with those findings fed back (articleScript's repair prompt).
 *
 *   const gate = persianGate(config);     // null when the site is not Persian
 *   gate(lines) → { ok, findings }
 */
import { projectGate } from "@saasreport/fa-lint";

export const PERSIAN_ERROR = "persian:";

const isPersian = (config) => String(config?.site?.locale || "").toLowerCase().split(/[-_]/)[0] === "fa";

const gates = new WeakMap();
/**
 * persian: the project's own { config: persian.config.json, packs: [its rule packs] }, bundled into the Worker (createKit
 * option `persian`), so the runtime gate has the same brand list, classes, packs and allow-list as `kit check persian`.
 * Without it the kit's pack alone runs (no brand rule, no allow-list).
 */
export function persianGate(config, persian = null) {
  if (!isPersian(config) || persian === false) return null;
  const key = persian || gates;
  if (!gates.has(key)) gates.set(key, projectGate(persian || {}));
  const gate = gates.get(key);
  return (lines, slug = "script") => gate(lines, { file: `podcast:${slug}` });
}

/** Findings as the lines a model (or an editor) reads: "line 3: fa-comma-before-conj «، » → « » (…context…)". */
export function findingsText(findings, max = 12) {
  const errs = findings;
  return errs.slice(0, max).map((f) => `line ${f.line}: ${f.rule} «${f.match}» → «${f.suggestion}» (${f.context})`).join("\n") + (errs.length > max ? `\n… ${errs.length - max} more` : "");
}

/** The episode error for a failed gate (kept by a re-queue, read back as feedback). */
export const persianError = (findings) => `${PERSIAN_ERROR} ${findings.length} findings before TTS\n${findingsText(findings)}`;

/** Findings fed back from a previous run's error, or null. */
export const feedbackOf = (error) => (typeof error === "string" && error.startsWith(PERSIAN_ERROR) ? error.slice(error.indexOf("\n") + 1) : null);
