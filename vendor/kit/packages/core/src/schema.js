/**
 * JSON Schema 2020-12 validation without dependencies (Workers, Node, browsers). The constitution (docs/CONSTITUTION.md §2)
 * makes JSON Schema the one canonical declaration of every config, content and data shape; this is the one validator.
 *
 *   const v = createValidator([siteSchema, kitConfigSchema]);   // schemas registered by $id
 *   v.validate(value, "urn:kit:schema:kit-config:v1")           // → [{ path: "/site/url", message: "…" }, …] ([] = valid)
 *   validate(value, schema)                                     // one-off, schema object (its own $id/$defs)
 *
 * Supported: type (incl. "integer"), enum, const, properties, required, additionalProperties, patternProperties,
 * propertyNames, minProperties, maxProperties, dependentRequired, items, prefixItems, contains, minItems, maxItems,
 * uniqueItems, minLength, maxLength, pattern, format (date, date-time, uri, email, hex-color, uri-reference, github-branch-glob-excludes-archive),
 * minContains, maxContains (with contains), formatMinimum, formatMaximum (a date or date-time not before / not after a bound, read in the schema's `format`; a bound or
 * value that is not of that format is a failure), minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, anyOf, oneOf, not, if/then/else,
 * $ref (local JSON pointers "#/$defs/x", other registered schemas by $id, "$id#/pointer"; the target must be a schema position
 * of its document (a subschema, never a const, enum, default or other data), and a plain-name anchor "#name" is not supported), $defs.
 * Refused, never ignored: a keyword that is not implemented, the pre-2020-12 array form of `items` (write prefixItems), a `format`
 * that is not implemented, a $ref that does not reach a schema.
 * Annotations (title, description, default, examples, $comment, deprecated, readOnly, writeOnly) are ignored.
 * JavaScript values that JSON cannot hold (functions, undefined) match only the empty schema / true.
 */

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v; // string, boolean, object, function, undefined, bigint, symbol
};
const matchesType = (v, t) => {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
};
const esc = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (k) => decodeURIComponent(k).replace(/~1/g, "/").replace(/~0/g, "~");

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}


/**
 * Can this GitHub branch filter pattern match an archive branch (`archive/<date>/<name...>`, docs/NAMING.md: any date, a free-form
 * name of any depth)? An existential question answered by the pattern's structure, never by a list of sample branches:
 *  (a) a pattern with `**`: whatever follows its first `**` can be matched by the free-form name (the name may be that literal
 *      suffix), so the pattern matches an archive branch exactly when the text before the first `**`, compiled with `**` appended,
 *      matches the start of one: some date from the calendar (every day of 2000-2099, tried only when the first witness fails) and a
 *      name (`x`, or the prefix's own literal text) make `archive/<date>/<name>`: `**`, `*\/**`, `**\/release`, `arch*\/**\/x`,
 *      `archive/2026-10-14/**`;
 *  (b) a pattern without `**`: `*` stops at `/`, so it matches only branches of its own segment count; an archive branch has at least
 *      three segments (archive, date, name), so the pattern is refused when its first segment can match "archive" and two more
 *      segments follow (`archive/*\/*`, `archive/*\/x`);
 *  (c) a pattern that starts with `!` negates: never a match.
 */
export function matchesArchiveBranch(glob) {
  if (glob.startsWith("!")) return false;
  const star = glob.indexOf("**");
  if (star >= 0) {
    const re = githubGlobRe(`${glob.slice(0, star)}**`);
    const names = ["x", glob.slice(0, star).split("/").slice(2).join("/").replace(/[*?+[\]\\]/g, "")];
    if (names.some((n) => re.test(`archive/2026-10-13/${n}`))) return true;
    const head = `${glob.slice(0, star)}**`.split("/");
    if (head.length > 1 && !githubGlobRe(head[0]).test("archive")) return false;   // the first segment is never "archive": no date can help
    for (let y = 2000; y < 2100; y++) for (let d = 0; d < 366; d++) {
      const day = new Date(Date.UTC(y, 0, 1 + d));
      if (day.getUTCFullYear() !== y) break;
      const date = day.toISOString().slice(0, 10);
      if (names.some((n) => re.test(`archive/${date}/${n}`))) return true;
    }
    return false;
  }
  const [first, ...rest] = glob.split("/");
  return rest.length >= 2 && githubGlobRe(first).test("archive");
}
/**
 * GitHub's filter-pattern syntax (workflow syntax, "Filter pattern cheat sheet") as a RegExp over a whole ref name: `*` any
 * characters but `/`, `**` any characters, `?` zero or one of the preceding character, `+` one or more of it, `[...]` a class,
 * `\` escapes the next character; everything else is literal. A pattern that starts with `!` negates and is not handled here.
 */
