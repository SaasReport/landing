/**
 * The site shell every page carries, whatever its type (landing, terminal, content, reference, apps, notices, widgets,
 * generated pages, the Worker's pages): a menu button that opens the drawer with the project's whole menu, and a global
 * search (a button, Ctrl/⌘K and "/") over a static index built from every page and its Markdown twin. No third-party
 * service: the index is a file next to the pages (/search-index.json), the script is the kit's (/shell.js), CSP-safe.
 *
 *   project.menu: [{ label, href?, groups: [{ label?, items: [{ label, href }] }] }]   (schema: site.schema.json#/$defs/menu)
 *   shellMarkup({ menu, t, home, script })     → { buttons, panels }: the two buttons for a bar, the drawer + search dialog
 *   searchIndex(outDir, opts)                   → the index object, version 2 (pages, body terms, sections, facets, synonyms)
 *   checkSearchIndex(index)                     → problems against kit.search-index.v2 and its cross-field rules
 *   writeSearchIndex(outDir, opts)              → writes outDir/search-index.json, returns { pages, terms, bytes }
 *   checkShell(outDir, { exempt })              → problems: built pages without the menu, the search or Sections in their
 *                                                 header, a header unlike the site's other pages, a missing index
 *   navReach(outDir, { menu, urls, depth })     → pages of urls not reachable from the menu in depth clicks (the nav graph)
 *   contrastProbe(page)                         → text below WCAG AA against its background (kit site contrast-qa)
 *   SHELL_PROBE / shellProbe(playwright, …)     → the browser check (kit site shell-qa): both visible at 390 and 1440 px,
 *                                                the menu opens, a search returns results
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { shellMarkup, SHELL_CSS, SEARCH_INDEX } from "./shell-markup.js";
import { compileMatch, shortLabel } from "./registry.js";
import { validateSchema } from "./schema.js";
import INDEX_SCHEMA from "../schema/search-index.schema.json" with { type: "json" };
import CONFIG_SCHEMA from "../schema/search-config.schema.json" with { type: "json" };
import { relativeLuminance } from "@saasreport/core/colour";
export { INDEX_SCHEMA, CONFIG_SCHEMA as SEARCH_CONFIG_SCHEMA };
export { shellMarkup, SHELL_CSS, SEARCH_INDEX };

// ---- the index -----------------------------------------------------------------------------------------------------

const STOP = new Set("the and for with that this from are was were you your our not but all any can has have had its into more most also than then them they their there these those which while what when where who will would about after before over under such each other only same both very just been being how why use used using per via may might must shall should could does did done".split(" "));
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
const text = (html) => decode(html.replace(/<(script|style|svg|template|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** Index terms: case, accents and Arabic-script variants folded (ي ى → ی, ك → ک, ة → ه, joiners, Persian and Arabic digits), as the browser folds queries. */
export const fold = (s) => String(s).replace(/[™®©]/g, "").normalize("NFKD").replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "").replace(/[\u200c-\u200f]/g, "").replace(/[\u064a\u0649]/g, "\u06cc").replace(/\u0643/g, "\u06a9").replace(/\u0629/g, "\u0647").replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toLowerCase();
export const terms = (s) => (fold(s).match(/[\p{L}\p{N}]{2,}/gu) || []).filter((w) => !STOP.has(w) && w.length <= 32);

const walk = (d, root = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), root) : [relative(root, join(d, e.name))]));
const glob = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$");

