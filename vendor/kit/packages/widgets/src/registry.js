/**
 * The archetype registry: every archetype is a plugin (kit.widgets-plugin.v1) and the engine core (build, check, html,
 * the runtime loader, the schemas) names none of them. The engine asks the registry; the registry holds what plugins declared.
 *
 *   validateManifest(plugin) → string[]          the declarative contract, then the hooks
 *   createRegistry(plugins) → Registry           refuses unknown keys, duplicate ids, a contract mismatch, missing hooks
 *   kitRegistry() → Registry                     the kit's own plugins (src/plugins/)
 *   registryFor(spec, dir) → Registry            the kit's plus the project's own (spec.plugins), same contract
 *   composeSpecSchema(base, registry) → schema   kit.widgets-spec.v1 with each plugin's fragment composed in by $ref
 *   resolveBySchema(value, schema, ctx)          text resolution guided by the plugin's own schema fragment
 *
 * A plugin is a module whose default export is the manifest:
 *   { schema: "kit.widgets-plugin.v1", contract: 1, id, version, describes, reads?, spec?: { key, schema?, resolve?, requiresWidget? },
 *     data?: <JSON Schema of the derived data>, capabilities: { rtl, reducedMotion, needsCanvas }, runtime: <file|null>,
 *     autoplay?: <selector>, chrome?: { <locale>: { title, words } }, chromeKeys?, textKeys?, requires?, exports?,
 *     needs(sc), derive(sc, ctx), render(w, c, f, locale, h), check(w, ctx) }
 * Plugins hold no content: every text comes from the project's widgets.spec.json and sources (kit widgets check).
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSchema } from "./schema.js";
import { isObj } from "./util.js";
import { KIT_PLUGINS } from "./plugins/index.js";
import PLUGIN_SCHEMA from "../schemas/widgets-plugin.schema.json" with { type: "json" };
import PROJECTS from "../../core/registry/projects.json" with { type: "json" };

export const PLUGIN_SCHEMA_ID = "kit.widgets-plugin.v1";
/** The plugin contract's major version: a plugin written for another one is refused. */
export const PLUGIN_CONTRACT = 1;
export const HOOKS = ["needs", "derive", "render", "check"];
const OPTIONAL_HOOKS = ["validate"];
const SPEC_HOOKS = ["resolve"];
export { PLUGIN_SCHEMA };

/** The declarative part of a manifest (what a JSON Schema can check) and its hooks (what only code can be). */
const split = (m) => {
  const data = {}, hooks = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "function") hooks[k] = v;
    else data[k] = v;
  }
  if (isObj(m.spec)) { data.spec = { ...m.spec }; for (const h of SPEC_HOOKS) if (typeof m.spec[h] === "function") { hooks[`spec.${h}`] = m.spec[h]; delete data.spec[h]; } }
  if (isObj(m.exports)) { data.exports = {}; for (const [k, v] of Object.entries(m.exports)) { if (typeof v === "function") hooks[`exports.${k}`] = v; else data.exports[k] = v; } }
  return { data, hooks };
};

/** Problems with one plugin manifest: the schema (unknown keys, ids, versions, capabilities), the contract version, the hooks. */
export function validateManifest(m, where = "plugin") {
  if (!isObj(m)) return [`${where}: a plugin's default export is an object (kit.widgets-plugin.v1)`];
  const { data, hooks } = split(m);
  const p = validateSchema(data, PLUGIN_SCHEMA).map((q) => `${where}${q.path === "/" ? "" : q.path}: ${q.message}`);
  if (data.contract !== undefined && data.contract !== PLUGIN_CONTRACT) p.push(`${where}: written for plugin contract ${data.contract}, this engine speaks ${PLUGIN_CONTRACT}`);
  for (const h of HOOKS) if (typeof hooks[h] !== "function") p.push(`${where}: missing hook "${h}" (needs, derive, render and check are all part of the contract)`);
  for (const k of Object.keys(hooks)) if (!HOOKS.includes(k) && !OPTIONAL_HOOKS.includes(k) && !k.startsWith("spec.") && !k.startsWith("exports.")) p.push(`${where}: "${k}" is a function the contract does not know`);
  if (isObj(m.spec) && m.spec.resolve && typeof m.spec.resolve !== "function") p.push(`${where}: spec.resolve must be a function`);
  if (isObj(m.spec) && !m.spec.schema && !m.spec.shared) p.push(`${where}: spec has no schema fragment (a plugin that reads only the shared scenario model sets spec.shared: true)`);
  if (data.runtime && typeof data.runtime === "string" && data.runtime.startsWith("/")) p.push(`${where}: runtime is a path relative to the plugin file`);
  return p;
}

