/**
 * evaluate(gate, cases, results, { bins }) → per-question accuracy and calibration, and what the gate saves.
 *
 * cases: kit.decide-eval.v1 cases ({ id, count?, labels }); results: decide() results in the same order.
 * Per question: accuracy of the best option over every case, coverage (share not escalated) and accuracy on the
 * covered cases, expected calibration error (equal-width bins over the best option's probability) and Brier score.
 * Gate: reads = items the big model would still read (weighted by count), avoided = items it would not, and
 * missed = items the labels say need a read but the gate let through (the costly error; it must stay at 0).
 */
import { mustRead } from "./gate.js";

const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function evaluate(gate, cases, results, { bins = 10 } = {}) {
  const questions = {};
  for (const q of gate.questions) {
    const rows = cases.map((c, i) => ({ truth: c.labels[q.id], a: results[i][q.id] })).filter((r) => r.truth != null && r.a);
    const n = rows.length;
    const covered = rows.filter((r) => !r.a.escalate);
    const bucket = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
    let brier = 0;
    for (const r of rows) {
      const b = bucket[Math.min(bins - 1, Math.floor(r.a.confidence * bins))];
      b.n++; b.conf += r.a.confidence; b.acc += r.a.best === r.truth ? 1 : 0;
      const names = Object.keys(r.a.probs);
      brier += names.reduce((s, k) => s + ((r.a.probs[k] ?? 0) - (k === r.truth ? 1 : 0)) ** 2, 0) + (names.includes(r.truth) ? 0 : 1);
    }
    const confusion = {};
    for (const r of rows) { const k = `${r.truth} -> ${r.a.best}`; confusion[k] = (confusion[k] || 0) + 1; }
    questions[q.id] = {
      n,
      accuracy: n ? r4(rows.filter((r) => r.a.best === r.truth).length / n) : null,
      coverage: n ? r4(covered.length / n) : null,
      coveredAccuracy: covered.length ? r4(covered.filter((r) => r.a.choice === r.truth).length / covered.length) : null,
      ece: n ? r4(bucket.reduce((s, b) => s + (b.n ? Math.abs(b.acc / b.n - b.conf / b.n) * b.n : 0), 0) / n) : null,
      brier: n ? r4(brier / n) : null,
      confusion,
    };
  }
  let events = 0, reads = 0, avoided = 0, missed = 0, escalated = 0;
  const missedIds = [];
  cases.forEach((c, i) => {
    const w = c.count || 1;
    const read = mustRead(gate, results[i]);
    const truthRead = gate.readWhen.some((r) => r.in.includes(c.labels[r.question]));
    events += w;
    if (Object.values(results[i]).some((a) => a.escalate)) escalated += w;
    if (read) reads += w; else avoided += w;
    if (truthRead && !read) { missed += w; missedIds.push(c.id); }
  });
  const ms = results.map((r) => Object.values(r)[0]?.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const pct = (p) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]) : null);
  return { questions, gate: { events, reads, avoided, escalated, missed, missedIds }, latencyMs: { requests: ms.length, p50: pct(0.5), p90: pct(0.9), max: ms.length ? Math.round(ms[ms.length - 1]) : null } };
}