/** Every indexable page of a built site: an .html file that is not noindex, not a redirect stub, with a title. */
function pagesOf(outDir, exclude = []) {
  const ex = exclude.map(glob);
  return walk(outDir).filter((f) => f.endsWith(".html") && !ex.some((r) => r.test(f))).sort().flatMap((f) => {
    const html = readFileSync(join(outDir, f), "utf8");
    if (/<meta name="robots" content="noindex/i.test(html) || /http-equiv="refresh"/i.test(html)) return [];
    const title = text((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");
    if (!title) return [];
    const url = "/" + f.replace(/(^|\/)index\.html$/, "$1");
    const twin = join(outDir, f.replace(/\.html$/, ".md"));
    const main = (/<main\b[\s\S]*?<\/main>/i.exec(html) || [html])[0];
    const heads = [...main.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => text(m[1])).filter(Boolean);
    const desc = decode((/<meta name="description" content="([^"]*)"/i.exec(html) || [])[1] || "");
    const body = existsSync(twin) ? readFileSync(twin, "utf8") : text(main);
    // the topics of the page: <meta name="kit:tags" content="id id"> (docs/TAGS.md); the search index lists them as a facet
    const tags = decode((/<meta name="kit:tags" content="([^"]*)"/i.exec(html) || [])[1] || "").split(/\s+/).filter(Boolean);
    return [{ url, title, heads, desc, body, tags }];
  });
}

/**
 * The search index, always version 2 (schema/search-index.schema.json, kit.search-index.v2): pages [url, title,
 * headings, description], an inverted index of body terms → page numbers, the sections and facets the dialog filters by,
 * synonym groups, and per page [section, weight, facet values]. Terms in more than half of the pages carry no signal
 * and are left out; the title, headings and description are matched in the browser directly, so they need no postings.
 *
 * Where the sections, facets and synonyms come from, in order: the project's page registry (opts.registry: exactly its
 * indexable pages, labels, summaries and weights); else the project's search config (opts.sections, opts.facets,
 * opts.synonyms, schema/search-config.schema.json) over what the built pages say: a section per first path segment
 * (the language prefix in opts.localePaths is not a segment), labelled by that section's own page with the site's names
 * (opts.strip) taken off, weights by depth. A site with no config still gets sections; facets and synonyms are its own.
 */
export function searchIndex(outDir, { exclude = [], registry = null, sections = [], facets = [], synonyms = [], localePaths = [], strip = [], homeLabel = "", tags = null } = {}) {
  let pages = pagesOf(outDir, exclude);
  // with a page registry (src/registry.js): exactly the registry's indexable pages, its labels, summaries and weights
  const reg = registry && new Map(registry.pages.filter((p) => p.index).map((p) => [p.url, p]));
  if (reg) pages = pages.filter((p) => reg.has(p.url)).map((p) => { const r = reg.get(p.url); return { ...p, title: r.label, heads: [r.title, ...p.heads], desc: r.summary || p.desc, r }; });
  const post = new Map();
  pages.forEach((p, i) => { for (const w of new Set(terms(`${p.body} ${p.heads.join(" ")} ${p.desc}`))) { let a = post.get(w); if (!a) post.set(w, (a = [])); a.push(i); } });
  const cap = Math.max(20, Math.floor(pages.length / 2));
  const idx = {};
  for (const w of [...post.keys()].sort()) { const a = post.get(w); if (a.length <= cap) idx[w] = a; }
  const model = reg ? fromRegistry(registry, pages) : derive(pages, { sections, facets, synonyms, localePaths, strip, homeLabel });
  if (tags) withTagFacet(model, pages, tags);
  const fpos = new Map(model.facets.flatMap((f) => f.values.map((v) => `${f.id}:${v.id}`)).map((k, i) => [k, i]));
  const out = {
    v: 2,
    pages: pages.map((p) => [p.url, p.title, p.heads.slice(0, 12).join(" · ").slice(0, 400), p.desc.slice(0, 220)]), terms: idx,
    sections: model.sections.map((s) => [s.id, s.label]),
    facets: model.facets.map((f) => ({ id: f.id, label: f.label, values: f.values.map((v) => [v.id, v.label, fpos.get(`${f.id}:${v.id}`), ...(v.synonyms?.length ? [v.synonyms] : [])]) })),
    synonyms: model.synonyms,
    meta: model.pages.map((m) => [model.sections.findIndex((s) => s.id === m.section), m.weight, Object.entries(m.facets).flatMap(([f, vs]) => vs.map((v) => fpos.get(`${f}:${v}`))).filter((x) => x !== undefined)]),
  };
  const problems = checkSearchIndex(out);
  if (problems.length) throw new Error(`the search index does not match kit.search-index.v2:\n  ${problems.join("\n  ")}`);
  return out;
}

/**
 * What buildSite hands to writeSearchIndex: the project's search config plus what the build knows (the language
 * prefixes, the home page's own word in the first locale, the site's names to take off a section's label).
 */
export function searchOptions(project, { localePaths = [], homeLabel = "" } = {}) {
  const names = [...new Set([...(project.trademark?.names || []), ...(typeof project.name === "string" ? [project.name] : Object.values(project.name || {}))])].filter(Boolean);
  const rx = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return { ...(project.search || {}), localePaths, homeLabel, strip: rx ? [`\\s*(?:${rx})\u2122?\\s*`] : [] };
}

function fromRegistry(registry, pages) {
  return {
    sections: registry.sections.map((s) => ({ id: s.id, label: s.label })),
    facets: registry.facets.map((f) => ({ id: f.id, label: f.label, values: f.values.map((v) => ({ id: v.id, label: v.label, synonyms: v.synonyms })) })),
    synonyms: registry.synonyms || [],
    pages: pages.map((p) => ({ section: p.r.section, weight: p.r.weight, facets: p.r.facets || {} })),
  };
}

/**
 * The topics of the pages as one more facet, "tags" (opts.tags: { label, values: [{ id, label, synonyms? }] }, the project's vocabulary in
 * the page's language: @saasreport/core/tags searchFacet). Only the tags some indexed page names become values; a page that names a tag outside
 * the vocabulary, or a project that already has a facet "tags", fails the build.
 */
function withTagFacet(model, pages, tags) {
  if (model.facets.some((f) => f.id === "tags")) throw new Error('the search config has a facet "tags" and a tag vocabulary: the vocabulary owns that id');
  const known = new Set(tags.values.map((v) => v.id));
  for (const p of pages) for (const id of p.tags) if (!known.has(id)) throw new Error(`${p.url}: <meta name="kit:tags"> names "${id}", which is not in the tag vocabulary`);
  const used = tags.values.filter((v) => pages.some((p) => p.tags.includes(v.id)));
  if (!used.length) return;
  model.facets = [...model.facets, { id: "tags", label: tags.label, values: used.map((v) => ({ id: v.id, label: v.label, synonyms: v.synonyms })) }];
  model.pages = model.pages.map((m, i) => (pages[i].tags.length ? { ...m, facets: { ...m.facets, tags: pages[i].tags } } : m));
}

const globRx = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$");
const slash = (u) => (u.endsWith("/") ? u : `${u}/`);
/** The model of a project without a registry: sections by rule or by first path segment, facets by rule, synonyms as given. */
function derive(pages, { sections, facets, synonyms, localePaths, strip, homeLabel }) {
  const prefixes = localePaths.filter((p) => p && p !== "/").map(slash);
  const rel = (u) => { for (const p of prefixes) if (u.startsWith(p)) return `/${u.slice(p.length)}`; return u; };
  const seg = (u) => rel(u).split("/").filter(Boolean)[0] || "";
  const rules = sections.map((s) => ({ ...s, rx: s.paths.map(globRx) }));
  const secOf = (p) => rules.find((s) => s.rx.some((r) => r.test(rel(p.url))))?.id || seg(p.url) || "home";
  const names = new Map(), hubTitle = new Map();
  for (const p of pages) { const u = rel(p.url), n = u.split("/").filter(Boolean); if (n.length === 1 && !hubTitle.has(n[0])) hubTitle.set(n[0], p.title); }
  const label = (id) => {
    const r = rules.find((s) => s.id === id); if (r) return r.label;
    if (id === "home") return homeLabel || "/";
    const t = hubTitle.get(id);
    if (t) {
      let l = shortLabel(t);   // the part before the first dash, bar or colon, then the site's own name taken off it
      for (const r of strip) { const x = l.replace(new RegExp(r, "gu"), " ").replace(/\s+/g, " ").trim(); if (x.length >= 2) l = x; }
      if (l.length >= 2) return l;
    }
    return id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  };
  const used = [...new Set(pages.map(secOf))];
  const order = [...rules.map((r) => r.id), ...used.filter((id) => !rules.some((r) => r.id === id)).sort((a, b) => (a === "home" ? -1 : b === "home" ? 1 : a.localeCompare(b)))].filter((id) => used.includes(id));
  const fdefs = facets.map((f) => ({ ...f, values: f.values.map((v) => ({ ...v, test: compileMatch({ paths: v.match.paths, words: v.match.words }) })) }));
  const weight = (p) => { const d = rel(p.url).split("/").filter(Boolean).length; return d === 0 ? 20 : d === 1 ? 12 : d === 2 ? 4 : 1; };
  for (const id of order) names.set(id, label(id));
  const outFacets = fdefs.map((f) => ({ id: f.id, label: f.label, values: f.values.map((v) => ({ id: v.id, label: v.label, synonyms: v.synonyms })) }));
  return {
    sections: order.map((id) => ({ id, label: names.get(id) })),
    facets: outFacets.filter((f) => f.values.length),
    synonyms,
    pages: pages.map((p) => {
      const input = { url: rel(p.url), title: p.title, summary: p.desc };
      const fs = {}; for (const f of fdefs) { const vs = f.values.filter((v) => v.test(input) > 0).map((v) => v.id); if (vs.length) fs[f.id] = vs; }
      return { section: secOf(p), weight: weight(p), facets: fs };
    }),
  };
}

/** Problems of a search index: its schema, one meta row per page, every section number and facet position in range. */
export function checkSearchIndex(idx) {
  const problems = validateSchema(idx, INDEX_SCHEMA).map((e) => `${e.path}: ${e.message}`);
  if (problems.length) return problems;
  const n = idx.pages.length, positions = idx.facets.reduce((t, f) => t + f.values.length, 0);
  if (idx.meta.length !== n) problems.push(`meta has ${idx.meta.length} rows for ${n} pages`);
  idx.meta.forEach((m, i) => { if (m[0] >= idx.sections.length) problems.push(`meta ${i}: section ${m[0]} of ${idx.sections.length}`); if (m[2].some((x) => x >= positions)) problems.push(`meta ${i}: a facet value beyond the ${positions} there are`); });
  for (const [w, a] of Object.entries(idx.terms)) if (a.some((i) => i >= n)) problems.push(`term ${w}: a page beyond the ${n} there are`);
  const ids = idx.sections.map((s) => s[0]); if (new Set(ids).size !== ids.length) problems.push("two sections share an id");
  return problems;
}

export function writeSearchIndex(outDir, opts) {
  const idx = searchIndex(outDir, opts);
  const json = JSON.stringify(idx);
  writeFileSync(join(outDir, SEARCH_INDEX), json);
  return { pages: idx.pages.length, terms: Object.keys(idx.terms).length, sections: idx.sections.length, bytes: json.length };
}

/** The header of a built page as the reader sees it: the logo, the labels of its call to action, its shell buttons. */
export function headerSignature(html) {
  const head = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] || "";
  const logo = head.match(/<img\b[^>]*class="[^"]*brand__logo[^"]*"[^>]*>/)?.[0]?.match(/src="([^"?]*)/)?.[1] || "";
  const cta = (head.match(/<div class="nav__cta">([\s\S]*?)<span class="kshell__btns">/)?.[1] || "")
    .match(/<(a|button)\b[^>]*class="btn[^"]*"[^>]*>[\s\S]*?<\/\1>/g)?.filter((b) => !/\bhreflang=/.test(b))
    .map((b) => b.replace(/<[^>]+>/g, "").trim()) || [];
  const shell = [...head.matchAll(/data-kit-(menu|search|sections)\b/g)].map((m) => m[1]);
  return { logo, cta, shell, key: JSON.stringify([logo, cta, shell]) };
}

