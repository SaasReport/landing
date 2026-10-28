/**
 * The directory of players: /directory/ (every card server-rendered, grouped by tier from upstream to downstream,
 * filtered in the browser by directory.js) and /directory/directory.json (the same data for crawlers and agents),
 * from
 *   data      entries: [{ id, name (or fa), en?, short?, category, tags?, sectors?, role, parent?, site,
 *             source: { title, url, checked: "YYYY-MM-DD", snapshot? } }]   (per locale or one list)
 *   taxonomy  { tiers: [{ key, name|fa, en }], categories: [{ key, name|fa, tier, color: a colour role (chart1 … chart6, accent, ok, warn, err) }], tags: [{ key, name|fa }] }
 *   sectors   [{ slug, name|fa }] for the sector links and filter (optional)
 *   changes   the correction form's change types (per locale)
 *   content   the page strings per locale; content.json the JSON file's own fields
 *
 *   { type: "directory", path: "/directory/", data, taxonomy, sectors, changes, generator?, json?, content: { en: {…} } }
 */
import { fill } from "../locale.js";
import { roleVar } from "../tokens.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { assertSchema } from "../schema.js";
import { CATEGORY_ROLES } from "@saasreport/core/colour";

/** The colour roles a directory category may use: the chart series (3:1 on the surfaces, apart under colour-blind simulation) and the status roles. */
export { CATEGORY_ROLES };
const roleRef = (role) => `var(${roleVar(role)})`;

export const DIRECTORY_SCRIPT = "directory.js";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const perLocale = (v, code) => (Array.isArray(v) || v == null ? v : v[code] ?? v);
const labelOf = (x) => x.name ?? x.fa;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === "string" && ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isHttps = (s) => { try { const u = new URL(s); return u.protocol === "https:" && !!u.hostname; } catch { return false; /* not a URL: not an https link */ } };
const FIELDS = new Set(["id", "name", "fa", "en", "short", "category", "tags", "sectors", "role", "parent", "site", "source"]);
const SOURCE_FIELDS = new Set(["title", "url", "checked", "snapshot"]);

/** Search normalisation, shared with the directory.js page script (data-q is written with it): Arabic-script letter
 * variants folded (ي/ى/ك/ة and hamza forms), no diacritics, tatweel, ZWNJ or direction marks, Persian and Arabic
 * digits to Latin, lower case. */
export const normalize = (s) => String(s ?? "").toLowerCase()
  .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[أإآ]/g, "ا").replace(/ؤ/g, "و")
  .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u200c\u200d\u200e\u200f]/g, "")
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/\s+/g, " ").trim();

const archiveUrl = (src) => (isHttps(src.snapshot) ? src.snapshot : `https://web.archive.org/web/${src.snapshot.replace(/-/g, "")}/${src.url}`);
const host = (url) => new URL(url).hostname.replace(/^www\./, "");

