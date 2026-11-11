/**
 * SEO and discovery helpers, all from config:
 *   jsonLd: org(config), website(config), graph(...nodes), crumbs(config, [[name, path], …])
 *   sitemap(urls, { base }) → sitemap.xml;  robots(config, opts) → robots.txt
 *   llmsTxt(config, sections) → llms.txt (llmstxt.org);  llmsFull(config, sections, docs) → llms-full.txt
 */
import { strings } from "./i18n.js";

export const xmlEscape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
/** Absolute URL for a site path (absolute URLs pass through). */
export const absUrl = (config, path = "/") => (/^https?:\/\//.test(path) ? path : `${config.site.url}${path.startsWith("/") ? "" : "/"}${path}`);

/** The site's origin URL: site.root on a multi-locale site (site.url carries the locale prefix there), else site.url. */
const rootUrl = (config) => config.site.root || config.site.url;
/** schema.org Organization node (id `${root}/#org`: one organization for every locale). */
export function org(config) {
  const o = config.site.org || {};
  return {
    "@type": "Organization", "@id": `${rootUrl(config)}/#org`, name: o.name || config.site.name,
    ...(o.alternateName ? { alternateName: o.alternateName } : {}),
    url: o.url || config.site.url,
    ...(o.logo || config.site.logo ? { logo: { "@type": "ImageObject", url: absUrl(config, o.logo || config.site.logo) } } : {}),
    ...(o.sameAs?.length ? { sameAs: o.sameAs } : {}),
  };
}
/** schema.org WebSite node, published by the org. */
export const website = (config) => ({
  "@type": "WebSite", "@id": `${config.site.url}/#website`, name: config.site.name, url: `${config.site.url}/`,
  inLanguage: config.site.locale, ...(config.site.description ? { description: config.site.description } : {}), publisher: { "@id": `${rootUrl(config)}/#org` },
});
/** { @context, @graph } wrapper. */
export const graph = (...nodes) => ({ "@context": "https://schema.org", "@graph": nodes.flat().filter(Boolean) });
/** BreadcrumbList; the home crumb is added when the first item is not "/". */
export function crumbs(config, items) {
  const list = items[0]?.[1] === "/" ? items : [[strings(config).home, "/"], ...items];
  return { "@type": "BreadcrumbList", itemListElement: list.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: absUrl(config, path) })) };
}
/** JSON-LD <script> tag (with </script> escaped). */
export const jsonLdScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

/**
 * sitemap.xml from urls: strings or { loc, lastmod?, changefreq?, priority?, alternates? }; relative locs resolve against `base`.
 * alternates: [{ hreflang, href }] (a multi-locale site: every language version of the page, x-default included) adds
 * <xhtml:link rel="alternate"> entries and the xhtml namespace; without alternates the output is unchanged.
 */
