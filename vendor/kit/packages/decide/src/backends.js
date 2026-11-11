/**
 * Backends: (state, questions) → { [questionId]: { [option]: probability } }.
 *
 * systemone — TypeSafe's System One API, POST {url}/v1/systemone. The same wire format is served by a local kev server
 *   (transformers + peft on CPU, CUDA or MLX), a Bev server (llama.cpp, ternary weights) and a hosted Jev, so one client
 *   covers the local, self-hosted, GPU and hosted tiers. choice → criteria {name: description}; noul → criteria
 *   {true, false}, answered as p(true) and returned here as { yes, no }.
 * fake — the config's fake table (question → option → probability), uniform where absent. For tests and CI, which
 *   have no model.
 */

function systemOneQuestion(q) {
  if (q.type === "noul") {
    const d = Object.fromEntries(q.options.map((o) => [o.name, o.description]));
    const criteria = {};
    if (d.yes) criteria.true = d.yes;
    if (d.no) criteria.false = d.no;
    return { type: "noul", instructions: q.instructions, ...(Object.keys(criteria).length ? { criteria } : {}) };
  }
  return { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.name, o.description])) };
}

/** The System One request body for a decide() request (exported for tests and for people debugging a server). */
export function systemOneBody(state, questions, model) {
  return { ...(model ? { model } : {}), state, questions: Object.fromEntries(questions.map((q) => [q.id, systemOneQuestion(q)])) };
}

/** System One answers → probabilities per option name. */
export function fromSystemOne(answers, questions) {
  const out = {};
  for (const q of questions) {
    const a = answers?.[q.id];
    if (!a) continue;
    if (q.type === "noul") {
      const y = Number(a.noul ?? a.probability);
      if (Number.isFinite(y)) out[q.id] = { yes: y, no: 1 - y };
    } else if (a.probabilities && typeof a.probabilities === "object") {
      out[q.id] = Object.fromEntries(q.options.map((o) => [o.name, Number(a.probabilities[o.name] ?? 0)]));
    }
  }
  return out;
}

function systemone(spec, { env, fetch, timeoutMs }) {
  const base = spec.url || (spec.urlEnv && env[spec.urlEnv]);
  return async (state, questions) => {
    if (!base) throw new Error(`no URL: set ${spec.urlEnv || "url"} for this backend`);
    const headers = { "content-type": "application/json" };
    const key = spec.apiKeyEnv && env[spec.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
    const ctl = timeoutMs ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${String(base).replace(/\/+$/, "")}/v1/systemone`, { method: "POST", headers, body: JSON.stringify(systemOneBody(state, questions, spec.model)), signal: ctl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return fromSystemOne(body.answers, questions);
    } catch (e) {
      throw new Error(e?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : e?.message || String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function fake(spec) {
  return async (_state, questions) => Object.fromEntries(questions.map((q) => {
    const table = spec.fake?.[q.id];
    const n = q.options.length;
    return [q.id, Object.fromEntries(q.options.map((o) => [o.name, table ? Number(table[o.name] ?? 0) : 1 / n]))];
  }));
}

const TYPES = { systemone, fake };

export function backendFor(spec, ctx) {
  const make = TYPES[spec.type];
  if (!make) throw new TypeError(`decide: unknown backend type "${spec.type}"`);
  return make(spec, ctx);
}
