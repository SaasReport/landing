/** Gates (kit.decide-gate.v1): which answers send an item to the big model. */

/** Whether a gate says the big model must read this item: any escalation, or an answer listed in gate.readWhen. */
export function mustRead(gate, result) {
  if (Object.values(result).some((a) => a.escalate)) return true;
  return gate.readWhen.some((r) => r.in.includes(result[r.question]?.choice));
}

/** Run a gate (kit.decide-gate.v1) on one state: { result, read }. */
export async function runGate(decide, gate, state, opts) {
  const result = await decide({ state, questions: gate.questions }, opts);
  return { result, read: mustRead(gate, result) };
}

