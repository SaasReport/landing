/**
 * Bundle a contract's external schema references before generation. A contract names a kit schema by its $id (one
 * source per fact: the schema lives once, in packages/core/schemas); Forge resolves only #/components/schemas/… refs,
 * so without this step an operation that references a schema would be generated as `unknown`. Each external $ref is
 * resolved to the schema file inside the repository (or its vendored kit), copied into components.schemas under a
 * name derived from its title, its $defs (at any depth) become sibling components, and every reference to it is
 * rewritten. Anything that cannot be bundled exactly is a problem, never a silent `unknown` or a wrong type: an
 * unresolvable file, unparsable JSON, a fragment other than the schema itself or one of its $defs, a local pointer
 * inside the schema other than "#" or "#/$defs/…", a path outside the repository.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/** The repository path a schema $id names (https://github.com/<owner>/<repo>/blob/<ref>/<path>), else null. */
export function idPath(id) {
  const m = String(id).match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+?)(#.*)?$/);
  if (!m) return null;
  // Only a plain relative path inside the repository: no "..", ".", empty or encoded segments, no backslashes.
  const segs = m[1].split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || /[%\\]/.test(s))) return null;
  return m[1];
}

/** A component name from a schema title or path: kit.broker-request.v1 → KitBrokerRequestV1. */
export function componentName(schema, ref) {
  const base = String(schema?.title || ref.split("/").pop().replace(/\.schema\.json$|\.json$/, ""));
  return base.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Schema";
}

/** The schema an external $ref names, read from a real path inside the repository (or its vendored kit). */
function loadExternal(root, base) {
  const path = idPath(base);
  if (!path) return { problem: "not a repository schema $id (https://github.com/<owner>/<repo>/blob/<ref>/<path>, plain path)" };
  const realRoot = realpathSync(root);
  for (const candidate of [join(root, path), join(root, "vendor", "kit", path)]) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return { problem: "resolves outside the repository (symlink)" };
    try { return { schema: JSON.parse(readFileSync(real, "utf8")) }; } catch (e) { return { problem: `not valid JSON: ${e.message}` }; }
  }
  return { problem: "cannot be resolved to a schema file in the repository or its vendored kit" };
}

/** Keywords whose values are data, not schemas: copied verbatim, never searched for references. */
const VALUE_KEYWORDS = new Set(["example", "examples", "default", "const", "enum"]);
/** Keywords whose values map names to schemas: the names are data, each value is a schema. */
const NAME_MAPS = new Set(["properties", "patternProperties", "dependentSchemas"]);
const unescape = (s) => s.replace(/~1/g, "/").replace(/~0/g, "~");

/** "/$defs/a/$defs/b" → ["a","b"]; "" → []; anything else → null. */
function defsPath(fragment) {
  if (!fragment || fragment === "/") return [];
  const parts = fragment.split("/").slice(1).map(unescape);
  if (parts.length % 2) return null;
  const names = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== "$defs" || !parts[i + 1]) return null;
    names.push(parts[i + 1]);
  }
  return names;
}

/**
 * Bundle every external $ref of `doc` (an OpenAPI document; not mutated), wherever it appears (paths, parameters,
 * responses, existing components). Returns { doc, problems, bundled }.
 */
