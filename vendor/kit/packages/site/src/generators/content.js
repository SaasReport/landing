/**
 * Content pages from structured blocks: documentation, product, programme, legal and research pages, a pricing page,
 * catalogues: any page that is a hero, sections of blocks and an optional band. One page type renders a whole tree
 * of pages, so a project can migrate hundreds of pages of an old site (or write new ones) as data, on the kit's chrome.
 *
 *   { type: "content", path: "/", pages: [ContentPage] | { en: [ContentPage], … }, styles?, scripts?,
 *     renderers?: { <block type>: (block, ctx) => html }, generator?, content: { en: {} } }
 *
 * ContentPage:
 *   path         the page's site path, under the page type's path ("/pricing/", "/legal/terms/")
 *   title        <title>; description, ogTitle, ogImage, robots (default "index, follow, …")
 *   bar          the inner-page bar links [{ href, label }]; crumbs [[label, path], …] (home is added first)
 *   ld           { type: "WebPage" | "CollectionPage" | "TechArticle" | …, extra: {…}, nodes: [more JSON-LD nodes, e.g. a
 *                FAQPage or a SoftwareApplication] } or graph: [nodes] (full override)
 *   hero         { eyebrow, title (HTML), lead (HTML), actions: [{ href, label }], extra (HTML) }
 *   note         HTML shown at the top of the first section (e.g. a notice that the page was migrated)
 *   sections     [{ id?, blocks: [Block], wide? }]
 *   band         { title (HTML), actions: [{ href, label, style }] }
 *   styles, scripts, bodyClass   page-level additions
 *
 * Block (t = type): h { level, html, id?, eyebrow? } · eyebrow { text } · p { html, lead? } · list { items, ordered? }
 *   · defs { items: [{ term, def, id? }] } · table { head, rows } · code { text, lang? } · quote { html, cite? }
 *   · details { summary, blocks } · cards { items: [{ href?, eyebrow?, title, text?, list?, go? }], cols? }
 *   · actions { items: [{ href?, label }] } · note { label, html } · html { html } (trusted markup)
 *   · any other type through `renderers` (a form, a widget), or skipped with a warning by checkContent.
 * HTML fields are trusted (the project escapes or sanitises its sources); plain-text fields are escaped.
 */
import { esc, plainText, innerPage, webPageLd, crumbsLd } from "./shell.js";

export const CONTENT_BLOCKS = ["h", "eyebrow", "p", "list", "defs", "table", "code", "quote", "details", "cards", "actions", "note", "html"];
const perLocale = (v, code) => (Array.isArray(v) || v == null ? v : v[code] ?? v);
const slugId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const unlink = (h) => String(h ?? "").replace(/<a\b[^>]*>|<\/a>/g, "");
const ext = (href) => (/^https?:/.test(href) ? ' rel="noopener"' : "");

/** One card: a link card when it has href (nested links are unwrapped), otherwise an article. */
export function cardHtml(c, tag = "h3") {
  const strip = c.href ? unlink : (x) => x;
  const inner = `${c.eyebrow || c.group ? `<span class="sx-card__group">${esc(c.eyebrow || c.group)}</span>` : ""}<${tag} class="sx-card__name">${strip(c.title)}</${tag}>${c.text ? `<p class="sx-card__head">${strip(c.text)}</p>` : ""}${c.list?.length ? `<ul class="cb-list cb-list--tight">${c.list.map((x) => `<li>${strip(x)}</li>`).join("")}</ul>` : ""}${c.go ? `<span class="sx-card__go">${c.go}</span>` : ""}`;
  return c.href ? `<a class="sx-card" href="${esc(c.href)}"${ext(c.href)}>${inner}</a>` : `<article class="sx-card">${inner}</article>`;
}

