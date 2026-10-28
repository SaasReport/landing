/** Drill records (kit.drill.v1 inside resilience.json): a drill is real when its proof file exists and matches its sha256. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatProblems } from "@saasreport/core/schema";

/** Days a drill of each kind stays fresh. Fixed here: a project cannot lengthen them. */
export const MAX_AGE_DAYS = Object.freeze({ alert: 30, restore: 90, "tts-fallback": 90, "email-fallback": 90, signing: 365, publish: 30 });

/** Drill kinds whose proof file is a typed document (a bundled schema), not a log: the drill counts only when the proof IS that document, passed, and names the subject. */
export const PROOF_SCHEMAS = Object.freeze({ publish: "podcast-drill" });

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const daysBetween = (a, b) => Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** The newest passing drill of kind/subject whose proof still matches, and why none counts. → { drill } | { problem }. */
export function freshDrill(root, drills = [], kind, subject, today, { kit = null } = {}) {
  const mine = drills.filter((d) => d.kind === kind && d.subject === subject).sort((a, b) => b.date.localeCompare(a.date));
  if (!mine.length) return { problem: `no ${kind} drill recorded for ${subject} (kit resilience record-drill): none is a failure at t=0` };
  const d = mine[0];
  if (d.result !== "pass") return { problem: `the latest ${kind} drill for ${subject} (${d.date}) failed` };
  const age = daysBetween(d.date, today);
  if (age < 0) return { problem: `the ${kind} drill for ${subject} is dated ${d.date}, after today (${today})` };
  if (age > MAX_AGE_DAYS[kind]) return { problem: `the latest ${kind} drill for ${subject} is ${age} days old (limit ${MAX_AGE_DAYS[kind]})` };
  const proof = join(root, d.proof_path);
  if (!existsSync(proof)) return { problem: `${kind} drill proof ${d.proof_path} does not exist` };
  if (sha256File(proof) !== d.proof_sha256) return { problem: `${kind} drill proof ${d.proof_path} does not match its recorded sha256 (edited after the drill)` };
  if (PROOF_SCHEMAS[kind]) {
    if (!kit) return { problem: `${kind} drill proof ${d.proof_path} cannot be read as ${PROOF_SCHEMAS[kind]} without the kit's schemas (a typed proof is never taken on trust)` };
    let doc;
    try { doc = JSON.parse(readFileSync(proof, "utf8")); } catch (e) { return { problem: `${kind} drill proof ${d.proof_path} is not JSON: ${e.message}` }; }
    const bad = kit.validator.validate(doc, kit.byName(PROOF_SCHEMAS[kind]));
    if (bad.length) return { problem: `${kind} drill proof ${d.proof_path} is not kit.${PROOF_SCHEMAS[kind]}.v1: ${formatProblems(bad).slice(0, 3).join("; ")}` };
    if (doc.subject !== subject) return { problem: `${kind} drill proof ${d.proof_path} is for ${doc.subject}, not ${subject}` };
    if (doc.ok !== true) return { problem: `${kind} drill proof ${d.proof_path} records a failed drill (${doc.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")})` };
  }
  return { drill: d };
}

/** Append a drill to resilience.json (deterministic key order, trailing newline). The caller supplies the facts; nothing is invented. */
export function recordDrill(root, file, { kind, subject, date, result, proof }) {
  if (!(kind in MAX_AGE_DAYS)) throw new Error(`unknown drill kind "${kind}" (${Object.keys(MAX_AGE_DAYS).join(", ")})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("--date YYYY-MM-DD is required");
  if (!["pass", "fail"].includes(result)) throw new Error("--result pass|fail is required");
  if (!proof || !existsSync(join(root, proof))) throw new Error(`--proof <file> must exist (the log or export of the drill), got ${proof}`);
  const path = join(root, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.drills = [...(doc.drills || []), { kind, subject, date, result, proof_path: proof, proof_sha256: sha256File(join(root, proof)) }];
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return doc.drills.at(-1);
}
