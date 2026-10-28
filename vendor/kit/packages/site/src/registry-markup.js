/**
 * The markup the page registry generates on every page (src/registry.js): the breadcrumb trail, the page's facets,
 * related pages and its previous / next page in its group, the listings of hub and facet pages, and the
 * BreadcrumbList JSON-LD. Every link shows its target's registry label. No project content: strings default to
 * English and come from the project (opts.t).
 *
 *   crumbsHtml(page, reg, t)        → <nav class="kreg-crumbs">
 *   footHtml(page, reg, t)          → <aside class="kreg"> facets, related, previous / next
 *   hubHtml(page, reg, t)           → the listing of a section, group, facet, facet value or the browse root
 *   decorateHtml(html, page, reg, { origin, t }) → html with all of the above in place (idempotent)
 *   decorateSite(outDir, reg, opts) → { pages, missing }   every registry page's file, decorated in place
 *   REGISTRY_CSS                    → the styles (theme variables), appended to the theme like SHELL_CSS
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byUrl, hubMembers } from "./registry.js";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const REGISTRY_STRINGS = {
  crumbs: "Breadcrumb", home: "Home", related: "Related", prev: "Previous", next: "Next", inGroup: "In this group",
  facets: "Browse by", page: "page", pages: "pages", groups: "Groups", all: "All", browse: "Browse", onThisPage: "Pages here",
};
const T = (t) => ({ ...REGISTRY_STRINGS, ...(t || {}) });
/** A summary cut at a word boundary (a brand mark stays with its word). */
export const clip = (s, n) => { const t = String(s || ""); if (t.length <= n) return t; const c = t.slice(0, n), i = c.lastIndexOf(" "); return `${(i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s,;:·—–-]+$/u, "")}…`; };
const link = (p, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(p.url)}">${esc(p.label)}</a>`;

export function crumbsHtml(page, reg, t) {
  const P = byUrl(reg), s = T(t);
  if (page.crumbs.length < 2) return "";
  return `<nav class="kreg-crumbs" aria-label="${esc(s.crumbs)}"><ol>${page.crumbs.map((u, i) => {
    const p = P.get(u);
    return i === page.crumbs.length - 1 ? `<li aria-current="page">${esc(p.label)}</li>` : `<li>${link(p)}</li>`;
  }).join("")}</ol></nav>`;
}

