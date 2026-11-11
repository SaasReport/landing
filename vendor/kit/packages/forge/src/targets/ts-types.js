// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge.
/**
 * JSON Schema 2020-12 (as used by OpenAPI 3.1) → TypeScript type expressions for the generated SDK's index.d.ts.
 * Component schemas become members of one `Schemas` interface, so a `$ref` is `Schemas["Name"]` and recursion is safe.
 * Anything this mapping cannot express precisely is `unknown`, never a guess.
 */

const PRIMITIVE = { string: "string", integer: "number", number: "number", boolean: "boolean", null: "null" };
const lit = (v) => JSON.stringify(v);
const key = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const union = (parts) => {
  const u = [...new Set(parts)];
  if (u.includes("unknown")) return "unknown";
  return u.length ? (u.length === 1 ? u[0] : u.map((p) => (/[&]/.test(p) ? `(${p})` : p)).join(" | ")) : "never";
};

/** `$ref` → a type, given the document (for refs outside components/schemas). */
function refType(ref, doc, depth, seen) {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (m) return `Schemas[${lit(decodeURIComponent(m[1]).replace(/~1/g, "/").replace(/~0/g, "~"))}]`;
  if (!ref.startsWith("#/") || seen.has(ref)) return "unknown";
  let node = doc;
  for (const seg of ref.slice(2).split("/")) node = node?.[decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) return "unknown";
  return tsType(node.schema ?? node, doc, depth + 1, new Set([...seen, ref]));
}

/** A JSON Schema → a TypeScript type expression. */
export function tsType(schema, doc = {}, depth = 0, seen = new Set()) {
  if (schema === true || schema === undefined || schema === null) return "unknown";
  if (schema === false) return "never";
  if (depth > 24 || typeof schema !== "object") return "unknown";
  if (schema.$ref) return refType(schema.$ref, doc, depth, seen);
  if ("const" in schema) return lit(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(lit));
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return union((schema.oneOf || schema.anyOf).map((s) => tsType(s, doc, depth + 1, seen)));
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s) => tsType(s, doc, depth + 1, seen)).filter((t) => t !== "unknown");
    const own = { ...schema };
    delete own.allOf;
    if (own.properties || own.type) parts.push(tsType(own, doc, depth + 1, seen));
    return parts.length ? parts.map((p) => (/[|]/.test(p) ? `(${p})` : p)).join(" & ") : "unknown";
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : (schema.properties ? ["object"] : []);
  if (!types.length) return "unknown";
  if (schema.nullable === true && !types.includes("null")) types.push("null");
  return union(types.map((t) => {
    if (PRIMITIVE[t]) return PRIMITIVE[t];
    if (t === "array") {
      const item = tsType(schema.items, doc, depth + 1, seen);
      return /[|& ]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    if (t === "object") return objectType(schema, doc, depth, seen);
    return "unknown";
  }));
}

function objectType(schema, doc, depth, seen) {
  const props = Object.entries(schema.properties || {});
  const required = new Set(schema.required || []);
  const ap = schema.additionalProperties;
  if (!props.length) {
    if (ap === false) return "Record<string, never>";
    return `Record<string, ${ap && ap !== true ? tsType(ap, doc, depth + 1, seen) : "unknown"}>`;
  }
  const pad = "  ".repeat(Math.min(depth, 12) + 1);
  const lines = props.map(([k, s]) => `${pad}${key(k)}${required.has(k) ? "" : "?"}: ${tsType(s, doc, depth + 1, seen)};`);
  if (ap && ap !== false) lines.push(`${pad}[key: string]: unknown;`);
  return `{\n${lines.join("\n")}\n${"  ".repeat(Math.min(depth, 12))}}`;
}

export const tsKey = key;