/**
 * Static check of a built site: every page has the menu button, the drawer and the search, the menu, search and
 * Sections buttons sit in the page's header (not a hand-built bar), every page of one language shows the same header
 * (logo, call to action, shell buttons) as the others, and the index exists.
 */
export function checkShell(outDir, { exempt = [] } = {}) {
  const ex = exempt.map(glob), problems = [];
  const need = [["data-kit-menu", "the menu button"], ["data-kit-drawer", "the menu drawer"], ["data-kit-search", "the search button"], ["data-kit-search-dialog", "the search dialog"], [/data-kit-sections[\s>]/, "the Sections control"], ["data-kit-sections-panel", "the Sections panel"], [/\/shell(\.[\w-]+)?\.js\b/, "the shell script"]];
  let pages = 0;
  const headers = new Map();   // lang → Map(signature key → [files])
  for (const f of walk(outDir).filter((x) => x.endsWith(".html") && !ex.some((r) => r.test(x)))) {
    const html = readFileSync(join(outDir, f), "utf8");
    if (/http-equiv="refresh"/i.test(html)) continue;
    pages++;
    const miss = need.filter(([k]) => (k instanceof RegExp ? !k.test(html) : !html.includes(k))).map(([, l]) => l);
    if (miss.length) { problems.push(`${f}: missing ${miss.join(", ")}`); continue; }
    const sig = headerSignature(html);
    const inHeader = ["menu", "search", "sections"].filter((k) => !sig.shell.includes(k));
    if (inHeader.length) { problems.push(`${f}: the ${inHeader.join(", ")} button${inHeader.length > 1 ? "s are" : " is"} not in the page's header (a hand-built bar?)`); continue; }
    const lang = html.match(/<html\b[^>]*\blang="([^"]+)"/)?.[1] || "";
    if (!headers.has(lang)) headers.set(lang, new Map());
    const byKey = headers.get(lang);
    byKey.set(sig.key, [...(byKey.get(sig.key) || []), f]);
  }
  // one header per language: the most common one is the site's; every other is named with what differs
  for (const [lang, byKey] of headers) {
    if (byKey.size < 2) continue;
    const [main] = [...byKey].sort((a, b) => b[1].length - a[1].length)[0];
    const want = JSON.parse(main);
    for (const [key, files] of byKey) if (key !== main) {
      const [logo, cta] = JSON.parse(key);
      const what = [logo !== want[0] && `logo ${logo || "none"} (the site's: ${want[0]})`, JSON.stringify(cta) !== JSON.stringify(want[1]) && `call to action [${cta.join(", ")}] (the site's: [${want[1].join(", ")}])`].filter(Boolean).join("; ") || "shell buttons";
      problems.push(`${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}${lang ? ` (${lang})` : ""}: a different header: ${what}`);
    }
  }
  const ip = join(outDir, SEARCH_INDEX);
  if (!existsSync(ip)) problems.push(`no ${SEARCH_INDEX} (writeSearchIndex after the last page is written)`);
  else {
    const idx = JSON.parse(readFileSync(ip, "utf8")), n = idx.pages?.length || 0;
    if (n < Math.min(pages, 1)) problems.push(`${SEARCH_INDEX} lists no page`);
    else if (idx.v !== 2) problems.push(`${SEARCH_INDEX} is version ${idx.v}, not 2 (kit site build writes version 2: sections, facets, synonyms; rebuild)`);
    else problems.push(...checkSearchIndex(idx).map((x) => `${SEARCH_INDEX}: ${x}`));
  }
  return { pages, problems };
}

