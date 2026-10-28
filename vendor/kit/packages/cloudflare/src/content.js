/**
 * Content access for the Worker: the content pack (with lazy `series.source` modules resolved once),
 * the planner from @saasreport/core, and the glossary (the first series with `glossary: true`).
 * Content shape (as in @saasreport/core): { [seriesId]: items[] | { items } | { categories, terms } }.
 */
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Fallback when @saasreport/core is not wired: resolve `source` functions, keep the rest. */
async function loadFallback(config, content) {
  const out = { ...(content || {}) };
  for (const s of config.series) {
    if (out[s.id] != null) continue;
    if (typeof s.source === "function") { const m = await s.source(); out[s.id] = m && m.default !== undefined ? m.default : m; }
    else if (s.source != null) out[s.id] = s.source;
  }
  return out;
}

function normalizeOne(series, raw) {
  if (raw == null) return { items: [], categories: [] };
  if (series.kind === "term") {
    const obj = Array.isArray(raw) ? { terms: raw } : raw;
    const categories = (obj.categories || []).map((c) => ({ key: c.key, name: c.name ?? c.title ?? c.key }));
    let terms = obj.terms || obj.items;
    if (!terms) terms = (obj.categories || []).flatMap((c) => (c.terms || []).map((t) => ({ ...t, category: t.category ?? c.key })));
    return { items: terms, categories };
  }
  return { items: Array.isArray(raw) ? raw : raw.items || [], categories: [] };
}

export function createContent(k) {
  const { config } = k;
  let readyP = null;
  const state = { content: null, plan: null };

  /** Resolve content and build the planner once (per isolate). */
  function ready() {
    if (!readyP) readyP = (async () => {
      state.content = k.deps.loadContent ? await k.deps.loadContent(k.rawConfig, k.content || {}) : await loadFallback(config, k.content);
      state.plan = k.deps.planner ? k.deps.planner(k.rawConfig, state.content) : null;
      return state;
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }

  async function series(id) {
    const s = config.series.find((x) => x.id === id);
    if (!s) return { items: [], categories: [] };
    const st = await ready();
    const n = st.plan?.content?.[id];
    return n ? { items: n.items || [], categories: n.categories || [] } : normalizeOne(s, st.content[id]);
  }
  const items = async (id) => (await series(id)).items;

  let glossaryP = null;
  /** { series, categories: [{key, name, terms}], terms, bySlug, dayOf(slug) } or null. */
  function glossary() {
    if (!glossaryP) glossaryP = (async () => {
      const s = config.series.find((x) => x.glossary);
      if (!s) return null;
      const { items: raw, categories: cats } = await series(s.id);
      const terms = raw.filter((x) => isObj(x) && x.slug && x.term);
      const keys = cats.length ? cats : [...new Set(terms.map((x) => x.category))].map((key) => ({ key, name: key }));
      const categories = keys.map((c) => ({ key: c.key, name: c.name || c.key, terms: terms.filter((x) => x.category === c.key) }));
      const known = new Set(categories.map((c) => c.key));
      const orphans = terms.filter((x) => !known.has(x.category));
      if (orphans.length) categories.push({ key: "other", name: "…", terms: orphans });
      const plan = (await ready()).plan;
      const dayOf = (slug) => { try { return plan?.dayOf ? plan.dayOf(s.id, slug) : null; } catch { return null; /* the plan has no day for this slug: unscheduled (null) */ } };
      return { series: s, categories, terms, bySlug: new Map(terms.map((x) => [x.slug, x])), dayOf, categoryName: (key) => categories.find((c) => c.key === key)?.name || key };
    })().catch((e) => { glossaryP = null; throw e; });
    return glossaryP;
  }

  /** Planner entries due on a day number ([] without a planner). */
  async function due(day) {
    const { plan } = await ready();
    return plan ? plan.due(day) || [] : [];
  }

  /** Today's glossary entry {term, number, day} or null. */
  async function termOfDay(day) {
    const g = await glossary();
    if (!g) return null;
    const e = (await due(day)).find((x) => x.series === g.series.id || x.series?.id === g.series.id);
    if (!e?.item) return null;
    return { term: g.bySlug.get(e.item.slug) || e.item, number: e.number ?? null, day: e.day ?? day, entry: e };
  }

  /** Categories of a series, synchronously: from the resolved content once ready(), else from the pack as given. */
  function categoriesOf(id) {
    const s = config.series.find((x) => x.id === id);
    if (!s) return [];
    const n = state.plan?.content?.[id];
    if (n?.categories?.length) return n.categories;
    return normalizeOne(s, (state.content || k.content || {})[id]).categories;
  }

  return { ready, series, items, glossary, due, termOfDay, categoriesOf, plan: async () => (await ready()).plan };
}
