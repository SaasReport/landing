/**
 * Discovery for search engines and AI assistants, generated from config + D1 + the content pack:
 *   /robots.txt   /llms.txt   /llms-full.txt   /.well-known/security.txt (/security.txt)   /sitemap.xml
 */
import { robots as coreRobots, sitemap as coreSitemap, llmsTxt, llmsFull } from "@saasreport/core";
import { text } from "../util.js";
import { postMd } from "./blog.js";
import { termMd } from "./glossary.js";

export function createDiscovery(k, { podcasts, twins, tagPages = null }) {
  const { config, t } = k;
  const T = k.tagsUi?.on ? k.tagsUi : null;
  const f = config.features;
  const now = () => k.now().toISOString();
  const u = (r) => k.urlSlug(r.slug);

  async function data(env) {
    const q = async (sql, ...b) => (env.DB ? (await env.DB.prepare(sql).bind(...b).all()).results || [] : []);
    const [lw, lb] = k.where();
    const [posts, eps, events] = await Promise.all([
      f.blog ? q(`SELECT slug, kind, title, summary, body_md, tags, published_at, updated_at FROM posts WHERE status = 'published' AND published_at <= ?${lw} ORDER BY published_at DESC LIMIT 5000`, now(), ...lb) : [],
      f.podcasts ? q(`SELECT slug, series, source_type, source_ref, number, title, summary, script_json, duration_ms, published_at, updated_at FROM podcast_episodes WHERE status = 'published'${lw} ORDER BY published_at DESC LIMIT 5000`, ...lb) : [],
      f.events ? q(`SELECT slug, title, summary, starts_at, updated_at FROM events${lw ? ` WHERE${lw.slice(4)}` : ""} ORDER BY starts_at DESC LIMIT 5000`, ...lb) : [],
    ]);
    const g = f.glossary ? await k.c.glossary() : null;
    const epTags = T ? await T.episodeTags(env, eps) : new Map();
    return { posts, eps, events, g, epTags };
  }

  const disallow = () => ["/api/forms/", "/api/reactions", "/api/podcasts/admin", "/api/podcasts/generate", "/cdn-cgi/", ...(config.security.disallow || [])];

  /** security: { robotsComment, aiComment, aiDisallow } shape the robots.txt comments and the AI crawlers' rules. */
  const robots = () => coreRobots(k.rawConfig, { disallow: disallow(), aiBots: config.security.aiBots !== false,
    comment: config.security.robotsComment, aiComment: config.security.aiComment, aiDisallow: config.security.aiDisallow });

  /** The Markdown twins of the static pages with their Markdown (for llms-full.txt): [{ title, url, markdown }]. */
  async function twinDocs(env, pages) {
    const md = await Promise.all(pages.map((x) => twins.markdown(env, x)));
    return pages.map((x, i) => ({ title: x.title, url: x.url, markdown: md[i] })).filter((x) => x.markdown);
  }

  /**
   * llms.txt / llms-full.txt. options.llms.build(ctx) → string replaces the generated index (ctx: { full, posts, eps, events, glossary,
   * abs, site, postMd, termMd, episodeMd, pages, pageDocs }); the documents of llms-full.txt use the same Markdown as
   * /blog|/glossary|/podcasts/<slug>.md. `pages` are the static pages' Markdown twins (md-twins.json: { title, url, md,
   * description, locale }); with `full`, `pageDocs` carries their Markdown ([{ title, url, markdown }]).
   */
  async function llms(env, full) {
    const { posts, eps, events, g, epTags } = await data(env);
    const pages = k.loc ? [] : await twins.list(env);
    if (typeof config.llms.build === "function" && !k.loc) {
      const body = await config.llms.build({ full, posts, eps, events, glossary: g, abs: k.abs, site: config.site, t,
        postMd: (p) => postMd(k, p), termMd: (x) => termMd(k, g, x), episodeMd: (e) => podcasts.episodeMd(e, epTags.get(e.slug) || []),
        pages, pageDocs: full ? await twinDocs(env, pages) : [] });
      return text(body, "text/markdown", 3600, { "x-robots-tag": "noindex" });
    }
    const link = (title, url, description) => ({ title, url, description });
    const twinLinks = pages.map((x) => link(x.title, x.md, x.description));
    const navPages = [
      f.blog && link(t("blog.title"), "/blog/", `${config.blog.lead || t("blog.lead")} (RSS: ${k.abs("/blog/feed.xml")})`),
      f.podcasts && Object.keys(config.shows).length && link(t("podcasts.title"), "/podcasts/", Object.values(config.shows).map((s) => `${s.title} (feed: ${k.abs(s.feed)})`).join("; ")),
      g && link(t("glossary.title"), "/glossary/", t("glossary.lead", { terms: g.terms.length, cats: g.categories.length })),
      T && link(t("tags.title"), "/tags/", t("tags.description")),
      f.events && link(t("events.title"), "/events/", config.events.lead || t("events.lead")),
      ...config.nav.map((n) => link(n.label, n.href, n.description)),
    ].filter(Boolean);
    const apis = [
      f.blog && link("Blog JSON", "/api/blog/posts"),
      f.podcasts && link("Podcast JSON", "/api/podcasts"),
      g && link("Glossary JSON", "/api/glossary"), g && link("Term of the day", "/api/glossary/today"),
      f.events && link("Events JSON", "/api/events"),
      T && link("Topics (tags) JSON", "/api/tags"),
      f.calendar && k.deps.calendar && link("Calendar REST API (OpenAPI 3.1)", "/api/calendar/openapi.json"),
      f.calendar && k.deps.calendar && link("MCP server (Streamable HTTP, read-only calendar tools)", "/mcp"),
      f.calendar && k.deps.calendar && config.calendar.holidays === "iran" && link("ICS feed of holidays", "/calendar.ics"),
      config.meta !== false && link("Site meta: forms, their required fields, APIs (JSON)", "/api/meta"),
    ].filter(Boolean);
    const sections = [
      navPages.length && { title: "Pages", links: navPages },
      twinLinks.length && { title: config.llms.pagesTitle || "Pages (Markdown)", links: twinLinks },
      apis.length && { title: "APIs", links: apis },
      posts.length && { title: t("blog.title"), links: posts.map((p) => link(p.title, `/blog/${u(p)}.md`, `${p.summary}${T ? T.note(T.postTags(p)) : ""}`)) },
      ...(g ? g.categories.map((c) => ({ title: `${t("glossary.title")}: ${c.name}`, links: c.terms.map((x) => link(x.en && x.en !== x.term ? `${x.term} (${x.en})` : x.term, `/glossary/${x.slug}.md`, x.short)) })) : []),
      eps.length && { title: t("podcasts.title"), links: eps.map((e) => link(e.title, `/podcasts/${u(e)}.md`, `${e.summary}${T ? T.note(epTags.get(e.slug) || []) : ""}`)) },
      T && k.tags.tags.length && { title: t("tags.title"), links: k.tags.tags.map((x) => link(x.label, `/tags/${x.id}/`, x.description)) },
      events.length && { title: t("events.title"), links: events.map((e) => link(`${e.title} (${e.starts_at.slice(0, 10)})`, `/events/${e.slug}`, e.summary)) },
      !full && { title: "Optional", links: [link("Full text", "/llms-full.txt"), ...(f.sitemap ? [link("Sitemap", "/sitemap.xml")] : [])] },
    ].filter(Boolean);
    const intro = config.security.about || "";
    const docs = full ? [
      ...(await twinDocs(env, pages)),
      ...posts.map((p) => ({ title: p.title, url: `/blog/${u(p)}`, markdown: postMd(k, p) })),
      ...(g ? g.terms.map((x) => ({ title: x.term, url: `/glossary/${x.slug}`, markdown: termMd(k, g, x) })) : []),
      ...eps.map((e) => ({ title: e.title, url: `/podcasts/${u(e)}`, markdown: podcasts.episodeMd(e, epTags.get(e.slug) || []) })),
    ] : [];
    // A locale of a multi-locale site hands its part to the router (multi.js), which writes one llms.txt for every locale.
    if (k.loc) return { config: k.rawConfig, sections: sections.filter((x) => x.title !== "Optional"), docs, intro };
    const body = full ? llmsFull(k.rawConfig, sections, docs, { intro }) : llmsTxt(k.rawConfig, sections, { intro });
    return text(body, "text/markdown", 3600, { "x-robots-tag": "noindex" });
  }

  function security() {
    const s = config.security;
    const expires = new Date(k.now().getTime() + 365 * 864e5).toISOString().slice(0, 10) + "T00:00:00.000Z";
    const contact = s.contact || (config.site.email ? `mailto:${config.site.email}` : k.abs("/"));
    return [`Contact: ${contact}`, `Expires: ${expires}`, `Preferred-Languages: ${[...new Set([config.site.lang, "en"])].join(", ")}`,
      `Canonical: ${k.abs("/.well-known/security.txt")}`, ...(s.policy ? [`Policy: ${s.policy}`] : [])].join("\n") + "\n";
  }

  /** Sitemap entries of this locale: { loc (a site path without the locale prefix), lastmod, changefreq, priority }. */
  async function sitemapUrls(env) {
    const { posts, eps, events, g } = await data(env);
    const u = (loc, lastmod, changefreq, priority) => ({ loc, lastmod, changefreq, priority });
    // Nav items are listed too (site paths without a fragment); nav[].sitemap: false leaves one out, { changefreq, priority } tunes it.
    const navUrls = config.nav.filter((n) => n.href.startsWith("/") && !n.href.includes("#") && n.sitemap !== false)
      .map((n) => u(n.href, null, n.sitemap?.changefreq || "monthly", n.sitemap?.priority || "0.6"));
    const urls = [u("/", null, "weekly", "1.0"), f.blog && u("/blog/", null, "daily", "0.8"), f.podcasts && Object.keys(config.shows).length && u("/podcasts/", null, "daily", "0.8"),
      g && u("/glossary/", null, "weekly", "0.8"), f.events && u("/events/", null, "weekly", "0.7"), ...navUrls,
      ...posts.map((r) => u(`/blog/${k.urlSlug(r.slug)}`, r.updated_at || r.published_at, "monthly", "0.6")),
      ...eps.map((r) => u(`/podcasts/${k.urlSlug(r.slug)}`, r.updated_at || r.published_at, "monthly", "0.6")),
      ...events.map((r) => u(`/events/${r.slug}`, r.updated_at, "weekly", "0.6")),
      ...(tagPages ? tagPages.sitemapUrls() : []),
      ...(g ? g.terms.map((x) => u(`/glossary/${x.slug}`, null, "monthly", "0.6")) : []),
    ].filter(Boolean);
    return urls;
  }
  async function sitemap(env) {
    const urls = await sitemapUrls(env);
    return new Response(coreSitemap(urls, { base: config.site.url }), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }

  async function handle(request, env, url) {
    const p = url.pathname;
    if (p === "/robots.txt") return text(robots(), "text/plain", 86400);
    if (p === "/.well-known/security.txt" || p === "/security.txt") return text(security(), "text/plain", 86400);
    if (p === "/sitemap.xml") return f.sitemap ? sitemap(env) : null;
    if (p === "/llms.txt") return f.llms ? llms(env, false) : null;
    if (p === "/llms-full.txt") return f.llms ? llms(env, true) : null;
    return null;
  }
  return { handle, robots, sitemap, sitemapUrls, llms, twinDocs };
}
