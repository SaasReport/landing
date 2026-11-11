// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/openapi-resolver.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance:
//   - TypeScript to JavaScript (JSDoc types).
//   - Resolver state lives in a resolver object (createResolver) instead of one module-wide document, so two contracts
//     never share state; populateOperationMap / resolveOperation / resolveDocRef keep upstream's module API on top.
//   - Every OpenAPI method: GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH and TRACE (upstream: the first five only).
//   - An operation without an operationId gets a deterministic one from its method and path (operationIdOf);
//     upstream skipped it silently.
//   - A request body is the contract's: any declared media type is a body, a bare { type: object } schema included
//     (upstream called that "semantically empty" and dropped it); requestBodyIsRequired, requestBodyMediaType and
//     requestBodySchema (as declared, refs intact) are new.
//   - Parameters: `parameters` lists every parameter (path, query, header, cookie) with its OpenAPI 3.1 serialization
//     (style, explode, allowReserved, content); cookieParams is new beside path/query/headerParams.
//   - Responses: `success` lists the 2xx responses with their media types and schemas as declared, a 2xx without
//     content or without a schema included; ResponseBodyInfo.rawSchema keeps the declared schema. Not ported: the
//     Cloudflare envelope (`{ success, result }` unwrap: responseRef, responseIsArray, resultRef, getResultTypeRef,
//     getResponseTypeRef) and the x-cf-api-versions extension.
//   - A document without components (or components.schemas) is accepted.

import { HTTP_METHODS } from "./http.js";
import { toCamelCase } from "./naming.js";

/**
 * @typedef {object} ParameterInfo  a parameter as a CLI or SDK surface sees it (upstream's shape)
 * @property {string} name                 the wire name
 * @property {string} [sdkName]            x-fern-parameter-name, when set
 * @property {boolean} required
 * @property {string} type                 resolved JSON type ("string", "number", "boolean", "array", "object", "unknown")
 * @property {string} [itemType]
 * @property {string[]} [itemEnumValues]
 * @property {boolean} [composed]          the schema is a oneOf / anyOf
 * @property {string} [schemaRef]          the local component name, when the schema is a $ref
 * @property {string} [description]
 * @property {string[]} [enumValues]
 * @property {string | number | boolean} [default]
 * @property {boolean} [sensitive]         x-sensitive
 *
 * @typedef {ParameterInfo & { apiFieldPath: string[], conflicts?: string[], implies?: string[] }} BodyParamInfo
 *
 * @typedef {object} WireParameter  a parameter as the wire needs it (OpenAPI 3.1 §4.8.12)
 * @property {string} name
 * @property {"path" | "query" | "header" | "cookie"} in
 * @property {boolean} required            path parameters are always required
 * @property {string} [description]
 * @property {boolean} deprecated
 * @property {string} [style]              as declared (undefined: the location's default)
 * @property {boolean} [explode]           as declared
 * @property {boolean} allowReserved
 * @property {object} [schema]             as declared (refs intact)
 * @property {{ mediaType: string, schema?: object }} [content]  a content-encoded parameter
 *
 * @typedef {object} ResponseBodyInfo
 * @property {object} [schema]             the schema with its top-level $ref resolved
 * @property {object} [rawSchema]          the schema as declared
 * @property {string | null} ref           components['schemas']['Name'] when the schema is a component $ref
 * @property {boolean} isArray
 * @property {string | null} itemRef
 *
 * @typedef {object} ResponseInfo
 * @property {string} [description]
 * @property {Record<string, ResponseBodyInfo>} content   by media type, in declaration order
 *
 * @typedef {object} SuccessResponse  one 2xx response
 * @property {string} status               "200", "201", "2XX" …
 * @property {string} [description]
 * @property {{ mediaType: string, schema?: object }[]} content   empty: the response has no content
 *
 * @typedef {object} OperationInfo
 * @property {string} operationId
 * @property {boolean} operationIdDerived  the contract declares none; derived from method and path
 * @property {string} path
 * @property {"get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"} method
 * @property {string} summary
 * @property {string} description
 * @property {string[]} tags
 * @property {boolean} deprecated
 * @property {WireParameter[]} parameters
 * @property {ParameterInfo[]} pathParams
 * @property {ParameterInfo[]} queryParams
 * @property {ParameterInfo[]} headerParams
 * @property {ParameterInfo[]} cookieParams
 * @property {BodyParamInfo[]} bodyParams  JSON body properties flattened to CLI-style flags
 * @property {boolean} hasRequestBody
 * @property {boolean} requestBodyIsRequired
 * @property {string[]} requestContentTypes
 * @property {string | null} requestBodyMediaType   the JSON media type if any, else the first
 * @property {object | undefined} requestBodySchema  the schema of requestBodyMediaType, as declared
 * @property {string | null} requestBodyRef
 * @property {string[]} requestBodyRequired
 * @property {string} [requestBodyDescription]
 * @property {MultipartInfo} [multipart]
 * @property {BodyDiscriminator} [bodyDiscriminator]
 * @property {number} [maxItems]
 * @property {boolean} requestBodyIsArray
 * @property {string | null} requestBodyArrayItemRef
 * @property {Record<string, ResponseInfo>} responses   every declared status, keys verbatim
 * @property {SuccessResponse[]} success
 *
 * @typedef {{ name: string, type: "string" | "number" | "boolean" | "object" | "array", isBinary: boolean, required: boolean, description: string }} MultipartField
 * @typedef {{ fields: MultipartField[], payloadField: string | undefined }} MultipartInfo
 * @typedef {{ field: string, variants: Record<string, string[]> }} BodyDiscriminator
 */

