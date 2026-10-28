/**
 * Sector pages: /sectors/ (a grid filtered by group) and /sectors/<slug>/ (products, value-chain actors, a typical
 * flow, a live terminal scene, glossary terms and related sectors), from
 *   data      the sectors: { slug, name (or fa), group, headline, intro, products: [{ name, how }], actors, flow,
 *             glossary: [slug], view, caption }  (per locale: { en: [...], ar: [...] } or one list)
 *   taxonomy  the groups: [{ key, name (or fa) }]
 *   content   the page strings per locale ({name}, {sector} and {count} are filled in)
 *   glossary  per locale: { slug: label } for the glossary links (optional)
 *
 *   { type: "sectors", path: "/sectors/", data, taxonomy, glossary, generator?, content: { en: {…} } }
 */
import { fill } from "../locale.js";

export const SECTORS_SCRIPT = "sectors.js";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const perLocale = (v, code) => (Array.isArray(v) || v == null ? v : v[code] ?? v);
const labelOf = (x) => x.name ?? x.fa;

/** Problems with sector data for one locale (views: the terminal's views; terms: glossary slugs, when known). */
export function checkSectors(sectors, groups, { views, terms, where = "sectors" } = {}) {
  const errs = [];
  const bad = (s, msg) => errs.push(`${where} ${s?.slug || "?"}: ${msg}`);
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const groupKeys = new Set((groups || []).map((g) => g.key));
  const seen = new Set();
  if (!Array.isArray(sectors) || !sectors.length) return [`${where}: no sectors`];
  for (const s of sectors) {
    for (const k of ["slug", "group", "headline", "intro", "view", "caption"]) if (!str(s[k])) bad(s, `missing ${k}`);
    if (!str(labelOf(s))) bad(s, "missing name");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug || "")) bad(s, "slug must be latin kebab-case");
    if (seen.has(s.slug)) bad(s, "duplicate slug"); seen.add(s.slug);
    if (!groupKeys.has(s.group)) bad(s, `unknown group «${s.group}»`);
    if (!Array.isArray(s.products) || !s.products.length) bad(s, "products: at least one");
    else s.products.forEach((p, i) => { if (!str(p?.name) || !str(p?.how)) bad(s, `products[${i}] needs name and how`); });
    if (!Array.isArray(s.actors) || !s.actors.every(str)) bad(s, "actors: a list of strings");
    if (!Array.isArray(s.flow) || !s.flow.length || !s.flow.every(str)) bad(s, "flow: a list of steps");
    if (!Array.isArray(s.glossary)) bad(s, "glossary: a list of slugs");
    else if (terms) for (const g of s.glossary) if (!terms[g]) bad(s, `glossary slug «${g}» has no label`);
    if (views && !views.includes(s.view)) bad(s, `view «${s.view}» is not a terminal view (${views.join(", ")})`);
  }
  for (const g of groups || []) if (!sectors.some((s) => s.group === g.key)) errs.push(`${where}: group ${g.key} has no sectors`);
  return errs;
}

function related(list, s) {
  const i = list.indexOf(s);
  const rot = [...list.slice(i + 1), ...list.slice(0, i)];
  return [...rot.filter((x) => x.group === s.group), ...rot.filter((x) => x.group !== s.group)].slice(0, 3);
}

