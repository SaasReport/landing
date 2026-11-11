/**
 * The guards: `kit widgets check`.
 *
 *   checkWidgets(specPath, { registry }) → { problems: string[], widgets: n }
 *
 * Fails when
 *   - the spec does not validate (kit.widgets-spec.v1) or its ids do not resolve (use cases, audiences, actors, sources);
 *   - the generated file is missing, does not validate (kit.widgets-generated.v1) or is stale (a rebuild differs);
 *   - a widget has no scenario of the project's spec, or an archetype the project did not choose;
 *   - a text a widget shows is not traceable: not in the spec, not in one of its sources, not an engine result;
 *   - another project's vocabulary (registry/vocabularies.json) or a word the spec forbids appears in the spec or the widgets.
 */
import { readFileSync, existsSync } from "node:fs";
import { buildWidgets, loadSpec, specProblems, fileProblems } from "./build.js";
import { registryFor, declaredTextKeys } from "./registry.js";
import { validateSchema } from "./schema.js";
import { strings, isObj, plain } from "./util.js";
import { renderWidgetsBody, latinDigits } from "./html.js";
import { loadSources } from "./sources.js";
import GENERATED_SCHEMA from "../schemas/widgets-generated.schema.json" with { type: "json" };
import VOCABULARIES_SCHEMA from "../schemas/vocabularies.schema.json" with { type: "json" };
import REGISTRY from "../registry/vocabularies.json" with { type: "json" };
import PROJECTS from "../../core/registry/projects.json" with { type: "json" };

/** The keys under which a widget carries text a visitor reads (everything else is ids, tones, dates, numbers, payloads). */
export const TEXT_KEYS = new Set(["benefit", "how", "surface", "components", "flow", "learns", "body", "recipient", "title", "summary", "action", "detail", "outcome", "actor", "to", "chip", "label", "text", "result", "done", "role", "unit", "cta", "rules", "sees", "does", "value"]);

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term as a pattern: whole words for Latin letters (case-insensitive), plain substring otherwise. */
export function termPattern(term) {
  const latinStart = /^[A-Za-z0-9]/.test(term), latinEnd = /[A-Za-z0-9]$/.test(term);
  return new RegExp(`${latinStart ? "(?<![A-Za-z0-9])" : ""}${escRe(term)}${latinEnd ? "(?![A-Za-z0-9])" : ""}`, "iu");
}

/** Every project's own words: the project registry (name, aliases, domain, prefixes) plus the vocabulary registry's marks. */
export function projectTerms(registry = REGISTRY, projects = PROJECTS) {
  const out = new Map();
  for (const p of projects.projects) out.set(p.key, new Set([p.name, ...(p.aliases || []), p.domain, p.prefix, p.short].filter((t) => t && t.length > 1)));
  for (const p of registry.projects) { if (!out.has(p.key)) out.set(p.key, new Set()); for (const t of p.terms) out.get(p.key).add(t); }
  return out;
}

/** Other projects' terms this project may not use. */
export function foreignTerms(key, registry = REGISTRY, projects = PROJECTS) {
  const shared = new Map(registry.projects.map((p) => [p.key, p.shared || []]));
  const out = [];
  for (const [owner, terms] of projectTerms(registry, projects)) {
    if (owner === key || (shared.get(owner) || []).includes(key)) continue;
    for (const t of terms) out.push({ term: t, owner });
  }
  return out;
}

/** Find vocabulary leaks in a set of texts: [{ term, owner, text }]. */
export function vocabularyLeaks(texts, terms) {
  const hits = [];
  for (const { term, owner } of terms) {
    const re = termPattern(term);
    for (const t of texts) if (re.test(t)) { hits.push({ term, owner, text: t }); break; }
  }
  return hits;
}

/** Payloads of the API explorer: contract samples or engine answers, checked by freshness, not by wording. */
const PAYLOAD_KEYS = new Set(["body", "response", "query"]);