export class Registry {
  #by = new Map();
  /** Register a plugin; `source` says where it came from (the kit, or a project folder) for the messages. */
  register(plugin, { source = "kit", file = null } = {}) {
    const where = `plugin ${plugin?.id ?? "?"} (${source})`;
    const problems = validateManifest(plugin, where);
    if (problems.length) { const e = new Error(problems.join("\n")); e.problems = problems; throw e; }
    if (this.#by.has(plugin.id)) throw new Error(`${where}: the id "${plugin.id}" is already registered (${this.#by.get(plugin.id).source})`);
    for (const need of plugin.requires || []) if (!this.#by.has(need)) throw new Error(`${where}: requires "${need}", which is not registered (register it first)`);
    const key = plugin.spec?.key;
    if (key) { const clash = [...this.#by.values()].find((x) => x.plugin.spec?.key === key); if (clash) throw new Error(`${where}: spec key "${key}" is already owned by ${clash.plugin.id}`); }
    this.#by.set(plugin.id, { plugin, source, file });
    return this;
  }
  has(id) { return this.#by.has(id); }
  get(id) { const e = this.#by.get(id); if (!e) throw new Error(`no archetype "${id}" (registered: ${this.ids().join(", ")})`); return e.plugin; }
  file(id) { return this.#by.get(id)?.file ?? null; }
  source(id) { return this.#by.get(id)?.source ?? null; }
  ids() { return [...this.#by.keys()]; }
  plugins() { return [...this.#by.values()].map((x) => x.plugin); }
  entries() { return [...this.#by.values()]; }
  /** The archetypes that can produce an export kind (build.exports[].as). */
  exporters(kind) { return this.plugins().filter((x) => typeof x.exports?.[kind] === "function"); }
  /** Plugins that own a scenario key beyond the shared scenario model. */
  keyed() { return this.plugins().filter((x) => x.spec?.key); }
  textKeys() { return new Set(this.plugins().flatMap((x) => x.textKeys || [])); }
  /** A copy with more plugins (a project's own). */
  with(plugins, opts) { const r = new Registry(); for (const e of this.entries()) r.register(e.plugin, { source: e.source, file: e.file }); for (const [pl, o] of plugins) r.register(pl, { ...opts, ...o }); return r; }
}

/**
 * The plugin set of several registries (a site with more than one widgets page): every plugin of each, once. The same id from the same
 * source is one plugin; the same id from different sources (files) is a conflict, never a silent pick of the first.
 * → { registry, conflicts: string[] }
 */
export function unionRegistries(registries = []) {
  const out = new Registry(), seen = new Map(), conflicts = [];
  for (const reg of registries) {
    for (const e of reg.entries()) {
      const was = seen.get(e.plugin.id);
      if (was) { if (was.source !== e.source || was.file !== e.file) conflicts.push(`plugin "${e.plugin.id}" comes from ${was.source} on one widgets page and from ${e.source} on another`); continue; }
      seen.set(e.plugin.id, e);
      if (!out.has(e.plugin.id)) { try { out.register(e.plugin, { source: e.source, file: e.file }); } catch (err) { conflicts.push(err.message); } }
    }
  }
  return { registry: out, conflicts };
}

/** The one test for "is this the widgets Registry": a duck-typed look-alike (an object with entries()) is not one and would throw later on has(). */
export const isRegistry = (r) => r instanceof Registry;

export function createRegistry(plugins = []) {
  const r = new Registry();
  for (const p of plugins) r.register(p);
  return r;
}

let kit;
/** The kit's own plugins (one registry, built once). */
export function kitRegistry() {
  kit ??= createRegistry(KIT_PLUGINS);
  return kit;
}

/** The prefixes a project's plugin ids may start with (the naming constitution: `<prefix>-name`). */
export function projectPrefixes(key, projects = PROJECTS) {
  const p = projects.projects.find((x) => x.key === key);
  return p ? [p.prefix, p.short].filter(Boolean) : [`${key}-`];
}

/** The kit's registry plus the plugins the project declares (spec.plugins: files or folders with a plugin.js / plugin.mjs). */
export async function registryFor(spec, dir, { projects = PROJECTS } = {}) {
  const base = kitRegistry();
  const declared = spec.plugins || [];
  if (!declared.length) return base;
  const loaded = [];
  for (const rel of declared) {
    let file = resolve(dir, rel);
    if (existsSync(file) && statSync(file).isDirectory()) file = ["plugin.mjs", "plugin.js", "index.mjs", "index.js"].map((f) => resolve(file, f)).find(existsSync) || file;
    if (!existsSync(file) || statSync(file).isDirectory()) throw new Error(`plugins: ${rel} does not exist (a file, or a folder with plugin.mjs)`);
    let mod;
    try { mod = await import(pathToFileURL(file).href); } catch (e) { throw new Error(`plugins: ${rel} cannot be imported (${e.message})`); }
    const plugin = mod.default;
    const prefixes = projectPrefixes(spec.project.key, projects);
    if (plugin?.id && !prefixes.some((pf) => plugin.id.startsWith(pf))) throw new Error(`plugins: ${rel}: id "${plugin.id}" must start with the project's prefix (${prefixes.join(" or ")}), the naming constitution; the kit's own plugins have bare ids`);
    loaded.push([plugin, { source: `project ${spec.project.key}: ${rel}`, file }]);
  }
  return base.with(loaded);
}

/* ---------- schema composition ---------- */

const PLUGIN_DEF = /^plugin\.([a-z][a-z0-9-]*)(\.|$)/;
const SHARED_DEFS = new Set(["id", "honesty", "archetype", "tone", "text", "sourced", "value", "scenario"]);

/** Rewrite a fragment's local `#/$defs/x` references: the shared definitions stay, its own become `plugin.<id>.<x>`. */
function rebase(node, id, own) {
  if (Array.isArray(node)) return node.map((x) => rebase(x, id, own));
  if (!isObj(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/")) {
      const name = v.slice(8).split("/")[0], rest = v.slice(8 + name.length);
      out[k] = own.has(name) ? `#/$defs/plugin.${id}.${name}${rest}` : v;
    } else out[k] = rebase(v, id, own);
  }
  return out;
}

/**
 * kit.widgets-spec.v1 with the plugins' fragments composed in. Idempotent: what an earlier composition added
 * (definitions `plugin.<id>.*`, scenario properties that $ref them) is removed first, so the committed schema is a
 * pure function of the kit's registry (`kit widgets schema --check`).
 */
export function composeSpecSchema(base, registry) {
  const s = structuredClone(base);
  s.$defs ??= {};
  for (const k of Object.keys(s.$defs)) if (PLUGIN_DEF.test(k)) delete s.$defs[k];
  const props = s.$defs.scenario.properties;
  for (const [k, v] of Object.entries(props)) if (typeof v?.$ref === "string" && /^#\/\$defs\/plugin\./.test(v.$ref)) delete props[k];
  for (const pl of registry.plugins()) {
    const spec = pl.spec;
    if (!spec?.key || !spec.schema) continue;
    if (props[spec.key] && !s.$defs[`plugin.${pl.id}`]) throw new Error(`plugin ${pl.id}: spec key "${spec.key}" already belongs to the shared scenario model`);
    const own = new Set(Object.keys(spec.schema.$defs || {}));
    const { $defs, ...root } = spec.schema;
    s.$defs[`plugin.${pl.id}`] = rebase(root, pl.id, own);
    for (const [name, def] of Object.entries($defs || {})) s.$defs[`plugin.${pl.id}.${name}`] = rebase(def, pl.id, own);
    props[spec.key] = { $ref: `#/$defs/plugin.${pl.id}` };
  }
  const as = s.properties.build?.properties?.exports?.items?.properties?.as;
  if (as) s.properties.build.properties.exports.items.properties.as = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "An export kind that a registered archetype produces (its `exports`); build checks that one does." };
  s.$defs.archetype = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "The id of a registered archetype plugin (the kit's, or one the project declares in `plugins`); the registry says which exist." };
  s.properties.plugins ??= { description: "The project's own archetype plugins (kit.widgets-plugin.v1): files, or folders with a plugin.mjs. Their ids start with the project's prefix.", type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } };
  return s;
}

/* ---------- schema-guided resolution of a plugin's data ---------- */

const refName = (ref) => (typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice(8) : null);

/**
 * Resolve the sourced texts of a plugin's scenario data guided by its schema: wherever the schema says `text` the value is
 * a string, a {locale: string} map, a {$ref} or an {$engine}; `value` is a number, a boolean or a text; `sourced` is
 * taken as the source's own value (an object is allowed). Everything else is structure and is copied.
 *   ctx = { T(text) → string, raw(sourced) → any, defs }
 */
export async function resolveBySchema(value, schema, ctx) {
  const { T, raw, defs } = ctx;
  const node = (s) => { let n = s; for (let i = 0; n?.$ref && i < 8; i++) { const name = refName(n.$ref); if (name === "text" || name === "value" || name === "sourced") return { kind: name }; n = defs[name]; if (!n) break; } return n; };
  const walk = async (v, s) => {
    if (v === undefined || v === null) return v;
    const n = node(s);
    if (n?.kind === "text") return T(v);
    if (n?.kind === "value") return typeof v === "number" || typeof v === "boolean" ? v : T(v);
    if (n?.kind === "sourced") return raw(v);
    if (Array.isArray(v)) return Promise.all(v.map((x, i) => walk(x, n?.items ?? (n?.prefixItems ? n.prefixItems[i] : undefined))));
    if (isObj(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x, n?.properties?.[k] ?? (isObj(n?.additionalProperties) ? n.additionalProperties : undefined));
      return out;
    }
    return v;
  };
  return walk(value, schema);
}

/** The `text`-typed leaves a plugin fragment declares, by property name (so the check reads them as copy). */
export function declaredTextKeys(schema, defs = {}) {
  const out = new Set();
  const seen = new Set();
  const visit = (n) => {
    if (!isObj(n) || seen.has(n)) return; seen.add(n);
    for (const [k, v] of Object.entries(n.properties || {})) { if (refName(v.$ref) === "text" || refName(v.$ref) === "value" || (v.type === "array" && ["text", "value"].includes(refName(v.items?.$ref)))) out.add(k); visit(v); visit(v.items); }
    for (const d of Object.values(n.$defs || {})) visit(d);
    if (n.items) visit(n.items);
    if (isObj(n.additionalProperties)) visit(n.additionalProperties);
    if (n.$ref && refName(n.$ref) && defs[refName(n.$ref)]) visit(defs[refName(n.$ref)]);
  };
  visit(schema);
  return out;
}

