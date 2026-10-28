/**
 * A project's canonical sources (widgets.spec.json "sources"): OpenAPI documents, JSON Schemas, content files and
 * engines. Widgets quote them ({"$ref": "<source>#/pointer"}), call them ({"$engine": {source, call, args}}), show their
 * operations ("operation": "<openapi source>#<operationId>") and sample their schemas — never invent their own data.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { sha16, pointer, isObj, escPtr, addDays } from "./util.js";

/** Load every source of a spec: JSON documents parsed, engine modules imported; each with the hash of its file. */
export async function loadSources(spec, specDir) {
  const out = {};
  for (const [id, s] of Object.entries(spec.sources || {})) {
    const file = resolve(specDir, s.path);
    let text;
    try { text = readFileSync(file, "utf8"); } catch (e) { throw new Error(`sources.${id}: cannot read ${s.path} (${e.code || e.message})`); }
    const entry = { id, kind: s.kind, path: s.path, file, hash: sha16(text) };
    if (s.kind !== "engine" && /\.m?js$/.test(s.path)) {
      const mod = await import(pathToFileURL(file).href);
      const doc = s.export ? mod[s.export] : mod.default;
      if (doc === undefined) throw new Error(`sources.${id}: ${s.path} has no ${s.export ? `export "${s.export}"` : "default export"}`);
      entry.doc = JSON.parse(JSON.stringify(doc));
    } else if (s.kind === "engine") {
      const mod = await import(pathToFileURL(file).href);
      entry.engine = mod.default ?? mod;
      if (!isObj(entry.engine) && typeof entry.engine !== "object") throw new Error(`sources.${id}: an engine module's default export is an object of functions`);
    } else if (/\.ya?ml$/.test(s.path)) {
      entry.doc = await parseYaml(text, specDir, `sources.${id}: ${s.path}`);
    } else {
      try { entry.doc = JSON.parse(text); } catch (e) { throw new Error(`sources.${id}: ${s.path} is not JSON (${e.message})`); }
    }
    out[id] = entry;
  }
  return out;
}

/** YAML contracts (OpenAPI documents are often YAML): parsed with the project's own `yaml` package. */
async function parseYaml(text, specDir, where) {
  let YAML;
  try { YAML = await import(pathToFileURL(createRequire(resolve(specDir, "package.json")).resolve("yaml")).href); }
  catch { throw new Error(`${where}: a YAML source needs the "yaml" package in the project (npm i -D yaml)`); }
  try { return (YAML.default ?? YAML).parse(text); } catch (e) { throw new Error(`${where} is not YAML (${e.message})`); }
}

/** "<source>#/pointer" → { source, ptr, value } (throws when it does not resolve). */
export function sourceRef(sources, ref) {
  const [id, ptr = ""] = ref.split("#");
  const s = sources[id];
  if (!s) throw new Error(`"${ref}": no source "${id}" (sources: ${Object.keys(sources).join(", ") || "none"})`);
  if (!s.doc) throw new Error(`"${ref}": source "${id}" is an engine; use {"$engine": …}`);
  const value = pointer(s.doc, ptr);
  if (value === undefined) throw new Error(`"${ref}" does not resolve in ${s.path}`);
  return { source: id, ptr, value };
}

/** Resolve local $refs of a JSON document (one level at a time, cycles cut at depth 8). */
function deref(doc, node, depth = 0) {
  let n = node;
  while (isObj(n) && typeof n.$ref === "string" && n.$ref.startsWith("#/") && depth < 8) { n = pointer(doc, n.$ref.slice(1)); depth++; }
  return n;
}

/**
 * A deterministic sample of a JSON Schema: example, examples[0], default, const, enum[0]; objects from their
 * properties, arrays with one item; strings by format (dates from asOf). No randomness, no invented words beyond the
 * schema's own: a string without an example is its property name in angle brackets.
 */
