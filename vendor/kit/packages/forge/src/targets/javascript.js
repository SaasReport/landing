// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge (whose TypeScript SDK runs the Fern generator in
// Docker): a native target, plain string emission, no dependencies.
/**
 * The JavaScript target: index.mjs (the client), index.d.ts (its types), package.json.
 *
 *   createClient({ baseUrl, fetch, headers }) → client.<command>.<group…>.<method>(params, { headers, signal })
 */
import { readFileSync } from "node:fs";
import { toPascalCase } from "../naming.js";
import { isJsonMediaType } from "../openapi-resolver.js";
import { responseKinds } from "../model.js";
import { tsKey, tsType } from "./ts-types.js";

/** A type name part from an operationId ("get-item" → "GetItem"). */
export const typeName = (id) => toPascalCase(String(id).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")) || "Operation";

/** runtime/params.js, inlined into every generated client (one source, unit-tested on its own). */
export const PARAMS_RUNTIME = readFileSync(new URL("../runtime/params.js", import.meta.url), "utf8").replace(/^\/\/ SPDX-License-Identifier:.*\n(\/\/ Copyright.*\n)?/, "").trim();

const docText = (s) => String(s).replace(/\*\//g, "*\\/");

function responseType(op, doc) {
  const parts = responseKinds(op).map((r) => {
    if (r.kind === "unknown") return "unknown";
    if (r.kind === "none") return "undefined";
    if (r.kind === "json") return r.schema === undefined ? "unknown" : tsType(r.schema, doc);
    if (r.kind === "text") return "string";
    return "ArrayBuffer";
  });
  return [...new Set(parts)].join(" | ") || "unknown";
}

function paramsType(op, doc) {
  const lines = op.params.map((p) => `  ${p.description ? `/** ${docText(p.description).replace(/\s+/g, " ")} */\n  ` : ""}${tsKey(p.name)}${p.required ? "" : "?"}: ${tsType(p.schema, doc, 1)};`);
  if (op.body) lines.push(`  /** Request body (${op.body.contentTypes.join(", ")}) */\n  body${op.body.required ? "" : "?"}: ${tsType(op.body.schema, doc, 1)}${op.body.contentTypes.some(isJsonMediaType) ? "" : " | BodyInit"};`);
  return lines.length ? `{\n${lines.join("\n")}\n}` : "Record<string, never>";
}

export const needsParams = (op) => op.params.some((p) => p.required) || Boolean(op.body?.required);

function docComment(op, indent) {
  const text = [op.summary, op.description && op.description !== op.summary ? op.description : ""].filter(Boolean).join("\n\n");
  const lines = [...text.split("\n"), `${op.method} ${op.path}`, ...(op.deprecated ? ["@deprecated"] : [])];
  return `${indent}/**\n${lines.map((l) => `${indent} * ${docText(l)}`.trimEnd()).join("\n")}\n${indent} */`;
}

/**
 * index.d.ts
 * @param {ReturnType<typeof import("../model.js").buildModel>} m
 * @param {object} doc the contract (component schemas)
 * @param {string} header
 */
export function emitDts(m, doc, header) {
  const schemas = Object.entries(doc.components?.schemas || {}).sort(([a], [b]) => a.localeCompare(b));
  const out = [header.trimEnd(), `// ${m.info.title || m.target.name} ${m.info.version || ""}`.trimEnd(), ""];
  out.push("/** Every component schema of the contract (components.schemas). */");
  out.push(`export interface Schemas {${schemas.length ? "\n" + schemas.map(([k, s]) => `  ${tsKey(k)}: ${tsType(s, doc, 1)};`).join("\n") + "\n" : ""}}`);
  out.push("");
  for (const op of Object.values(m.ops)) {
    const P = typeName(op.id);
    out.push(`export type ${P}Params = ${paramsType(op, doc)};`);
    out.push(`export type ${P}Response = ${responseType(op, doc)};`);
  }
  out.push("");
  out.push(`export interface ClientConfig {
  /** Base URL of the API (default: the contract's first server, ${JSON.stringify(m.servers[0] || "")}). */
  baseUrl?: string;
  /** fetch implementation (default: globalThis.fetch). */
  fetch?: typeof fetch;
  /** Headers sent with every request (e.g. authorization). */
  headers?: Record<string, string>;
}
export interface RequestOptions { headers?: Record<string, string>; signal?: AbortSignal }
export declare class ApiError extends Error {
  readonly operationId: string;
  readonly status: number;
  readonly body: unknown;
}`);
  const tree = (node, depth) => {
    const pad = "  ".repeat(depth);
    return Object.entries(node).map(([name, v]) => {
      if (typeof v === "string") {
        const op = m.ops[v];
        if (!op) return "";
        const P = typeName(op.id);
        return `${docComment(op, pad)}\n${pad}${tsKey(name)}(params${needsParams(op) ? "" : "?"}: ${P}Params, options?: RequestOptions): Promise<${P}Response>;`;
      }
      return `${pad}${tsKey(name)}: {\n${tree(v, depth + 1)}\n${pad}};`;
    }).filter(Boolean).join("\n");
  };
  out.push(`export interface Client {\n${tree(m.tree, 1)}\n}`);
  out.push("export declare const SERVERS: string[];");
  out.push("export declare function createClient(config?: ClientConfig): Client;");
  out.push("export default createClient;");
  return out.join("\n") + "\n";
}

/** The operation table every runtime reads: method, path, parameters (serialization), body. */
export function operationTable(m) {
  return Object.fromEntries(Object.values(m.ops).map((op) => [op.id, {
    method: op.method, path: op.path,
    params: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, type: p.type, style: p.style, explode: p.explode, ...(p.allowReserved ? { allowReserved: true } : {}), ...(p.json ? { json: true } : {}) })),
    body: op.body ? { required: op.body.required, contentTypes: op.body.contentTypes, ...(op.body.nullable ? { nullable: true } : {}) } : null,
  }]));
}

