// Deterministic guard for AI prose. The model writes words; every number in them must be one the engine
// computed. A narrative that contains any other number is rejected, never repaired.

const NUMBER = /(?<![\w.])[$€£]?\d[\d,]*(?:\.\d+)?%?/g;
const tokens = (text) => (String(text).match(NUMBER) ?? []).map((t) => t.replace(/[.,]+$/, ""));

/**
 * @param {string} narrative text from the model
 * @param {string[]} facts strings the engine produced (formatted metric values, period labels, counts)
 * @returns {{ok: boolean, unsupported: string[]}}
 */
export function verifyNarrative(narrative, facts) {
  const allowed = new Set(facts.flatMap(tokens));
  const unsupported = [...new Set(tokens(narrative).filter((t) => !allowed.has(t)))];
  return { ok: unsupported.length === 0, unsupported };
}