/** Problems with directory entries (and the taxonomy). `maxRole`: the longest role in characters (default 160). */
export function checkDirectory(entries, tax, sectors = [], { maxRole = 160 } = {}) {
  const errs = [];
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const tierKeys = new Set(tax.tiers.map((t) => t.key));
  const catKeys = new Set(tax.categories.map((c) => c.key));
  const tagKeys = new Set(tax.tags.map((t) => t.key));
  const sectorSlugs = new Set(sectors.map((s) => s.slug));
  for (const [name, list] of [["TIERS", tax.tiers], ["CATEGORIES", tax.categories], ["TAGS", tax.tags]]) {
    const seen = new Set();
    for (const x of list) {
      if (!KEBAB.test(x.key || "") || !str(labelOf(x))) errs.push(`taxonomy ${name}: «${x.key}» needs a kebab key and fa`);
      if (seen.has(x.key)) errs.push(`taxonomy ${name}: duplicate key «${x.key}»`); seen.add(x.key);
    }
  }
  for (const c of tax.categories) {
    if (!tierKeys.has(c.tier)) errs.push(`taxonomy category ${c.key}: unknown tier «${c.tier}»`);
    if (!CATEGORY_ROLES.includes(c.color)) errs.push(`taxonomy category ${c.key}: color must be a colour role (${CATEGORY_ROLES.join(", ")}), never a hex value (colour canon)`);
  }
  if (!Array.isArray(entries)) return [...errs, "entities.js must export an array"];
  const ids = new Map();
  for (const e of entries) {
    const bad = (msg) => errs.push(`${e?.id || "?"}: ${msg}`);
    if (!e || typeof e !== "object") { errs.push("entry is not an object"); continue; }
    for (const k of Object.keys(e)) if (!FIELDS.has(k)) bad(`unknown field «${k}» (allowed: ${[...FIELDS].filter((f) => f !== "name").join(", ")})`);
    if (!KEBAB.test(e.id || "")) bad("id must be latin kebab-case");
    else if (ids.has(e.id)) bad("duplicate id"); else ids.set(e.id, e);
    if (!str(labelOf(e))) bad("missing fa");
    for (const k of ["en", "short"]) if (e[k] !== undefined && !str(e[k])) bad(`${k} must be a non-empty string when set`);
    if (!catKeys.has(e.category)) bad(`unknown category «${e.category}»`);
    if (e.tags !== undefined) {
      if (!Array.isArray(e.tags)) bad("tags must be an array");
      else {
        for (const t of e.tags) if (!tagKeys.has(t)) bad(`unknown tag «${t}» (add it to TAGS first)`);
        if (new Set(e.tags).size !== e.tags.length) bad("duplicate tag");
      }
    }
    if (e.sectors !== undefined) {
      if (!Array.isArray(e.sectors)) bad("sectors must be an array");
      else {
        for (const s of e.sectors) if (!sectorSlugs.has(s)) bad(`sector «${s}» is not a slug in src/sectors/data.js`);
        if (new Set(e.sectors).size !== e.sectors.length) bad("duplicate sector");
      }
    }
    if (!str(e.role)) bad("missing role");
    else if ([...e.role].length > maxRole) bad(`role is ${[...e.role].length} characters (max ${maxRole})`);
    if (!isHttps(e.site)) bad("site must be an https URL");
    const src = e.source;
    if (!src || typeof src !== "object") bad("missing source");
    else {
      for (const k of Object.keys(src)) if (!SOURCE_FIELDS.has(k)) bad(`unknown source field «${k}»`);
      if (!str(src.title)) bad("source.title missing");
      if (!isHttps(src.url)) bad("source.url must be an https URL");
      if (!isIsoDate(src.checked)) bad("source.checked must be an ISO date (YYYY-MM-DD)");
      if (src.snapshot !== undefined && !isIsoDate(src.snapshot) && !isHttps(src.snapshot)) bad("source.snapshot must be an ISO date or an https archive URL");
    }
    if (/[۰-۹]\s*·|·\s*[۰-۹]/.test(JSON.stringify(e))) bad("«·» next to a Persian digit");
  }
  for (const e of entries) {
    if (!e || e.parent === undefined) continue;
    if (!ids.has(e.parent)) { errs.push(`${e.id}: parent «${e.parent}» does not exist`); continue; }
    const seen = new Set([e.id]);
    for (let p = ids.get(e.parent); p; p = p.parent !== undefined ? ids.get(p.parent) : null) {
      if (seen.has(p.id)) { errs.push(`${e.id}: parent chain has a cycle (${[...seen, p.id].join(" → ")})`); break; }
      seen.add(p.id);
    }
  }
  return errs;
}

function model(entries, tax, sectors) {
  const cat = new Map(tax.categories.map((c, i) => [c.key, { ...c, i }]));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const list = entries.map((e, i) => ({ ...e, i, tier: cat.get(e.category).tier, cat: cat.get(e.category), tags: e.tags || [], sectors: e.sectors || [] }))
    .sort((a, b) => a.cat.i - b.cat.i || a.i - b.i);
  const tagName = new Map(tax.tags.map((t) => [t.key, labelOf(t)]));
  const sectorName = new Map(sectors.map((s) => [s.slug, labelOf(s)]));
  return { list, byId, tagName, sectorName, cat };
}