export function sampleOf(schema, { doc = schema, asOf = "2026-01-01", name = "value", depth = 0 } = {}) {
  const s = deref(doc, schema);
  if (!isObj(s) || depth > 6) return null;
  if ("example" in s) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if ("default" in s) return s.default;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  for (const k of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(s[k]) && s[k].length) {
    if (k !== "allOf") return sampleOf(s[k][0], { doc, asOf, name, depth: depth + 1 });
    return Object.assign({}, ...s[k].map((x) => sampleOf(x, { doc, asOf, name, depth: depth + 1 })).filter(isObj));
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type || (s.properties ? "object" : s.items ? "array" : "string");
  if (type === "object") {
    const props = s.properties || {};
    const keys = Object.keys(props);
    return Object.fromEntries(keys.map((k) => [k, sampleOf(props[k], { doc, asOf, name: k, depth: depth + 1 })]));
  }
  if (type === "array") return s.items ? [sampleOf(s.items, { doc, asOf, name, depth: depth + 1 })] : [];
  if (type === "integer") return s.minimum ?? 1;
  if (type === "number") return s.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (s.format === "date") return asOf;
  if (s.format === "date-time") return `${asOf}T09:00:00Z`;
  if (s.format === "uri" || s.format === "url") return "https://example.org/";
  if (s.format === "email") return "name@example.org";
  if (s.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  return `<${name}>`;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** An OpenAPI operation by operationId: method, path, summary, parameters, request and first 2xx response samples. */
export function operation(sources, ref, { asOf, request = {} }) {
  const [id, opId] = ref.split("#");
  const byPath = /^(GET|POST|PUT|PATCH|DELETE) (\S*)$/.exec(opId);
  const s = sources[id];
  if (!s) throw new Error(`operation "${ref}": no source "${id}"`);
  if (s.kind !== "openapi") throw new Error(`operation "${ref}": source "${id}" is ${s.kind}, not openapi`);
  for (const [path, item] of Object.entries(s.doc.paths || {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || (byPath ? !(byPath[1].toLowerCase() === method && byPath[2] === path) : op.operationId !== opId)) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => deref(s.doc, p)).filter(Boolean);
      const query = {}; let url = path;
      const given = request.query || {};
      for (const k of Object.keys(given)) if (!params.some((p) => p.name === k)) throw new Error(`operation "${ref}": no parameter "${k}" in the contract`);
      for (const p of params) {
        const v = given[p.name] ?? p.example ?? sampleOf(p.schema || {}, { doc: s.doc, asOf, name: p.name });
        if (p.in === "path") url = url.replace(`{${p.name}}`, encodeURIComponent(String(v)));
        else if (p.in === "query" && (p.name in given || p.required || p.example != null)) query[p.name] = v;
      }
      const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${String(v).replace(/[&#= ]/g, encodeURIComponent)}`).join("&");
      const media = (c) => c?.["application/json"] || (c && Object.values(c)[0]);
      const reqMedia = media(deref(s.doc, op.requestBody)?.content);
      const body = request.body !== undefined ? request.body : reqMedia ? reqMedia.example ?? sampleOf(reqMedia.schema || {}, { doc: s.doc, asOf, name: "body" }) : undefined;
      const codes = Object.keys(op.responses || {});
      const code = codes.find((c) => /^2/.test(c)) || codes[0] || "200";
      const res = deref(s.doc, op.responses?.[code]);
      const resMedia = media(res?.content);
      const response = resMedia ? resMedia.example ?? (resMedia.examples && Object.values(resMedia.examples)[0]?.value) ?? sampleOf(resMedia.schema || {}, { doc: s.doc, asOf, name: "response" }) : null;
      return {
        method: method.toUpperCase(), path: url + (qs ? `?${qs}` : ""), query, summary: op.summary || res?.description || opId,
        body, status: Number(code) || 200, response,
        trace: `${id}#/paths/${escPtr(path)}/${method}`,
      };
    }
  }
  throw new Error(`operation "${ref}": no ${byPath ? `${byPath[1]} ${byPath[2]}` : `operationId "${opId}"`} in ${s.path}`);
}

/** Call an engine (memoised per call+args+locale); every call is recorded for the generated file. */
export function engineCaller(sources, { asOf, calls }) {
  const memo = new Map();
  return async (req, locale) => {
    const s = sources[req.source];
    if (!s) throw new Error(`$engine: no source "${req.source}"`);
    if (s.kind !== "engine") throw new Error(`$engine: source "${req.source}" is ${s.kind}, not an engine`);
    const fn = s.engine[req.call];
    if (typeof fn !== "function") throw new Error(`$engine: ${req.source} has no function "${req.call}" (has: ${Object.keys(s.engine).join(", ")})`);
    const args = req.args || {};
    const key = JSON.stringify([req.source, req.call, args, locale]);
    if (!memo.has(key)) {
      const result = await fn(args, { asOf, locale, addDays });
      memo.set(key, result);
      calls.push({ source: req.source, call: req.call, args, locale, result });
    }
    let v = memo.get(key);
    if (req.pick) v = req.pick.split(".").reduce((o, k) => (o == null ? o : o[k]), v);
    if (v === undefined) throw new Error(`$engine ${req.source}.${req.call}${req.pick ? ` pick ${req.pick}` : ""} returned nothing`);
    return v;
  };
}
