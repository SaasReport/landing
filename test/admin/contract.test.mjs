// The contract and the Worker agree, both ways, and the contract keeps the promises the design makes (one security scheme, every mutation
// guarded, the audit log without a write route).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTRACT, operations } from "../../workers/admin/src/contract.js";
import { ROUTES } from "../../workers/admin/src/routes.js";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { schemaDocument } from "../../workers/admin/src/contract.js";

const ROOT = new URL("../../", import.meta.url);
const ops = operations();

test("every operation of the contract has a route, and every route has an operation (method, path and operationId)", () => {
  const fromContract = ops.map((o) => `${o.method} ${o.path} ${o.operationId}`).sort();
  const fromRoutes = ROUTES.map(([m, p, id]) => `${m} ${p} ${id}`).sort();
  assert.deepEqual(fromRoutes, fromContract);
  for (const [, , id, handler] of ROUTES) if (id !== "getBuild") assert.equal(typeof handler, "function", `${id} has a handler`);
});

test("operation ids are unique and written in camelCase", () => {
  const ids = ops.map((o) => o.operationId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z]+$/);
});

test("one security scheme, cfAccess, on every operation but the kit's /api/build", () => {
  assert.deepEqual(Object.keys(CONTRACT.components.securitySchemes), ["cfAccess"]);
  assert.deepEqual(CONTRACT.security, [{ cfAccess: [] }]);
  assert.equal(CONTRACT.components.securitySchemes.cfAccess.name, "Cf-Access-Jwt-Assertion");
  for (const [path, item] of Object.entries(CONTRACT.paths)) for (const [m, op] of Object.entries(item)) {
    if (path === "/api/build") assert.deepEqual(op.security, [], "the build route is the only public one");
    else assert.equal(op.security, undefined, `${m} ${path} inherits cfAccess`);
  }
});

test("every operation but the public one answers 401, 403 and 503; every mutation also documents its refusals", () => {
  for (const [path, item] of Object.entries(CONTRACT.paths)) for (const [m, op] of Object.entries(item)) {
    if (path === "/api/build") continue;
    for (const c of ["401", "403", "503"]) assert.ok(op.responses[c], `${m} ${path} documents ${c}`);
    if (m !== "get") {
      assert.ok(op.responses["400"], `${m} ${path} documents 400`);
      if (op.requestBody) {
        assert.deepEqual(Object.keys(op.requestBody.content), ["application/json"], "a body is JSON only");
        for (const c of ["411", "413", "415"]) assert.ok(op.responses[c], `${m} ${path} documents ${c}`);
      }
    }
  }
});

test("the audit log has no write operation in the contract", () => {
  assert.deepEqual(Object.keys(CONTRACT.paths["/api/audit"]), ["get"]);
  assert.equal(ops.filter((o) => /audit/i.test(o.path) && o.mutating).length, 0);
});

test("a mutation that changes a stored thing takes an Idempotency-Key (required where the engine is called)", () => {
  const key = (id) => { for (const item of Object.values(CONTRACT.paths)) for (const op of Object.values(item)) if (op.operationId === id) return (op.parameters || []).find((p) => p.name === "Idempotency-Key"); };
  assert.equal(key("retryDelivery").required, true);
  for (const id of ["updateLead", "addSuppression", "removeSuppression"]) assert.equal(key(id).required, false, id);
});

test("every schema is JSON Schema 2020-12 the kit validator accepts, and every local $ref resolves", () => {
  assert.equal(CONTRACT.jsonSchemaDialect, "https://json-schema.org/draft/2020-12/schema");
  assert.doesNotThrow(() => createValidator([schemaDocument(["LeadUpdate", "SuppressionAdd"])]));
  const refs = new Set();
  const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/")) refs.add(v); else walk(v); } };
  walk(CONTRACT);
  for (const r of refs) { const [, , kind, name] = r.split("/"); assert.ok(CONTRACT.components[kind]?.[name], `${r} resolves`); }
});

test("request schemas refuse what the design forbids: unknown fields, an empty update, a status outside the list", async () => {
  const { problems } = await import("../../workers/admin/src/contract.js");
  assert.ok(problems("LeadUpdate", {}).length);
  assert.ok(problems("LeadUpdate", { status: "won", extra: 1 }).length);
  assert.ok(problems("LeadUpdate", { status: "gone" }).length);
  assert.deepEqual(formatProblems(problems("LeadUpdate", { status: "won", note: "x" })), []);
  assert.ok(problems("SuppressionAdd", { reason: "complaint" }).length, "an address or a hash is needed");
  assert.ok(problems("SuppressionAdd", { reason: "complaint", recipient: "a@example.test", recipient_hash: "a".repeat(64) }).length, "not both");
  assert.ok(problems("SuppressionAdd", { reason: "complaint", recipient_hash: "a".repeat(64) }).length === 0);
});

test("the contract is the file named in kit.canon.json, so `kit check canon` holds it against the route literals", () => {
  const canon = JSON.parse(readFileSync(new URL("kit.canon.json", ROOT), "utf8"));
  const c = canon.contracts.find((x) => x.contract === "contracts/admin.openapi.json");
  assert.ok(c, "declared in kit.canon.json contracts");
  assert.ok(c.sources.some((s) => s.startsWith("workers/admin/src")));
});
