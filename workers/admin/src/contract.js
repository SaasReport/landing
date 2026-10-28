// The contract (contracts/admin.openapi.json) as the Worker's one source of request validation: a request body is validated against the
// named component schema with the kit's validator (@saasreport/core/schema: JSON Schema 2020-12, no code generation, safe in a Worker).
import doc from "../../../contracts/admin.openapi.json" with { type: "json" };
import { createValidator } from "@saasreport/core/schema";

export const CONTRACT = doc;
export const CONTRACT_ID = "urn:saasreport:admin:v1";
const LOCAL = "#/components/schemas/";

export const localize = (node) => {
  if (Array.isArray(node)) return node.map(localize);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith(LOCAL) ? `${CONTRACT_ID}#/$defs/${v.slice(LOCAL.length)}` : localize(v)]));
};
const refsOf = (node, out = new Set()) => {
  if (Array.isArray(node)) node.forEach((x) => refsOf(x, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { if (k === "$ref" && typeof v === "string" && v.startsWith(LOCAL)) out.add(v.slice(LOCAL.length)); else refsOf(v, out); }
  return out;
};

/** The schema document for `names` and every component they reference (all of them when names is null). */
export function schemaDocument(names = null) {
  const all = doc.components.schemas, take = new Set(names ?? Object.keys(all)), todo = [...take];
  while (todo.length) for (const r of refsOf(all[todo.pop()])) if (!take.has(r)) { take.add(r); todo.push(r); }
  return { $id: CONTRACT_ID, $defs: localize(Object.fromEntries([...take].map((n) => [n, all[n]]))) };
}

let REQUESTS;
/** Problems ([{ path, message }]) of a value against the component schema `name`. */
export function problems(name, value) {
  REQUESTS ||= createValidator([schemaDocument(["LeadUpdate", "SuppressionAdd", "InvitationCreate"])]);
  return REQUESTS.validate(value, { $ref: `${CONTRACT_ID}#/$defs/${name}` });
}
export const describe = (list) => list.slice(0, 3).map((p) => `${p.path || "/"}: ${p.message}`).join("; ");

/** Every operation of the contract: [{ method, path, operationId, mutating }]. */
export function operations() {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) if (op && typeof op === "object" && op.operationId) out.push({ method: method.toUpperCase(), path, operationId: op.operationId, mutating: method !== "get" });
  return out;
}