/**
 * The browser check of one page at one width (runs in Node with a Playwright page): the menu and search buttons are
 * visible, the menu opens the drawer with links, Ctrl+K opens the search and a query returns results.
 */
export async function shellProbe(page, { query }) {
  const r = { menu: false, drawer: 0, search: false, sections: false, results: 0 };
  const vis = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= innerWidth && c.visibility !== "hidden" && c.display !== "none"; }), sel);
  // visible = inside the viewport too (a button pushed off a crowded bar does not count)
  r.menu = await vis("header [data-kit-menu]");
  r.search = await vis("header [data-kit-search], .nav [data-kit-search]");
  r.sections = await vis("header [data-kit-sections]");
  if (r.menu) { await page.locator("[data-kit-menu]:visible").first().click(); await page.waitForTimeout(150); r.drawer = await page.evaluate(() => { const d = document.querySelector("[data-kit-drawer]"); return d && !d.hidden ? d.querySelectorAll("a[href]").length : 0; }); await page.keyboard.press("Escape"); }
  await page.keyboard.press("Control+k");
  await page.waitForSelector("[data-kit-search-dialog]:not([hidden])", { timeout: 3000 }).catch(() => {});   // a dialog that never opens is reported by the result count below
  await page.locator("[data-kit-search-dialog] input").fill(query).catch(() => {});   // no input to fill is reported by the result count below
  r.results = await page.waitForFunction(() => document.querySelectorAll("[data-kit-search-dialog] .kshell__results li a").length, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => 0);   // no results within 8 s counts as 0, which the shell check reports
  await page.keyboard.press("Escape");
  return r;
}

