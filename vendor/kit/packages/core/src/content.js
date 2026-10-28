/**
 * Content packs. `content` is an object keyed by series id; each value is
 *   topic / report series: an array of items, or { items }
 *   term series:           { categories: [{ key, name }], terms: [...] }  (or categories with nested `terms`)
 * loadContent(config) resolves every series' `source` (e.g. () => import("./content/weekly/index.js")).
 */
import { isMultiLocale, isLocaleRoot, contentFor, configFor, localesOf } from "./locales.js";

const cache = new WeakMap();
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function normalizeOne(series, raw) {
  if (raw == null) return null;
  if (isObj(raw) && raw.default != null && Object.keys(raw).length === 1) raw = raw.default;
  if (series.kind === "term") {
    const obj = Array.isArray(raw) ? { terms: raw } : raw;
    const cats = (obj.categories || []).map((c) => ({ key: c.key, name: c.name ?? c.title ?? c.fa ?? c.key, ...(c.description ? { description: c.description } : {}) }));
    let terms = obj.terms || obj.items;
    if (!terms) terms = (obj.categories || []).flatMap((c) => (c.terms || []).map((t) => ({ ...t, category: t.category ?? c.key })));
    return { categories: cats, items: [...terms] };
  }
  const items = Array.isArray(raw) ? raw : raw.items || raw.topics || raw.reports || raw.themes || [];
  return { categories: [], items: [...items] };
}

/** { [seriesId]: { items, categories } } — cached per content object. */
export function normalizeContent(config, content = {}) {
  if (isMultiLocale(config)) content = contentFor(config, content); // the config's own locale (the default one for the root)
  const key = content && typeof content === "object" ? content : {};
  let per = cache.get(key);
  if (!per) { per = new Map(); cache.set(key, per); }
  if (per.has(config)) return per.get(config);
  const out = {};
  for (const s of config.series) {
    const raw = key[s.id] ?? (typeof s.source === "function" ? null : s.source);
    out[s.id] = normalizeOne(s, raw);
  }
  per.set(config, out);
  return out;
}

/**
 * Resolve every series' `source` into a content object (async; call once at startup or build time).
 * The root of a multi-locale config gets a pack keyed per locale ({ en: {...}, ar: {...} }), one locale's config its own pack.
 */
export async function loadContent(config, content = {}) {
  if (isLocaleRoot(config)) {
    const out = {};
    for (const l of localesOf(config)) { const c = configFor(config, l); out[l] = await loadContent(c, contentFor(config, content, l)); }
    return out;
  }
  if (isMultiLocale(config)) content = contentFor(config, content);
  const out = { ...content };
  for (const s of config.series) {
    if (out[s.id] != null) continue;
    if (typeof s.source === "function") { const m = await s.source(); out[s.id] = m && m.default !== undefined ? m.default : m; }
    else if (s.source != null) out[s.id] = s.source;
  }
  return out;
}
