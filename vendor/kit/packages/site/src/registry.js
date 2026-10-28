/**
 * The page registry: one canonical, schema-validated record of every page of a site (kit.page-registry.v1),
 * generated from the project's pages and its taxonomy (kit.taxonomy.v1: sections, groups and facets as rules). The
 * site's navigation is generated from it and from nothing else: the menu, the section, group and facet hubs, the
 * breadcrumbs, the related / previous / next links, the sitemap, llms.txt, the search index and the BreadcrumbList
 * structured data. A page is listed in exactly one group (no duplicates), every link shows its target's own label (no
 * mislabels), and every indexable page sits under a hub (no orphans); checkRegistry fails on any of the three.
 *
 *   buildRegistry({ pages, taxonomy, generatedBy }) → registry      pages: the project's page input (see PAGE_INPUT)
 *   registryMenu(registry, { perGroup, browse })    → project.menu (the shell drawer), labels from the registry
 *   menuLinks(menu)                                 → [{ label, href, where }] every link the drawer shows
 *   checkMenu(menu, registry)                       → problems: duplicate targets, labels that are not the target's
 *   registrySitemap(registry, { origin, lastmod })  → sitemap XML of the indexable pages
 *   registryLlms(registry, { twin, perGroup })      → llms.txt sections (for @saasreport/core llmsTxt): every hub, each group's first pages
 *   byUrl(registry)                                 → Map(url → page)
 *
 * PAGE_INPUT: { url, title, h1?, summary?, label?, aliases?, index?, kind?, family?, parent?, rail?, surface?, tags?,
 *   related? (urls), widgets? }. url is the path (/a/b/); parent is a page path or slug the project's sources give.
 */
import { validateSchema } from "./schema.js";
import TAXONOMY_SCHEMA from "../schema/taxonomy.schema.json" with { type: "json" };
import REGISTRY_SCHEMA from "../schema/page-registry.schema.json" with { type: "json" };

export { TAXONOMY_SCHEMA, REGISTRY_SCHEMA };
export const REGISTRY_VERSION = "kit.page-registry.v1";

