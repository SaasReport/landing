// The contract and the code agree both ways; the limits are one fact; nothing secret ships.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { contract, root, problemsOf } from "./helpers.mjs";
import { ROUTES, SERVED, handlers } from "../src/worker.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const operations = Object.entries(contract.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), path, id: item[m].operationId })));

test("every operation of the contract is a route of the Worker, and every route is in the contract", () => {
  const inContract = operations.map((o) => `${o.method} ${o.path} ${o.id}`).sort();
  const inCode = ROUTES.map(([m, p, id]) => `${m} ${p} ${id}`).sort();
  assert.deepEqual(inCode, inContract);
});

test("every operationId has exactly one handler, and a handler exists for nothing else", () => {
  assert.deepEqual(Object.keys(handlers).sort(), operations.map((o) => o.id).sort());
});

test("every operation is read-only except the guard, which stores nothing", () => {
  assert.deepEqual(operations.filter((o) => o.method !== "GET").map((o) => o.id), ["checkNarrative"]);
});

test("every operation declares the 429 and 503 problems and a 2xx; every error is the one problem schema", () => {
  for (const o of operations) {
    const responses = contract.paths[o.path][o.method.toLowerCase()].responses;
    assert.ok(Object.keys(responses).some((s) => /^2/.test(s)), `${o.id}: no 2xx`);
    for (const s of ["429", "503"]) assert.ok(responses[s], `${o.id}: no ${s}`);
  }
  for (const [name, r] of Object.entries(contract.components.responses)) {
    assert.equal(r.content["application/problem+json"].schema.$ref, "#/components/schemas/Problem", name);
  }
});

test("the registries the API serves are exactly the contract's list, and each has a core registry and schema", () => {
  assert.deepEqual(SERVED, ["stakeholders", "metrics", "report-types", "cadences", "findings", "commitments", "roles", "currencies"]);
  assert.equal(new Set(SERVED).size, SERVED.length);
});

test("the rate limit of the wrangler config is the contract's x-limits.rate", () => {
  const toml = readFileSync(new URL("workers/api/wrangler.toml", root), "utf8");
  const m = toml.match(/simple\s*=\s*\{\s*limit\s*=\s*(\d+)\s*,\s*period\s*=\s*(\d+)\s*\}/);
  assert.ok(m, "no ratelimits simple = { limit, period } in wrangler.toml");
  assert.equal(Number(m[1]), contract["x-limits"].rate.limit);
  assert.equal(Number(m[2]), contract["x-limits"].rate.period_seconds);
  assert.match(toml, /name\s*=\s*"RATE_LIMITER"/);
  assert.equal(contract["x-limits"].rate.binding, "RATE_LIMITER");
});

test("the Worker config follows the naming registry and uses no Node compatibility", () => {
  const toml = readFileSync(new URL("workers/api/wrangler.toml", root), "utf8");
  assert.match(toml, /^name = "saasreport-api-production"$/m);
  assert.doesNotMatch(toml, /nodejs_compat/);
  assert.match(toml, /^routes = \[\{ pattern = "api\.saasreport\.ai\/\*", zone_name = "saasreport\.ai" \}\]$/m, "a route on the zone, not a custom-domain create");
  assert.doesNotMatch(toml, /custom_domain/);
  assert.doesNotMatch(toml, /\[\[(kv_namespaces|d1_databases|r2_buckets)\]\]/, "the API holds no storage");
});

test("the Worker source uses no Node API, no process, no eval and no mailto", () => {
  for (const f of readdirSync(new URL("workers/api/src/", root)).filter((n) => n.endsWith(".js") && !n.startsWith("data.generated"))) {
    const src = readFileSync(new URL(`workers/api/src/${f}`, root), "utf8");
    assert.doesNotMatch(src, /from\s+["']node:/, f);
    assert.doesNotMatch(src, /\bprocess\.|require\(|new Function|\beval\(/, f);
    assert.doesNotMatch(src, /mailto:/i, f);
  }
});

test("no secret and no mailto in the contract, the Worker files or the generated SDK", () => {
  const files = ["contracts/api.openapi.json", "workers/api/wrangler.toml", ...["src/worker.js", "src/engine.js"].map((f) => `workers/api/${f}`),
    ...readdirSync(new URL("sdk/saasreport/", root)).filter((n) => /\.(mjs|ts|json|md)$/.test(n)).map((n) => `sdk/saasreport/${n}`)];
  for (const f of files) {
    const text = readFileSync(new URL(f, root), "utf8");
    assert.doesNotMatch(text, /mailto:/i, f);
    assert.doesNotMatch(text, /\b(sk|rk|pk)_(live|test)_\w{8,}|whsec_\w{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bAKIA[0-9A-Z]{16}\b|\bghp_\w{20,}/, f);
    assert.doesNotMatch(text, /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, `${f} holds an email address`);
  }
});

test("the contract examples are valid against the contract's own schemas", () => {
  const sample = { text: "Net revenue retention was 104% last month.", facts: ["104%"] };
  assert.deepEqual(problemsOf(sample, "GuardRequest"), []);
  assert.deepEqual(problemsOf({ commit: null }, "Build"), []);
  assert.notDeepEqual(problemsOf({ text: 1, facts: [] }, "GuardRequest"), []);
  assert.notDeepEqual(problemsOf({ type: "x", title: "t", status: 200 }, "Problem"), []);
});