/**
 * The contrast of text as it is painted (pure; runs in Node and, as source, in the page): `fg` is the text colour and
 * `layers` the background colours from the element up to the root, each [r, g, b, a]. Translucent backgrounds are
 * composited over the ones behind them, onto the white canvas, then a translucent text colour over the result.
 */
export function paintedContrast(fg, layers, lum = relativeLuminance) {   // `lum`: the one formula of @saasreport/core/colour (the page is given its source)
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  let bg = [255, 255, 255];
  for (const l of [...layers].reverse()) if (l && l[3] > 0) bg = over(l, bg);
  const text = over(fg, bg);
  const [x, y] = [lum(text), lum(bg)].sort((m, n) => n - m);
  return { ratio: (x + 0.05) / (y + 0.05), background: bg.map(Math.round), color: text.map(Math.round) };
}

/**
 * The browser contrast check of one page (runs in Node with a Playwright page): every visible text node's colour
 * against what is painted behind it (paintedContrast: translucent colours composited over their ancestors), WCAG AA
 * (4.5:1, or 3:1 for large text: 24px, or 18.66px bold). Text over an image or gradient is skipped. The page's CSP
 * must allow evaluation (kit site contrast-qa opens pages with bypassCSP). Returns [{ ratio, need, color, background,
 * path, text }].
 */