const clean = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
/** Label comparison: case, trademark marks, punctuation and spacing do not count. */
export const labelKey = (s) => clean(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[™®©]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const slashed = (u) => { const p = String(u).replace(/[?#].*$/, ""); return p.endsWith("/") || /\.[a-z0-9]+$/i.test(p) ? p : `${p}/`; };
const idOf = (url) => (url === "/" ? "home" : url.replace(/^\/|\/$/g, "").toLowerCase().replace(/[^a-z0-9/._-]+/g, "-") || "home");
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$");
const wordRe = (w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.+^${}()|[\]\\*?]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");

/** The short label of a title: the site-name suffix removed, then the part before a dash, bar or colon when there is one. */
export function shortLabel(title, strip = []) {
  let t = clean(title);
  for (const r of strip) t = t.replace(new RegExp(r, "u"), "").trim();
  // the part before the first dash, bar, middle dot or colon that is not inside brackets
  let depth = 0, cut = -1;
  for (let i = 0; i < t.length && cut < 0; i++) {
    const c = t[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth) depth--;
    else if (!depth && (/^\s[—–|·-]\s/.test(t.slice(i, i + 3)) || (c === ":" && t[i + 1] === " "))) cut = i;
  }
  const head = (cut > 0 ? t.slice(0, cut) : t).trim();
  const l = head.length >= 3 ? head : t;
  return /^\p{Ll}/u.test(l) && !/^[a-z]+[A-Z/]/.test(l) ? l[0].toUpperCase() + l.slice(1) : l;
}

/** A compiled match rule → (page) → strength 0..4 (see taxonomy.schema.json #/$defs/match). */
function compile(m = {}) {
  const exact = new Set((m.paths || []).filter((p) => !p.includes("*")).map(slashed));
  const globs = (m.paths || []).filter((p) => p.includes("*")).map(globRe);
  const sources = new Set(m.sources || []);
  const attrs = [["families", "family"], ["parents", "parentSlug"], ["rails", "rail"], ["surfaces", "surface"], ["kinds", "kind"]].map(([k, f]) => [new Set(m[k] || []), f]);
  const words = (m.words || []).map(wordRe);
  const within = (m.within || []).map((g) => (g.includes("*") ? globRe(g) : new RegExp(`^${slashed(g).replace(/[.+^${}()|[\]\\]/g, "\\$&")}$`)));
  const only = within.length && !exact.size && !globs.length && !sources.size && !words.length && attrs.every(([set]) => !set.size);
  return (p) => {
    if (within.length && !within.some((r) => r.test(p.url))) return 0;
    if (only) return 0.5;
    if (exact.has(p.url) || (p.tags || []).some((t) => sources.has(t))) return 4;
    if (globs.some((r) => r.test(p.url))) return 3;
    if (attrs.some(([set, f]) => set.size && p[f] && set.has(p[f]))) return 2;
    if (words.length) { const hay = ` ${clean(`${p.title} ${p.h1 || ""} ${p.summary || ""}`).toLowerCase()} `; if (words.some((r) => r.test(hay))) return 1; }
    return 0;
  };
}

/**
 * The registry from the project's pages and taxonomy. Throws listing every problem when the taxonomy is invalid, a
 * hub names a page that does not exist, or two pages share a URL. Deterministic: the same input gives the same file.
 */
export function buildRegistry({ pages: input, taxonomy, generatedBy = "@saasreport/site buildRegistry" }) {
  const tp = validateSchema(taxonomy, TAXONOMY_SCHEMA);
  if (tp.length) throw new Error(`taxonomy does not match kit.taxonomy.v1:\n${tp.map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
  const problems = [];
  const browse = taxonomy.browse || "/browse/";
  const home = taxonomy.home || { url: "/", label: "Home" };
  const strip = taxonomy.titleStrip || [];

  // ---- pages
  const pages = new Map();
  for (const x of input) {
    const url = slashed(x.url);
    if (pages.has(url)) { problems.push(`two pages at ${url}`); continue; }
    const title = clean(x.title) || url;
    const label = clean(x.label) || (url === home.url ? home.label : shortLabel(title, strip));
    const aliases = [...new Set([title, shortLabel(title, strip), clean(x.h1), ...(x.aliases || []).map(clean)].filter((a) => a && a !== label))];
    pages.set(url, { ...x, parent: undefined, parentSlug: x.parent, url, title, label, aliases, summary: clean(x.summary), index: x.index !== false, kind: url === home.url ? "home" : "page", srcKind: x.kind });
  }
  if (!pages.has(home.url)) problems.push(`no home page at ${home.url}`);
  const all = () => [...pages.values()];

  // ---- the tree: sections → groups → pages
  const gen = (url, title, kind, summary = "") => { pages.set(url, { url, title, label: title, aliases: [], summary, index: true, kind, generated: true, tags: [] }); return pages.get(url); };
  const sections = taxonomy.sections.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, test: compile(g.match) })) }));
  for (const s of sections) {
    if (s.hub) { if (!pages.has(slashed(s.hub))) problems.push(`section ${s.id}: hub ${s.hub} is not a page`); else s.hub = slashed(s.hub); }
    else s.hub = gen(`${browse}${s.id}/`, s.label, "section", s.summary).url;
    for (const g of s.groups) {
      if (g.hub) { if (!pages.has(slashed(g.hub))) problems.push(`group ${s.id}/${g.id}: hub ${g.hub} is not a page`); else g.hub = slashed(g.hub); }
      else g.hub = gen(`${browse}${s.id}/${g.id}/`, g.label, "group", g.summary).url;
    }
  }
  if (problems.length) throw new Error(`page registry:\n  - ${problems.join("\n  - ")}`);
  const fb = sections.find((s) => s.id === taxonomy.fallback.section)?.groups.find((g) => g.id === taxonomy.fallback.group);
  if (!fb) throw new Error(`page registry: fallback ${taxonomy.fallback.section}/${taxonomy.fallback.group} is not a group`);
  const hubOf = new Map();
  for (const s of sections) {
    const sp = pages.get(s.hub); if (!hubOf.has(s.hub)) { hubOf.set(s.hub, { section: s.id }); sp.kind = sp.kind === "home" ? "home" : "section"; }
    for (const g of s.groups) { const gp = pages.get(g.hub); if (!hubOf.has(g.hub)) { hubOf.set(g.hub, { section: s.id, group: g.id }); if (gp.kind === "page") gp.kind = "group"; } }
  }
  for (const p of all()) {
    if (p.generated || p.kind === "home" || !p.index) continue;
    const h = hubOf.get(p.url);
    if (h?.group) { p.section = h.section; p.group = h.group; continue; }
    if (h) { p.section = h.section; continue; }
    let best = { n: 0 };
    for (const s of sections) for (const g of s.groups) { const n = g.test(p); if (n > best.n) best = { n, s, g }; }
    const s = best.n ? best.s : sections.find((x) => x.groups.includes(fb)), g = best.n ? best.g : fb;
    p.section = s.id; p.group = g.id;
  }
  for (const s of sections) for (const g of s.groups) { const gp = pages.get(g.hub); if (gp.generated) { gp.section = s.id; gp.group = g.id; } }
  for (const s of sections) { const sp = pages.get(s.hub); if (sp.generated) sp.section = s.id; }
  const secOf = (id) => sections.find((s) => s.id === id), grpOf = (sid, gid) => secOf(sid)?.groups.find((g) => g.id === gid);

  // parents and crumbs: home → section hub → group hub → page (repeats collapsed)
  for (const p of all()) {
    if (p.kind === "home") { p.crumbs = [home.url]; continue; }
    const s = secOf(p.section), g = grpOf(p.section, p.group);
    const chain = [home.url, s?.hub, g?.hub, p.url].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);
    p.crumbs = p.index ? chain : [home.url, p.url];
    p.parent = p.crumbs.length > 1 ? p.crumbs[p.crumbs.length - 2] : undefined;
  }

  // ---- facets (multi-valued) and the content type (single-valued)
  const facetDefs = [...(taxonomy.facets || []).map((f) => ({ ...f, single: false })), ...(taxonomy.contentType ? [{ ...taxonomy.contentType, single: true }] : [])];
  for (const f of facetDefs) f.values = f.values.map((v) => ({ ...v, test: compile(v.match) }));
  for (const p of all()) {
    p.facets = {};
    if (!p.index || p.generated) continue;
    for (const f of facetDefs) {
      const hits = f.values.map((v) => [v, v.test(p)]).filter(([, n]) => n > 0);
      if (!hits.length) continue;
      if (f.single) { const top = hits.reduce((a, b) => (b[1] > a[1] ? b : a)); p.contentType = top[0].id; p.facets[f.id] = [top[0].id]; if (top[0].visual) p.visual = top[0].visual; }
      else p.facets[f.id] = hits.map(([v]) => v.id);
    }
  }
  // facet pages: /browse/ → /browse/<facet>/ → /browse/<facet>/<value>/ (values no page has are left out)
  const facetOut = [];
  const used = (fid, vid) => all().filter((p) => (p.facets?.[fid] || []).includes(vid));
  if (facetDefs.length) {
    const root = gen(browse, "Browse", "browse"); root.crumbs = [home.url, browse]; root.parent = home.url;
    for (const f of facetDefs) {
      const values = f.values.map((v) => ({ v, n: used(f.id, v.id).length })).filter((x) => x.n);
      if (!values.length) continue;
      const fp = gen(`${browse}${f.id}/`, f.label, "facet", f.summary); fp.crumbs = [home.url, browse, fp.url]; fp.parent = browse; fp.facet = f.id;
      const vals = values.map(({ v, n }) => {
        const vp = gen(`${browse}${f.id}/${v.id}/`, `${f.label}: ${v.label}`, "facet-value", v.summary); vp.label = v.label; vp.facetLabel = f.label; vp.crumbs = [home.url, browse, fp.url, vp.url]; vp.parent = fp.url; vp.facet = f.id; vp.value = v.id;
        return { id: v.id, label: v.label, hub: vp.url, count: n, ...(v.synonyms?.length ? { synonyms: v.synonyms } : {}), ...(v.visual ? { visual: v.visual } : {}) };
      });
      facetOut.push({ id: f.id, label: f.label, hub: fp.url, ...(f.single ? { single: true } : {}), values: vals });
    }
  }

  // ---- weights: hubs first, then pages the legacy navigation listed, then pages others point to
  const inbound = new Map();
  for (const p of all()) for (const r of p.related || []) { const u = slashed(r); inbound.set(u, (inbound.get(u) || 0) + 1); }
  for (const p of all()) {
    const g = grpOf(p.section, p.group);
    const base = { home: 20, section: 12, group: 9, browse: 6, facet: 5, "facet-value": 4 }[p.kind] || 1;
    p.weight = Math.round((base + (g?.weight || 0) + ((p.tags || []).some((t) => t.startsWith("menu:")) ? 2 : 0) + Math.min(5, inbound.get(p.url) || 0) * 0.5) * 10) / 10;
  }

  // ---- labels are unique among indexable pages. A generated hub or facet page gives way first (it takes its longer
  // title: "Product: Evidence Pack™"); among source pages the heaviest keeps the short label and the others name their
  // parent ("Evidence Pack™ (Glossary)"), then their full title, then their URL, so a link always names one page.
  {
    const full = (p) => { let t = p.title; for (const r of strip) t = t.replace(new RegExp(r, "u"), "").trim(); return t; };
    const clash = () => { const m = new Map(); for (const p of all()) if (p.index) (m.get(labelKey(p.label)) || m.set(labelKey(p.label), []).get(labelKey(p.label))).push(p); return [...m.values()].filter((l) => l.length > 1); };
    const rename = (p, n) => { if (n && n !== p.label) { if (!p.aliases.includes(p.label)) p.aliases.push(p.label); p.label = n; } };
    for (const group of clash()) for (const p of group) if (p.generated) rename(p, p.title !== p.label ? p.title : `${p.label} (${pages.get(p.parent)?.label || "Browse"})`);
    // the qualifier names where the page sits: its parent's label, or (when the parent has the same label, "Glossary
    // (Glossary)") the first segment of its URL ("Glossary (Learn)")
    const seg = (p) => { const s = p.url.split("/").filter(Boolean)[0]; return s ? s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Home"; };
    const where = (p) => { const l = pages.get(p.parent)?.label; return l && labelKey(l) !== labelKey(p.label) ? l : seg(p); };
    for (const step of [(p) => `${p.label} (${where(p)})`, (p) => full(p), (p) => `${p.label} (${p.url})`]) {
      for (const group of clash()) { const keep = [...group].sort((x, y) => y.weight - x.weight || x.url.length - y.url.length || x.url.localeCompare(y.url))[0]; for (const p of group) if (p !== keep) rename(p, step(p)); }
    }
  }

  // ---- order inside a group, previous / next, related
  const byLabel = (a, b) => b.weight - a.weight || a.label.localeCompare(b.label, "en") || a.url.localeCompare(b.url);
  const members = (sid, gid) => all().filter((p) => p.index && p.section === sid && p.group === gid && p.kind === "page").sort(byLabel);
  for (const s of sections) for (const g of s.groups) {
    const ms = members(s.id, g.id);
    ms.forEach((p, i) => { if (i > 0) p.prev = ms[i - 1].url; if (i < ms.length - 1) p.next = ms[i + 1].url; });
    g.count = ms.length;
  }
  const max = taxonomy.related?.max ?? 5;
  const listed = all().filter((p) => p.index && p.kind === "page");
  const fv = (p) => new Set(Object.entries(p.facets || {}).filter(([k]) => k !== taxonomy.contentType?.id).flatMap(([k, vs]) => vs.map((v) => `${k}:${v}`)));
  const fsets = new Map(listed.map((p) => [p.url, fv(p)]));
  for (const p of all()) {
    const own = (p.related || []).map(slashed).filter((u) => u !== p.url && pages.get(u)?.index);
    if (p.kind !== "page" || !p.index) { p.related = [...new Set(own)].slice(0, max); continue; }
    const mine = fsets.get(p.url);
    const scored = [];
    for (const q of listed) {
      if (q.url === p.url || q.url === p.parent) continue;
      let n = 0; for (const k of fsets.get(q.url)) if (mine.has(k)) n++;
      if (q.group === p.group && q.section === p.section) n += 1; else if (q.section === p.section) n += 0.5;
      if (n >= 1.5) scored.push([q, n]);
    }
    scored.sort((a, b) => b[1] - a[1] || b[0].weight - a[0].weight || a[0].url.localeCompare(b[0].url));
    const out = [...new Set(own)];
    for (const [q] of scored) { if (out.length >= max) break; if (!out.includes(q.url) && q.url !== p.prev && q.url !== p.next) out.push(q.url); }
    p.related = out.slice(0, max);
  }

  // ---- the file
  const keep = ["id", "url", "title", "label", "aliases", "summary", "kind", "generated", "index", "section", "group", "parent", "crumbs", "facets", "contentType", "related", "prev", "next", "weight", "widgets", "visual"];
  const outPages = all().sort((a, b) => a.url.localeCompare(b.url)).map((p) => {
    const o = { ...p, id: idOf(p.url), summary: p.summary || "", facets: p.facets || {}, widgets: p.widgets || [], aliases: p.aliases?.length ? p.aliases : undefined, generated: p.generated || undefined };
    return Object.fromEntries(keep.filter((k) => o[k] !== undefined && (o[k] !== "" || k === "summary")).map((k) => [k, o[k]]));
  });
  const ids = new Map();
  for (const p of outPages) { if (ids.has(p.id)) throw new Error(`page registry: ${p.url} and ${ids.get(p.id)} have the same id ${p.id}`); ids.set(p.id, p.url); }
  const reg = {
    schema: REGISTRY_VERSION, generated_by: generatedBy, home: home.url, browse,
    ...(taxonomy.synonyms?.length ? { synonyms: taxonomy.synonyms } : {}),
    sections: sections.map((s) => ({ id: s.id, label: s.label, hub: s.hub, groups: s.groups.map((g) => ({ id: g.id, label: g.label, hub: g.hub, count: g.count })) })),
    facets: facetOut, pages: outPages,
  };
  const rp = validateSchema(reg, REGISTRY_SCHEMA);
  if (rp.length) throw new Error(`page registry does not match ${REGISTRY_VERSION}:\n${rp.slice(0, 20).map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
  return reg;
}

export { compile as compileMatch };
export const byUrl = (reg) => new Map(reg.pages.map((p) => [p.url, p]));

/** The pages of a hub in order: a group's members, a section's groups, a facet value's pages. */
export function hubMembers(reg, hub) {
  const url = typeof hub === "string" ? hub : hub.url;
  const order = (a, b) => b.weight - a.weight || a.label.localeCompare(b.label, "en") || a.url.localeCompare(b.url);
  const grp = reg.sections.flatMap((s) => s.groups.map((g) => ({ s, g }))).find(({ g }) => g.hub === url);
  if (grp) return reg.pages.filter((p) => p.index && p.kind === "page" && p.section === grp.s.id && p.group === grp.g.id).sort(order);
  for (const f of reg.facets) for (const v of f.values) if (v.hub === url) return reg.pages.filter((p) => p.index && p.kind === "page" && (p.facets[f.id] || []).includes(v.id)).sort(order);
  return [];
}

/**
 * project.menu from the registry: one drawer section per taxonomy section, one group per taxonomy group (its heading
 * links to the group hub), and the group's first pages by weight. Every label is the target page's own label.
 */
export function registryMenu(reg, { perGroup = 5, browse = true } = {}) {
  const P = byUrl(reg);
  const lab = (u) => P.get(u)?.label || u;
  const menu = reg.sections.map((s) => ({
    label: s.label, href: s.hub, hrefLabel: lab(s.hub),
    groups: s.groups.filter((g) => g.count || !P.get(g.hub)?.generated).map((g) => {
      const items = hubMembers(reg, g.hub).filter((p) => p.url !== s.hub).slice(0, perGroup).map((p) => ({ label: p.label, href: p.url }));
      return { label: lab(g.hub), href: g.hub, count: g.count, items };
    }),
  }));
  if (browse && reg.facets.length) menu.push({ label: lab(reg.browse), href: reg.browse, hrefLabel: lab(reg.browse), groups: reg.facets.map((f) => ({ label: f.label, href: f.hub, count: f.values.length, items: f.values.slice(0, perGroup).map((v) => ({ label: v.label, href: v.hub })) })) });
  return menu;
}

/** Every link the drawer shows: section overview links, group headings and items. */
export function menuLinks(menu) {
  const out = [];
  for (const s of menu) {
    if (s.href) out.push({ label: s.hrefLabel || s.label, href: s.href, where: s.label });
    for (const g of s.groups || []) {
      if (g.href) out.push({ label: g.label, href: g.href, where: `${s.label} › ${g.label}` });
      for (const i of g.items || []) out.push({ label: i.label, href: i.href, where: `${s.label} › ${g.label || ""}` });
    }
  }
  return out;
}

/** Problems of a menu against the registry: a target twice (duplicate), a label that is not the target's label or alias (mislabel), a target that is not a page. */
export function checkMenu(menu, reg) {
  const P = byUrl(reg), seen = new Map(), problems = [];
  for (const l of menuLinks(menu)) {
    if (!l.href.startsWith("/")) continue;
    const u = slashed(l.href), p = P.get(u);
    if (seen.has(u)) problems.push(`duplicate: ${u} is linked from "${seen.get(u)}" and "${l.where} › ${l.label}"`); else seen.set(u, `${l.where} › ${l.label}`);
    if (!p) { problems.push(`not a page: ${l.where} › ${l.label} → ${u}`); continue; }
    const ok = [p.label, p.title, ...(p.aliases || [])].map(labelKey);
    if (!ok.includes(labelKey(l.label))) problems.push(`mislabel: "${l.label}" → ${u}, whose label is "${p.label}"`);
  }
  return problems;
}

/**
 * Problems of the registry itself: an indexable page in no hub (orphan), crumbs that do not end at the page or start at
 * home, related / prev / next that point at nothing, ids or URLs twice.
 */
export function checkRegistry(reg) {
  const problems = [], P = byUrl(reg);
  const listed = new Set();
  for (const s of reg.sections) for (const g of s.groups) for (const p of hubMembers(reg, g.hub)) listed.add(p.url);
  for (const p of reg.pages) {
    if (p.index && p.kind === "page" && !listed.has(p.url)) problems.push(`orphan: ${p.url} is in no hub`);
    if (p.crumbs[0] !== reg.home || p.crumbs.at(-1) !== p.url) problems.push(`crumbs of ${p.url} do not run from ${reg.home} to the page`);
    for (const c of p.crumbs) if (!P.has(c)) problems.push(`${p.url}: crumb ${c} is not a page`);
    for (const u of [...p.related, p.prev, p.next].filter(Boolean)) if (!P.get(u)?.index) problems.push(`${p.url}: link to ${u}, which is not an indexable page`);
  }
  if (new Set(reg.pages.map((p) => p.id)).size !== reg.pages.length) problems.push("two pages share an id");
  return problems;
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The sitemap (urlset) of the registry's indexable pages. */
export function registrySitemap(reg, { origin, lastmod }) {
  const o = origin.replace(/\/$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${reg.pages.filter((p) => p.index).map((p) => `  <url><loc>${xmlEsc(o + p.url)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
}

/** llms.txt sections from the registry: one per taxonomy section, its groups' pages in order (title, url, summary). */
export function registryLlms(reg, { twin = (u) => u, perGroup = 15 } = {}) {
  const P = byUrl(reg);
  return reg.sections.map((s) => ({
    title: s.label,
    links: [P.get(s.hub), ...s.groups.flatMap((g) => [P.get(g.hub), ...hubMembers(reg, g.hub).slice(0, perGroup)])].filter((p, i, a) => p && p.index && a.indexOf(p) === i)
      .map((p) => ({ title: p.label, url: twin(p.url), ...(p.summary ? { description: p.summary.length > 180 ? `${p.summary.slice(0, 180).replace(/\s+\S*$/, "")}…` : p.summary } : {}) })),
  }));
}
