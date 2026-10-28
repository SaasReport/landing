/**
 * The legal notices page (/legal/notices/): the project's base notice and the audience and jurisdiction blocks the
 * page picks, from the same notices data the comms engine puts in the email footer (@saasreport/comms/notices). One
 * version per locale, in that locale's direction and digits; the wording is the kit's draft for the locale, with
 * the project's copy over it.
 *
 *   { type: "notices", path: "/legal/notices/",
 *     notices,                                     // the project's notices (the comms config's legal.notices)
 *     select: { audiences: ["institutional"], jurisdictions: [] },   // the blocks this page shows (default: notices.default → base only)
 *     entity,                                      // optional: the comms config's legal.entity (fills {{legal_entity}} …)
 *     content: { en: { bar, footNote, meta: { title, description }, …page string overrides } } }
 *
 * What is never published: draft jurisdiction blocks (status "draft …") and paragraphs with unfilled placeholders.
 * `drafts: true` / `placeholders: "show"` on the page show them, for a local preview only.
 */
import { scriptTag } from "@saasreport/core/cloudflare-safe";
import { noticeBlocks, selectNotices, noticePageStrings, fillNotice, noticeValues } from "@saasreport/comms/notices";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escaped text with any {{placeholder}} left visible (previews only) marked up. */
const text = (s) => esc(s).replace(/\{\{([a-z0-9_]+)\}\}/g, '<mark class="lg-ph" dir="ltr">{{$1}}</mark>');

/** Problems with a notices page: [] when it is usable. */
export function checkNoticesPage(page) {
  const out = [];
  if (!page.notices || typeof page.notices !== "object") out.push("notices: the project's notices data is required");
  const offered = { audiences: page.notices?.audiences || [], jurisdictions: page.notices?.jurisdictions || [] };
  for (const k of ["audiences", "jurisdictions"]) for (const x of page.select?.[k] || []) if (!offered[k].includes(x)) out.push(`select.${k}: "${x}" is not offered in notices.${k}`);
  return out;
}

export function renderNotices(page, ctx) {
  const { L, name, url, asset, chrome } = ctx;
  const c = ctx.c || {};
  const lang = L.lang;
  const opts = { brand: name, site: url, entity: page.entity || {}, drafts: page.drafts === true, placeholders: page.placeholders === "show" ? "show" : "omit" };
  const blocks = selectNotices(noticeBlocks(page.notices, lang, opts), page.select ?? page.notices.default ?? {});
  const S = { ...noticePageStrings(page.notices, lang), ...c };
  const values = noticeValues(page.notices, lang, opts);
  const f = (s) => fillNotice(s, values).text;
  const title = f(c.meta?.title || S.title);
  const description = f(c.meta?.description || S.description);
  const PATH = ctx.pathOf(page.path);
  const pageUrl = url + PATH;
  const alts = ctx.alternatesOf(page.path);
  const kindLabel = (b) => (b.kind === "base" ? S.general : b.kind === "audience" ? S.audience : S.jurisdiction);
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", name: title, description, url: pageUrl, inLanguage: L.intl, isPartOf: { "@id": `${ctx.homeUrl}#website` } },
      { "@type": "BreadcrumbList", itemListElement: [[chrome.strings.home, ctx.homeUrl], [f(S.crumb), pageUrl]].map(([nm, u], i) => ({ "@type": "ListItem", position: i + 1, name: nm, item: u })) },
    ],
  };
  const section = (b) => `  <section class="lg-block lg-block--${b.kind}" id="${b.id}" aria-labelledby="${b.id}-t">
    <p class="lg-kind">${esc(kindLabel(b))}${b.draft ? ` <span class="lg-draft">${esc(S.draft)}</span>` : ""}</p>
    <h2 id="${b.id}-t">${esc(b.title)}</h2>
${b.paragraphs.map((p) => `    <p>${text(p)}</p>`).join("\n")}
  </section>`;
  return {
    "index.html": `<!doctype html>
<html lang="${L.lang}" dir="${L.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${ctx.colorHex.accent}">
<meta name="color-scheme" content="light">
<link rel="canonical" href="${pageUrl}"><meta name="robots" content="${opts.drafts || opts.placeholders === "show" ? "noindex, nofollow" : "index, follow"}">${alts.map((x) => `\n<link rel="alternate" hreflang="${x.hreflang}" href="${x.url}">`).join("")}
<meta property="og:type" content="website"><meta property="og:locale" content="${L.og}"><meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${pageUrl}"><meta property="og:image" content="${ctx.page.ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${ctx.page.ogImage}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
${chrome.icons}
${chrome.preload}
<link rel="stylesheet" href="${asset("/styles.css")}">
<link rel="stylesheet" href="${asset("/terminal.css")}">
<link rel="stylesheet" href="${asset("/pages.css")}">
</head>
<body class="tpage lg-page">
${chrome.bar(c.bar, page.path)}
<main class="wrap lg-wrap">
  <nav class="lg-crumb" aria-label="${esc(S.crumbLabel || S.crumb)}"><ol><li><a href="${ctx.root}">${chrome.strings.home}</a></li><li aria-current="page">${esc(f(S.crumb))}</li></ol></nav>
  <header class="lg-hero">
    <p class="eyebrow">${esc(S.eyebrow)}</p>
    <h1>${esc(title)}</h1>
    <p>${esc(f(S.lead))}</p>
  </header>
${blocks.length > 1 ? `  <nav class="lg-toc" aria-labelledby="lg-toc-t"><p id="lg-toc-t">${esc(S.contents)}</p><ol>${blocks.map((b) => `<li><a href="#${b.id}">${esc(b.title)}</a></li>`).join("")}</ol></nav>\n` : ""}${blocks.map(section).join("\n")}
</main>
${chrome.footer(c.footNote)}
${scriptTag({ src: asset("/totop.js") })}
</body>
</html>
`,
  };
}