export async function contrastProbe(page) {
  return page.evaluate(({ src, lumSrc }) => {
    const lumFn = new Function(`return (${lumSrc})`)(), paintedFn = new Function(`return (${src})`)();
    const painted = (f, l) => paintedFn(f, l, lumFn);
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
    const layersOf = (el) => { const out = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== "none" || cs.backgroundClip === "text") return null; out.push(parse(cs.backgroundColor)); } return out; };
    const path = (el) => { const a = []; for (let e = el; e && e !== document.body && a.length < 4; e = e.parentElement) a.unshift(e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? `.${e.className.trim().split(/\s+/).join(".")}` : "")); return a.join(" > "); };
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (el.closest("[hidden],[aria-hidden=true],.sr-only,.nn__sr")) continue;
      const cs = getComputedStyle(el), bx = el.getBoundingClientRect();
      if (cs.visibility === "hidden" || cs.display === "none" || bx.width < 2 || bx.height < 2 || +cs.opacity < 0.5 || parse(cs.webkitTextFillColor)?.[3] === 0) continue;
      const fg = parse(cs.color), layers = layersOf(el);
      if (!fg || !layers || fg[3] === 0) continue;
      const r = painted(fg, layers);
      const size = parseFloat(cs.fontSize), need = size >= 24 || (+cs.fontWeight >= 700 && size >= 18.66) ? 3 : 4.5;
      if (r.ratio < need) out.push({ ratio: +r.ratio.toFixed(2), need, color: `rgb(${r.color.join(", ")})`, background: `rgb(${r.background.join(", ")})`, path: path(el), text: el.textContent.trim().slice(0, 40) });
    }
    return out;
  }, { src: paintedContrast.toString(), lumSrc: relativeLuminance.toString() });
}