export function githubGlobRe(glob) {
  const atoms = [];
  const lit = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") { if (glob[i + 1] === "*") { atoms.push(".*"); i++; } else atoms.push("[^/]*"); }
    else if (c === "?" || c === "+") { if (!atoms.length) atoms.push(lit(c)); else atoms[atoms.length - 1] = `(?:${atoms[atoms.length - 1]})${c}`; }
    else if (c === "[") { const end = glob.indexOf("]", i + 1); if (end < 0) atoms.push(lit(c)); else { atoms.push(`[${glob.slice(i + 1, end).replace(/\\/g, "\\\\")}]`); i = end; } }
    else if (c === "\\" && i + 1 < glob.length) atoms.push(lit(glob[++i]));
    else atoms.push(lit(c));
  }
  return new RegExp(`^${atoms.join("")}$`, "u");
}

const FORMATS = {
  date: (s) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; },
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)),
  uri: (s) => /^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(s),
  "uri-reference": (s) => !/\s/.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  /** A GitHub branch filter pattern that no `archive/<date>/<name>` branch matches (GitHub's own syntax, evaluated, never a list of forms): see githubGlobRe. */
  "github-branch-glob-excludes-archive": (s) => !matchesArchiveBranch(s),
  "hex-color": (s) => /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s),
};

/** A JSON Pointer fragment ("/a/b~1c") as its decoded tokens; throws on a percent-escape that is not one. */
const tokens = (frag) => frag.slice(1).split("/").map(unesc);

