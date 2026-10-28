// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge: the generation model every native target reads.
/**
 * buildModel(doc, target) → { forge, tree, ops, servers, info, target, problems }
 *
 *   tree  Forge's command tree as nested objects: { command: { method: operationId, group: { … } } }, sorted
 *   ops   operationId → { id, derived, method, path, summary, description, deprecated, params, body, success }
 *
 * Parameters carry their OpenAPI 3.1 serialization (style, explode, allowReserved, JSON content); a combination the
 * specification leaves undefined, or a name two parameters share, is a problem: generation stops, nothing is guessed.
 */
import { initFromOpenApi } from "./init-from-openapi.js";
import { isJsonMediaType } from "./openapi-resolver.js";
import { isMethodGroup } from "./schema-utils.js";

export const STYLES = { path: ["simple", "label", "matrix"], query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"], header: ["simple"], cookie: ["form"] };
export const DEFAULT_STYLE = { path: "simple", query: "form", header: "simple", cookie: "form" };

/**
 * One parameter's serialization for the generated runtimes, or the problem that stops generation.
 * @param {import("./openapi-resolver.js").WireParameter} p
 * @param {string} where "GET /path (operationId)"
 * @param {(v: any) => any} resolveDocRef
 * @returns {{ param?: object, problem?: string }}
 */
export function paramSpec(p, where, resolveDocRef = (v) => v) {
  const fail = (why) => ({ problem: `${where}: ${p.in} parameter "${p.name}": ${why}` });
  if (!STYLES[p.in]) return fail(`unknown location "${p.in}"`);
  let schema = p.schema ?? {};
  let json = false;
  if (p.content && p.content.mediaType === undefined) {
    // a parameter as the contract writes it: content is a map of media types
    const mediaTypes = Object.keys(p.content);
    p = { ...p, content: { mediaType: mediaTypes[0], schema: p.content[mediaTypes[0]]?.schema, mediaTypes } };
  }
  if (p.content) {
    if ((p.content.mediaTypes ?? [p.content.mediaType]).length !== 1) return fail("content must name exactly one media type");
    if (!isJsonMediaType(p.content.mediaType)) return fail(`content ${p.content.mediaType} is not supported (JSON only); use schema + style`);
    json = true;
    schema = p.content.schema ?? {};
  }
  const style = p.style ?? DEFAULT_STYLE[p.in];
  if (!STYLES[p.in].includes(style)) return fail(`style ${style} is not defined for ${p.in} parameters (${STYLES[p.in].join(", ")})`);
  const explode = p.explode ?? style === "form";
  const r = resolveDocRef(schema) ?? {};
  const types = new Set([r.type].flat().filter(Boolean));
  if (!types.size && r.properties) types.add("object");
  const complex = types.has("object") || types.has("array");
  if (!json && style === "deepObject") {
    if (!explode) return fail("style deepObject is only defined with explode: true");
    if (!types.has("object") || types.has("array")) return fail("style deepObject is only defined for objects");
  }
  if (!json && p.in === "cookie" && complex && explode) return fail("a list or object cookie is only defined with explode: false");
  if (!json && (style === "spaceDelimited" || style === "pipeDelimited") && !complex) return fail(`style ${style} is only defined for arrays and objects`);
  const type = [r.type].flat().find((t) => t && t !== "null") ?? (types.has("object") || json ? "object" : null);
  return {
    param: {
      name: p.name, in: p.in, required: p.in === "path" ? true : Boolean(p.required), schema, description: p.description,
      type, style, explode, allowReserved: p.in === "query" && p.allowReserved === true, json,
    },
  };
}

/**
 * Whether a schema admits JSON null (type "null" or a list with it, nullable: true, const or enum null, or a
 * oneOf/anyOf member that does; refs followed). A body that admits null can be sent as null, not only omitted.
 * @param {unknown} schema
 * @param {(v: any) => any} resolveDocRef
 */
export function admitsNull(schema, resolveDocRef = (v) => v, seen = new Set()) {
  if (schema === true) return true;
  if (!schema || typeof schema !== "object") return false;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return false;
    const target = resolveDocRef(schema);
    return target !== schema && admitsNull(target, resolveDocRef, new Set([...seen, schema.$ref]));
  }
  if ("const" in schema) return schema.const === null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if (schema.nullable === true || [schema.type].flat().includes("null")) return true;
  if ([...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some((s) => admitsNull(s, resolveDocRef, seen))) return true;
  if (Array.isArray(schema.allOf)) return schema.allOf.length > 0 && schema.allOf.every((s) => admitsNull(s, resolveDocRef, seen));
  return !schema.type && !schema.properties && !schema.items && !schema.oneOf && !schema.anyOf && !schema.allOf && Object.keys(schema).every((k) => ["description", "title", "examples", "example", "default", "deprecated"].includes(k));
}

/**
 * The model of one contract: Forge's command tree and every resolved operation, in a stable order.
 * @param {object} doc an OpenAPI 3.1 document
 * @param {{ name: string, cli?: string }} target
 */
export function buildModel(doc, target) {
  const forge = initFromOpenApi(doc);
  const problems = [];
  const tree = {};
  for (const [command, schema] of [...forge.commands.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const node = (tree[command] = {});
    const place = (methods, into, where) => {
      for (const m of methods) {
        if (isMethodGroup(m)) {
          if (typeof into[m.name] === "string") problems.push(`${where}.${m.name}: a group and a method share the name`);
          else place(m.methods, (into[m.name] = into[m.name] || {}), `${where}.${m.name}`);
        } else if (into[m.name] !== undefined) problems.push(`${where}.${m.name}: a group and a method share the name`);
        else into[m.name] = m.operationId;
      }
    };
    place(schema.methods, node, command);
  }
  const ops = {};
  for (const id of forge.getOperationIds()) {
    const info = forge.resolveOperation(id);
    if (!info) continue;
    const where = `${info.method.toUpperCase()} ${info.path} (${id})`;
    const params = [];
    const names = new Map();
    for (const raw of info.parameters) {
      const r = paramSpec(raw, where, (v) => forge.resolveDocRef(v));
      if (r.problem) { problems.push(r.problem); continue; }
      // the client takes parameters by name: a name used in two locations, or "body", would be ambiguous
      if (r.param.name === "body") problems.push(`${where}: ${r.param.in} parameter "body": the name is reserved for the request body`);
      else if (names.has(r.param.name)) problems.push(`${where}: parameter "${r.param.name}" is declared in ${names.get(r.param.name)} and ${r.param.in}; the generated client takes parameters by name`);
      names.set(r.param.name, r.param.in);
      params.push(r.param);
    }
    const body = info.hasRequestBody ? {
      required: info.requestBodyIsRequired, contentTypes: info.requestContentTypes, schema: info.requestBodySchema ?? {},
      nullable: admitsNull(info.requestBodySchema, (v) => forge.resolveDocRef(v)),
    } : null;
    ops[id] = {
      id, derived: info.operationIdDerived, method: info.method.toUpperCase(), path: info.path,
      summary: info.summary, description: info.description, deprecated: info.deprecated,
      params, body, success: info.success,
    };
  }
  const servers = (doc.servers || []).map((s) => s?.url).filter(Boolean);
  return { forge, tree, ops, servers, info: doc.info || {}, target, problems };
}

/**
 * What an operation returns, by kind, one entry per 2xx media type: { kind: "none" | "json" | "text" | "binary", schema? }.
 * No 2xx at all → [{ kind: "unknown" }]; a 2xx without content, or any HEAD response → { kind: "none" }; a media type
 * without a schema → its kind with no schema (JSON: any value).
 * @param {{ method: string, success: import("./openapi-resolver.js").SuccessResponse[] }} op
 */
export function responseKinds(op) {
  if (!op.success.length) return [{ kind: "unknown" }];
  const out = [];
  for (const s of op.success) {
    if (op.method === "HEAD" || ["204", "205"].includes(s.status) || !s.content.length) { out.push({ kind: "none" }); continue; }
    for (const c of s.content) {
      const kind = isJsonMediaType(c.mediaType) ? "json" : /^text\/|xml/.test(c.mediaType) ? "text" : "binary";
      out.push({ kind, ...(c.schema !== undefined ? { schema: c.schema } : {}) });
    }
  }
  return out;
}