/** Blocks → HTML. `renderers` adds or replaces block types; `depth` shifts heading levels (nested details). */
export function renderBlocks(blocks, { renderers = {}, depth = 0, ctx } = {}) {
  const out = [];
  for (const b of blocks || []) {
    if (renderers[b.t]) { out.push(renderers[b.t](b, ctx)); continue; }
    switch (b.t) {
      case "h": {
        const lvl = Math.min(4, Math.max(2, (b.level || 2) + depth)), id = b.id || slugId(plainText(b.html));
        out.push(`${b.eyebrow ? `<p class="eyebrow cb-eyebrow">${esc(b.eyebrow)}</p>` : ""}<h${lvl} class="cb-h${lvl}" id="${esc(id)}">${b.html}</h${lvl}>`);
        break;
      }
      case "eyebrow": out.push(`<p class="eyebrow cb-eyebrow">${esc(b.text)}</p>`); break;
      case "p": out.push(`<p${b.lead ? ' class="cb-lead"' : ""}>${b.html}</p>`); break;
      case "list": { const tag = b.ordered ? "ol" : "ul"; out.push(`<${tag} class="cb-list${b.tight ? " cb-list--tight" : ""}">${b.items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`); break; }
      case "defs": out.push(`<dl class="cb-defs">${b.items.map((d) => `<div${d.id ? ` id="${esc(d.id)}"` : ""}><dt>${d.term}</dt><dd>${d.def}</dd></div>`).join("")}</dl>`); break;
      case "table": out.push(`<div class="cb-table" role="region" aria-label="${esc(b.label || "Table")}" tabindex="0"><table>${b.head?.length ? `<thead><tr>${b.head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>` : ""}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); break;
      case "code": out.push(`<pre class="cb-code" tabindex="0"${b.lang ? ` data-lang="${esc(b.lang)}"` : ""}><code>${esc(b.text)}</code></pre>`); break;
      case "quote": out.push(`<blockquote class="cb-quote"><p>${b.html}</p>${b.cite ? `<footer>${esc(b.cite)}</footer>` : ""}</blockquote>`); break;
      case "details": out.push(`<details class="cb-details"><summary>${b.summary || "Details"}</summary><div class="cb-details__body">${renderBlocks(b.blocks, { renderers, depth, ctx })}</div></details>`); break;
      case "cards": out.push(`<div class="sx-grid sx-grid--${b.cols || 3} cb-cards">${b.items.map((c) => cardHtml(c)).join("")}</div>`); break;
      case "actions": {
        const items = (b.items || []).filter((x) => x.label);
        if (items.length) out.push(`<div class="actions cb-actions">${items.map((x, i) => (x.href ? `<a class="btn ${x.style ? `btn--${x.style}` : i ? "btn--ghost" : "btn--primary"}" href="${esc(x.href)}"${ext(x.href)}>${unlink(x.label)}</a>` : `<span class="chip2">${unlink(x.label)}</span>`)).join("")}</div>`);
        break;
      }
      case "note": out.push(`<p class="tx-note"><b>${b.label}</b><span>${b.html}</span></p>`); break;
      case "html": out.push(b.html); break;
      default: break;
    }
  }
  return out.join("\n");
}

/** Hero section of a content page. */
export function heroHtml(h = {}) {
  const actions = (h.actions || []).filter((a) => a.href && a.label).slice(0, 3);
  return `  <section class="hero-t wrap sx-hero cb-hero">
    ${h.eyebrow ? `<p class="eyebrow">${esc(h.eyebrow)}</p>` : ""}
    <h1>${h.title}</h1>
    ${h.lead ? `<p>${h.lead}</p>` : ""}${actions.length ? `\n    <div class="actions actions--center">${actions.map((a, i) => `<a class="btn ${a.style ? `btn--${a.style}` : i ? "btn--ghost" : "btn--primary"} btn--lg" href="${esc(a.href)}"${ext(a.href)}>${unlink(a.label)}</a>`).join("")}</div>` : ""}${h.extra || ""}
  </section>`;
}

export const bandHtml = (b) => `  <section class="band sx-band">
    <div class="wrap band__in">
      <h2>${b.title}</h2>
      <div class="actions">${(b.actions || []).map((x) => `<a class="btn btn--${x.style || "light"} btn--lg" href="${esc(x.href)}"${ext(x.href)}>${x.label}</a>`).join("")}</div>
    </div>
  </section>`;

/** The <main> body of a content page. */
export function contentBody(p, opts = {}) {
  const sections = (p.sections || []).map((s, i) => `  <section class="section sx-sec cb-sec"${s.id ? ` id="${esc(s.id)}"` : ""}>
    <div class="wrap ${s.wide ? "cb-wide" : "cb-prose"}">
${i === 0 && p.note ? `      ${p.note}\n` : ""}${renderBlocks(s.blocks, opts)}
    </div>
  </section>`);
  if (!sections.length && p.note) sections.push(`  <section class="section sx-sec cb-sec"><div class="wrap cb-prose">${p.note}</div></section>`);
  return [heroHtml(p.hero || { title: esc(p.title) }), ...sections, ...(p.band ? [bandHtml(p.band)] : [])].join("\n");
}

/** Problems with a list of content pages (paths under `base`, unique; titles; known block types). */
export function checkContent(pages, { base = "/", renderers = {}, where = "content" } = {}) {
  const errs = [], seen = new Set();
  if (!Array.isArray(pages) || !pages.length) return [`${where}: no pages`];
  const known = new Set([...CONTENT_BLOCKS, ...Object.keys(renderers)]);
  const walk = (blocks, at) => { for (const b of blocks || []) { if (!known.has(b?.t)) errs.push(`${at}: unknown block type ${JSON.stringify(b?.t)}`); if (b?.t === "details") walk(b.blocks, at); } };
  for (const p of pages) {
    const at = `${where} ${p?.path || "?"}`;
    if (!/^\/([\w.-]+\/)*$/.test(p?.path || "")) errs.push(`${at}: path must look like /pricing/`);
    else if (!p.path.startsWith(base) || p.path === base && base !== "/") errs.push(`${at}: path must be under ${base}`);
    if (seen.has(p?.path)) errs.push(`${at}: duplicate path`); seen.add(p?.path);
    if (!plainText(p?.title)) errs.push(`${at}: missing title`);
    if (!p?.hero?.title) errs.push(`${at}: missing hero.title`);
    (p?.sections || []).forEach((s, i) => walk(s.blocks, `${at} sections[${i}]`));
  }
  return errs;
}

/** Render every content page of one locale → { "<rel>index.html": html }. */
export function renderContent(page, ctx) {
  const list = perLocale(page.pages, ctx.L.code) || [];
  const files = {};
  const opts = { renderers: page.renderers || {}, ctx };
  for (const p of list) {
    const rel = p.path.slice(page.path.length);
    const u = ctx.url + ctx.pathOf(p.path);
    const name = p.ogTitle || p.title;
    const crumbs = [[ctx.chrome.strings.home, ctx.homeUrl], ...(p.crumbs || []).map(([l, h]) => [l, ctx.url + ctx.pathOf(h)])];
    if (!p.crumbs?.some(([, h]) => h === p.path)) crumbs.push([name, u]);
    const graph = p.graph || [webPageLd({ type: p.ld?.type, name, description: p.description, url: u, ctx, extra: p.ld?.extra }), crumbsLd(crumbs), ...(p.ld?.nodes || [])];
    files[`${rel}index.html`] = innerPage(ctx, {
      path: p.path, title: p.title, description: p.description, ogTitle: p.ogTitle, ogImage: p.ogImage, robots: p.robots, graph,
      styles: [...(page.styles || []), ...(p.styles || [])], scripts: [...(page.scripts || []), ...(p.scripts || [])],
      bodyClass: p.bodyClass, bar: p.bar, generator: page.generator, footNote: ctx.c?.footNote,
      body: contentBody(p, opts),
    });
  }
  return files;
}
