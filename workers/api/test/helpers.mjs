// Test helpers: the Worker's fetch handler in-process, and the contract's own schemas as the validator for every response.
import { readFileSync } from "node:fs";
import { createValidator } from "../../../vendor/kit/packages/core/src/schema.js";
import { bundleExternalRefs } from "../../../vendor/kit/packages/sdk/src/bundle.js";
import worker from "../src/worker.js";

export const root = new URL("../../../", import.meta.url);
export const contract = JSON.parse(readFileSync(new URL("contracts/api.openapi.json", root), "utf8"));
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A rate limiter that counts per key, like the Cloudflare binding: success until `limit` calls, then false. */
export function limiter(limit = Infinity) {
  const seen = new Map();
  return { limit: async ({ key }) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= limit }; } };
}
export const env = (extra = {}) => ({ RATE_LIMITER: limiter(), BUILD_COMMIT: COMMIT, ...extra });

export async function call(path, { method = "GET", body, headers = {}, e = env() } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] ??= "application/json"; }
  const res = await worker.fetch(new Request(`https://api.saasreport.ai${path}`, init), e, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: the tests that need JSON assert on it */ }
  return { res, status: res.status, text, json, headers: res.headers };
}

// --- the contract as a validator ------------------------------------------------------------------------------------
const bundled = bundleExternalRefs(contract, root.pathname);
if (bundled.problems.length) throw new Error(bundled.problems.join("; "));
const toDefs = (v) => JSON.parse(JSON.stringify(v).replaceAll("#/components/schemas/", "urn:saasreport:api#/$defs/"));
const SCHEMAS = toDefs(bundled.doc.components.schemas);
const validator = createValidator([{ $id: "urn:saasreport:api", $defs: SCHEMAS }]);

const deref = (node) => {
  let n = node;
  while (n?.$ref?.startsWith("#/components/")) n = n.$ref.slice(2).split("/").reduce((o, k) => o[k], bundled.doc);
  return n;
};

/** The schema the contract declares for an operation's response with this status and media type, or undefined. */
export function declared(method, path, status, mediaType = "application/json") {
  const res = deref(bundled.doc.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]);
  const schema = res?.content?.[mediaType]?.schema;
  return schema ? toDefs(schema) : undefined;
}

/** Problems of a value against a schema of the contract (a component name or a schema object); [] when valid. */
export function problemsOf(value, schemaOrName) {
  const schema = typeof schemaOrName === "string" ? { $ref: `urn:saasreport:api#/$defs/${schemaOrName}` } : schemaOrName;
  return validator.validate(value, schema).map((p) => `${p.path || "/"}: ${p.message}`);
}

/** Every response is checked against what the contract declares for that operation, status and media type. */
export function assertConforms(r, method, path, assert) {
  const type = (r.headers.get("content-type") || "").split(";")[0];
  const schema = declared(method, path, r.status, type);
  assert.ok(schema, `the contract declares no ${r.status} ${type} response for ${method} ${path}`);
  assert.deepEqual(problemsOf(r.json, schema), [], `${method} ${path} ${r.status} does not match the contract`);
}