/**
 * Fixed elements whose visibility changes while the page scrolls (a floating button that steps aside when text sits
 * under it, a bar that fades in after a scroll): the page is scrolled top to bottom in steps and every fixed element's
 * shown state recorded; any element seen both shown and hidden is returned. Open dialogs and drawers are not scrolled.
 */
export async function fixedFlicker(page, { step = 500 } = {}) {
  return page.evaluate(async (STEP) => {
    const seen = new Map();
    const key = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")}`;
    const shown = (el) => { const c = getComputedStyle(el), b = el.getBoundingClientRect(); return !el.hidden && c.display !== "none" && c.visibility !== "hidden" && +c.opacity > 0.05 && b.width > 0 && b.height > 0; };
    const sample = () => { for (const el of document.querySelectorAll("body *")) { if (getComputedStyle(el).position !== "fixed") continue; const k = key(el), v = shown(el); const s = seen.get(k) || new Set(); s.add(v); seen.set(k, s); } };
    const H = document.documentElement.scrollHeight;
    for (let y = Math.round(innerHeight * 1.6); y < H; y += STEP) { scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))); sample(); }
    scrollTo(0, 0);
    return [...seen].filter(([, s]) => s.size > 1).map(([k]) => k);
  }, step);
}

/**
 * The nav graph of a built site: click 1 is any link of the menu (project.menu, the drawer on every page), every
 * further click is a link on the page reached; links inside the drawer are the menu and are not counted again.
 * Returns { depth: Map(path → clicks), orphans: the paths of urls not reached within `depth` clicks }.
 */
export function navReach(outDir, { menu = [], urls = [], depth = 3, origin = "" } = {}) {
  const pathOf = (u) => { try { return new URL(u, origin || "https://x.invalid").pathname; } catch { return null; /* not a URL: it has no path (null) */ } };
  const fileOf = (p) => join(outDir, decodeURIComponent(p).replace(/^\//, ""), p.endsWith("/") ? "index.html" : "");
  const linksOf = (html) => [...html.replace(/<div class="kshell__drawer"[\s\S]*?<\/nav>\s*<\/div>/, "").matchAll(/<a\b[^>]*?href="([^"#?]+)/g)]
    .map((m) => m[1]).filter((h) => h.startsWith("/") || (origin && h.startsWith(origin))).map(pathOf).filter(Boolean);
  const first = [...new Set(menu.flatMap((s) => [s.href, ...(s.groups || []).flatMap((g) => [g.href, ...(g.items || []).map((i) => i.href)])]).filter((h) => h && (h.startsWith("/") || (origin && h.startsWith(origin)))).map(pathOf))];
  const seen = new Map([["/", 0]]);
  let frontier = [];
  for (const p of first) if (!seen.has(p)) { seen.set(p, 1); frontier.push(p); }
  for (let d = 2; d <= depth; d++) {
    const next = [];
    for (const p of frontier) {
      const f = fileOf(p);
      if (!existsSync(f)) continue;
      for (const q of linksOf(readFileSync(f, "utf8"))) if (!seen.has(q)) { seen.set(q, d); next.push(q); }
    }
    frontier = next;
  }
  return { depth: seen, orphans: urls.map(pathOf).filter((p) => p && !seen.has(p)) };
}