/** Render /sectors/ and every /sectors/<slug>/ for one locale → { "index.html": …, "<slug>/index.html": … }. */
export function renderSectors(page, ctx) {
  const { c, L, name, url, asset, chrome, pathOf } = ctx;
  const code = L.code;
  const SECTORS = perLocale(page.data, code), GROUPS = perLocale(page.taxonomy, code);
  const terms = page.glossary?.[code] ?? page.glossary ?? {};
  const d = (n) => L.toDigits(n);
  const f = (s, vars = {}) => fill(s, { name, ...vars });
  const groupName = (key) => labelOf(GROUPS.find((g) => g.key === key));
  const home = ctx.homeUrl;
  const base = pathOf(page.path);                       // "/sectors/" or "/ar/sectors/"
  const abs = (p) => url + p;
  const jsonld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
  const crumbs = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: u })) });
  const mark = page.generator ? `<meta name="generator" content="${esc(page.generator)}">\n` : "";
  const ogImage = ctx.page.ogImage;
  const alt = (p) => { const a = ctx.alternatesOf(p); return { alternates: a.map((x) => `\n<link rel="alternate" hreflang="${x.hreflang}" href="${x.url}">`).join(""), og: a.filter((x) => x.og && x.og !== L.og).map((x) => `<meta property="og:locale:alternate" content="${x.og}">`).join("") }; };

  function head({ title, description, path, ogTitle, ld, sceneCss }) {
    const u = abs(pathOf(path));
    const a = alt(path);
    return `<!doctype html>
<html lang="${L.lang}" dir="${L.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${mark}<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${ctx.colorHex.accent}">
<link rel="canonical" href="${u}"><meta name="robots" content="index, follow, max-image-preview:large">${a.alternates}
<meta property="og:type" content="website"><meta property="og:locale" content="${L.og}">${a.og}<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(ogTitle)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${u}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(ogTitle)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(ogTitle)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${ogImage}">
${jsonld(ld)}
${chrome.icons}
${chrome.preload}
<link rel="stylesheet" href="${asset("/styles.css")}">
${sceneCss ? `<link rel="stylesheet" href="${asset("/notify.css")}">\n` : ""}<link rel="stylesheet" href="${asset("/terminal.css")}">
<link rel="stylesheet" href="${asset("/sectors.css")}">
</head>`;
  }

  const card = (s, tag = "h2") => `<a class="sx-card" href="${base}${s.slug}/" data-group="${s.group}">
          <span class="sx-card__group">${esc(groupName(s.group))}</span>
          <${tag} class="sx-card__name">${esc(labelOf(s))}</${tag}>
          <p class="sx-card__head">${esc(s.headline)}</p>
          <ul class="sx-card__prods">${s.products.slice(0, 3).map((p) => `<li>${esc(p.name)}</li>`).join("")}</ul>
          <span class="sx-card__go">${c.card.go} <span aria-hidden="true">${L.arrow.next}</span></span>
        </a>`;

  const files = {};
  {
    const title = f(c.index.title);
    const description = f(c.index.description);
    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "CollectionPage", name: title, url: abs(base), inLanguage: L.intl, isPartOf: { "@id": `${home}#website` }, publisher: { "@id": `${url}/#org` },
          mainEntity: { "@type": "ItemList", itemListElement: SECTORS.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: labelOf(s), url: abs(`${base}${s.slug}/`) })) } },
        crumbs([[chrome.strings.home, home], [c.crumb, abs(base)]]),
      ],
    };
    files["index.html"] = `${head({ title, description, path: page.path, ogTitle: f(c.index.ogTitle), ld })}
<body class="tpage sx-page">
${chrome.bar(c.index.bar, page.path)}
<main>
  <section class="hero-t wrap sx-hero">
    <p class="eyebrow">${c.index.eyebrow}</p>
    <h1>${c.index.title_h1}</h1>
    <p>${f(c.index.lead)}</p>
  </section>

  <section class="section sx-sec sx-list" aria-labelledby="sx-list-title">
    <div class="wrap">
      <h2 class="sx-sr" id="sx-list-title">${c.index.listTitle}</h2>
      <div class="chips chips--filter sx-filter" role="group" aria-label="${esc(c.index.filterLabel)}" data-sx-filter>
        <button type="button" aria-pressed="true" data-filter="all">${c.index.all}</button>${GROUPS.map((g) => `<button type="button" aria-pressed="false" data-filter="${g.key}">${esc(labelOf(g))}</button>`).join("")}
      </div>
      <p class="sx-count" aria-live="polite" data-sx-count>${f(c.index.count, { count: d(SECTORS.length) })}</p>
      <div class="sx-grid" data-sx-grid>
        ${GROUPS.flatMap((g) => SECTORS.filter((s) => s.group === g.key)).map((s) => card(s)).join("\n        ")}
      </div>
    </div>
  </section>

  <section class="band sx-band">
    <div class="wrap band__in">
      <h2>${c.index.band}</h2>
      <div class="actions">${c.index.actions.map((a) => `<a class="btn btn--${a.style} btn--lg" href="${esc(a.href)}">${a.label}</a>`).join("")}</div>
    </div>
  </section>
</main>
${chrome.footer(c.footNote)}
<script src="${asset("/sectors.js")}" defer></script>
<script src="${asset("/totop.js")}" defer></script>
</body>
</html>
`;
  }

  for (const s of SECTORS) {
    const sector = labelOf(s);
    const title = f(c.sector.title, { sector });
    const path = `${page.path}${s.slug}/`;
    const u = abs(pathOf(path));
    const description = f(c.sector.description, { sector, headline: s.headline, products: s.products.slice(0, 3).map((p) => p.name).join(c.sector.join) });
    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: title, description, url: u, inLanguage: L.intl, isPartOf: { "@id": `${home}#website` }, publisher: { "@id": `${url}/#org` } },
        crumbs([[chrome.strings.home, home], [c.crumb, abs(base)], [sector, u]]),
      ],
    };
    const S = c.sector;
    files[`${s.slug}/index.html`] = `${head({ title, description, path, ogTitle: f(S.ogTitle, { sector }), ld, sceneCss: true })}
<body class="tpage sx-page">
${chrome.bar(S.bar, path)}
<main>
  <nav class="wrap sx-crumb" aria-label="${esc(S.crumbLabel)}"><ol><li><a href="${ctx.root}">${chrome.strings.home}</a></li><li><a href="${base}">${c.crumb}</a></li><li aria-current="page">${esc(sector)}</li></ol></nav>

  <section class="hero-t wrap sx-hero">
    <p class="eyebrow">${esc(groupName(s.group))}</p>
    <h1>${esc(sector)}</h1>
    <p class="sx-hero__head">${esc(s.headline)}</p>
    <p>${esc(s.intro)}</p>
    <div class="actions actions--center">${S.heroActions.map((a) => `<a class="btn btn--${a.style} btn--lg" href="${esc(a.href)}">${a.label}</a>`).join("")}</div>
  </section>

  <section class="section sx-sec" id="products" aria-labelledby="sx-products">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.products.eyebrow}</p><h2 id="sx-products">${f(S.products.title)}</h2></header>
      <div class="sx-prods">
        ${s.products.map((p, i) => `<article class="sx-prod"><span class="sx-prod__n">${d(i + 1)}</span><h3>${esc(p.name)}</h3><p>${esc(p.how)}</p></article>`).join("\n        ")}
      </div>
    </div>
  </section>

  <section class="section section--paper sx-sec" id="actors" aria-labelledby="sx-actors">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.actors.eyebrow}</p><h2 id="sx-actors">${S.actors.title}</h2><p>${f(S.actors.lead)}</p></header>
      <div class="chips sx-actors">${s.actors.map((a) => `<span>${esc(a)}</span>`).join("")}</div>
${S.actors.directory ? `      <p class="sx-dir"><a class="link" href="${esc(S.actors.directory.href)}?sector=${s.slug}">${S.actors.directory.label}</a></p>\n` : ""}    </div>
  </section>

  <section class="section sx-sec" id="flow" aria-labelledby="sx-flow">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.flow.eyebrow}</p><h2 id="sx-flow">${S.flow.title}</h2></header>
      <ol class="sx-flow" style="--n:${s.flow.length}">
        ${s.flow.map((x) => `<li><span class="sx-flow__dot" aria-hidden="true"></span><b>${esc(x)}</b></li>`).join("\n        ")}
      </ol>
    </div>
  </section>

  <section class="section section--paper sx-sec" id="demo" aria-labelledby="sx-demo">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.demo.eyebrow}</p><h2 id="sx-demo">${S.demo.title}</h2><p>${esc(s.caption)} <span class="badge badge--demo">${S.demo.badge}</span></p></header>
      <div class="tx-stage" data-tx-view="${s.view}"></div>
      <p class="tx-note"><b>${S.demo.note.label}</b><span>${S.demo.note.text}</span></p>
    </div>
  </section>

  <section class="section sx-sec" id="glossary" aria-labelledby="sx-glossary">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.glossary.eyebrow}</p><h2 id="sx-glossary">${S.glossary.title}</h2></header>
      <div class="chips sx-terms">${s.glossary.map((g) => `<a href="${esc(S.glossary.href)}${g}">${esc(terms[g] ?? g)}</a>`).join("")}</div>
    </div>
  </section>

  <section class="section section--paper sx-sec" id="related" aria-labelledby="sx-related">
    <div class="wrap">
      <header class="sec-head"><p class="eyebrow">${S.related.eyebrow}</p><h2 id="sx-related">${S.related.title}</h2></header>
      <div class="sx-grid sx-grid--3">
        ${related(SECTORS, s).map((r) => card(r, "h3")).join("\n        ")}
      </div>
    </div>
  </section>

  <section class="band sx-band">
    <div class="wrap band__in">
      <h2>${f(S.band, { sector: esc(sector) })}</h2>
      <div class="actions">${S.bandActions.map((a) => `<a class="btn btn--${a.style} btn--lg" href="${esc(a.href)}">${a.label}</a>`).join("")}</div>
    </div>
  </section>
</main>
${chrome.footer(c.footNote)}
<script src="${asset("/notify.js")}" defer></script>
<script src="${asset("/terminal.js")}" defer></script>
<script src="${asset("/totop.js")}" defer></script>
</body>
</html>
`;
  }
  return files;
}
