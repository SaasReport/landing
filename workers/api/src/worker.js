// The public API of SaasReport (api.saasreport.ai): exactly the operations of contracts/api.openapi.json.
// Cloudflare only: no Node API, no nodejs_compat, no storage. Limits (rate, body size) are read from the contract's x-limits.
import { withBuild, commitOf } from "@saasreport/cloudflare/build";
import { verifyNarrative } from "../../../vendor/core/src/index.js";
import { createValidator } from "@saasreport/core/schema";
import contract from "../../../contracts/api.openapi.json" with { type: "json" };
import { registries, schemas } from "./data.generated.js";
import { sampleStakeholder, sampleFindings, sampleReport } from "./engine.js";

const LIMITS = contract["x-limits"];
const PROBLEMS = "https://api.saasreport.ai/problems/";
const CACHE = "public, max-age=300";
const NO_STORE = "no-store";
const guardRequest = contract.components.schemas.GuardRequest;
const validator = createValidator([]);

/** The registries the API serves: the contract's own list of names, each with its core registry and schema. */
export const SERVED = contract.components.parameters.RegistryName.schema.enum;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Retry-After",
  "x-content-type-options": "nosniff",
};

function reply(body, { status = 200, cache = CACHE, type = "application/json; charset=utf-8", headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": type, "cache-control": cache, ...headers } });
}

function problem(status, slug, title, detail, request, headers) {
  const instance = new URL(request.url).pathname;
  return reply({ type: `${PROBLEMS}${slug}`, title, status, ...(detail ? { detail } : {}), instance }, { status, cache: NO_STORE, type: "application/problem+json; charset=utf-8", headers });
}

const notFound = (request, detail) => problem(404, "not-found", "Not found", detail, request);
const badRequest = (request, detail) => problem(400, "bad-request", "Bad request", detail, request);

// --- operations: one handler per operationId of the contract ---------------------------------------------------------

const handlers = {
  getHealth: () => reply({ status: "ok", service: "saasreport-api", api_version: contract.info.version }, { cache: NO_STORE }),
  getBuild: (_request, env) => reply({ commit: commitOf(env) }, { cache: NO_STORE }),
  listRegistries: () => reply({ registries: SERVED.map((name) => ({ name, registry: registries[name].registry, version: registries[name].version, schema: schemas[name].$id, href: `/v1/registries/${name}` })) }),
  getRegistry: (request, _env, { name }) => (SERVED.includes(name) ? reply(registries[name]) : notFound(request, `No registry "${name}". Registry names are listed by the index at /v1/registries (GET)`)),
  getSampleStakeholder: (request, _env, { id }) => {
    const body = sampleStakeholder(id);
    return body ? reply(body) : notFound(request, `No stakeholder "${id}" in the stakeholders registry.`);
  },
  getSampleFindings: () => reply(sampleFindings()),
  getSampleReport: (request) => {
    const q = new URL(request.url).searchParams;
    const type = q.get("type"), stakeholder = q.get("stakeholder");
    for (const [name, value, param] of [["type", type, contract.components.parameters.ReportType], ["stakeholder", stakeholder, contract.components.parameters.StakeholderQuery]]) {
      if (!value) return badRequest(request, `The query parameter "${name}" is required.`);
      if (value.length > param.schema.maxLength || !new RegExp(param.schema.pattern).test(value)) return badRequest(request, `The query parameter "${name}" is not a valid id.`);
    }
    const r = sampleReport(type, stakeholder);
    if (r.missing) return notFound(request, `No ${r.missing === "type" ? "report type" : "stakeholder"} "${r.missing === "type" ? type : stakeholder}" in its registry.`);
    if (r.notOffered) return problem(422, "unprocessable", "Unprocessable", `The report type "${type}" is not offered to "${stakeholder}".`, request);
    return reply(r.report);
  },
  checkNarrative: async (request) => {
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") || "")) return problem(415, "unsupported-media-type", "Unsupported media type", "Send application/json.", request);
    const read = await readCapped(request, LIMITS.max_body_bytes);
    if (read.tooLarge) return problem(413, "payload-too-large", "Payload too large", `The body is larger than ${LIMITS.max_body_bytes} bytes.`, request);
    let body;
    try { body = JSON.parse(read.text); } catch { return badRequest(request, "The body is not valid JSON."); }
    const issues = validator.validate(body, guardRequest);
    if (issues.length) return badRequest(request, issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; "));
    const v = verifyNarrative(body.text, body.facts);
    return reply({ ok: v.ok, decision: v.ok ? "allow" : "deny", unsupported: v.unsupported }, { cache: NO_STORE });
  },
};

/** Reads at most `cap` bytes of the body; never text() or json() before the cap. */
async function readCapped(request, cap) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel(); return { tooLarge: true }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(bytes) };
}

// --- routes: literal paths, checked against the contract both ways by `kit check canon` and the tests ----------------

export const ROUTES = [
  ["GET", "/v1/health", "getHealth"],
  ["GET", "/v1/build", "getBuild"],
  ["GET", "/v1/registries", "listRegistries"],
  ["GET", "/v1/registries/{name}", "getRegistry"],
  ["GET", "/v1/sample/stakeholders/{id}", "getSampleStakeholder"],
  ["GET", "/v1/sample/findings", "getSampleFindings"],
  ["GET", "/v1/sample/report", "getSampleReport"],
  ["POST", "/v1/guard", "checkNarrative"],
];

function match(method, pathname) {
  const parts = pathname.replace(/\/$/, "").split("/");
  const paths = [];
  for (const [m, template, operation] of ROUTES) {
    const t = template.split("/");
    if (t.length !== parts.length) continue;
    const params = {};
    if (!t.every((seg, i) => (seg.startsWith("{") ? ((params[seg.slice(1, -1)] = decodeURIComponent(parts[i])), parts[i] !== "") : seg === parts[i]))) continue;
    paths.push(m);
    if (m === method) return { operation, params };
  }
  return paths.length ? { allow: [...new Set(paths)] } : null;
}

async function limited(request, env) {
  if (!env?.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== "function") return problem(503, "unavailable", "Unavailable", "The rate limiter is not bound, so the API answers nothing.", request);
  const key = request.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success ? null : problem(429, "too-many-requests", "Too many requests", `At most ${LIMITS.rate.limit} requests every ${LIMITS.rate.period_seconds} seconds per client.`, request, { "retry-after": String(LIMITS.rate.period_seconds) });
}

const worker = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
    }
    const found = match(request.method, new URL(request.url).pathname);
    if (!found) return notFound(request, "No such route. The contract is at /openapi.json.");
    if (found.allow) return problem(405, "method-not-allowed", "Method not allowed", `Use ${found.allow.join(", ")}.`, request, { allow: found.allow.join(", ") });
    const over = await limited(request, env);
    if (over) return over;
    return handlers[found.operation](request, env, found.params);
  },
};

export { handlers };
export default withBuild(worker);