/** The directory for one locale → { "index.html": …, "directory.json": … }. */
export function renderDirectory(page, ctx) {
  const { c, L, name, url, asset, chrome } = ctx;
  const code = L.code;
  const entries = perLocale(page.data, code) || [];
  const tax = perLocale(page.taxonomy, code);
  const sectors = perLocale(page.sectors, code) || [];
  const changes = perLocale(page.changes, code) || [];
  return {
    "index.html": renderDirectoryPage({ entries, tax, sectors, changes, c, L, name, url, asset, chrome, page, ctx }),
    "directory.json": renderDirectoryJson({ entries, tax, sectors, c, L, name, url, page, ctx }),
  };
}

export function renderDirectoryPage({ entries, tax, sectors, changes, c, L, name, url, asset, chrome, page, ctx }) {
  const m = model(entries, tax, sectors);
  const n = m.list.length;
  const d = (x) => L.toDigits(x);
  const f = (s, vars = {}) => fill(s, { name, ...vars });
  const PATH = ctx.pathOf(page.path);
  const pageUrl = url + PATH;
  // Solar Hijri dates from the locale's arithmetic calendar (L.date), never the ICU Persian calendar of L.dateIntl.
  const DATE = L.calendar === "jalali" ? null : new Intl.DateTimeFormat(L.dateIntl, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const date = (iso) => (DATE ? DATE.format(new Date(`${iso}T00:00:00Z`)) : L.date(iso));
  const EXT = 'rel="noopener nofollow external"';
  const count = (pred) => m.list.filter(pred).length;
  const title = f(c.title);
  const description = f(c.description);
  const alts = ctx.alternatesOf(page.path);
  const sectorsPath = ctx.pathOf(page.sectorsPath || "/sectors/");
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: title, description, url: pageUrl, inLanguage: L.intl, isPartOf: { "@id": `${ctx.homeUrl}#website` }, publisher: { "@id": `${url}/#org` },
        mainEntity: { "@type": "ItemList", numberOfItems: n, itemListElement: m.list.map((e, i) => ({ "@type": "ListItem", position: i + 1, url: `${pageUrl}#${e.id}`,
          item: { "@type": "Organization", "@id": `${pageUrl}#${e.id}`, name: labelOf(e), ...([e.en, e.short].some(Boolean) ? { alternateName: [e.en, e.short].filter(Boolean) } : {}), url: e.site } })) } },
      { "@type": "BreadcrumbList", itemListElement: [[chrome.strings.home, ctx.homeUrl], [c.crumb, pageUrl]].map(([nm, u], i) => ({ "@type": "ListItem", position: i + 1, name: nm, item: u })) },
    ],
  };
  const jsonld = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
  const mark = page.generator ? `<meta name="generator" content="${esc(page.generator)}">\n` : "";
  const ogImage = ctx.page.ogImage;
  const head = `<!doctype html>
<html lang="${L.lang}" dir="${L.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${mark}<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${ctx.colorHex.accent}">
<meta name="color-scheme" content="light">
<link rel="canonical" href="${pageUrl}"><meta name="robots" content="index, follow, max-image-preview:large">${alts.map((x) => `\n<link rel="alternate" hreflang="${x.hreflang}" href="${x.url}">`).join("")}
<link rel="alternate" type="application/json" href="${pageUrl}directory.json" title="${esc(c.jsonLink)}">
<meta property="og:type" content="website"><meta property="og:locale" content="${L.og}">${alts.filter((x) => x.og && x.og !== L.og).map((x) => `<meta property="og:locale:alternate" content="${x.og}">`).join("")}<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${pageUrl}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${ogImage}">
${jsonld}
${chrome.icons}
${chrome.preload}
<link rel="stylesheet" href="${asset("/styles.css")}">
<link rel="stylesheet" href="${asset("/notify.css")}">
<link rel="stylesheet" href="${asset("/content.css")}">
<link rel="stylesheet" href="${asset("/terminal.css")}">
<link rel="stylesheet" href="${asset("/pages.css")}">
<link rel="stylesheet" href="${asset("/directory.css")}">
</head>`;

  const card = (e) => {
    const parent = e.parent ? m.byId.get(e.parent) : null;
    const q = normalize([labelOf(e), e.short, e.en, e.id].filter(Boolean).join(" "));
    const src = e.source;
    return `<article class="dx-card" id="${e.id}" data-cat="${e.category}" data-tier="${e.tier}" data-tags="${e.tags.join(" ")}" data-sectors="${e.sectors.join(" ")}" data-q="${esc(q)}" style="--c:${roleRef(e.cat.color)}">
            <span class="dx-cat"><i aria-hidden="true"></i>${esc(labelOf(e.cat))}</span>
            <h3 class="dx-card__name">${esc(labelOf(e))}${e.en && L.lang !== "en" ? ` <small lang="en" dir="ltr">${esc(e.en)}</small>` : ""}</h3>
            <p class="dx-card__role">${esc(e.role)}</p>${e.tags.length ? `
            <ul class="dx-tags" aria-label="${esc(c.card.tags)}">${e.tags.map((t) => `<li>${esc(m.tagName.get(t))}</li>`).join("")}</ul>` : ""}${parent ? `
            <p class="dx-card__parent">${c.card.under} <a href="#${parent.id}">${esc(parent.short || labelOf(parent))}</a></p>` : ""}${e.sectors.length ? `
            <p class="dx-card__sectors">${c.card.sectors} ${e.sectors.map((s) => `<a href="${sectorsPath}${s}/">${esc(m.sectorName.get(s))}</a>`).join(c.card.join)}</p>` : ""}
            <a class="dx-card__site" href="${esc(e.site)}" ${EXT}><span dir="ltr">${esc(host(e.site))}</span> <span aria-hidden="true">↗</span><span class="sx-sr"> ${c.card.official}</span></a>
            <p class="dx-src">${c.card.source} <a href="${esc(src.url)}" ${EXT}>${esc(src.title)}</a>${c.card.checked} <time datetime="${src.checked}">${date(src.checked)}</time>${src.snapshot ? `${c.card.join}<a href="${esc(archiveUrl(src))}" ${EXT}>${c.card.archive}</a>` : ""}</p>
          </article>`;
  };
  const chip = (group, key, label, k, extra = "") => `<button type="button" aria-pressed="false" data-dx-f="${group}" data-v="${key}"${extra}>${label}<span class="dx-n" data-dx-n>${d(k)}</span></button>`;

  const chain = `<section class="section dx-sec dx-chainsec" id="chain" aria-labelledby="dx-chain-title">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${c.chain.eyebrow}</p><h2 id="dx-chain-title">${c.chain.title}</h2><p>${c.chain.lead}</p></header>
      <ol class="dx-chain" role="group" aria-label="${esc(c.chain.label)}">
        ${tax.tiers.map((t, i) => `<li>${chip("tier", t.key, `<span class="dx-chain__i">${d(i + 1)}</span><b>${esc(labelOf(t))}</b>${t.en && L.lang !== "en" ? `<small lang="en" dir="ltr">${esc(t.en)}</small>` : ""}`, count((e) => e.tier === t.key))}</li>`).join("\n        ")}
      </ol>
      <p class="dx-chain__ends" aria-hidden="true"><span>${c.chain.upstream}</span><span>${c.chain.downstream}</span></p>
    </div>
  </section>`;

  const usedTags = tax.tags.filter((t) => m.list.some((e) => e.tags.includes(t.key)));
  const F = c.filters;
  const filters = `<div class="dx-filters" data-dx-filters hidden>
        <label class="dx-search"><span class="sx-sr">${F.searchLabel}</span><input type="search" name="q" data-dx-q placeholder="${esc(F.searchPlaceholder)}" autocomplete="off" enterkeyhint="search"></label>
        <div class="dx-fgroup"><span class="dx-flabel" id="dx-f-cat">${F.category}</span><div class="dx-chips dx-chips--cat" role="group" aria-labelledby="dx-f-cat">${tax.categories.filter((cc) => m.list.some((e) => e.category === cc.key)).map((cc) => chip("cat", cc.key, `<i aria-hidden="true"></i>${esc(labelOf(cc))}`, count((e) => e.category === cc.key), ` style="--c:${roleRef(cc.color)}"`)).join("")}</div></div>${usedTags.length ? `
        <div class="dx-fgroup"><span class="dx-flabel" id="dx-f-tag">${F.tag}</span><div class="dx-chips dx-chips--tag" role="group" aria-labelledby="dx-f-tag">${usedTags.map((t) => chip("tag", t.key, esc(labelOf(t)), count((e) => e.tags.includes(t.key)))).join("")}</div></div>` : ""}
        <div class="dx-fgroup dx-fgroup--row"><label class="dx-sector"><span class="dx-flabel">${F.sector}</span><select data-dx-sector><option value="">${F.allSectors}</option>${sectors.map((s) => `<option value="${s.slug}">${esc(labelOf(s))}</option>`).join("")}</select></label>
          <p class="dx-count" aria-live="polite" data-dx-count>${f(F.count, { count: d(n) })}</p>
          <button type="button" class="btn btn--ghost btn--sm" data-dx-clear disabled>${F.clear}</button></div>
      </div>`;

  const groups = tax.tiers.map((t) => ({ t, items: m.list.filter((e) => e.tier === t.key) })).filter((g) => g.items.length);
  const results = n ? `${filters}
      <div class="dx-none" data-dx-none hidden><b>${c.none.title}</b><p>${c.none.text}</p><button type="button" class="btn btn--primary btn--sm" data-dx-clear>${F.clear}</button></div>
      ${groups.map(({ t, items }) => `<section class="dx-tier" id="tier-${t.key}" data-dx-tier="${t.key}" aria-labelledby="dx-h-${t.key}">
        <h2 class="dx-tier__h" id="dx-h-${t.key}"><span>${esc(labelOf(t))}</span> <small data-dx-tn>${d(items.length)}</small></h2>
        <div class="dx-grid">
          ${items.map((e) => card(e)).join("\n          ")}
        </div>
      </section>`).join("\n      ")}` : `<div class="dx-empty"><p class="eyebrow">${c.empty.eyebrow}</p><h2>${c.empty.title}</h2><p>${c.empty.text}</p></div>`;

  const H = c.hero, P = c.form;
  return `${head}
<body class="tpage dx-page">
${chrome.bar(c.bar, page.path)}
<main>
  <nav class="wrap sx-crumb" aria-label="${esc(c.crumbLabel)}"><ol><li><a href="${ctx.root}">${chrome.strings.home}</a></li><li aria-current="page">${c.crumb}</li></ol></nav>

  <section class="hero-t wrap sx-hero dx-hero">
    <p class="eyebrow">${H.eyebrow}</p>
    <h1>${H.title}</h1>
    <p>${H.lead}</p>
    <div class="dx-notice" role="note">
      <b>${H.notice.title}</b>
      <ul>
${H.notice.items.map((x) => `        <li>${f(x, { json: `${PATH}directory.json` })}</li>\n`).join("")}      </ul>
    </div>
  </section>

  ${chain}

  <section class="section section--paper dx-sec" id="list" aria-labelledby="dx-list-title">
    <div class="wrap" data-dx>
      <h2 class="sx-sr" id="dx-list-title">${c.listTitle}</h2>
      ${results}
    </div>
  </section>

  <section class="section dx-sec" id="correct">
    <div class="wrap">
      <div class="pform">
        <div><p class="eyebrow">${P.eyebrow}</p><h2>${P.title}</h2><p>${P.lead}</p></div>
        <form class="cform" data-cform="directory" novalidate>
          <label><span>${P.name}</span><input name="name" required maxlength="120" autocomplete="name"></label>
          <label><span>${P.email}</span><input name="email" type="email" required maxlength="200" autocomplete="email" dir="ltr"></label>
          <label><span>${P.entity}</span><input name="entity" required maxlength="160"></label>
          <label><span>${P.changeType}</span><select name="change_type" required><option value="">${P.choose}</option>${changes.map((x) => `<option>${x}</option>`).join("")}</select></label>
          <label class="dx-wide"><span>${P.details}</span><textarea name="details" required maxlength="1500"></textarea></label>
          <label class="dx-wide"><span>${P.sourceUrl}</span><input name="source_url" type="url" required maxlength="300" dir="ltr" inputmode="url" placeholder="https://"></label>
          <input name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
          <label class="cform__ok"><input type="checkbox" name="consent" required><span>${P.consent}</span></label>
          <button class="btn btn--primary" type="submit">${P.submit}</button>
        </form>
      </div>
    </div>
  </section>
</main>
${chrome.footer(c.footNote)}
<script src="${asset("/notify.js")}" defer></script>
<script src="${asset("/content-client.js")}" defer></script>
<script src="${asset("/directory.js")}" defer></script>
<script src="${asset("/totop.js")}" defer></script>
</body>
</html>
`;
}

