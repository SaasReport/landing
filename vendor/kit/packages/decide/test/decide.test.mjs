// @saasreport/decide without a model (CI has none): a stub System One server stands in for kev / Bev / Jev, and the
// fake backend for "no model at all". Requests and results are validated against the kit.decision.v1 contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator } from "@saasreport/core/schema";
import { createDecider, normalizeQuestion, mustRead, evaluate, ESCALATE } from "../src/index.js";
import { systemOneBody } from "../src/backends.js";
import { main } from "../../cli/src/index.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const contract = read("../contracts/decision.schema.json");
const schemas = ["../schemas/decide-config.schema.json", "../schemas/decide-gate.schema.json", "../schemas/decide-eval.schema.json"].map(read);
const v = createValidator([contract, ...schemas]);
const id = (title) => [contract, ...schemas].find((s) => s.title === title).$id;
const config = read("../decide.config.json");
const gate = read("../gates/notification-triage.json");
const evalSet = read("../eval/notification-triage.json");

/** A System One server that answers by rule, so the pipeline can be checked end to end without a model. */
function stubServer({ status = 200, delay = 0, seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    if (delay) await new Promise((r, j) => { const t = setTimeout(r, delay); init.signal?.addEventListener("abort", () => { clearTimeout(t); j(Object.assign(new Error("aborted"), { name: "AbortError" })); }); });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const { state, questions } = JSON.parse(init.body);
    const ev = state?.event || "";
    const kind = ev.startsWith("check_run") ? (state.data?.conclusion === "failure" ? "ci_failed" : "ci_passed") : ev.startsWith("check_suite") ? "ci_passed"
      : ev === "pull_request.closed" ? "merged" : /mergeable|pr_status|synchronize/.test(ev) ? "conflict" : /comment|review\.submitted/.test(ev) ? "review_comment" : "subscription_noise";
    const act = ["ci_failed", "conflict", "review_comment"].includes(kind), owner = ["merged", "review_comment"].includes(kind);
    const answers = {};
    for (const [qid, q] of Object.entries(questions)) {
      if (q.type === "noul") answers[qid] = { type: "noul", noul: qid === "needs_action" ? (act ? 0.93 : 0.04) : qid === "owner_attention" ? (owner ? 0.9 : 0.08) : 0.5 };
      else { const names = Object.keys(q.criteria); const p = Object.fromEntries(names.map((n) => [n, n === kind ? 0.9 : 0.1 / (names.length - 1)])); answers[qid] = { type: "choice", choice: kind, probabilities: p }; }
    }
    return { ok: true, status: 200, json: async () => ({ model: "stub", answers }) };
  };
}

test("bundled config, gate and eval set are valid against their schemas", () => {
  assert.deepEqual(v.validate(config, id("kit.decide-config.v1")), []);
  assert.deepEqual(v.validate(gate, id("kit.decide-gate.v1")), []);
  assert.deepEqual(v.validate(evalSet, id("kit.decide-eval.v1")), []);
  assert.ok(v.validate({ ...config, threshold: 1.5 }, id("kit.decide-config.v1")).length, "threshold above 1 rejected");
  assert.ok(v.validate({ ...config, backends: { x: { type: "systemone", tier: "gpu" } } }, id("kit.decide-config.v1")).length, "systemone needs url or urlEnv");
  for (const c of evalSet.cases) for (const q of gate.questions) assert.ok(Array.isArray(q.options) ? q.options.includes(c.labels[q.id]) : c.labels[q.id] in q.options, `${c.id}: label ${q.id}=${c.labels[q.id]} is an option`);
});