/** Facet chips (each a link to its facet page), related pages, previous / next in the group. */
export function footHtml(page, reg, t) {
  const P = byUrl(reg), s = T(t);
  const chips = reg.facets.flatMap((f) => (page.facets[f.id] || []).map((vid) => f.values.find((v) => v.id === vid)).filter(Boolean).map((v) => `<a class="kreg-chip" href="${esc(v.hub)}"><small>${esc(f.label)}</small>${esc(v.label)}</a>`));
  const rel = page.related.map((u) => P.get(u)).filter(Boolean);
  const prev = page.prev && P.get(page.prev), next = page.next && P.get(page.next);
  if (!chips.length && !rel.length && !prev && !next) return "";
  return `<aside class="kreg" aria-label="${esc(s.related)}"><div class="wrap">
${chips.length ? `<div class="kreg-facets"><b>${esc(s.facets)}</b><div class="kreg-chips">${chips.join("")}</div></div>` : ""}
${rel.length ? `<div class="kreg-rel"><b>${esc(s.related)}</b><ul>${rel.map((p) => `<li>${link(p)}${p.summary ? `<span>${esc(clip(p.summary, 140))}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
${prev || next ? `<nav class="kreg-pn" aria-label="${esc(s.inGroup)}">${prev ? `<a class="kreg-prev" href="${esc(prev.url)}" rel="prev"><small>${esc(s.prev)}</small>${esc(prev.label)}</a>` : "<span></span>"}${next ? `<a class="kreg-next" href="${esc(next.url)}" rel="next"><small>${esc(s.next)}</small>${esc(next.label)}</a>` : ""}</nav>` : ""}
</div></aside>`;
}

const cards = (ps) => `<ul class="kreg-list">${ps.map((p) => `<li>${link(p)}${p.summary ? `<span>${esc(clip(p.summary, 160))}</span>` : ""}</li>`).join("")}</ul>`;

/** The listing a hub page carries: its groups (section), its pages (group, facet value), its values (facet, browse). */
export function hubHtml(page, reg, t) {
  const P = byUrl(reg), s = T(t);
  const head = (p, n) => `<h2 class="kreg-h">${link(p)} <small>${n} ${esc(n === 1 ? s.page : s.pages)}</small></h2>`;
  const sec = reg.sections.find((x) => x.hub === page.url);
  if (sec) return `<section class="kreg-hub" id="kreg-hub"><div class="wrap">${sec.groups.filter((g) => g.count).map((g) => {
    const ms = hubMembers(reg, g.hub);
    return `<div class="kreg-grp">${head(P.get(g.hub), ms.length)}${cards(ms.filter((p) => p.url !== g.hub).slice(0, 8))}</div>`;
  }).join("")}</div></section>`;
  const grp = reg.sections.flatMap((x) => x.groups).find((g) => g.hub === page.url);
  if (grp) return `<section class="kreg-hub" id="kreg-hub"><div class="wrap">${cards(hubMembers(reg, page.url))}</div></section>`;
  const facet = reg.facets.find((f) => f.hub === page.url);
  if (facet) return `<section class="kreg-hub" id="kreg-hub"><div class="wrap"><ul class="kreg-vals">${facet.values.map((v) => `<li><a href="${esc(v.hub)}">${esc(v.label)}</a> <small>${v.count}</small></li>`).join("")}</ul></div></section>`;
  const value = reg.facets.flatMap((f) => f.values).find((v) => v.hub === page.url);
  if (value) {
    const ms = hubMembers(reg, page.url);
    return `<section class="kreg-hub" id="kreg-hub"><div class="wrap">${reg.sections.map((x) => [x, ms.filter((p) => p.section === x.id)]).filter(([, l]) => l.length).map(([x, l]) => `<div class="kreg-grp">${head(P.get(x.hub), l.length)}${cards(l)}</div>`).join("")}</div></section>`;
  }
  if (page.url === reg.browse) return `<section class="kreg-hub" id="kreg-hub"><div class="wrap">${[
    `<div class="kreg-grp"><h2 class="kreg-h">${esc(s.groups)}</h2><ul class="kreg-vals">${reg.sections.map((x) => `<li>${link(P.get(x.hub))} <small>${x.groups.reduce((n, g) => n + g.count, 0)}</small></li>`).join("")}</ul></div>`,
    ...reg.facets.map((f) => `<div class="kreg-grp"><h2 class="kreg-h">${link(P.get(f.hub))}</h2><ul class="kreg-vals">${f.values.map((v) => `<li><a href="${esc(v.hub)}">${esc(v.label)}</a> <small>${v.count}</small></li>`).join("")}</ul></div>`),
  ].join("")}</div></section>`;
  return "";
}

/** BreadcrumbList JSON-LD of a page's crumbs. */
export function crumbsLdNode(page, reg, origin) {
  const P = byUrl(reg), o = origin.replace(/\/$/, "");
  return { "@type": "BreadcrumbList", itemListElement: page.crumbs.map((u, i) => ({ "@type": "ListItem", position: i + 1, name: P.get(u).label, item: o + u })) };
}

const LD = /<script type="application\/ld\+json"([^>]*)>([\s\S]*?)<\/script>/;
const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

/** One page's HTML with the registry's crumbs, hub listing, facets, related and previous / next, and its BreadcrumbList. */
export function decorateHtml(html, page, reg, { origin, t } = {}) {
  if (html.includes('data-kreg="1"')) return html;
  let out = html;
  const crumbs = page.kind === "home" ? "" : crumbsHtml(page, reg, t);
  const hub = hubHtml(page, reg, t);
  const foot = footHtml(page, reg, t);
  const open = /<main\b[^>]*>/.exec(out);
  if (open) {
    const at = open.index + open[0].length;
    out = `${out.slice(0, at)}\n${crumbs}${out.slice(at)}`;
    const close = out.lastIndexOf("</main>");
    out = `${out.slice(0, close)}${hub}\n${foot}\n${out.slice(close)}`;
  }
  out = out.replace(/<body\b([^>]*)>/, (m, a) => `<body${a} data-kreg="1">`);
  if (origin) {
    const node = crumbsLdNode(page, reg, origin);
    const m = LD.exec(out);
    if (m) {
      let j; try { j = JSON.parse(m[2]); } catch { j = null; /* a block that is not JSON is reported by the null check below */ }
      if (j) {
        if (Array.isArray(j["@graph"])) j["@graph"] = [...j["@graph"].filter((n) => n["@type"] !== "BreadcrumbList"), node];
        else if (j["@type"] === "BreadcrumbList") j = { "@context": "https://schema.org", ...node };
        else { const { "@context": c, ...rest } = j; j = { "@context": c || "https://schema.org", "@graph": [rest, node] }; }
        out = out.replace(m[0], `<script type="application/ld+json"${m[1]}>${ldJson(j)}</script>`);
      }
    } else out = out.replace("</head>", `<script type="application/ld+json">${ldJson({ "@context": "https://schema.org", ...node })}</script>\n</head>`);
  }
  return out;
}

/** The file of a page URL in a built site. */
export const fileOfUrl = (outDir, url) => join(outDir, decodeURIComponent(url).replace(/^\//, ""), url.endsWith("/") ? "index.html" : "");

/** Every registry page's built file, decorated in place. Returns { pages, missing: [urls with no file] }. */
export function decorateSite(outDir, reg, opts = {}) {
  let pages = 0; const missing = [];
  for (const p of reg.pages) {
    const f = fileOfUrl(outDir, p.url);
    if (!existsSync(f)) { missing.push(p.url); continue; }
    const a = readFileSync(f, "utf8"), b = decorateHtml(a, p, reg, opts);
    if (a !== b) { writeFileSync(f, b); pages++; }
  }
  return { pages, missing };
}

export const REGISTRY_CSS = `.kreg-crumbs{max-width:var(--wrap,1180px);margin:0 auto;padding:4px var(--gutter,20px) 0}
.kreg-crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;font-size:14px;color:var(--muted)}
.kreg-crumbs ol::-webkit-scrollbar{display:none}
.kreg-crumbs li{display:flex;align-items:center;flex:none;max-width:min(62vw,420px)}
.kreg-crumbs li+li::before{content:"›";padding:0 8px;color:var(--muted)}
.kreg-crumbs a,.kreg-crumbs [aria-current]{display:block;line-height:44px;min-height:44px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);text-decoration:none}
.kreg-crumbs a:hover{color:var(--text,var(--ink));text-decoration:underline}
.kreg-crumbs [aria-current]{color:var(--text,var(--ink));font-weight:600}
.kreg,.kreg-hub{padding:28px 0;border-top:1px solid var(--line)}
.kreg .wrap,.kreg-hub .wrap{display:grid;gap:22px}
.kreg b,.kreg-facets b{display:block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.kreg-chips{display:flex;flex-wrap:wrap;gap:8px}
.kreg-chip{display:inline-flex;flex-direction:column;justify-content:center;min-height:44px;padding:4px 14px;border-radius:99px;border:1px solid var(--line);background:var(--surface);color:var(--text,var(--ink));font-size:14px;font-weight:600;text-decoration:none}
.kreg-chip small{font-size:11px;font-weight:500;color:var(--muted);line-height:1.2}
.kreg-chip:hover{border-color:var(--accent,var(--orange))}
.kreg-rel ul,.kreg-list,.kreg-vals{list-style:none;margin:0;padding:0;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))}
.kreg-rel li,.kreg-list li{padding-bottom:12px;border:1px solid var(--line);border-radius:var(--r-card,var(--radius,12px));background:var(--surface)}
.kreg-rel a,.kreg-list a{display:flex;align-items:center;min-height:44px;padding:10px 14px 2px;font-weight:600;color:var(--text,var(--ink));text-decoration:none;overflow-wrap:anywhere}
.kreg-rel span,.kreg-list span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding:0 14px;font-size:13px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}
.kreg-rel a:hover,.kreg-list a:hover{color:var(--accent,var(--orange))}
.kreg-vals li{display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--line)}
.kreg-vals a{display:flex;align-items:center;min-height:44px;font-weight:600;color:var(--text,var(--ink))}
.kreg-vals small,.kreg-h small{color:var(--muted);font-weight:500;font-size:13px}
.kreg-h{font-size:20px;margin:0 0 10px}.kreg-h a{color:var(--text,var(--ink))}
.kreg-grp{min-width:0}
.kreg-pn{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kreg-pn a{display:flex;flex-direction:column;justify-content:center;min-height:56px;padding:8px 14px;border:1px solid var(--line);border-radius:var(--r-card,var(--radius,12px));color:var(--text,var(--ink));font-weight:600;text-decoration:none;overflow-wrap:anywhere;min-width:0}
.kreg-pn small{font-size:12px;font-weight:500;color:var(--muted)}
.kreg-next{text-align:end;grid-column:2}
@media (max-width:520px){.kreg-pn{grid-template-columns:1fr}.kreg-next{grid-column:1}}`;