/** directory.json: taxonomy + entries, machine-readable. `page.json` sets schema; content.json the named fields. */
export function renderDirectoryJson({ entries, tax, sectors, c, L, url, page, ctx }) {
  const m = model(entries, tax, sectors);
  const PATH = ctx.pathOf(page.path);
  const sectorsPath = ctx.pathOf(page.sectorsPath || "/sectors/");
  const J = c.json || {};
  const lang = L.lang;
  const nameKey = page.json?.nameKey || lang;        // the name fields are named after the language ("en", "fa")
  const updated = m.list.map((e) => e.source.checked).sort().at(-1) || null;
  const schemaId = page.json?.schema === "kit.directory.v2" ? "kit.directory.v2" : DIRECTORY_SCHEMA_ID;
  // v2 makes colour portable by publishing a semantic role, never a rendered brand hex value.
  // v1 remains available for existing consumers until they deliberately opt in to v2.
  // the contract's own fields come last: a content pack's head and meta add fields, they cannot replace the schema id, the url or the counts
  const doc = {
    ...J.head,
    ...J.meta,
    schema: schemaId,
    url: url + PATH,
    corrections: `${url}${PATH}#correct`,
    updated,
    count: m.list.length,
    taxonomy: {
      tiers: tax.tiers.map((t, i) => ({ key: t.key, order: i + 1, [nameKey]: labelOf(t), ...(t.en !== undefined ? { en: t.en } : {}) })),
      categories: tax.categories.map((cc) => ({ key: cc.key, [nameKey]: labelOf(cc), tier: cc.tier, ...(schemaId === "kit.directory.v2" ? {} : { color: ctx.colorHex[cc.color] }), colorRole: cc.color })),
      tags: tax.tags.map((t) => ({ key: t.key, [nameKey]: labelOf(t) })),
      sectors: sectors.map((s) => ({ slug: s.slug, [nameKey]: labelOf(s), url: `${url}${sectorsPath}${s.slug}/` })),
    },
    entries: m.list.map((e) => ({
      id: e.id, url: `${url}${PATH}#${e.id}`, [nameKey]: labelOf(e), ...(e.en ? { en: e.en } : {}), ...(e.short ? { short: e.short } : {}),
      category: e.category, tier: e.tier, tags: e.tags, sectors: e.sectors, role: e.role, ...(e.parent ? { parent: e.parent } : {}),
      site: e.site, source: { ...e.source, ...(e.source.snapshot ? { archive: archiveUrl(e.source) } : {}) },
    })),
  };
  assertSchema(JSON.parse(JSON.stringify(doc)), directorySchema(schemaId), `${PATH}directory.json`);   // the published file is validated at build time against kit.directory.v1
  return JSON.stringify(doc, null, 2) + "\n";
}

/** The id every directory.json carries (schema kit.directory.v1): fixed, never taken from content. */
export const DIRECTORY_SCHEMA_ID = "kit.directory.v1";
const schemaCache = new Map();
function directorySchema(id = DIRECTORY_SCHEMA_ID) {
  if (!schemaCache.has(id)) {
    const file = id === "kit.directory.v2" ? "directory-v2.schema.json" : "directory.schema.json";
    const f = createRequire(import.meta.url).resolve(`@saasreport/core/schemas/${file}`);
    schemaCache.set(id, JSON.parse(readFileSync(f, "utf8")));
  }
  return schemaCache.get(id);
}