const LOCATIONS = ["path", "query", "header", "cookie"];

/** Whether a media type is JSON (application/json, application/problem+json …). */
export const isJsonMediaType = (mediaType) => /^application\/(.+\+)?json\b/i.test(String(mediaType));

/**
 * The operationId of an operation: the contract's (apostrophes stripped, as upstream does), else one derived from the
 * method and path, camelCase: GET /api/items/{id} → getApiItemsById, GET / → getRoot.
 * @param {string} method
 * @param {string} path
 * @param {{ operationId?: unknown }} [operation]
 * @returns {{ operationId: string, derived: boolean }}
 */
export function operationIdOf(method, path, operation) {
  if (typeof operation?.operationId === "string" && operation.operationId.replace(/'/g, "")) {
    return { operationId: operation.operationId.replace(/'/g, ""), derived: false };
  }
  const words = [method.toLowerCase()];
  for (const seg of String(path).split("/").filter(Boolean)) {
    const param = /^\{(.+)\}$/.exec(seg);
    words.push(...(param ? ["by", ...param[1].split(/[^A-Za-z0-9]+/)] : seg.split(/[^A-Za-z0-9]+/)));
  }
  if (words.length === 1) words.push("root");
  const id = toCamelCase(words.filter(Boolean).map((w) => w.toLowerCase()).join("-"));
  return { operationId: id, derived: true };
}

/** "#/components/schemas/foo" → "components['schemas']['foo']" (a type path), else null. */
function extractRef(schema) {
  if (!schema?.$ref) return null;
  const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
  return match ? `components['schemas']['${match[1]}']` : null;
}

/** The JSON type of a schema as a parameter surface sees it ("string", "number", "boolean", "array", "object", "unknown"). */
function extractType(schema) {
  if (!schema) return "unknown";
  if (schema.$ref) {
    const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
    if (match?.[1]) return match[1];
  }
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return "array";
  if (schema.type === "object") return "object";
  if (schema.enum?.length) {
    const enumTypes = new Set(schema.enum.map((value) => typeof value));
    if (enumTypes.size === 1) {
      const [enumType] = enumTypes;
      if (enumType === "string" || enumType === "number" || enumType === "boolean") return enumType;
    }
  }
  if (typeof schema.example === "string") return "string";
  if (typeof schema.example === "number") return "number";
  if (typeof schema.example === "boolean") return "boolean";
  return "unknown";
}

/** The component name a schema $refs (JSON Pointer escapes undone), else undefined. */
function componentSchemaName(schema) {
  const match = schema?.$ref?.match(/^#\/components\/schemas\/(.+)$/);
  return match?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Convert a snake_case or camelCase name to kebab-case (CLI flag names). */
function toKebabCase(name) {
  return name.replace(/_/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** x-fern-property-name of a property node (inline, beside a $ref, or on an allOf wrapper; never from the target). */
function fernPropertyName(schema) {
  const name = schema["x-fern-property-name"];
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** Flag segment of a body property: its x-fern-property-name when set, else the wire name, kebab-cased. */
function propertyFlagSegment(propName, propSchema) {
  return toKebabCase(fernPropertyName(propSchema) ?? propName);
}

const isScalarDefault = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * A resolver over one OpenAPI document: every operation's paths, parameters, bodies and responses.
 * @param {object} openapi
 */
export function createResolver(openapi) {
  if (!isOpenAPISpec(openapi)) throw new Error("populateOperationMap: input is not a valid OpenAPI spec");
  const schemas = openapi.components?.schemas ?? {};
  /** @type {Map<string, OperationInfo>} */
  const operationMap = new Map();

  function resolveParameterSchema(schema, seen = new Set()) {
    if (!schema) return undefined;
    const name = componentSchemaName(schema);
    if (name !== undefined) {
      if (seen.has(name)) return undefined;
      const target = schemas[name];
      if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
      return resolveParameterSchema(target, new Set([...seen, name]));
    }
    if (schema.$ref !== undefined) return undefined;
    const members = (list) => list.flatMap((member) => {
      const resolved = resolveParameterSchema(member, seen);
      return resolved === undefined ? [] : [resolved];
    });
    if (schema.anyOf?.length) {
      const resolved = members(schema.anyOf);
      const types = new Set(resolved.map(extractType).filter((type) => type !== "unknown"));
      if (types.size === 1) return resolved[0];
      if (isScalarDefault(schema.example)) return schema;
      if (types.size === 2 && types.has("string") && types.has("array")) {
        const array = resolved.find((member) => extractType(member) === "array");
        if (extractType(resolveParameterSchema(array?.items, seen)) === "string") return resolved.find((member) => extractType(member) === "string");
      }
      return undefined;
    }
    if (schema.oneOf?.length) {
      const resolved = members(schema.oneOf);
      const types = new Set(resolved.map(extractType).filter((type) => type !== "unknown"));
      return types.size === 1 ? resolved[0] : undefined;
    }
    if (schema.allOf?.length) {
      const resolved = members(schema.allOf);
      const types = new Set(resolved.map(extractType).filter((type) => type !== "unknown"));
      if (types.size > 1) return undefined;
      if (resolved.length > 0) {
        const { allOf: _, ...base } = schema;
        return Object.assign(base, ...resolved);
      }
    }
    return schema;
  }

  /** A parameter or a #/components/parameters/… reference → the parameter, or null. */
  function resolveParameter(param) {
    if (param?.$ref) {
      const match = param.$ref.match(/#\/components\/parameters\/(.+)/);
      const resolved = match?.[1] ? openapi.components?.parameters?.[match[1]] : undefined;
      return resolved?.name && resolved?.in ? resolved : null;
    }
    return param?.name && param?.in ? param : null;
  }

  /** Path-item parameters, overridden by the operation's own (same name and location). */
  function mergeParameters(pathParameters, operationParameters) {
    const merged = new Map();
    let unresolvedIndex = 0;
    for (const parameter of [...(pathParameters ?? []), ...(operationParameters ?? [])]) {
      const resolved = resolveParameter(parameter);
      merged.set(resolved ? `${resolved.in}:${resolved.name}` : `unresolved:${unresolvedIndex++}`, parameter);
    }
    return [...merged.values()];
  }

  /** The parameters of one location, as a CLI or SDK surface sees them. */
  function extractParameters(params, location) {
    if (!params) return [];
    return params
      .map(resolveParameter)
      .filter((p) => p !== null && p.in === location)
      .map((p) => {
        // keep component identity separate from the resolved wire type
        const schemaRef = componentSchemaName(p.schema);
        const referencedSchema = p.schema?.$ref ? resolveSchemaRef(p.schema) : undefined;
        const resolvedSchema = resolveParameterSchema(p.schema);
        /** @type {ParameterInfo} */
        const info = { name: p.name, required: p.required ?? false, type: location === "path" ? "string" : extractType(resolvedSchema) };
        const sdkName = p["x-fern-parameter-name"]?.trim();
        if (sdkName) info.sdkName = sdkName;
        if (p.schema?.oneOf?.length || p.schema?.anyOf?.length) info.composed = true;
        if (resolvedSchema?.type === "array") {
          const itemSchema = resolveParameterSchema(resolvedSchema.items);
          info.itemType = extractType(itemSchema);
          if (Array.isArray(itemSchema?.enum)) info.itemEnumValues = itemSchema.enum.flatMap((v) => (isScalarDefault(v) ? [String(v)] : []));
        }
        if (schemaRef !== undefined) info.schemaRef = schemaRef;
        // description: the parameter's own, then the reference shell's, then the target's
        const desc = p.description ?? p.schema?.description ?? referencedSchema?.description ?? resolvedSchema?.description;
        if (desc) info.description = desc.trim();
        // enum and default: the $ref target first, then the inline schema
        const enumSchema = resolvedSchema?.enum ? resolvedSchema : p.schema;
        if (enumSchema && Array.isArray(enumSchema.enum)) info.enumValues = enumSchema.enum.flatMap((v) => (isScalarDefault(v) ? [String(v)] : []));
        const defaultSchema = resolvedSchema?.default !== undefined ? resolvedSchema : p.schema;
        if (defaultSchema && "default" in defaultSchema && isScalarDefault(defaultSchema.default)) info.default = defaultSchema.default;
        if (resolvedSchema?.["x-sensitive"] === true || p.schema?.["x-sensitive"] === true) info.sensitive = true;
        return info;
      });
  }

  /** Every parameter with its wire serialization, in the merged order. */
  function extractWireParameters(params) {
    return params.map(resolveParameter).filter(Boolean).map((p) => {
      /** @type {WireParameter} */
      const w = { name: p.name, in: p.in, required: p.in === "path" ? true : p.required === true, deprecated: p.deprecated === true, allowReserved: p.allowReserved === true };
      if (p.description) w.description = String(p.description).trim();
      if (p.style !== undefined) w.style = p.style;
      if (p.explode !== undefined) w.explode = p.explode;
      if (p.schema !== undefined) w.schema = p.schema;
      if (p.content && typeof p.content === "object") {
        const [mediaType] = Object.keys(p.content);
        if (mediaType !== undefined) w.content = { mediaType, schema: p.content[mediaType]?.schema, mediaTypes: Object.keys(p.content) };
      }
      return w;
    });
  }

  /**
   * Resolve a #/components/schemas/… $ref to the schema (one level); anything else is returned as is.
   * Consumers walking a response schema dereference nested refs with this or resolveDocRef.
   */
  function resolveSchemaRef(schema) {
    if (!schema?.$ref) return schema;
    const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
    const resolved = match?.[1] ? schemas[match[1]] : undefined;
    return resolved ?? schema;
  }

  /**
   * Recursively dereference a $ref into the document (any #/… path: request bodies, parameters, responses …);
   * the value is returned unchanged when it has no $ref or the path cannot be walked.
   */
  function resolveDocRef(value, seen = new Set()) {
    if (!value || typeof value !== "object" || typeof value.$ref !== "string" || seen.has(value.$ref)) return value;
    let cur = openapi;
    for (const raw of value.$ref.replace(/^#\//, "").split("/")) {
      const p = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
      if (cur == null || typeof cur !== "object") return value;
      cur = cur[p];
      if (cur == null) return value;
    }
    return resolveDocRef(cur, new Set([...seen, value.$ref]));
  }

  /** The request body's description, else the description of its JSON, octet-stream or multipart schema. */
  function extractRequestBodyDescription(requestBody) {
    if (!requestBody) return undefined;
    const body = resolveDocRef(requestBody);
    if (typeof body.description === "string" && body.description.length > 0) return body.description;
    const content = body.content;
    if (!content) return undefined;
    const schema = resolveDocRef(content["application/json"]?.schema) ?? resolveDocRef(content["application/octet-stream"]?.schema) ?? resolveDocRef(content["multipart/form-data"]?.schema);
    return schema && typeof schema.description === "string" && schema.description.length > 0 ? schema.description : undefined;
  }

  /**
   * The multipart/form-data fields and which one carries the payload: the field whose $ref equals the octet-stream
   * schema's, else the first format: binary field, else a field named "file". Undefined without a multipart body or
   * for a dynamic-key schema.
   */
  function extractMultipart(requestBody) {
    if (!requestBody) return undefined;
    const body = resolveDocRef(requestBody);
    const schema = resolveDocRef(body.content?.["multipart/form-data"]?.schema);
    if (!schema || !schema.properties || typeof schema.properties !== "object") return undefined;
    const octetRef = body.content?.["application/octet-stream"]?.schema?.$ref;
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const fields = [];
    let payloadField;
    for (const [propName, rawProp] of Object.entries(schema.properties)) {
      if (!rawProp) continue;
      const prop = resolveDocRef(rawProp);
      const isBinary = prop.format === "binary";
      let type = "string";
      if (prop.type === "number" || prop.type === "integer") type = "number";
      else if (prop.type === "boolean") type = "boolean";
      else if (prop.type === "array") type = "array";
      else if (prop.type === "object") type = "object";
      fields.push({ name: propName, type, isBinary, required: required.has(propName), description: typeof prop.description === "string" ? prop.description : `The ${propName.replace(/_/g, " ")}` });
      if (!payloadField && ((octetRef && rawProp.$ref && octetRef === rawProp.$ref) || isBinary || propName === "file")) payloadField = propName;
    }
    return { fields, payloadField };
  }

  /** maxItems of an array-shaped JSON body. */
  function extractBodyMaxItems(requestBody) {
    if (!requestBody) return undefined;
    const schema = resolveDocRef(resolveDocRef(requestBody).content?.["application/json"]?.schema);
    if (!schema || schema.type !== "array") return undefined;
    return typeof schema.maxItems === "number" ? schema.maxItems : undefined;
  }

  /** Whether the JSON body is an array, and its items' component ref. */
  function extractArrayBodyInfo(requestBody) {
    if (!requestBody) return { isArray: false, itemRef: null };
    const schema = resolveDocRef(resolveDocRef(requestBody).content?.["application/json"]?.schema);
    if (!schema || schema.type !== "array") return { isArray: false, itemRef: null };
    return { isArray: true, itemRef: schema.items ? extractRef(schema.items) : null };
  }

  /** Fields required at the root of the JSON body (allOf members included). */
  function extractRequestBodyRequired(requestBody) {
    if (!requestBody) return [];
    const schema = resolveDocRef(resolveDocRef(requestBody).content?.["application/json"]?.schema);
    if (!schema || schema.type === "array") return [];
    const required = new Set();
    const collectRequired = (s) => {
      const r = resolveDocRef(s);
      if (!r) return;
      if (Array.isArray(r.required)) for (const name of r.required) if (typeof name === "string") required.add(name);
      if (Array.isArray(r.allOf)) for (const sub of r.allOf) if (sub) collectRequired(sub);
    };
    collectRequired(schema);
    return [...required];
  }

  /**
   * A discriminated oneOf JSON body: the discriminator field and, per value, the fields only that variant requires.
   */
  function extractBodyDiscriminator(requestBody) {
    if (!requestBody) return undefined;
    const jsonSchema = resolveDocRef(resolveDocRef(requestBody).content?.["application/json"]?.schema);
    if (!jsonSchema?.oneOf) return undefined;
    const discriminator = jsonSchema.discriminator;
    if (!discriminator?.propertyName) return undefined;
    const field = discriminator.propertyName;
    const variantRequireds = [];
    for (const variantRef of jsonSchema.oneOf) {
      const variant = resolveDocRef(variantRef);
      if (!variant?.properties) continue;
      // the variant's own single-value enum on the discriminator, else the mapping entry that names the variant's $ref
      const discProp = resolveDocRef(variant.properties[field]);
      let value = null;
      if (discProp && Array.isArray(discProp.enum) && discProp.enum.length === 1 && typeof discProp.enum[0] === "string") value = discProp.enum[0];
      else if (discriminator.mapping) value = Object.entries(discriminator.mapping).find(([, v]) => v === variantRef.$ref)?.[0] ?? null;
      if (value == null) continue;
      variantRequireds.push({ value, required: Array.isArray(variant.required) ? variant.required.map(String) : [] });
    }
    if (variantRequireds.length === 0) return undefined;
    let common = null;
    for (const v of variantRequireds) common = common === null ? new Set(v.required) : new Set(v.required.filter((r) => common.has(r)));
    const variants = {};
    for (const v of variantRequireds) variants[v.value] = v.required.filter((r) => !common.has(r));
    return { field, variants };
  }

  /** Merge an allOf composition into one object schema (properties, required, the first oneOf and description). */
  function flattenAllOf(list) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const s of list) {
      const resolved = resolveSchemaRef(s);
      for (const [key, val] of Object.entries(resolved.properties ?? {})) if (val) merged.properties[key] = val;
      if (resolved.required) merged.required = [...merged.required, ...resolved.required];
      if (resolved.oneOf && !merged.oneOf) merged.oneOf = resolved.oneOf;
      if (resolved.description && !merged.description) merged.description = resolved.description;
      if (resolved.allOf) {
        const nested = flattenAllOf(resolved.allOf);
        for (const [key, val] of Object.entries(nested.properties ?? {})) if (val) merged.properties[key] = val;
        if (nested.required) merged.required = [...merged.required, ...nested.required];
        if (nested.oneOf && !merged.oneOf) merged.oneOf = nested.oneOf;
      }
    }
    merged.required = [...new Set(merged.required)];
    return merged;
  }

  function isObjectValuedSchema(schema, active = new Set()) {
    if (active.has(schema)) return false;
    const nextActive = new Set([...active, schema]);
    const resolved = resolveSchemaRef(schema);
    if (resolved !== schema) return isObjectValuedSchema(resolved, nextActive);
    if (resolved.type === "object" || resolved.properties !== undefined) return true;
    if (resolved.oneOf?.length) return resolved.oneOf.every((variant) => isObjectValuedSchema(variant, nextActive));
    if (resolved.anyOf?.length) return resolved.anyOf.every((variant) => isObjectValuedSchema(variant, nextActive));
    if (resolved.allOf?.length) return resolved.allOf.some((member) => isObjectValuedSchema(member, nextActive));
    return false;
  }

  /**
   * An array body property as one parameter: scalar arrays stay repeatable values; an array of objects directly under
   * the body root is one JSON-valued parameter (itemType "object").
   */
  function createArrayBodyParam(arraySchema, rawArraySchema, name, apiFieldPath, required) {
    if (!arraySchema.items) return undefined;
    const items = resolveSchemaRef(arraySchema.items);
    const hasScalarItems = items.type === "string" || items.type === "number" || items.type === "integer";
    const hasObjectItems = apiFieldPath.length === 1 && isObjectValuedSchema(arraySchema.items);
    if (!hasScalarItems && !hasObjectItems) return undefined;
    /** @type {BodyParamInfo} */
    const info = { name, required, type: "array", apiFieldPath };
    if (hasObjectItems) info.itemType = "object";
    if (arraySchema.description) info.description = arraySchema.description;
    if (arraySchema["x-sensitive"] === true || rawArraySchema["x-sensitive"] === true) info.sensitive = true;
    return info;
  }

  /** A scalar body property as one parameter. */
  function scalarBodyParam(resolved, propSchema, name, apiFieldPath, required) {
    /** @type {BodyParamInfo} */
    const info = { name, required, type: resolved.type === "integer" ? "number" : resolved.type, apiFieldPath };
    if (resolved.description) info.description = resolved.description;
    if (Array.isArray(resolved.enum)) info.enumValues = resolved.enum.filter((v) => typeof v === "string" && v !== "");
    if (resolved.default !== undefined && isScalarDefault(resolved.default)) info.default = resolved.default;
    if (resolved["x-sensitive"] === true || propSchema["x-sensitive"] === true) info.sensitive = true;
    return info;
  }

  const SCALARS = new Set(["string", "number", "integer", "boolean"]);

  /**
   * Body properties as flat parameters, recursing into nested objects with kebab-prefixed names (depth ≤ 3).
   */
  function extractPropertiesFromSchema(schema, prefix, fieldPath, requiredSet, depth) {
    if (depth > 3) return [];
    const results = [];
    if (!schema.properties) return results;
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (!propSchema) continue;
      const resolved = resolveSchemaRef(propSchema);
      if (resolved.readOnly) continue;  // id, created_on …
      if (/[/~.[\]{}()]/.test(propName)) continue;  // not a valid flag
      const segment = propertyFlagSegment(propName, propSchema);
      const flagName = prefix ? `${prefix}-${segment}` : segment;
      const currentPath = [...fieldPath, propName];
      const isRequired = requiredSet.has(propName);
      // a property-level oneOf (a non-discriminated union of shapes)
      if (resolved.oneOf) {
        results.push(...deriveOneOfConstraints(resolved.oneOf, flagName, currentPath, depth + 1));
        continue;
      }
      if (resolved.allOf) {
        const merged = flattenAllOf(resolved.allOf);
        if (merged.oneOf) {
          results.push(...deriveOneOfConstraints(merged.oneOf, flagName, currentPath, depth + 1));
          continue;
        }
      }
      if (resolved.type === "object" || resolved.properties || resolved.allOf) {
        const nestedSchema = resolved.allOf ? flattenAllOf(resolved.allOf) : resolved;
        results.push(...extractPropertiesFromSchema(nestedSchema, flagName, currentPath, new Set(nestedSchema.required ?? []), depth + 1));
      } else if (SCALARS.has(resolved.type)) {
        results.push(scalarBodyParam(resolved, propSchema, flagName, currentPath, isRequired));
      } else if (resolved.type === "array" && resolved.items) {
        const info = createArrayBodyParam(resolved, propSchema, flagName, currentPath, isRequired);
        if (info) results.push(info);
      }
      // other shapes stay in --body territory
    }
    return results;
  }

  /** Every property name a variant contributes (nested leaves included). */
  function collectVariantPropNames(schema, depth = 0) {
    const names = new Set();
    if (depth > 3 || !schema.properties) return names;
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!sub) continue;
      names.add(name);
      let resolved = resolveSchemaRef(sub);
      if (resolved.allOf) resolved = flattenAllOf(resolved.allOf);
      if (resolved.type === "object" || resolved.properties) for (const deep of collectVariantPropNames(resolved, depth + 1)) names.add(deep);
    }
    return names;
  }

  /** Union of two enum schemas' values; the first schema stays the base (its default wins). */
  function mergeEnumSchemas(a, b) {
    const resolvedA = resolveSchemaRef(a);
    const resolvedB = resolveSchemaRef(b);
    if (!Array.isArray(resolvedA.enum) || !Array.isArray(resolvedB.enum)) return null;
    const merged = { ...resolvedA, enum: [...new Set([...resolvedA.enum, ...resolvedB.enum])] };
    const fernName = fernPropertyName(a) ?? fernPropertyName(b);
    if (fernName !== undefined) merged["x-fern-property-name"] = fernName;
    return merged;
  }

  /** Deep-merge two object schemas: union of properties, intersection of required. Null unless both are objects. */
  function deepMergeObjectSchemas(a, b) {
    let resolvedA = resolveSchemaRef(a);
    let resolvedB = resolveSchemaRef(b);
    if (resolvedA.allOf) resolvedA = flattenAllOf(resolvedA.allOf);
    if (resolvedB.allOf) resolvedB = flattenAllOf(resolvedB.allOf);
    const isObj = (s) => s.type === "object" || s.properties !== undefined;
    if (!isObj(resolvedA) || !isObj(resolvedB)) return null;
    const mergedProps = { ...resolvedA.properties };
    for (const [key, val] of Object.entries(resolvedB.properties ?? {})) {
      if (!val) continue;
      const existing = mergedProps[key];
      if (!existing) {
        mergedProps[key] = val;
        continue;
      }
      const recursed = deepMergeObjectSchemas(existing, val);
      if (recursed) mergedProps[key] = recursed;
      else {
        const mergedEnum = mergeEnumSchemas(existing, val);
        if (mergedEnum) mergedProps[key] = mergedEnum;
      }
      // otherwise the first wins
    }
    const aRequired = new Set(resolvedA.required ?? []);
    const merged = { type: "object", properties: mergedProps, required: (resolvedB.required ?? []).filter((r) => aRequired.has(r)) };
    if (resolvedA.description) merged.description = resolvedA.description;
    const fernName = fernPropertyName(a) ?? fernPropertyName(b);
    if (fernName !== undefined) merged["x-fern-property-name"] = fernName;
    return merged;
  }

  /**
   * oneOf variants → parameters with constraints: fields unique to one variant conflict with fields unique to another;
   * fields a variant requires together imply each other (unless another variant requires them too).
   */
  function deriveOneOfConstraints(variants, prefix, fieldPath, depth) {
    if (depth > 3) return [];
    const resolvedVariants = variants.map((variant) => {
      let resolved = resolveSchemaRef(variant);
      if (resolved.allOf) resolved = flattenAllOf(resolved.allOf);
      return { schema: resolved, propNames: collectVariantPropNames(resolved), requiredNames: new Set(resolved.required ?? []) };
    });
    let commonRequired = null;
    for (const v of resolvedVariants) {
      if (commonRequired === null) commonRequired = new Set(v.requiredNames);
      else for (const name of commonRequired) if (!v.requiredNames.has(name)) commonRequired.delete(name);
    }
    commonRequired = commonRequired ?? new Set();
    // the same property in several variants: object shapes deep-merge, enums union, otherwise the first wins
    const mergedProperties = {};
    for (const v of resolvedVariants) {
      for (const [name, schema] of Object.entries(v.schema.properties ?? {})) {
        if (!schema) continue;
        const existing = mergedProperties[name];
        if (!existing) {
          mergedProperties[name] = schema;
          continue;
        }
        const deepMerged = deepMergeObjectSchemas(existing, schema);
        if (deepMerged) mergedProperties[name] = deepMerged;
        else {
          const mergedEnum = mergeEnumSchemas(existing, schema);
          if (mergedEnum) mergedProperties[name] = mergedEnum;
        }
      }
    }
    const params = extractPropertiesFromSchema({ type: "object", properties: mergedProperties, required: [...commonRequired] }, prefix, fieldPath, commonRequired, depth);
    const propToFlag = new Map();
    for (const p of params) {
      const lastSegment = p.apiFieldPath[p.apiFieldPath.length - 1];
      if (lastSegment) propToFlag.set(lastSegment, p.name);
    }
    for (let i = 0; i < resolvedVariants.length; i++) {
      for (let j = i + 1; j < resolvedVariants.length; j++) {
        const vi = resolvedVariants[i];
        const vj = resolvedVariants[j];
        const uniqueToI = [...vi.propNames].filter((n) => !vj.propNames.has(n));
        const uniqueToJ = [...vj.propNames].filter((n) => !vi.propNames.has(n));
        if (uniqueToI.length === 0 || uniqueToJ.length === 0) continue;
        const flagsI = uniqueToI.map((n) => propToFlag.get(n)).filter(Boolean);
        const flagsJ = uniqueToJ.map((n) => propToFlag.get(n)).filter(Boolean);
        const setI = new Set(uniqueToI);
        const setJ = new Set(uniqueToJ);
        for (const param of params) {
          const lastSegment = param.apiFieldPath[param.apiFieldPath.length - 1];
          if (!lastSegment) continue;
          if (setI.has(lastSegment)) param.conflicts = [...new Set([...(param.conflicts ?? []), ...flagsJ])];
          if (setJ.has(lastSegment)) param.conflicts = [...new Set([...(param.conflicts ?? []), ...flagsI])];
        }
      }
    }
    // a field required by more than one variant does not tell which variant was picked: no implies for it
    const variantSpecificRequiredCount = new Map();
    for (const v of resolvedVariants) {
      for (const name of v.requiredNames) {
        if (commonRequired.has(name)) continue;
        variantSpecificRequiredCount.set(name, (variantSpecificRequiredCount.get(name) ?? 0) + 1);
      }
    }
    for (const v of resolvedVariants) {
      const variantSpecificRequired = [...v.requiredNames].filter((n) => !commonRequired.has(n));
      if (variantSpecificRequired.length <= 1) continue;
      for (const propName of variantSpecificRequired) {
        if ((variantSpecificRequiredCount.get(propName) ?? 0) > 1) continue;
        const param = params.find((p) => p.name === propToFlag.get(propName));
        if (!param) continue;
        const others = variantSpecificRequired.filter((n) => n !== propName).map((n) => propToFlag.get(n)).filter(Boolean);
        if (others.length > 0) param.implies = [...new Set([...(param.implies ?? []), ...others])];
      }
    }
    return params;
  }

  /** The JSON body's properties as flat parameters (allOf flattened, oneOf constraints derived). */
  function extractBodyProperties(requestBody) {
    const jsonSchema = requestBody?.content?.["application/json"]?.schema;
    if (!jsonSchema) return [];
    let resolved = resolveSchemaRef(jsonSchema);
    if (resolved.allOf) resolved = flattenAllOf(resolved.allOf);
    // the whole body is a oneOf
    if (resolved.oneOf && !resolved.properties) return deriveOneOfConstraints(resolved.oneOf, "", [], 0);
    const requiredSet = new Set(resolved.required ?? []);
    const results = [];
    for (const [propName, propSchema] of Object.entries(resolved.properties ?? {})) {
      if (!propSchema) continue;
      const propResolved = resolveSchemaRef(propSchema);
      if (propResolved.readOnly) continue;
      const flagPrefix = propertyFlagSegment(propName, propSchema);
      const currentPath = [propName];
      const isRequired = requiredSet.has(propName);
      if (propResolved.oneOf) {
        results.push(...deriveOneOfConstraints(propResolved.oneOf, flagPrefix, currentPath, 1));
        continue;
      }
      if (propResolved.allOf) {
        const merged = flattenAllOf(propResolved.allOf);
        if (merged.oneOf) results.push(...deriveOneOfConstraints(merged.oneOf, flagPrefix, currentPath, 1));
        else results.push(...extractPropertiesFromSchema(merged, flagPrefix, currentPath, new Set(merged.required ?? []), 1));
        continue;
      }
      if (propResolved.type === "object" || propResolved.properties) {
        results.push(...extractPropertiesFromSchema(propResolved, flagPrefix, currentPath, new Set(propResolved.required ?? []), 1));
        continue;
      }
      if (SCALARS.has(propResolved.type)) results.push(scalarBodyParam(propResolved, propSchema, flagPrefix, currentPath, isRequired));
      else if (propResolved.type === "array" && propResolved.items) {
        const info = createArrayBodyParam(propResolved, propSchema, flagPrefix, currentPath, isRequired);
        if (info) results.push(info);
      }
    }
    return results;
  }

  /** One response body: the schema with its top-level $ref resolved, the declared schema, its ref and array-ness. */
  function extractResponseBody(rawSchema) {
    if (!rawSchema) return { ref: null, isArray: false, itemRef: null };
    const resolved = rawSchema.$ref ? resolveSchemaRef(rawSchema) : rawSchema;
    const isArray = resolved.type === "array";
    return { schema: resolved, rawSchema, ref: extractRef(rawSchema), isArray, itemRef: isArray && resolved.items ? extractRef(resolved.items) : null };
  }

  /** Every declared response, status keys verbatim, each body's schema resolved once at the top. */
  function extractResponses(responses) {
    const result = {};
    for (const [status, rawResponse] of Object.entries(responses ?? {})) {
      if (!rawResponse) continue;
      // a response can itself be a $ref into #/components/responses
      const response = resolveDocRef(rawResponse);
      const info = { content: {} };
      if (typeof response.description === "string" && response.description.length > 0) info.description = response.description;
      for (const [mediaType, body] of Object.entries(response.content ?? {})) if (body) info.content[mediaType] = extractResponseBody(body.schema);
      result[status] = info;
    }
    return result;
  }

  /** The 2xx responses in status order ("200" < "201" < "2XX"), each media type with its declared schema. */
  function extractSuccess(responses) {
    return Object.entries(responses)
      .filter(([status]) => /^2(\d\d|XX|xx)$/.test(status))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, r]) => ({
        status,
        ...(r.description !== undefined ? { description: r.description } : {}),
        content: Object.entries(r.content).map(([mediaType, body]) => ({ mediaType, ...(body.rawSchema !== undefined ? { schema: body.rawSchema } : {}) })),
      }));
  }

  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;
      const { operationId, derived } = operationIdOf(method, path, operation);
      const responses = extractResponses(operation.responses);
      // #/components/requestBodies/… resolved once; any declared media type is a body (a bare { type: object } too)
      const resolvedRequestBody = operation.requestBody ? resolveDocRef(operation.requestBody) : undefined;
      const requestBody = resolvedRequestBody?.content && Object.keys(resolvedRequestBody.content).length > 0 ? resolvedRequestBody : undefined;
      const requestContentTypes = requestBody ? Object.keys(requestBody.content) : [];
      const requestBodyMediaType = requestContentTypes.find(isJsonMediaType) ?? requestContentTypes[0] ?? null;
      const requestBodyDescription = extractRequestBodyDescription(requestBody);
      const multipart = extractMultipart(requestBody);
      const bodyDiscriminator = extractBodyDiscriminator(requestBody);
      const maxItems = extractBodyMaxItems(requestBody);
      const arrayBodyInfo = extractArrayBodyInfo(requestBody);
      const parameters = mergeParameters(pathItem.parameters, operation.parameters);
      /** @type {OperationInfo} */
      const info = {
        operationId,
        operationIdDerived: derived,
        path,
        method,
        summary: operation.summary ?? "",
        description: operation.description ?? "",
        tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
        deprecated: operation.deprecated === true,
        parameters: extractWireParameters(parameters),
        pathParams: extractParameters(parameters, "path"),
        queryParams: extractParameters(parameters, "query"),
        headerParams: extractParameters(parameters, "header"),
        cookieParams: extractParameters(parameters, "cookie"),
        bodyParams: extractBodyProperties(requestBody),
        hasRequestBody: !!requestBody,
        requestBodyIsRequired: !!requestBody && requestBody.required === true,
        requestContentTypes,
        requestBodyMediaType,
        requestBodySchema: requestBodyMediaType ? requestBody.content[requestBodyMediaType]?.schema : undefined,
        requestBodyRef: extractRef(requestBody?.content?.["application/json"]?.schema),
        requestBodyRequired: extractRequestBodyRequired(requestBody),
        requestBodyIsArray: arrayBodyInfo.isArray,
        requestBodyArrayItemRef: arrayBodyInfo.itemRef,
        responses,
        success: extractSuccess(responses),
      };
      if (requestBodyDescription !== undefined) info.requestBodyDescription = requestBodyDescription;
      if (multipart !== undefined) info.multipart = multipart;
      if (bodyDiscriminator !== undefined) info.bodyDiscriminator = bodyDiscriminator;
      if (maxItems !== undefined) info.maxItems = maxItems;
      operationMap.set(operationId, info);
    }
  }

  return {
    document: openapi,
    /** @param {string} operationId apostrophes are stripped, like the keys */
    resolveOperation: (operationId) => operationMap.get(String(operationId).replace(/'/g, "")),
    getAllOperationIds: () => [...operationMap.keys()],
    hasOperation: (operationId) => operationMap.has(operationId),
    resolveSchemaRef,
    resolveDocRef: (value) => resolveDocRef(value),
  };
}

/** Whether a value is an OpenAPI document the resolver can read (paths; components optional). */
function isOpenAPISpec(value) {
  if (typeof value !== "object" || value === null) return false;
  if (typeof value.paths !== "object" || value.paths === null) return false;
  if (value.components !== undefined && (typeof value.components !== "object" || value.components === null)) return false;
  return true;
}

// ── upstream's module API: one current document ──────────────────────────────────────────────────────────────────────

let current = createResolver({ paths: {} });

/** Load a document into the module-level resolver (upstream API; a Forge instance keeps its own resolver). */
export function populateOperationMap(value) {
  current = createResolver(value);
  return current;
}

/** @param {string} operationId @returns {OperationInfo | undefined} */
export const resolveOperation = (operationId) => current.resolveOperation(operationId);
/** @returns {string[]} */
export const getAllOperationIds = () => current.getAllOperationIds();
/** @param {string} operationId */
export const hasOperation = (operationId) => current.hasOperation(operationId);
/** @template T @param {T} schema @returns {T} */
export const resolveSchemaRef = (schema) => current.resolveSchemaRef(schema);
/** @template T @param {T} value @returns {T} */
export const resolveDocRef = (value) => current.resolveDocRef(value);

/**
 * The response key that answers an HTTP status: exact ("401"), then its range ("4XX" or "4xx"), then "default".
 * @param {number} status
 * @param {Iterable<string>} availableKeys
 * @returns {string | undefined}
 */
export function matchResponseStatusKey(status, availableKeys) {
  if (!Number.isInteger(status)) return undefined;
  const keys = new Set(availableKeys);
  const exact = String(status);
  if (keys.has(exact)) return exact;
  if (status >= 100 && status <= 599) {
    const bucketDigit = Math.floor(status / 100);
    if (keys.has(`${bucketDigit}XX`)) return `${bucketDigit}XX`;
    if (keys.has(`${bucketDigit}xx`)) return `${bucketDigit}xx`;
  }
  return keys.has("default") ? "default" : undefined;
}

export { LOCATIONS };
