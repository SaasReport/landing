// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge.
/**
 * JSON Schema 2020-12 (OpenAPI 3.1) → Python type expressions for the generated client (Python ≥ 3.11, typing only).
 *
 * Component schemas become module-level names (an object schema a TypedDict, anything else a type alias), referenced
 * as quoted forward references ("Item") so order and recursion never matter. An anonymous nested object is
 * dict[str, Any]; whatever this mapping cannot express precisely is Any, never a guess.
 */
import { toPascalCase } from "../naming.js";

/** Python keywords and soft keywords, and the builtins a generated name must not shadow. */
export const PY_RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield", "match", "case", "type", "_",
]);
/** Names the generated module defines or imports. */
export const PY_MODULE_NAMES = new Set([
  "Any", "Callable", "Literal", "Mapping", "NotRequired", "Optional", "TypeAlias", "TypedDict", "Union", "json", "re", "urllib",
  "SERVERS", "OPERATIONS", "ApiError", "Client", "Transport", "urllib_transport", "Omitted", "OMITTED",
]);

export const isPyIdentifier = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !PY_RESERVED.has(s);

/**
 * Python names for every component schema, unique and never reserved: { contractName → pythonName }.
 * @param {string[]} names
 */
export function pySchemaNames(names) {
  const out = {};
  const used = new Set();
  for (const n of [...names].sort()) {
    let base = toPascalCase(n.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "Schema";
    if (/^\d/.test(base)) base = `Schema${base}`;
    if (PY_RESERVED.has(base) || PY_MODULE_NAMES.has(base)) base = `${base}Schema`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    out[n] = name;
  }
  return out;
}

const lit = (v) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : JSON.stringify(v));
const union = (parts) => {
  const u = [...new Set(parts)];
  if (u.includes("Any")) return "Any";
  if (!u.length) return "Any";
  const nonNone = u.filter((p) => p !== "None");
  if (nonNone.length === u.length) return u.length === 1 ? u[0] : `Union[${u.join(", ")}]`;
  if (!nonNone.length) return "None";
  return `Optional[${nonNone.length === 1 ? nonNone[0] : `Union[${nonNone.join(", ")}]`}]`;
};

/**
 * A JSON Schema → a Python type expression.
 * @param {unknown} schema
 * @param {{ doc?: object, names?: Record<string, string> }} ctx
 * @param {number} [depth]
 * @param {Set<string>} [seen]
 * @returns {string}
 */
export function pyType(schema, ctx = {}, depth = 0, seen = new Set()) {
  if (schema === true || schema === undefined || schema === null) return "Any";
  if (schema === false || depth > 24 || typeof schema !== "object") return "Any";
  if (schema.$ref) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    if (m) {
      const n = decodeURIComponent(m[1]).replace(/~1/g, "/").replace(/~0/g, "~");
      return ctx.names?.[n] ? JSON.stringify(ctx.names[n]) : "Any";
    }
    if (!schema.$ref.startsWith("#/") || seen.has(schema.$ref)) return "Any";
    let node = ctx.doc;
    for (const seg of schema.$ref.slice(2).split("/")) node = node?.[decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~")];
    return node === undefined ? "Any" : pyType(node.schema ?? node, ctx, depth + 1, new Set([...seen, schema.$ref]));
  }
  if ("const" in schema) return `Literal[${lit(schema.const)}]`;
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum.filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (vals.length !== schema.enum.length || !vals.length) return "Any";
    const nonNull = vals.filter((v) => v !== null);
    const t = nonNull.length ? `Literal[${nonNull.map(lit).join(", ")}]` : "None";
    return vals.includes(null) && nonNull.length ? `Optional[${t}]` : t;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return union((schema.oneOf || schema.anyOf).map((s) => pyType(s, ctx, depth + 1, seen)));
  if (Array.isArray(schema.allOf)) {
    // an intersection has no Python spelling: a single member is that member, anything else a plain mapping
    const parts = schema.allOf.map((s) => pyType(s, ctx, depth + 1, seen)).filter((t) => t !== "Any");
    return parts.length === 1 && !schema.properties ? parts[0] : "dict[str, Any]";
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : schema.properties ? ["object"] : [];
  if (!types.length) return "Any";
  if (schema.nullable === true && !types.includes("null")) types.push("null");
  return union(types.map((t) => {
    if (t === "string") return "str";
    if (t === "integer") return "int";
    if (t === "number") return "float";
    if (t === "boolean") return "bool";
    if (t === "null") return "None";
    if (t === "array") return `list[${pyType(schema.items, ctx, depth + 1, seen)}]`;
    if (t === "object") {
      const ap = schema.additionalProperties;
      if (!schema.properties && ap && ap !== true) return `dict[str, ${pyType(ap, ctx, depth + 1, seen)}]`;
      return "dict[str, Any]";
    }
    return "Any";
  }));
}

/**
 * One component schema as a Python definition: a TypedDict for an object with properties (class syntax when every key
 * is an identifier, else the functional syntax), else a TypeAlias.
 * @param {string} pyName
 * @param {object} schema
 * @param {{ doc?: object, names?: Record<string, string> }} ctx
 */
export function pyDefinition(pyName, schema, ctx) {
  const s = schema && typeof schema === "object" ? schema : {};
  const props = s.properties && typeof s.properties === "object" && !s.$ref && !s.allOf && !s.oneOf && !s.anyOf ? Object.entries(s.properties) : [];
  const types = [s.type].flat().filter(Boolean);
  if (!props.length || (types.length && !types.includes("object")) || types.includes("null")) {
    return `${pyName}: TypeAlias = ${pyType(s, ctx)}`;
  }
  const required = new Set(s.required || []);
  const field = ([k, v]) => {
    const t = pyType(v, ctx, 1);
    return [k, required.has(k) ? t : `NotRequired[${t}]`];
  };
  const fields = props.map(field);
  const doc = s.description ? String(s.description).replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"') : "";
  if (fields.every(([k]) => isPyIdentifier(k))) {
    return [`class ${pyName}(TypedDict):`, ...(doc ? [`    """${doc}"""`, ""] : []), ...fields.map(([k, t]) => `    ${k}: ${t}`)].join("\n");
  }
  return `${pyName} = TypedDict(${JSON.stringify(pyName)}, {\n${fields.map(([k, t]) => `    ${JSON.stringify(k)}: ${t},`).join("\n")}\n})`;
}