function textLeaves(v, out = [], key = "", path = "", keys = TEXT_KEYS) {
  if (PAYLOAD_KEYS.has(key) && /\/calls\/\d+\/[a-z]+$/.test(path)) return out;
  if (typeof v === "string") { if (keys.has(key)) out.push({ path, text: v }); }
  else if (Array.isArray(v)) v.forEach((x, i) => textLeaves(x, out, key, `${path}/${i}`, keys));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) textLeaves(x, out, k, `${path}/${k}`, keys);
  return out;
}

export async function checkWidgets(specPath, { registry = REGISTRY, projects = PROJECTS } = {}) {
  const problems = [];
  const reg = validateSchema(registry, VOCABULARIES_SCHEMA);
  for (const q of reg) problems.push(`registry/vocabularies.json${q.path}: ${q.message}`);
  let loaded;
  try { loaded = loadSpec(specPath); } catch (e) { return { problems: [e.message], widgets: 0 }; }
  const { spec, dir } = loaded;
  let pluginReg;
  try { pluginReg = await registryFor(spec, dir, { projects }); } catch (e) { return { problems: [...problems, ...(e.problems || [e.message])], widgets: 0 }; }
  // the text keys of a widget: the engine's own, plus the ones its archetype's plugin declares (never another plugin's)
  const keysOf = (archetype) => { if (!pluginReg.has(archetype)) return TEXT_KEYS; const q = pluginReg.get(archetype); return new Set([...TEXT_KEYS, ...(q.textKeys || []), ...(q.spec?.schema ? declaredTextKeys(q.spec.schema, q.spec.schema.$defs || {}) : [])]); };
  const allKeys = new Set([...TEXT_KEYS, ...pluginReg.textKeys()]);
  const sp = [...specProblems(spec, pluginReg), ...fileProblems(spec, dir)];
  if (sp.length) return { problems: [...problems, ...sp], widgets: 0 };
  if (!projectTerms(registry, projects).has(spec.project.key)) problems.push(`project "${spec.project.key}" is in neither the project registry (packages/core/registry/projects.json) nor the vocabulary registry: register it first`);

  // Cross-project vocabulary and forbidden words, in the spec itself.
  const terms = [...foreignTerms(spec.project.key, registry, projects), ...(spec.vocabulary.forbidden || []).map((t) => ({ term: t, owner: "forbidden by this spec" }))];
  const own = new Set((spec.vocabulary.owned || []).map((t) => t.toLowerCase()));
  // Author guidance (tone notes, comments) may name forbidden words; everything a widget can show is scanned.
  const specTexts = [...strings({ ...spec, $schema: undefined, $comment: undefined, tone: undefined, sources: undefined, vocabulary: { ...spec.vocabulary, forbidden: undefined } })];
  for (const h of vocabularyLeaks(specTexts, terms.filter((t) => !own.has(t.term.toLowerCase())))) problems.push(`widgets.spec.json: "${h.term}" belongs to ${h.owner} ("${h.text.slice(0, 80)}")`);

  // Regenerate (also proves every source resolves) and compare.
  let fresh;
  try { fresh = await buildWidgets(specPath, { registry: pluginReg }); } catch (e) { problems.push(e.message); return { problems, widgets: 0 }; }
  if (!existsSync(fresh.out)) { problems.push(`${spec.build.out}: missing; run \`kit widgets build\``); return { problems, widgets: 0 }; }
  const onDisk = readFileSync(fresh.out, "utf8");
  let gen;
  try { gen = JSON.parse(onDisk); } catch (e) { problems.push(`${spec.build.out}: not JSON (${e.message})`); return { problems, widgets: 0 }; }
  for (const q of validateSchema(gen, GENERATED_SCHEMA)) problems.push(`${spec.build.out}${q.path}: ${q.message}`);
  if (onDisk !== fresh.json) problems.push(`${spec.build.out}: stale (differs from a fresh build of widgets.spec.json and its sources); run \`kit widgets build\` and commit the result — never edit it by hand`);

  // Every widget belongs to a scenario and an archetype of this project.
  const scenarios = new Map(spec.scenarios.map((s) => [s.id, s]));
  for (const w of gen.widgets || []) {
    const s = scenarios.get(w.scenario);
    if (!s) { problems.push(`widget ${w.id} (${w.locale}): no scenario "${w.scenario}" in widgets.spec.json`); continue; }
    if (!s.widgets.some((x) => x.archetype === w.archetype)) problems.push(`widget ${w.id} (${w.locale}): scenario ${s.id} does not ask for a ${w.archetype}`);
    if (!spec.archetypes.includes(w.archetype)) problems.push(`widget ${w.id}: archetype ${w.archetype} is not one this project chose`);
  }

  // Traceability: every text a widget shows comes from the spec, a source or an engine result.
  const sources = await loadSources(spec, dir);
  const allowed = strings(spec);
  for (const s of Object.values(sources)) if (s.doc) strings(s.doc, allowed);
  for (const c of gen.calls || []) strings(c.result, allowed);
  for (const t of [...allowed]) allowed.add(plain(t));   // HTML in a content source is shown as its plain text
  for (const w of gen.widgets || []) {
    for (const { path, text } of textLeaves({ title: w.title, summary: w.summary, data: w.data, usage: w.usage, application: w.application, architecture: w.architecture, utility: w.utility }, [], "", "", keysOf(w.archetype))) {
      if (!allowed.has(text)) problems.push(`widget ${w.id} (${w.locale})${path}: "${text.slice(0, 60)}" is not traceable to widgets.spec.json, its sources or an engine result`);
      // A template placeholder the page would show as-is ({date} is the only one the runtime fills, from the item's date).
      const hole = text.match(/\{(?!date\})[A-Za-z_]\w*\}/);
      if (hole) problems.push(`widget ${w.id} (${w.locale})${path}: unresolved placeholder ${hole[0]} in "${text.slice(0, 60)}"; point the $ref at a resolved text in the source`);
    }
  }
  // each archetype's own checks: its derived-data schema, then its check hook (vocabulary, reduced-motion final state, …)
  for (const w of gen.widgets || []) {
    if (!pluginReg.has(w.archetype)) continue;
    const pl = pluginReg.get(w.archetype);
    if (pl.data) for (const q of validateSchema(w.data, pl.data)) problems.push(`widget ${w.id} (${w.locale}) data${q.path === "/" ? "" : q.path}: ${q.message}`);
    for (const m of pl.check(w, { spec, scenario: scenarios.get(w.scenario), registry: pluginReg }) || []) problems.push(`widget ${w.id} (${w.locale}): ${m}`);
  }
  for (const [as, byLocale] of Object.entries(gen.exports || {})) for (const [code, v] of Object.entries(byLocale)) {
    for (const { path, text } of textLeaves(v, [], "", "", allKeys)) if (!allowed.has(text.replace(/\{date[+-]\d+\}/g, "{date}"))) problems.push(`exports.${as}.${code}${path}: "${text.slice(0, 60)}" is not traceable`);
  }

  // Cross-project vocabulary in what is generated.
  const genTexts = [...strings({ widgets: gen.widgets, exports: gen.exports, page: gen.page })];
  for (const h of vocabularyLeaks(genTexts, terms.filter((t) => !own.has(t.term.toLowerCase())))) problems.push(`${spec.build.out}: "${h.term}" belongs to ${h.owner} ("${h.text.slice(0, 80)}")`);

  // Numerals: a Persian page shows Persian digits (۰-۹) everywhere outside code; Arabic pages their own digits.
  for (const l of spec.locales) {
    const want = l.code.startsWith("fa") ? "arabext" : null;
    if (want && l.digits && l.digits !== want) problems.push(`locales.${l.code}: digits must be ${want} (Persian ۰-۹), not ${l.digits}`);
  }
  for (const l of gen.locales || []) {
    if (l.digits === "latn") continue;
    const left = latinDigits(renderWidgetsBody(gen, l.code, { registry: pluginReg }));
    if (left.length) problems.push(`rendered ${l.code} widgets show Latin digits outside code: ${left.slice(0, 3).map((t) => JSON.stringify(t.slice(0, 40))).join(", ")}`);
  }

  return { problems: [...new Set(problems)], widgets: (gen.widgets || []).length };
}