export function bundleExternalRefs(doc, root) {
  const out = structuredClone(doc);
  const schemas = (out.components ||= {}).schemas ||= {};
  const problems = [];
  const files = new Map(); // external base URL → { name, defs: Map("a/b" → component name) } | null (failed)
  const taken = new Set(Object.keys(schemas));
  const unique = (base) => { let n = base; while (taken.has(n)) n += "_"; taken.add(n); return n; };

  /** Bundle one external file; returns its entry or null. Registered before walking, so cycles terminate. */
  function include(base, where) {
    const key = idPath(base) || base; // one file, one component, whatever branch name the $id carries
    if (files.has(key)) return files.get(key);
    const loaded = loadExternal(root, base);
    if (!loaded.schema) { problems.push(`$ref ${base} (${where}): ${loaded.problem}`); files.set(key, null); return null; }
    const entry = { name: unique(componentName(loaded.schema, base)), defs: new Map() };
    files.set(key, entry);
    // Name every $defs entry, at any depth, before rewriting, so internal references can point at them.
    const collect = (node, path) => {
      for (const [def, sub] of Object.entries(node?.$defs || {})) {
        const key = [...path, def].join("/");
        entry.defs.set(key, unique(`${entry.name}_${[...path, def].join("_")}`));
        collect(sub, [...path, def]);
      }
    };
    collect(loaded.schema, []);
    const strip = ({ $schema, $id, $defs, ...body }) => body;
    const rewrite = (node, where2) => localRewrite(node, base, entry, where2);
    schemas[entry.name] = rewrite(strip(loaded.schema), `${base}`);
    const emit = (node, path) => {
      for (const [def, sub] of Object.entries(node?.$defs || {})) {
        const key = [...path, def].join("/");
        schemas[entry.defs.get(key)] = rewrite(strip(sub), `${base}#/$defs/${key}`);
        emit(sub, [...path, def]);
      }
    };
    emit(loaded.schema, []);
    return entry;
  }

  /** The component an external ref (base + fragment) names, or null with a problem. */
  function target(ref, where) {
    const [base, fragment = ""] = ref.split("#");
    const entry = include(base, where);
    if (!entry) return null;
    const path = defsPath(fragment);
    if (!path) { problems.push(`$ref ${ref} (${where}): only the schema itself or one of its $defs can be referenced`); return null; }
    if (!path.length) return entry.name;
    const name = entry.defs.get(path.join("/"));
    if (!name) problems.push(`$ref ${ref} (${where}): no such $defs entry`);
    return name || null;
  }

  /** Rewrite references inside an external schema: local "#"/"#/$defs/…" to components, external ones bundled. */
  function localRewrite(node, base, entry, where) {
    if (Array.isArray(node)) return node.map((n) => localRewrite(n, base, entry, where));
    if (!node || typeof node !== "object") return node;
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs") continue; // emitted as components
      if (VALUE_KEYWORDS.has(k)) { copy[k] = v; continue; }
      if (NAME_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
        copy[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, localRewrite(sub, base, entry, where)]));
        continue;
      }
      if (k === "$ref" && typeof v === "string") {
        if (v.startsWith("#")) {
          const path = defsPath(v.slice(1));
          const name = path && (path.length ? entry.defs.get(path.join("/")) : entry.name);
          if (name) copy.$ref = `#/components/schemas/${name}`;
          else { problems.push(`$ref ${v} inside ${where}: only "#" or "#/$defs/…" can be bundled`); copy.$ref = v; }
        } else {
          const abs = v.startsWith("http") ? v : null;
          const name = abs && target(abs, where);
          copy.$ref = name ? `#/components/schemas/${name}` : v;
          if (!abs) problems.push(`$ref ${v} inside ${where}: relative external references are not supported; use the $id`);
        }
      } else copy[k] = localRewrite(v, base, entry, where);
    }
    return copy;
  }

  const external = (v) => typeof v === "string" && !v.startsWith("#");
  const refTo = (v, where) => { const name = target(v, where); return name ? `#/components/schemas/${name}` : v; };

  /**
   * Walk a JSON Schema (a schema position): $ref is a keyword, value keywords (example, default, const, enum …) are
   * data copied verbatim, name maps (properties …) map names to schemas, every other object or array is a subschema.
   */
  function walkSchema(node, where) {
    if (Array.isArray(node)) return node.map((n, i) => walkSchema(n, `${where}/${i}`));
    if (!node || typeof node !== "object") return node;
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && external(v)) copy.$ref = refTo(v, where);
      else if (VALUE_KEYWORDS.has(k)) copy[k] = v;
      else if ((NAME_MAPS.has(k) || k === "$defs") && v && typeof v === "object" && !Array.isArray(v)) {
        copy[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, walkSchema(sub, `${where}/${k}/${name}`)]));
      } else copy[k] = walkSchema(v, `${where}/${k}`);
    }
    return copy;
  }

  /**
   * Walk the OpenAPI document by its own structure: a value under "schema", and every entry of components.schemas,
   * is a JSON Schema; "example" and an Example Object's "value" are data; everything else (paths, responses —
   * including one named "default" —, parameters, components maps) is walked as document structure, where an external
   * $ref is still bundled.
   */
  function walkDoc(node, where) {
    if (Array.isArray(node)) return node.map((n, i) => walkDoc(n, `${where}/${i}`));
    if (!node || typeof node !== "object") return node;
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      const at = `${where}/${k}`;
      const componentMap = /^#\/components\/[^/]+$/.test(where); // keys here are component names, not keywords
      if (where === "#/components" && k === "schemas" && v && typeof v === "object") {
        copy[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, walkSchema(sub, `${at}/${name}`)]));
      } else if (k === "schema" && !componentMap) copy[k] = walkSchema(v, at);
      else if (!componentMap && (k === "example" || (k === "value" && !("schema" in node)))) copy[k] = v;
      else if (k === "$ref" && external(v)) {
        // A Reference Object outside a schema position (a parameter, response, …) cannot point at a JSON Schema.
        problems.push(`$ref ${v} (${where}): a kit schema can only be referenced where a schema is expected`);
        copy.$ref = v;
      } else copy[k] = walkDoc(v, at);
    }
    return copy;
  }

  const existing = Object.keys(schemas);
  const walked = walkDoc({ ...out, components: { ...out.components, schemas: Object.fromEntries(existing.map((k) => [k, schemas[k]])) } }, "#");
  // Bundled components were added to `schemas` during the walk; keep the walked existing ones and add the rest.
  const finalSchemas = { ...walked.components.schemas };
  for (const [k, v] of Object.entries(schemas)) if (!existing.includes(k)) finalSchemas[k] = v;
  return {
    doc: { ...walked, components: { ...walked.components, schemas: finalSchemas } },
    problems,
    bundled: [...files.values()].filter(Boolean).map((e) => e.name),
  };
}
