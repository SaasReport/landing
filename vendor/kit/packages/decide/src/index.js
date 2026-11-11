/**
 * @saasreport/decide — typed decisions on a small local model, so the big model only reads what needs it.
 *
 *   const decide = createDecider({ config });            // config: decide.config.json (kit.decide-config.v1)
 *   const r = await decide({ state, questions: [{ id: "kind", options: { merged: "…", ci_failed: "…" } }] });
 *   r.kind → { choice: "merged" | "escalate", best, probs: { merged: 0.97, … }, confidence, escalate, backend, ms }
 *
 * One request is one System One call: the state is read once, every question is scored over its own options in a
 * single forward pass (no generation). A question escalates (choice "escalate") when its best option's probability is
 * below the threshold (question > backend > config), and every question escalates when the backend fails or times
 * out: the caller then falls back to the big model, so a broken or absent model costs tokens, never correctness.
 * Contract: contracts/decision.schema.json (kit.decision.v1). No dependencies; Node ≥ 20, Workers, browsers.
 */
import { backendFor } from "./backends.js";

export const ESCALATE = "escalate";

/** Normalise a question: options as [{ name, description }], type choice | noul. */
export function normalizeQuestion(q) {
  if (!q || typeof q.id !== "string" || !q.id) throw new TypeError("decide: every question has an id");
  const type = q.type || "choice";
  if (type !== "choice" && type !== "noul") throw new TypeError(`decide: question ${q.id}: type is choice or noul`);
  const entries = Array.isArray(q.options) ? q.options.map((n) => [n, ""]) : Object.entries(q.options || {});
  if (!entries.length) throw new TypeError(`decide: question ${q.id} has no options`);
  if (entries.some(([n]) => n === ESCALATE)) throw new TypeError(`decide: question ${q.id}: "${ESCALATE}" is reserved`);
  if (type === "noul" && (entries.length !== 2 || !entries.some(([n]) => n === "yes") || !entries.some(([n]) => n === "no")))
    throw new TypeError(`decide: noul question ${q.id} has exactly the options yes and no`);
  return { id: q.id, type, instructions: q.instructions || "", options: entries.map(([name, description]) => ({ name, description: description || "" })), threshold: q.threshold };
}

/** probs → the answer for one question: escalate below the threshold or on a tie for first place. */
export function answer(probs, threshold, extra = {}) {
  let best = null, p = -1;
  for (const [k, v] of Object.entries(probs)) if (v > p) { best = k; p = v; }
  const tie = Object.entries(probs).some(([k, v]) => k !== best && v === p);
  const escalate = tie || !(p >= threshold);
  const reason = tie ? `tie at ${p.toFixed(3)}` : `confidence ${p.toFixed(3)} below ${threshold}`;
  return { choice: escalate ? ESCALATE : best, best, probs, confidence: Math.max(0, p), escalate, ...(escalate ? { reason } : {}), ...extra };
}

function failed(questions, reason, extra) {
  return Object.fromEntries(questions.map((q) => [q.id, { choice: ESCALATE, best: null, probs: {}, confidence: 0, escalate: true, reason, ...extra }]));
}

/**
 * createDecider({ config, backend?, env?, fetch?, now? }) → decide(request, { backend? }) → result
 * `config` is the parsed decide.config.json; `backend` names one of config.backends (default config.backend).
 */
export function createDecider({ config, backend: defaultName, env = globalThis.process?.env || {}, fetch = (...a) => globalThis.fetch(...a), now = () => Date.now() } = {}) {
  if (!config?.backends) throw new TypeError("decide: a config (kit.decide-config.v1) is required");
  return async function decide(request, { backend: name = defaultName || config.backend } = {}) {
    const spec = config.backends[name];
    if (!spec) throw new TypeError(`decide: no backend "${name}" in the config`);
    const questions = (request?.questions || []).map(normalizeQuestion);
    if (!questions.length) throw new TypeError("decide: at least one question");
    if (new Set(questions.map((q) => q.id)).size !== questions.length) throw new TypeError("decide: question ids are unique");
    const run = backendFor(spec, { env, fetch, timeoutMs: config.timeoutMs });
    const t0 = now();
    let probs;
    try {
      probs = await run(request.state, questions);
    } catch (e) {
      return failed(questions, `backend ${name} failed: ${e?.message || e}`, { backend: name, ms: now() - t0 });
    }
    const ms = now() - t0;
    const out = {};
    for (const q of questions) {
      const p = probs[q.id];
      if (!p) { out[q.id] = failed([q], `backend ${name} returned no answer for ${q.id}`, { backend: name, ms })[q.id]; continue; }
      out[q.id] = answer(p, q.threshold ?? spec.threshold ?? config.threshold, { backend: name, ms });
    }
    return out;
  };
}

export { mustRead, runGate } from "./gate.js";
export { backendFor } from "./backends.js";
export { evaluate } from "./eval.js";