export function sitemap(urls, { base = "" } = {}) {
  if (urls && urls.site) { const config = urls; urls = arguments[1] || []; base = config.site.root || config.site.url; }
  const b = String(base || "").replace(/\/+$/, "");
  const abs = (l) => (/^https?:\/\//.test(l) ? l : `${b}${l.startsWith("/") ? "" : "/"}${l}`);
  let xhtml = false;
  const body = (urls || []).map((u) => {
    const x = typeof u === "string" ? { loc: u } : u;
    const loc = abs(x.loc);
    const alt = Array.isArray(x.alternates) && x.alternates.length ? x.alternates.map((a) => `<xhtml:link rel="alternate" hreflang="${xmlEscape(a.hreflang)}" href="${xmlEscape(abs(a.href))}"/>`).join("") : "";
    if (alt) xhtml = true;
    return `<url><loc>${xmlEscape(loc)}</loc>${alt}${x.lastmod ? `<lastmod>${xmlEscape(String(x.lastmod).slice(0, 10))}</lastmod>` : ""}${x.changefreq ? `<changefreq>${x.changefreq}</changefreq>` : ""}${x.priority != null ? `<priority>${x.priority}</priority>` : ""}</url>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""}>${body}</urlset>`;
}

/**
 * hreflang alternates of one page on a multi-locale site: [{ hreflang, href }] for every locale that has `path`
 * (has(locale) decides; default: all), plus x-default → the default locale. [] on a single-locale site.
 */
export function hreflangs(config, path, has = () => true) {
  const L = config.site.locales;
  if (!Array.isArray(L) || L.length < 2) return [];
  const def = config.site.defaultLocale, root = rootUrl(config);
  const href = (l) => `${root}${l === def ? "" : `/${l.toLowerCase()}`}${path}`;
  const out = L.filter((l) => has(l)).map((l) => ({ hreflang: l, href: href(l) }));
  if (out.length && has(def)) out.push({ hreflang: "x-default", href: href(def) });
  return out;
}

export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot"];
export const DEFAULT_DISALLOW = ["/api/forms/", "/api/reactions", "/api/admin/", "/api/podcasts/admin", "/cdn-cgi/"];
/** robots.txt: everyone allowed, private APIs excluded; AI crawlers allowed explicitly (aiBots: false blocks them).
 *  comment / aiComment: the header comments; aiDisallow: the AI crawlers' own Disallow list (default: disallow). */
export function robots(config, { disallow = DEFAULT_DISALLOW, aiBots = true, extra = "", comment, aiComment, aiDisallow } = {}) {
  const dis = disallow.map((d) => `Disallow: ${d}`);
  const out = [`# ${comment || config.site.name}`, "User-agent: *", "Allow: /", ...dis, ""];
  if (aiComment) out.push(`# ${aiComment}`);
  out.push(`User-agent: ${AI_BOTS[0]}`, ...AI_BOTS.slice(1).map((b) => `User-agent: ${b}`), ...(aiBots ? ["Allow: /", ...(aiDisallow || disallow).map((d) => `Disallow: ${d}`)] : ["Disallow: /"]), "");
  if (config.features?.sitemap !== false) out.push(`Sitemap: ${config.site.url}/sitemap.xml`);
  if (config.features?.llms !== false) out.push(`# LLM-friendly index: ${config.site.url}/llms.txt`);
  if (extra) out.push(extra);
  return out.join("\n") + "\n";
}

const linkLine = (config, l) => `- [${l.title}](${absUrl(config, l.url)})${l.description ? `: ${l.description}` : ""}`;
/**
 * llms.txt: "# name", "> description", optional intro, then sections.
 * sections: [{ title, text?, links?: [{ title, url, description? }] }]
 */
export function llmsTxt(config, sections = [], { intro = "" } = {}) {
  const out = [`# ${config.site.name}`, ""];
  if (config.site.description) out.push(`> ${config.site.description.replace(/\n+/g, " ")}`, "");
  if (intro) out.push(intro.trim(), "");
  out.push(`Language: ${config.site.locale} (${config.site.dir}). Site: ${config.site.url}`, "");
  for (const s of sections) {
    out.push(`## ${s.title}`);
    if (s.text) out.push(s.text.trim());
    if (s.links?.length) out.push(...s.links.map((l) => linkLine(config, l)));
    out.push("");
  }
  return out.join("\n");
}
/**
 * llms.txt of a multi-locale site: one file listing every locale. parts: [{ config (the locale's config), sections, docs? }],
 * the default locale first. Each locale opens with a "## <name> (<locale>)" section (its description, language, direction
 * and home URL); its own sections follow with " (<locale>)" appended to their titles. With `full`, the docs of every locale follow.
 */
export function llmsTxtLocales(config, parts = [], { intro = "", full = false } = {}) {
  const out = [`# ${config.site.name}`, ""];
  if (config.site.description) out.push(`> ${config.site.description.replace(/\n+/g, " ")}`, "");
  if (intro) out.push(intro.trim(), "");
  out.push(`Languages: ${parts.map((p) => `${p.config.site.locale} (${p.config.site.dir}) ${p.config.site.url}/`).join(", ")}`, "");
  for (const p of parts) {
    const c = p.config, l = c.site.locale;
    out.push(`## ${c.site.name} (${l})`);
    if (c.site.description) out.push(c.site.description.replace(/\n+/g, " "));
    out.push(`Language: ${l} (${c.site.dir}). Site: ${c.site.url}/`, "");
    for (const s of p.sections || []) {
      out.push(`## ${s.title} (${l})`);
      if (s.text) out.push(s.text.trim());
      if (s.links?.length) out.push(...s.links.map((x) => linkLine(c, x)));
      out.push("");
    }
  }
  const text = out.join("\n");
  if (!full) return text;
  return [text, ...parts.flatMap((p) => (p.docs || []).map((d) => `\n---\n\n# ${d.title}\n${d.url ? `\nSource: ${absUrl(p.config, d.url)}\n` : ""}\n${String(d.markdown || "").trim()}\n`))].join("\n");
}

/** llms-full.txt: llms.txt plus the full Markdown of every doc ({ title, url?, markdown }). */
export function llmsFull(config, sections = [], docs = [], opts = {}) {
  return [llmsTxt(config, sections, opts), ...docs.map((d) => `\n---\n\n# ${d.title}\n${d.url ? `\nSource: ${absUrl(config, d.url)}\n` : ""}\n${String(d.markdown || "").trim()}\n`)].join("\n");
}

export const seo = { org, website, graph, crumbs, jsonLdScript, sitemap, hreflangs, robots, llmsTxt, llmsTxtLocales, llmsFull, absUrl, xmlEscape, AI_BOTS };