/** Keywords the validator implements, and the annotation-only keywords it knows are no-ops: the one list. Any other keyword is refused. */
export const KEYWORDS = new Set(["$ref", "type", "const", "enum", "minLength", "maxLength", "pattern", "format", "formatMinimum", "formatMaximum",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "prefixItems", "items", "contains",
  "minContains", "maxContains", "minProperties", "maxProperties", "required", "dependentRequired", "properties", "patternProperties", "additionalProperties", "propertyNames",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else"]);
export const ANNOTATIONS = new Set(["$comment", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly", "$schema", "$id", "$defs"]);
/**
 * Extension keywords this validator ignores because other code enforces them. Each value is the path of the test file that
 * fails when its rule is broken (a test checks the path exists, packages/core/test/schema.test.mjs); the enforcing code:
 * x-*-by-origin: packages/core/src/podcast-provenance.js (checkProvenance) and podcast-provenance-sql.js (triggers), proven by
 * packages/core/test/podcast-provenance.test.mjs;
 * x-minTau2OverTau1: packages/sim/src/nss.js (validateNss, NSS_BOUNDS.minRatio equal to the schema value), proven by
 * packages/sim/test/curves.test.mjs (the bound: below, at, above), and packages/sim/test/review.test.mjs (schema value = code value).
 * A name is listed only when that is true; a typo or an unenforced rule is refused.
 */
export const EXTENSIONS = Object.freeze({
  "x-trigger-by-origin": "packages/core/test/podcast-provenance.test.mjs",
  "x-required-by-origin": "packages/core/test/podcast-provenance.test.mjs",
  "x-allowed-only-by-origin": "packages/core/test/podcast-provenance.test.mjs",
  "x-minTau2OverTau1": "packages/sim/test/curves.test.mjs",
});
const SUBSCHEMA = new Set(["items", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"]);
const SUBSCHEMAS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs"]);

/**
 * Whether the JSON Pointer tokens lead from a schema document's root to a schema: each step is a keyword that holds a subschema
 * (then the next token names the entry of a map or the index of a list, where the keyword holds several), and the node it
 * ends on is an object or a boolean. A pointer into const, enum, default, examples or any other data is not a schema.
 */
function reachesSchema(root, path) {
  let node = root;
  for (let i = 0; i < path.length; i++) {
    if (!isObj(node)) return false;
    const k = path[i];
    if (SUBSCHEMA.has(k)) node = node[k];
    else if (SUBSCHEMAS.has(k) || SCHEMA_MAPS.has(k)) {
      if (i + 1 >= path.length || !isObj(node[k]) && !Array.isArray(node[k]) || !Object.hasOwn(node[k], path[i + 1])) return false;
      if (SCHEMA_MAPS.has(k) === Array.isArray(node[k])) return false;
      node = node[k][path[++i]];
    } else return false;
  }
  return isObj(node) || typeof node === "boolean";
}

/**
 * Throws on any keyword the validator does not implement, naming it and its JSON Pointer: an unknown keyword would otherwise be
 * ignored and the schema would pass what it was written to refuse (constitution §11). const, enum, default and examples hold
 * data and are not walked; the keys of properties, patternProperties and $defs are names, not keywords. Also refused, for the
 * same reason: the array form of `items` (the pre-2020-12 tuple form, which this validator would ignore: write prefixItems), a
 * keyword that holds a subschema and holds something else, and a `format` that is not in `formats` (the formats the validator
 * implements, by default; an unknown format would pass every value), and a value of an implemented keyword of the wrong shape
 * (a non-array enum, `required` as a string, a count that is not a non-negative integer, a pattern that is not a regular expression,
 * an unsubstituted {"$bind"}). With `refs` (an array) every $ref met is collected for the caller to resolve.
 */
export function assertSupported(schema, at = "", formats = FORMATS, refs = null) {
  if (!isObj(schema)) return;
  for (const [k, v] of Object.entries(schema)) {
    const here = `${at}/${esc(k)}`;
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k) && !Object.hasOwn(EXTENSIONS, k)) throw new Error(`unsupported keyword "${k}" at ${here}: the validator would ignore it and pass what the schema was written to refuse; implement it in packages/core/src/schema.js or correct the schema`);
    if (k === "format" && (typeof v !== "string" || !Object.hasOwn(formats, v))) throw new Error(`unknown format ${JSON.stringify(v)} at ${here}: the validator would pass every value; implemented formats: ${Object.keys(formats).join(", ")}`);
    if (k === "items" && Array.isArray(v)) throw new Error(`array-form items at ${here}: the pre-2020-12 tuple form is not implemented and would be ignored; write prefixItems for the positions and items for the rest`);
    if (SUBSCHEMA.has(k) && !isObj(v) && typeof v !== "boolean") throw new Error(`${k} at ${here} must be a schema (an object or a boolean)`);
    if (SUBSCHEMAS.has(k) && !Array.isArray(v)) throw new Error(`${k} at ${here} must be a list of schemas`);
    if (SCHEMA_MAPS.has(k) && !isObj(v)) throw new Error(`${k} at ${here} must be an object of schemas`);
    assertShape(k, v, here);
    if (k === "$ref") refs?.push({ ref: v, at: here });
    if (SCHEMA_MAPS.has(k)) for (const [name, sub] of Object.entries(v)) assertSupported(sub, `${here}/${esc(name)}`, formats, refs);
    else if (SUBSCHEMA.has(k)) assertSupported(v, here, formats, refs);
    else if (SUBSCHEMAS.has(k)) v.forEach((sub, i) => assertSupported(sub, `${here}/${i}`, formats, refs));
  }
}

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const COUNTS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]);
const NUMBERS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const isRegex = (x) => { try { new RegExp(x, "u"); return true; } catch { return false; /* the caller reports it as the malformed keyword it is */ } };
const isStrings = (x) => Array.isArray(x) && x.every((y) => typeof y === "string");
/** The first `{"$bind": …}` inside data (const, enum): a binding the engine did not substitute, which would be compared as the literal object. */
const unboundAt = (v, at) => {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = unboundAt(v[i], `${at}/${i}`); if (r) return r; } return null; }
  if (!isObj(v)) return null;
  if (Object.hasOwn(v, "$bind")) return `${at}/$bind`;
  for (const [k, x] of Object.entries(v)) { const r = unboundAt(x, `${at}/${esc(k)}`); if (r) return r; }
  return null;
};

