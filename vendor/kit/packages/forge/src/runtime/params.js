// OpenAPI 3.1 parameter serialization (§4.8.12.4 style values, explode, allowReserved; content-encoded parameters).
// This file is inlined verbatim into every generated index.mjs (kit sdk generate) and unit-tested on its own.
//   path:   simple (default), label, matrix        query: form (default), spaceDelimited, pipeDelimited, deepObject
//   header: simple                                  cookie: form (primitives and explode: false lists/objects)
// Combinations the specification leaves undefined are refused when the SDK is generated (checkParam), never guessed.

/** Percent-encode; allowReserved keeps RFC 3986 reserved characters as they are (query only). */
export function encodeValue(value, allowReserved = false) {
  const s = String(value);
  if (!allowReserved) return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return s.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (c) => encodeURIComponent(c)).replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
}

const kindOf = (v) => (Array.isArray(v) ? "array" : v !== null && typeof v === "object" ? "object" : "primitive");
const pairs = (o) => Object.entries(o).filter(([, x]) => x !== undefined && x !== null);

/**
 * Serialize one parameter value. p = { name, in, style, explode, allowReserved, json }.
 * Returns { path } (the replacement of {name}), { query: ["k=v", …] }, { header } or { cookie: "k=v" }.
 */
export function serializeParam(p, value) {
  const enc = (x) => encodeValue(x, p.allowReserved);
  const v = p.json ? JSON.stringify(value) : value;
  const kind = kindOf(v);
  const name = p.in === "query" || p.in === "cookie" ? encodeValue(p.name) : p.name;
  if (p.in === "path") {
    const sep = p.style === "label" ? (p.explode ? "." : ",") : p.style === "matrix" ? (p.explode ? ";" : ",") : ",";
    const prefix = p.style === "label" ? "." : "";
    let body;
    if (kind === "primitive") body = p.style === "matrix" ? `;${name}=${enc(v)}` : `${prefix}${enc(v)}`;
    else if (kind === "array") {
      if (p.style === "matrix") body = p.explode ? v.map((x) => `;${name}=${enc(x)}`).join("") : `;${name}=${v.map(enc).join(",")}`;
      else body = prefix + v.map(enc).join(sep);
    } else {
      const kv = pairs(v);
      if (p.style === "matrix") body = p.explode ? kv.map(([k, x]) => `;${enc(k)}=${enc(x)}`).join("") : `;${name}=${kv.map(([k, x]) => `${enc(k)},${enc(x)}`).join(",")}`;
      else body = prefix + (p.explode ? kv.map(([k, x]) => `${enc(k)}=${enc(x)}`).join(sep) : kv.map(([k, x]) => `${enc(k)},${enc(x)}`).join(","));
    }
    return { path: body };
  }
  if (p.in === "header") {
    if (kind === "primitive") return { header: String(v) };
    if (kind === "array") return { header: v.map(String).join(",") };
    const kv = pairs(v);
    return { header: p.explode ? kv.map(([k, x]) => `${k}=${x}`).join(",") : kv.map(([k, x]) => `${k},${x}`).join(",") };
  }
  if (p.in === "cookie") {
    if (kind === "primitive") return { cookie: `${name}=${enc(v)}` };
    const list = kind === "array" ? v.map(enc) : pairs(v).flatMap(([k, x]) => [enc(k), enc(x)]);
    return { cookie: `${name}=${list.join(",")}` };
  }
  // query
  const style = p.style || "form";
  if (kind === "primitive") return { query: [`${name}=${enc(v)}`] };
  if (style === "deepObject") return { query: pairs(v).map(([k, x]) => `${name}%5B${enc(k)}%5D=${enc(x)}`) };
  if (kind === "array") {
    if (p.explode) return { query: v.map((x) => `${name}=${enc(x)}`) };
    const sep = style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "%7C" : ",";
    return { query: [`${name}=${v.map(enc).join(sep)}`] };
  }
  const kv = pairs(v);
  if (p.explode) return { query: kv.map(([k, x]) => `${enc(k)}=${enc(x)}`) };
  const sep = style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "%7C" : ",";
  return { query: [`${name}=${kv.map(([k, x]) => `${enc(k)}${sep}${enc(x)}`).join(sep)}`] };
}

/** Every parameter of an operation → { path, query, headers, cookie } (throws on a missing required one). */
export function serializeParams(operationId, op, params = {}) {
  let path = op.path;
  const query = [];
  const headers = {};
  const cookies = [];
  for (const p of op.params) {
    const v = params[p.name];
    if (v === undefined || v === null) {
      if (p.required) throw new TypeError(`${operationId}: missing required ${p.in} parameter "${p.name}"`);
      continue;
    }
    const s = serializeParam(p, v);
    if (p.in === "path") path = path.split(`{${p.name}}`).join(s.path);
    else if (p.in === "query") query.push(...s.query);
    else if (p.in === "header") headers[p.name] = s.header;
    else if (p.in === "cookie") cookies.push(s.cookie);
  }
  return { path, query: query.join("&"), headers, cookie: cookies.join("; ") };
}

/** The JSON media type of a list (application/json, application/problem+json …), or undefined. */
export const jsonMediaType = (types) => types.find((t) => /^application\/(.+\+)?json\b/i.test(t));
const isBinaryBody = (b) => (typeof Blob !== "undefined" && b instanceof Blob) || b instanceof ArrayBuffer || ArrayBuffer.isView(b) || (typeof ReadableStream !== "undefined" && b instanceof ReadableStream);

/**
 * A request body by its declared media type: { body, contentType } (body undefined: no body).
 *   undefined                      omitted (a required body throws); null is JSON null
 *   a JSON media type (or none)    JSON.stringify — a string too ("hello" → "\"hello\""); bytes, Blob, streams as they are
 *   application/x-www-form-urlencoded with an object   URLSearchParams
 *   text/*, octet-stream, others   a string or bytes as they are, a number or boolean as text, an object refused;
 *                                  FormData lets fetch set the type
 * The content type is the declared one (the JSON one when there is one).
 */
export function encodeBody(operationId, spec, b) {
  if (b === undefined) {
    if (spec.required) throw new TypeError(`${operationId}: missing required body`);
    return { body: undefined };
  }
  const json = spec.contentTypes.length ? jsonMediaType(spec.contentTypes) : "application/json";
  const media = json ?? spec.contentTypes[0];
  if (typeof FormData !== "undefined" && b instanceof FormData) return { body: b };
  if (json) return isBinaryBody(b) ? { body: b, contentType: json } : { body: JSON.stringify(b), contentType: json };
  if (b === null) {
    if (spec.required) throw new TypeError(`${operationId}: missing required body`);
    return { body: undefined };
  }
  if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return { body: b.toString(), contentType: media };
  if (media === "application/x-www-form-urlencoded" && typeof b === "object" && !isBinaryBody(b)) return { body: new URLSearchParams(b).toString(), contentType: media };
  if (typeof b === "string" || isBinaryBody(b)) return { body: b, contentType: media };
  if (typeof b === "object") throw new TypeError(`${operationId}: a ${media} body is a string or bytes, not an object`);
  return { body: String(b), contentType: media };
}
