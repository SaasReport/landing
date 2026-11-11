/**
 * The shared document of the generated surface pages (content, reference, apps): the same head as the kit's other
 * inner pages (title, description, canonical, robots, hreflang, Open Graph, Twitter card, JSON-LD, icons, font
 * preload, theme stylesheets with ?v hashes), the inner-page bar and footer, and deferred scripts (CSP script-src
 * 'self': no inline script except JSON-LD).
 *
 *   innerPage(ctx, { path, title, description, ogTitle, ogImage, robots, graph, styles, scripts, bodyClass, bar,
 *                    body, footNote, generator }) → html
 *   esc(value), crumbsLd(items), webPageLd({ type, name, description, url, ctx, extra })
 */
import { scriptTag } from "@saasreport/core/cloudflare-safe";
export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text of an HTML fragment (for titles, descriptions and JSON-LD). */
export const plainText = (h) => String(h ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

export const crumbsLd = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: plainText(n), item: u })) });

export function webPageLd({ type = "WebPage", name, description, url, ctx, extra = {} }) {
  return { "@type": type, name: plainText(name), ...(description ? { description: plainText(description) } : {}), url, inLanguage: ctx.L.intl, isPartOf: { "@id": `${ctx.homeUrl}#website` }, publisher: { "@id": `${ctx.url}/#org` }, ...extra };
}

/** Base stylesheets of every generated surface page (theme files; projects add theirs per page or per page type). */
export const SURFACE_STYLES = ["/styles.css", "/notify.css", "/terminal.css", "/sectors.css", "/surfaces.css"];

export function innerPage(ctx, o) {
  const { L, name, chrome, asset } = ctx;
  const path = o.path;
  const u = ctx.url + ctx.pathOf(path);
  const alts = ctx.alternatesOf(path);
  const alternates = alts.map((x) => `\n<link rel="alternate" hreflang="${x.hreflang}" href="${x.url}">`).join("");
  const ogAlt = alts.filter((x) => x.og && x.og !== L.og).map((x) => `<meta property="og:locale:alternate" content="${x.og}">`).join("");
  const og = o.ogImage ? (/^https?:/.test(o.ogImage) ? o.ogImage : ctx.url + o.ogImage) : ctx.page.ogImage;
  const ogTitle = o.ogTitle || o.title;
  const description = o.description || ogTitle;
  const robots = o.robots || "index, follow, max-image-preview:large";
  const graph = o.graph || [webPageLd({ name: ogTitle, description, url: u, ctx }), crumbsLd([[chrome.strings.home, ctx.homeUrl], [ogTitle, u]])];
  const ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`;
  const styles = [...new Set([...SURFACE_STYLES, ...(o.styles || [])])];
  const scripts = [...new Set([...(o.scripts || []), "/totop.js"])];
  return `<!doctype html>
<html lang="${L.lang}" dir="${L.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${o.generator ? `<meta name="generator" content="${esc(o.generator)}">\n` : ""}<title>${esc(plainText(o.title))}</title>
<meta name="description" content="${esc(plainText(description))}">
<meta name="theme-color" content="${ctx.colorHex.accent}">
<link rel="canonical" href="${u}"><meta name="robots" content="${esc(robots)}">${alternates}
<meta property="og:type" content="website"><meta property="og:locale" content="${L.og}">${ogAlt}<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(plainText(ogTitle))}"><meta property="og:description" content="${esc(plainText(description))}">
<meta property="og:url" content="${u}"><meta property="og:image" content="${og}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(plainText(ogTitle))}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(plainText(ogTitle))}"><meta name="twitter:description" content="${esc(plainText(description))}"><meta name="twitter:image" content="${og}">
${ld}
${chrome.icons}
${chrome.preload}
${styles.map((h) => `<link rel="stylesheet" href="${asset(h)}">`).join("\n")}
</head>
<body class="${o.bodyClass || "tpage sx-page"}">
${chrome.bar(o.bar || [], path)}
<main>
${o.body}
</main>
${chrome.footer(o.footNote || "")}
${scripts.map((h) => scriptTag({ src: asset(h) })).join("\n")}
</body>
</html>
`;
}
