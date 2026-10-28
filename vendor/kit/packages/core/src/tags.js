/**
 * Content tags (docs/TAGS.md): the project's tag vocabulary (kit.content-tags.v1, tags.config.json) is the ONE place a tag is
 * defined; podcast series, episode items and blog posts name tags by id. Pure functions, no I/O (Workers, Node, browsers).
 *
 *   checkVocabulary(doc)                      → problems (schema + cross-field rules)
 *   compileVocabulary(doc, { locale })        → { locale, locales, groups, tags, get(id), has(id), resolve(ids) } (labels in the locale)
 *   searchFacet(vocab, label)                 → the `tags` of kit.search-config.v1 (static search index)
 *   effectiveTags(seriesTags, itemTags)       → the tags of an episode: its own when it names any, else its series'
 *   checkAssignment(vocab, where, ids, { required }) → problems of one series / item / post
 *   foldQuery(text), matchesQuery(query, parts)      → the search fold shared with the browser script (assets/tags.js)
 */
import SCHEMA from "../schemas/content-tags.schema.json" with { type: "json" };
import { createValidator, formatProblems } from "./schema.js";

const validator = createValidator([SCHEMA]);

/** The colour roles a tag may name: the schema's enum (tested equal to the tone roles of the colour canon). */
export const TAG_COLOURS = SCHEMA.$defs.tag.properties.colour.enum;
export const TAGS_SCHEMA = SCHEMA.title;

const dup = (list, key) => { const seen = new Set(), out = []; for (const x of list) { if (seen.has(x[key])) out.push(x[key]); seen.add(x[key]); } return out; };

/** Problems with a vocabulary document ([] when valid): the schema, then what a schema cannot say. */
export function checkVocabulary(doc) {
  const problems = formatProblems(validator.validate(doc, SCHEMA.$id));
  if (problems.length) return problems;
  const groups = new Set(doc.groups.map((g) => g.id));
  for (const id of dup(doc.groups, "id")) problems.push(`group "${id}" is declared twice`);
  for (const id of dup(doc.tags, "id")) problems.push(`tag "${id}" is declared twice`);
  const covers = (text, where) => { for (const l of doc.locales) if (typeof text[l] !== "string") problems.push(`${where} has no text for the locale "${l}"`); };
  for (const g of doc.groups) covers(g.label, `group "${g.id}" label`);
  for (const t of doc.tags) {
    if (!groups.has(t.group)) problems.push(`tag "${t.id}": group "${t.group}" is not declared in groups`);
    covers(t.label, `tag "${t.id}" label`);
    covers(t.description, `tag "${t.id}" description`);
  }
  return problems;
}

/** The text of a { locale: text } map for a locale: exact, then its language, then the vocabulary's first locale, then any. */
export function pickText(map, locale, locales = []) {
  const keys = Object.keys(map || {});
  const want = String(locale || "").toLowerCase();
  const by = (k) => keys.find((x) => x.toLowerCase() === k);
  const hit = by(want) || by(want.split("-")[0]) || (locales[0] && by(String(locales[0]).toLowerCase())) || keys[0];
  return hit ? map[hit] : "";
}

/** The vocabulary for one locale. Throws on an invalid document (a Worker must not run on a vocabulary the canon would refuse). */
export function compileVocabulary(doc, { locale = "en" } = {}) {
  const problems = checkVocabulary(doc);
  if (problems.length) throw new Error(`${TAGS_SCHEMA}: ${problems.slice(0, 5).join("; ")}`);
  const text = (m) => pickText(m, locale, doc.locales);
  const groups = doc.groups.map((g) => ({ id: g.id, label: text(g.label) }));
  const groupLabel = new Map(groups.map((g) => [g.id, g.label]));
  const tags = doc.tags.map((t) => ({ id: t.id, label: text(t.label), description: text(t.description), group: t.group, groupLabel: groupLabel.get(t.group), colour: t.colour }));
  const byId = new Map(tags.map((t) => [t.id, t]));
  return {
    locale, locales: doc.locales, groups, tags,
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    /** → { known: [tag] (in order, once each), unknown: [id] } */
    resolve(ids) {
      const known = [], unknown = [], seen = new Set();
      for (const id of Array.isArray(ids) ? ids : []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const t = byId.get(id);
        if (t) known.push(t); else unknown.push(id);
      }
      return { known, unknown };
    },
  };
}

/** The most tags one request filters by (`?tag=` repeated), and the longest tag id it accepts: the handlers enforce them and the OpenAPI contract declares them (a test keeps the two equal). */
export const MAX_FILTER_TAGS = 8;
export const FILTER_TAG_ID_MAX = 48;

/** The vocabulary as the search facet of a static site's index (kit.search-config.v1 `tags`): { label, values: [{ id, label }] }. */
export const searchFacet = (vocab, label) => ({ label, values: vocab.tags.map((x) => ({ id: x.id, label: x.label })) });

/** The tags of an episode or post: the item's own when it names any, otherwise the series'. */
export const effectiveTags = (seriesTags, itemTags) => (Array.isArray(itemTags) && itemTags.length ? itemTags : Array.isArray(seriesTags) ? seriesTags : []);

/** Problems of one assignment: `where` names it ("series legal-licensing"), `required` when an empty list is itself a problem. */
export function checkAssignment(vocab, where, ids, { required = true } = {}) {
  if (ids == null || (Array.isArray(ids) && !ids.length)) return required ? [`${where}: has no tags (name at least one tag of the vocabulary)`] : [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return [`${where}: tags must be a list of tag ids`];
  const out = [], seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) { out.push(`${where}: tag "${id}" is listed twice`); continue; }
    seen.add(id);
    if (!vocab.has(id)) out.push(`${where}: tag "${id}" is not declared in the vocabulary`);
  }
  return out;
}

/**
 * The search fold: lower case, Arabic yeh/kaf to Persian, ZWNJ to a space, diacritics off, spaces collapsed.
 * packages/cloudflare/assets/tags.js carries a copy (a browser script has no imports), tested equal to this one.
 */
export const foldQuery = (s) => String(s ?? "").toLowerCase().replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ")
  .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Does every word of the query occur in the folded parts (title, summary, tag labels)? An empty query matches. */
export function matchesQuery(query, parts) {
  const words = foldQuery(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = foldQuery((parts || []).join(" "));
  return words.every((w) => hay.includes(w));
}