/** The value of an implemented keyword has the shape the validator reads it in; any other is an error, never ignored, iterated as a string or coerced. */
function assertShape(k, v, here) {
  const fail = (what) => { throw new Error(`${k} at ${here} must be ${what}`); };
  if (k === "type" && !(typeof v === "string" ? TYPES.has(v) : Array.isArray(v) && v.length > 0 && v.every((x) => TYPES.has(x)))) fail(`one of ${[...TYPES].join(", ")}, or a non-empty list of them`);
  else if (k === "enum" && !Array.isArray(v)) fail("an array");
  else if (COUNTS.has(k) && !(Number.isInteger(v) && v >= 0)) fail("a non-negative integer");
  else if (NUMBERS.has(k) && !(typeof v === "number" && Number.isFinite(v))) fail("a finite number");
  else if (k === "multipleOf" && !(typeof v === "number" && v > 0 && Number.isFinite(v))) fail("a number above 0");
  else if (k === "uniqueItems" && typeof v !== "boolean") fail("a boolean");
  else if (k === "required" && !isStrings(v)) fail("a list of strings");
  else if (k === "dependentRequired") {
    if (!isObj(v)) fail("an object of lists of strings");
    for (const [name, deps] of Object.entries(v)) if (!isStrings(deps)) throw new Error(`dependentRequired at ${here}/${esc(name)} must be a list of strings`);
  } else if (k === "pattern" && typeof v !== "string") fail("a string");
  else if (k === "pattern" && !isRegex(v)) throw new Error(`pattern at ${here} is not a regular expression: ${JSON.stringify(v)}`);
  else if (k === "patternProperties") { for (const name of Object.keys(v)) if (!isRegex(name)) throw new Error(`patternProperties at ${here}/${esc(name)} is not a regular expression`); }
  else if ((k === "$ref" || k === "formatMinimum" || k === "formatMaximum") && typeof v !== "string") fail("a string");
  if (k === "const" || k === "enum") { const u = unboundAt(v, here); if (u) throw new Error(`$bind at ${u.slice(0, -"/$bind".length)} is not substituted: the engine replaces a {"$bind": …} before the schema is validated; here it would be compared as a literal object`); }
}