/**
 * index.mjs
 * @param {ReturnType<typeof import("../model.js").buildModel>} m
 * @param {string} header
 */
export function emitIndex(m, header) {
  return `${header.trimEnd()}
// ${m.info.title || m.target.name} ${m.info.version || ""} — client for every operation of the contract.

export const SERVERS = ${JSON.stringify(m.servers)};
export const OPERATIONS = ${JSON.stringify(operationTable(m), null, 2)};
export const TREE = ${JSON.stringify(m.tree, null, 2)};

/** A JSON reply: an empty body is no content; a body that does not parse is an ApiError, never undefined. */
function parseJson(operationId, status, text) {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch (e) { throw new ApiError(operationId, status, { error: "invalid_json", message: e.message }); }
}

export class ApiError extends Error {
  constructor(operationId, status, body) {
    super(\`\${operationId}: HTTP \${status}\`);
    this.name = "ApiError";
    this.operationId = operationId;
    this.status = status;
    this.body = body;
  }
}

const isJson = (ct) => /^application\\/(.+\\+)?json\\b/i.test(ct || "");

${PARAMS_RUNTIME}

/** One request: params by their contract names (path, query, header, cookie) plus \`body\`. */
export async function request(config, operationId, params = {}, options = {}) {
  const op = OPERATIONS[operationId];
  if (!op) throw new TypeError(\`unknown operation \${operationId}\`);
  const fetchImpl = config.fetch || globalThis.fetch;
  const { path, query: qs, headers: paramHeaders, cookie } = serializeParams(operationId, op, params);
  const headers = { ...(config.headers || {}), ...(options.headers || {}), ...paramHeaders };
  if (cookie) headers.cookie = headers.cookie ? \`\${headers.cookie}; \${cookie}\` : cookie;
  let body;
  if (op.body) {
    const enc = encodeBody(operationId, op.body, params.body);
    body = enc.body;
    if (enc.contentType && body !== undefined) headers["content-type"] ??= enc.contentType;
  }
  const base = String(config.baseUrl ?? SERVERS[0] ?? "").replace(/\\/$/, "");
  const res = await fetchImpl(\`\${base}\${path}\${qs ? \`?\${qs}\` : ""}\`, { method: op.method, headers, body, signal: options.signal });
  const ct = res.headers.get("content-type") || "";
  const empty = op.method === "HEAD" || res.status === 204 || res.status === 205;
  const data = empty ? undefined : isJson(ct) ? parseJson(operationId, res.status, await res.text()) : /^text\\/|xml/.test(ct) || !ct ? await res.text() : await res.arrayBuffer();
  if (!res.ok) throw new ApiError(operationId, res.status, data);
  return data;
}

/** The client: one function per operation, grouped as Forge groups them (contract tags). */
export function createClient(config = {}) {
  const build = (node) => Object.fromEntries(Object.entries(node).map(([k, v]) => [k, typeof v === "string" ? (params, options) => request(config, v, params, options) : build(v)]));
  return build(TREE);
}

export default createClient;
`;
}

/** An npm version from the contract's info.version ("v1.2.0" → "1.2.0"; anything else → "0.0.0"). */
export const packageVersion = (v) => {
  const s = String(v || "").replace(/^[^0-9]*/, "");
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(s) ? s : /^\d+(\.\d+)?$/.test(s) ? `${s}${".0".repeat(2 - (s.match(/\./g) || []).length)}` : "0.0.0";
};

/**
 * package.json
 * @param {ReturnType<typeof import("../model.js").buildModel>} m
 * @param {string} description
 */
export function emitPackage(m, description) {
  const bin = m.target.cli || m.target.name;
  return `${JSON.stringify({
    name: `${m.target.name}-sdk`,
    version: packageVersion(m.info.version),
    description,
    private: true,
    type: "module",
    main: "./index.mjs",
    types: "./index.d.ts",
    exports: { ".": { types: "./index.d.ts", default: "./index.mjs" } },
    bin: { [bin]: "./cli.mjs" },
  }, null, 2)}\n`;
}