test("eval set: transcript cases carry only kind + payload, pseudonymised", () => {
  const t = evalSet.cases.filter((c) => c.source === "transcript");
  assert.ok(t.length > 300);
  for (const c of t) {
    assert.deepEqual(Object.keys(c.state).sort(), ["data", "event"]);
    if (c.state.data.pr) assert.match(c.state.data.pr, /^owner-\d+\/repo-\d+#\d+$/);
    assert.doesNotMatch(JSON.stringify(c.state), /<!--|You are now subscribed|github\.com\/(?!owner-)/);
  }
});

test("questions: normalised, reserved and malformed options refused", () => {
  assert.deepEqual(normalizeQuestion({ id: "a", options: ["x", "y"] }).options, [{ name: "x", description: "" }, { name: "y", description: "" }]);
  assert.throws(() => normalizeQuestion({ id: "a", options: [ESCALATE, "y"] }), /reserved/);
  assert.throws(() => normalizeQuestion({ id: "a", type: "noul", options: ["x", "y"] }), /yes and no/);
  assert.throws(() => normalizeQuestion({ id: "a", options: [] }), /no options/);
});

test("systemone: request mapped to System One, answers to probabilities, key from env never in the body", async () => {
  const seen = [];
  const cfg = { ...config, backends: { ...config.backends, s: { type: "systemone", tier: "hosted", urlEnv: "S_URL", apiKeyEnv: "S_KEY", model: "m" } } };
  const decide = createDecider({ config: cfg, backend: "s", env: { S_URL: "http://stub.test/", S_KEY: "k-123" }, fetch: stubServer({ seen }) });
  const request = { state: { event: "check_run.completed", data: { conclusion: "failure" } }, questions: gate.questions };
  const r = await decide(request);
  assert.deepEqual(v.validate({ request, result: r }, id("kit.decision.v1")), []);
  assert.equal(seen[0].url, "http://stub.test/v1/systemone");
  assert.equal(seen[0].init.headers.authorization, "Bearer k-123");
  assert.doesNotMatch(seen[0].init.body, /k-123/);
  assert.equal(seen[0].body.model, "m");
  assert.equal(seen[0].body.questions.kind.type, "choice");
  assert.equal(seen[0].body.questions.needs_action.type, "noul");
  assert.ok(seen[0].body.questions.needs_action.criteria.true);
  assert.equal(r.kind.choice, "ci_failed");
  assert.equal(r.needs_action.choice, "yes");
  assert.equal(r.owner_attention.choice, "no");
  assert.ok(Math.abs(r.needs_action.probs.yes + r.needs_action.probs.no - 1) < 1e-9);
  assert.equal(mustRead(gate, r), true);
});

test("threshold: question > backend > config; below it the answer is escalate with the best option kept", async () => {
  const cfg = { ...config, threshold: 0.95, backends: { s: { type: "systemone", tier: "local-cpu", url: "http://stub.test" } } };
  const decide = createDecider({ config: cfg, backend: "s", fetch: stubServer() });
  const state = { event: "pull_request.closed", data: { outcome: "merged" } };
  const questions = gate.questions.map(({ threshold, ...q }) => q);
  const r = await decide({ state, questions });
  assert.equal(r.kind.choice, ESCALATE);
  assert.equal(r.kind.best, "merged");
  assert.match(r.kind.reason, /below 0.95/);
  const r2 = await decide({ state, questions: questions.map((q) => ({ ...q, threshold: 0.6 })) });
  assert.equal(r2.kind.choice, "merged");
  assert.equal(mustRead(gate, r2), false);
  const cfg3 = { ...cfg, backends: { s: { ...cfg.backends.s, threshold: 0.5 } } };
  assert.equal((await createDecider({ config: cfg3, backend: "s", fetch: stubServer() })({ state, questions })).kind.choice, "merged");
});

test("failure is safe: HTTP error, timeout, missing URL and the fake backend all escalate every question", async () => {
  const req = { state: "x", questions: gate.questions };
  const s = { type: "systemone", tier: "local-cpu", url: "http://stub.test" };
  for (const [cfg, fetch, why] of [
    [{ ...config, backends: { s } }, stubServer({ status: 503 }), /HTTP 503/],
    [{ ...config, timeoutMs: 20, backends: { s } }, stubServer({ delay: 200 }), /timed out/],
    [{ ...config, backends: { s: { type: "systemone", tier: "gpu", urlEnv: "NOPE_URL" } } }, stubServer(), /NOPE_URL/],
    [{ ...config, backends: { s } }, async () => { throw new Error("ECONNREFUSED"); }, /ECONNREFUSED/],
  ]) {
    const r = await createDecider({ config: cfg, backend: "s", env: {}, fetch })(req);
    for (const a of Object.values(r)) { assert.equal(a.choice, ESCALATE); assert.equal(a.best, null); assert.match(a.reason, why); }
    assert.deepEqual(v.validate({ request: req, result: r }, id("kit.decision.v1")), []);
    assert.equal(mustRead(gate, r), true);
  }
  const f = await createDecider({ config, backend: "fake" })(req);
  assert.ok(Object.values(f).every((a) => a.escalate));
});

test("evaluate: the whole bundled eval set through the stub server; accuracy, calibration, reads avoided, none missed", async () => {
  const decide = createDecider({ config: { ...config, backends: { s: { type: "systemone", tier: "test", url: "http://stub.test" } } }, backend: "s", fetch: stubServer() });
  const results = [];
  for (const c of evalSet.cases) results.push(await decide({ state: c.state, questions: gate.questions }));
  const m = evaluate(gate, evalSet.cases, results);
  assert.equal(m.questions.kind.accuracy, 1);
  assert.equal(m.questions.needs_action.coverage, 1);
  assert.ok(m.questions.kind.ece < 0.11 && m.questions.kind.brier < 0.03);
  const total = evalSet.cases.reduce((s, c) => s + (c.count || 1), 0);
  const act = evalSet.cases.filter((c) => c.labels.needs_action === "yes").reduce((s, c) => s + (c.count || 1), 0);
  assert.deepEqual([m.gate.events, m.gate.reads, m.gate.avoided, m.gate.missed], [total, act, total - act, 0]);
});

test("evaluate: a missed read and calibration error are counted", () => {
  const g = { questions: [{ id: "q", options: ["a", "b"] }], readWhen: [{ question: "q", in: ["a"] }] };
  const cases = [{ id: "1", labels: { q: "a" } }, { id: "2", labels: { q: "b" }, count: 3 }];
  const res = [{ q: { choice: "b", best: "b", probs: { a: 0.1, b: 0.9 }, confidence: 0.9, escalate: false } }, { q: { choice: "b", best: "b", probs: { a: 0.1, b: 0.9 }, confidence: 0.9, escalate: false } }];
  const m = evaluate(g, cases, res);
  assert.equal(m.questions.q.accuracy, 0.5);
  assert.equal(m.questions.q.ece, 0.4);
  assert.deepEqual([m.gate.events, m.gate.avoided, m.gate.missed, m.gate.missedIds], [4, 4, 1, ["1"]]);
});

test("kit decide: one state and an eval run, through an injected server", async () => {
  const lines = [], errs = [];
  // the default backend's URL comes from the project's environment (L15: no project's URL in the kit)
  const io = { out: (s) => lines.push(s), err: (s) => errs.push(s), fetch: stubServer(), env: { KIT_DECIDE_URL: "http://stub.test", KIT_DECIDE_KEY: "k" } };
  const state = new URL("./fixture-event.json", import.meta.url).pathname;
  assert.equal(await main(["decide", "--gate", "notification-triage", "--state", state, "--json"], io), 0, errs.join("\n"));
  const out = JSON.parse(lines.join("\n"));
  assert.equal(out.read, true);
  assert.equal(out.result.kind.choice, "ci_failed");
  lines.length = 0;
  const cases = new URL("../eval/notification-triage.json", import.meta.url).pathname;
  assert.equal(await main(["decide", "eval", "--gate", "notification-triage", "--cases", cases, "--limit", "20", "--json"], io), 0, errs.join("\n"));
  assert.equal(JSON.parse(lines.join("\n")).questions.kind.accuracy, 1);
  assert.equal(await main(["decide", "--gate", "nope", "--state", state], io), 1);
  assert.equal(await main(["decide", "--gate", "notification-triage", "--state", state, "--backend", "nope"], io), 1);
});

test("L15: the kit's decide config names no project's deployment: the default backend reads its URL from KIT_DECIDE_URL", () => {
  const text = readFileSync(new URL("../decide.config.json", import.meta.url), "utf8");
  assert.doesNotMatch(text, /saasreport-decide\.|workers\.dev|"url": "https:/);
  const d = JSON.parse(text);
  assert.equal(d.backends[d.backend].urlEnv, "KIT_DECIDE_URL");
});

test("systemOneBody: noul without descriptions sends no criteria (Bev's strict schema accepts it)", () => {
  const b = systemOneBody("s", [normalizeQuestion({ id: "x", type: "noul", options: ["yes", "no"] })]);
  assert.deepEqual(b.questions.x, { type: "noul", instructions: "" });
});

test("saasreport-decide Worker guard: the request body is capped while it streams, before the container sees a byte; the key header never goes on", async () => {
  const { forwardable, MAX_BODY_BYTES } = await import("../deploy/saasreport-decide/src/guard.js");
  const mk = (body, headers = {}) => new Request("https://d.example/v1/systemone", { method: "POST", body, headers: { authorization: "Bearer k", "content-type": "application/json", ...headers }, duplex: "half" });
  const ok = await forwardable(mk('{"a":1}'));
  assert.equal(await ok.request.text(), '{"a":1}'); assert.equal(ok.request.headers.get("authorization"), null);
  assert.equal(ok.request.headers.get("content-length"), "7");
  const over = await forwardable(mk("x".repeat(MAX_BODY_BYTES + 1)));
  assert.equal(over.response.status, 413); assert.equal(over.request, undefined);
  let pulled = 0;
  const endless = await forwardable(mk(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(65536)); } })));
  assert.equal(endless.response.status, 413); assert.ok(pulled <= MAX_BODY_BYTES / 65536 + 3, `pulled ${pulled}`);
  const lying = await forwardable(mk(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }), { "content-length": "10" }));
  assert.equal(lying.response.status, 400);
  const get = await forwardable(new Request("https://d.example/health", { headers: { authorization: "Bearer k" } }));
  assert.equal(get.request.headers.get("authorization"), null);
});