/** A validator over a set of schemas keyed by $id. */
export function createValidator(schemas = [], { formats = {} } = {}) {
  const byId = new Map();
  const checked = new WeakSet();
  const F = { ...FORMATS, ...formats };
  const add = (s) => {
    if (!isObj(s)) throw new TypeError("schema must be an object");
    const refs = [];
    assertSupported(s, "", F, refs);
    if (s.$id) byId.set(String(s.$id).replace(/#$/, ""), s);
    pending.push([s, refs]);
    return s;
  };
  const pending = [];   // [schema, its $refs]: resolved once the whole list is registered, so a $ref may name a schema that comes later
  /** Every $ref of the registered schemas resolves to a schema, whether or not an instance ever reaches its branch. */
  const resolveAll = () => {
    for (const [s, refs] of pending.splice(0)) for (const { ref, at } of refs) { const r = resolve(ref, s); if (r.error) throw new Error(`${r.error} at ${at}`); }
  };
  schemas.forEach(add);
  resolveAll();

  function resolve(ref, root) {
    let [base, frag = ""] = String(ref).split("#");
    if (base && !/^[a-z][a-z0-9+.-]*:/i.test(base) && root?.$id) { try { base = new URL(base, root.$id).href; } catch { /* not resolvable against $id: the ref is looked up as written, and a miss is reported */ } }
    const doc = base ? byId.get(base) : root;
    if (!doc) return { error: `unresolved $ref "${ref}"` };
    if (frag !== "" && !frag.startsWith("/")) return { error: `unresolved $ref "${ref}": a plain-name anchor is not supported, use a JSON Pointer ("#/$defs/name")` };
    let path;
    try { path = frag === "" ? [] : tokens(frag); } catch { return { error: `unresolved $ref "${ref}": the fragment is not a valid JSON Pointer` }; /* reported as the $ref error it is: the caller records it in the result */ }
    if (!reachesSchema(doc, path)) return { error: `unresolved $ref "${ref}": it does not lead to a schema (a $ref must name a subschema of its document, never data such as const, enum or default)` };
    return { node: path.reduce((n, k) => (isObj(n) || Array.isArray(n) ? n[k] : undefined), doc), root: doc };
  }

  function check(v, s, path, root, out) {
    if (s === true || s === undefined) return out;
    if (s === false) { out.push({ path, message: "not allowed here" }); return out; }
    if (!isObj(s)) return out;
    if (s.$ref != null) {
      const r = resolve(s.$ref, root);
      if (r.error) out.push({ path, message: r.error });
      else check(v, r.node, path, r.root, out);
    }
    const t = typeOf(v);
    if (s.type != null) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((x) => matchesType(v, x))) { out.push({ path, message: `must be ${types.join(" or ")} (got ${t})` }); return out; }
    }
    if (s.const !== undefined && !equal(v, s.const)) out.push({ path, message: `must be ${JSON.stringify(s.const)}` });
    if (Array.isArray(s.enum) && !s.enum.some((x) => equal(v, x))) out.push({ path, message: `must be one of ${s.enum.map((x) => JSON.stringify(x)).join(", ")} (got ${JSON.stringify(v)})` });

    if (t === "string") {
      const len = [...v].length;
      if (s.minLength != null && len < s.minLength) out.push({ path, message: `must have at least ${s.minLength} characters` });
      if (s.maxLength != null && len > s.maxLength) out.push({ path, message: `must have at most ${s.maxLength} characters` });
      if (s.pattern != null && !new RegExp(s.pattern, "u").test(v)) out.push({ path, message: `must match /${s.pattern}/ (got ${JSON.stringify(v)})` });
      if (s.format != null && F[s.format] && !F[s.format](v)) out.push({ path, message: `must be a valid ${s.format} (got ${JSON.stringify(v)})` });
      for (const [key, sign, word] of [["formatMinimum", 1, "before"], ["formatMaximum", -1, "after"]]) {
        if (s[key] == null) continue;
        const stamp = (x) => (s.format === "date" ? x : s.format === "date-time" ? Date.parse(x) : NaN);
        const readable = (s.format === "date" || s.format === "date-time") && F[s.format](v) && typeof s[key] === "string" && F[s.format](s[key]);
        if (!readable) out.push({ path, message: `${key} ${JSON.stringify(s[key])} cannot be compared with ${JSON.stringify(v)}: it needs "format": "date" or "date-time" and a ${s.format || "dated"} bound and value` });
        else if ((stamp(v) < stamp(s[key]) ? -1 : stamp(v) > stamp(s[key]) ? 1 : 0) * sign < 0) out.push({ path, message: `must not be ${word} ${s[key]} (got ${v})` });
      }
    }
    if (t === "number" || t === "integer") {
      if (s.minimum != null && v < s.minimum) out.push({ path, message: `must be ≥ ${s.minimum}` });
      if (s.maximum != null && v > s.maximum) out.push({ path, message: `must be ≤ ${s.maximum}` });
      if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) out.push({ path, message: `must be > ${s.exclusiveMinimum}` });
      if (s.exclusiveMaximum != null && v >= s.exclusiveMaximum) out.push({ path, message: `must be < ${s.exclusiveMaximum}` });
      if (s.multipleOf != null && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) out.push({ path, message: `must be a multiple of ${s.multipleOf}` });
    }
    if (t === "array") {
      if (s.minItems != null && v.length < s.minItems) out.push({ path, message: `must have at least ${s.minItems} items` });
      if (s.maxItems != null && v.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} items` });
      if (s.uniqueItems && v.some((x, i) => v.findIndex((y) => equal(x, y)) !== i)) out.push({ path, message: "items must be unique" });
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : [];
      prefix.forEach((ps, i) => { if (i < v.length) check(v[i], ps, `${path}/${i}`, root, out); });
      if (s.items !== undefined) for (let i = prefix.length; i < v.length; i++) check(v[i], s.items, `${path}/${i}`, root, out);
      if (s.contains !== undefined) {
        const n = v.filter((x) => !check(x, s.contains, path, root, []).length).length;
        const min = s.minContains ?? 1;
        if (n < min) out.push({ path, message: min === 1 ? "must contain a matching item" : `must contain at least ${min} matching items (has ${n})` });
        if (s.maxContains != null && n > s.maxContains) out.push({ path, message: `must contain at most ${s.maxContains} matching items (has ${n})` });
      }
    }
    if (t === "object") {
      const keys = Object.keys(v);
      if (s.minProperties != null && keys.length < s.minProperties) out.push({ path, message: `must have at least ${s.minProperties} properties` });
      if (s.maxProperties != null && keys.length > s.maxProperties) out.push({ path, message: `must have at most ${s.maxProperties} properties` });
      for (const r of s.required || []) if (!Object.hasOwn(v, r) || v[r] === undefined) out.push({ path: `${path}/${esc(r)}`, message: "is required" });
      for (const [k, deps] of Object.entries(s.dependentRequired || {})) if (Object.hasOwn(v, k)) for (const d of deps) if (!Object.hasOwn(v, d)) out.push({ path: `${path}/${esc(d)}`, message: `is required when ${k} is set` });
      const props = isObj(s.properties) ? s.properties : {};
      const pats = Object.entries(isObj(s.patternProperties) ? s.patternProperties : {}).map(([p, ps]) => [new RegExp(p, "u"), ps]);
      for (const k of keys) {
        if (v[k] === undefined) continue;
        const at = `${path}/${esc(k)}`;
        let known = false;
        if (Object.hasOwn(props, k)) { known = true; check(v[k], props[k], at, root, out); }
        for (const [re, ps] of pats) if (re.test(k)) { known = true; check(v[k], ps, at, root, out); }
        if (!known && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) out.push({ path: at, message: `unknown property "${k}"${Object.keys(props).length ? ` (expected one of ${Object.keys(props).join(", ")})` : ""}` });
          else check(v[k], s.additionalProperties, at, root, out);
        }
        if (s.propertyNames !== undefined) for (const e of check(k, s.propertyNames, at, root, [])) out.push({ path: at, message: `property name ${e.message}` });
      }
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(v, sub, path, root, out);
    if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => !check(v, sub, path, root, []).length)) {
      out.push({ path, message: `must match at least one of ${s.anyOf.length} alternatives` });
    }
    if (Array.isArray(s.oneOf)) {
      const results = s.oneOf.map((sub) => check(v, sub, path, root, []));
      const n = results.filter((r) => !r.length).length;
      if (n !== 1) {
        out.push({ path, message: n ? `must match exactly one of ${s.oneOf.length} alternatives (matches ${n})` : `must match one of ${s.oneOf.length} alternatives` });
        if (!n && results.length) out.push(...results.reduce((a, b) => (b.length < a.length ? b : a)));   // the closest alternative's problems
      }
    }
    if (s.not !== undefined && !check(v, s.not, path, root, []).length) out.push({ path, message: "must not match the excluded shape" });
    if (s.if !== undefined) {
      const ok = !check(v, s.if, path, root, []).length;
      if (ok && s.then !== undefined) check(v, s.then, path, root, out);
      if (!ok && s.else !== undefined) check(v, s.else, path, root, out);
    }
    return out;
  }

  return {
    add: (s) => { add(s); resolveAll(); return s; },
    has: (id) => byId.has(String(id).replace(/#$/, "")),
    get: (id) => byId.get(String(id).replace(/#$/, "")),
    ids: () => [...byId.keys()],
    /** Problems of `value` against the schema (object, or a registered $id). [] = valid. */
    validate(value, schema) {
      const s = typeof schema === "string" ? byId.get(schema.replace(/#$/, "")) : schema;
      if (s === undefined) return [{ path: "", message: `unknown schema "${schema}"` }];
      if (!checked.has(s)) {
        const refs = [];
        assertSupported(s, "", F, refs);
        for (const { ref, at } of refs) { const r = resolve(ref, s); if (r.error) throw new Error(`${r.error} at ${at}`); }
        if (isObj(s)) checked.add(s);
      }
      return check(value, s, "", isObj(s) ? s : {}, []);
    },
  };
}

/** One-off validation against a single schema object (its own $defs). */
export const validate = (value, schema, opts) => createValidator(isObj(schema) && schema.$id ? [schema] : [], opts).validate(value, schema);

/** "path: message" lines for humans. */
export const formatProblems = (problems, prefix = "") => problems.map((p) => `${prefix}${p.path || "/"}: ${p.message}`);
