/**
 * Blog: /blog/ (kind filter + pagination), /blog/<slug>, /blog/<slug>.md, /blog/feed.xml, /api/blog/posts.
 * Posts live in D1 `posts` (the daily cron upserts scheduled ones; editorial rows can be synced by the CLI).
 */
import { renderMarkdown, toPlain, readingMinutes, rss } from "@saasreport/core";
import { esc, html, jsonRes, text, redirect, clampInt, parseJSON } from "../util.js";
import { icon } from "../shell.js";
import { aggregates, reactionsBlock } from "./reactions.js";

const readMin = (md) => readingMinutes(md);

/** Published posts, newest first. `locale`: the locale column's value on a multi-locale site (omitted: every row, as a single-locale site reads them). */
export async function listPosts(env, { kind = null, limit = 12, offset = 0, now = new Date().toISOString(), locale = null } = {}) {
  const where = `status = 'published' AND published_at <= ?${kind ? " AND kind = ?" : ""}${locale != null ? " AND locale = ?" : ""}`;
  const binds = [now, ...(kind ? [kind] : []), ...(locale != null ? [locale] : [])];
  const rows = await env.DB.prepare(`SELECT slug, kind, title, summary, body_md, tags, author, source, published_at, updated_at FROM posts WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`).bind(...binds).first();
  return { posts: rows.results || [], total: total?.n || 0 };
}

export const getPost = (env, slug, now = new Date().toISOString()) =>
  env.DB.prepare("SELECT * FROM posts WHERE slug = ? AND status = 'published' AND published_at <= ?").bind(slug, now).first();

export function postMd(k, p) {
  const T = k.tagsUi?.on ? k.tagsUi : null;
  return `---
title: ${JSON.stringify(p.title)}
type: ${k.t(`kind.${p.kind}`)}
published: ${p.published_at}
url: ${k.abs(`/blog/${k.urlSlug(p.slug)}`)}
source: ${k.config.llms.source ?? JSON.stringify(k.config.site.name)}
${T ? T.front(T.postTags(p)) : ""}---

# ${p.title}

> ${p.summary}

${p.body_md}
`;
}

export function createBlog(k) {
  const { t, config } = k;
  const kinds = config.blog.kinds;
  const H = k.href, u = (p) => k.urlSlug(p.slug), loc = k.loc?.db ?? null;
  const kindLabel = (x) => t(`kind.${x}`);
  const cardMeta = (p) => { const n = readMin(p.body_md || p.summary); return t("blog.cardMeta", { date: k.fmtDate(p.published_at), read: t("blog.readMin", { n }), n }); };
  const blogName = () => config.blog.name || `${t("blog.title")} · ${config.site.name}`;
  const lead = () => config.blog.lead || t("blog.lead");
  const ogImage = (o) => (o?.image ? { image: o.image, ...(o.alt ? { alt: o.alt } : {}) } : {});
  const T = k.tagsUi?.on ? k.tagsUi : null;
  /** A post card; with tags on it carries its chips (after the link: a chip is a link) and the data the browser filter reads. */
  const card = (p) => { const ids = T ? T.postTags(p) : []; return `<article class="pcard"${T ? ` data-slug="${esc(u(p))}" data-kind="${esc(p.kind)}" data-tags="${esc(ids.join(" "))}" data-q="${esc(T.parts(p, ids).join(" "))}"` : ""}><a href="${H("/blog/")}${esc(u(p))}">
  <span class="kb kb--${esc(p.kind)}">${esc(kindLabel(p.kind))}</span><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p>
  <span class="meta">${icon("cal")}${esc(cardMeta(p))}</span></a>${T ? T.chips(ids, { cls: "tags--sm" }) : ""}</article>`; };
  /** The full rows of some posts, in the order of `slugs` (the light listing of the filter has no body). */
  async function fullPosts(env, slugs) {
    const by = new Map();
    for (let i = 0; i < slugs.length; i += 50) {
      const chunk = slugs.slice(i, i + 50);
      const r = await env.DB.prepare(`SELECT slug, kind, title, summary, body_md, tags, author, source, published_at, updated_at FROM posts WHERE slug IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      for (const row of r.results || []) by.set(row.slug, row);
    }
    return slugs.map((x) => by.get(x)).filter(Boolean);
  }
  const blogId = k.abs("/blog/#blog");

  async function index(env, url) {
    const filter = T ? T.parseFilter(url) : { tags: [], show: null, kind: null, q: "" };
    const kind = kinds.includes(T ? filter.kind : url.searchParams.get("kind")) ? (T ? filter.kind : url.searchParams.get("kind")) : null;
    const per = config.blog.perPage;
    const page = clampInt(url.searchParams.get("page"), 1, 10_000, 1);
    let posts, total, present = [];
    if (T) {
      // The light listing of every published post (no body), filtered here, then the page's full rows: a tag or a search reaches every post.
      const [lw, lb] = k.where();
      const light = (await env.DB.prepare(`SELECT slug, kind, title, summary, tags, published_at FROM posts WHERE status = 'published' AND published_at <= ?${lw} ORDER BY published_at DESC LIMIT ${T.MAX_ROWS}`).bind(k.now().toISOString(), ...lb).all()).results || [];
      present = [...new Set(light.flatMap((x) => T.postTags(x)))].filter((id) => k.tags.has(id)).sort((a, b) => k.tags.tags.findIndex((x) => x.id === a) - k.tags.tags.findIndex((x) => x.id === b));
      const hit = T.matching(light.filter((x) => !kind || x.kind === kind), filter, T.postTags);
      total = hit.length;
      posts = await fullPosts(env, hit.slice((page - 1) * per, page * per).map((x) => x.slug));
    } else {
      ({ posts, total } = await listPosts(env, { kind, limit: per, offset: (page - 1) * per, now: k.now().toISOString(), locale: loc }));
    }
    const pages = Math.max(1, Math.ceil(total / per));
    const state = { ...filter, show: null, kind };
    const q = (n) => (T ? `${T.link("/blog/", state)}${T.qs(state) ? "&" : "?"}page=${n}` : `?${kind ? `kind=${kind}&` : ""}page=${n}`);
    const chips = [["", t("blog.all")], ...kinds.map((x) => [x, kindLabel(x)])]
      .map(([x, l]) => `<a class="chip" href="${T ? esc(T.link("/blog/", { ...state, kind: x || null })) : `${H("/blog/")}${x ? `?kind=${x}` : ""}`}"${(x || null) === kind ? ' aria-current="true"' : ""}>${esc(l)}</a>`).join("");
    const bar = T ? T.bar({ path: "/blog/", filter: state, tagIds: present, catalogue: !T.active(filter) && !kind && page === 1 && pages === 1 }) : "";
    const body = `
${k.hero("blog", { lead: lead(), actions: `<a class="btn btn--ghost btn--sm" href="${H("/blog/feed.xml")}">${icon("rss")}${esc(t("rss"))}</a>` })}
${bar}
<section class="wrap"><nav class="chips" aria-label="${esc(t("blog.kinds"))}">${chips}</nav>
  ${posts.length ? `<div class="grid">${posts.map(card).join("")}</div>` : `<p class="empty"${T ? " data-tags-none" : ""}>${esc(T && T.active(filter) ? t("tags.none") : t("blog.empty"))}</p>`}
  ${T && posts.length ? `<p class="empty" data-tags-none hidden>${esc(t("tags.none"))}</p>` : ""}
  ${pages > 1 ? `<nav class="pager" aria-label="${esc(t("blog.pageOf", { page, pages }))}">${page > 1 ? `<a class="btn btn--ghost btn--sm" rel="prev" href="${q(page - 1)}">${esc(t("blog.prev"))}</a>` : ""}<span>${esc(t("blog.pageOf", { page, pages }))}</span>${page < pages ? `<a class="btn btn--ghost btn--sm" rel="next" href="${q(page + 1)}">${esc(t("blog.next"))}</a>` : ""}</nav>` : ""}
</section>`;
    const jsonld = k.graph({ "@type": "Blog", "@id": blogId, name: blogName(), url: k.abs("/blog/"), inLanguage: config.site.localeBase, publisher: k.orgRef(),
      blogPost: posts.map((x) => ({ "@type": "BlogPosting", headline: x.title, url: k.abs(`/blog/${u(x)}`), datePublished: x.published_at })) },
      k.crumbs([[t("nav.home"), "/"], [t("blog.title"), "/blog/"]]));
    const qs = [kind ? `kind=${kind}` : "", page > 1 ? `page=${page}` : ""].filter(Boolean).join("&");
    const path = `/blog/${qs ? `?${qs}` : ""}`;
    return html(k.page({ title: k.pageTitle("blog", t("blog.title")), description: t.opt("blog.description") || lead(), path, body, active: "blog", jsonld, placement: "blog",
      og: ogImage(config.blog.og), after: k.subscribe(), ...(T ? { scripts: ["tags.js"] } : {}), ...(T && T.active(filter) ? { robots: "noindex, follow" } : {}) }));
  }

  async function post(env, slug) {
    const p = await getPost(env, slug, k.now().toISOString());
    if (!p) return null;
    const { html: bodyHtml, headings } = renderMarkdown(p.body_md, { origin: config.site.url });
    const [lw, lb] = k.where();
    const related = (await env.DB.prepare(`SELECT slug, kind, title, summary, body_md, published_at FROM posts WHERE status = 'published' AND slug != ? AND kind = ? AND published_at <= ?${lw} ORDER BY published_at DESC LIMIT 3`).bind(slug, p.kind, k.now().toISOString(), ...lb).all()).results || [];
    const tags = parseJSON(p.tags, []);
    const url = k.abs(`/blog/${u(p)}`);
    const item = `post:${p.slug}`;
    const agg = config.features.reactions ? (await aggregates(env, [item]))[item] : undefined;
    const toc = headings.filter((h) => h.level === 2);
    const body = `
<article class="wrap post">
  <nav class="crumbs" aria-label="${esc(t("crumbs"))}"><a href="${H("/blog/")}">${esc(t("blog.title"))}</a><span>/</span><a href="${H("/blog/")}?kind=${esc(p.kind)}">${esc(kindLabel(p.kind))}</a></nav>
  <header class="post__head"><span class="kb kb--${esc(p.kind)}">${esc(kindLabel(p.kind))}</span><h1>${esc(p.title)}</h1><p class="lead">${esc(p.summary)}</p>
    <div class="meta"><span>${icon("cal")}<time datetime="${esc(p.published_at)}">${esc(k.fmtDate(p.published_at))}</time></span><span>${icon("clock")}${esc(t("blog.readMin", { n: readMin(p.body_md) }))}</span>${p.author ? `<span>${esc(p.author)}</span>` : ""}${p.source === "auto" ? `<span class="kb kb--auto">${esc(t("blog.auto"))}</span>` : ""}</div></header>
  <div class="post__grid">
    <div class="post__body"><div class="md">${bodyHtml}</div>
      ${T ? T.chips(tags) : tags.length ? `<div class="tags">${tags.map((x) => `<span>#${esc(x)}</span>`).join("")}</div>` : ""}
      ${reactionsBlock(k, { item, url, title: p.title, agg })}
    </div>
    ${(config.blog.tocAllLevels ? headings.length > 1 && toc.length : toc.length > 1) ? `<aside class="aside"><b>${esc(t("blog.toc"))}</b><ol>${toc.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join("")}</ol></aside>` : ""}
  </div>
</article>
${related.length ? `<section class="wrap"><h2 class="sec">${esc(t("blog.related"))}</h2><div class="grid">${related.map(card).join("")}</div></section>` : ""}`;
    const og = config.blog.itemOg || config.blog.og;
    const image = og?.image ? k.abs(og.image) : config.site.ogImage ? k.abs(config.site.ogImage) : undefined;
    const jsonld = k.graph({ "@type": "BlogPosting", "@id": `${url}#post`, headline: p.title, description: p.summary, datePublished: p.published_at, dateModified: p.updated_at || p.published_at,
      inLanguage: config.site.localeBase, url, mainEntityOfPage: url, ...(image ? { image } : {}), keywords: (T ? T.labelList(tags) : tags).join(t("blog.keywordSep")), articleSection: kindLabel(p.kind),
      wordCount: toPlain(p.body_md).split(/\s+/).length, author: p.author && p.author !== config.blog.author ? { "@type": "Person", name: p.author } : k.orgRef(), publisher: k.orgRef(), isPartOf: { "@id": blogId } },
    k.crumbs([[t("nav.home"), "/"], [t("blog.title"), "/blog/"], [p.title, `/blog/${u(p)}`]]));
    return html(k.page({ title: k.itemTitle("blog", p.title), description: p.summary, path: `/blog/${u(p)}`, body, active: "blog", jsonld, after: k.subscribe(),
      head: `${T && tags.length ? `<meta name="kit:tags" content="${esc(tags.join(" "))}">` : ""}<link rel="alternate" type="text/markdown" title="Markdown" href="${H("/blog/")}${esc(u(p))}.md">`,
      og: { type: "article", title: p.title, ...(og?.image ? { image: og.image } : {}), published: p.published_at, modified: p.updated_at, section: kindLabel(p.kind), tags: T ? T.labelList(tags) : tags } }));
  }

  async function feed(env) {
    const { posts } = await listPosts(env, { limit: 30, now: k.now().toISOString(), locale: loc });
    const xmlBody = rss(k.rawConfig, posts.map((p) => ({ title: p.title, url: `/blog/${u(p)}`, summary: p.summary, published_at: p.published_at, categories: [kindLabel(p.kind), ...(T ? T.labelList(T.postTags(p)) : [])] })),
      { title: blogName(), description: config.blog.feedDescription || config.blog.lead || config.site.description || t("blog.lead"), path: "/blog/", feedPath: "/blog/feed.xml", language: config.site.locale });
    return new Response(xmlBody, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  async function handle(request, env, url) {
    const p = url.pathname;
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (p === "/blog") return redirect(`${H("/blog/")}${url.search}`);
    if (p === "/blog/") return index(env, url);
    if (p === "/blog/feed.xml") return feed(env);
    if (p === "/api/blog/posts") {
      const kind = kinds.includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : null;
      const limit = clampInt(url.searchParams.get("limit"), 1, 50, 10);
      const offset = clampInt(url.searchParams.get("offset"), 0, 1e6, 0);
      let posts, total;
      if (T) {
        const f = T.parseFilter(url), [lw, lb] = k.where();
        const light = (await env.DB.prepare(`SELECT slug, kind, title, summary, tags, published_at FROM posts WHERE status = 'published' AND published_at <= ?${lw} ORDER BY published_at DESC LIMIT ${T.MAX_ROWS}`).bind(k.now().toISOString(), ...lb).all()).results || [];
        const hit = T.matching(light.filter((x) => !kind || x.kind === kind), f, T.postTags);
        total = hit.length;
        posts = await fullPosts(env, hit.slice(offset, offset + limit).map((x) => x.slug));
      } else ({ posts, total } = await listPosts(env, { kind, limit, offset, now: k.now().toISOString(), locale: loc }));
      return jsonRes(await k.api("blogPosts", { ok: true, total, posts: posts.map((x) => ({ slug: u(x), kind: x.kind, kind_label: kindLabel(x.kind), title: x.title, summary: x.summary, tags: parseJSON(x.tags, []), ...(T ? { tag_labels: T.labelList(T.postTags(x)) } : {}),
        published_at: x.published_at, published_label: k.fmtDate(x.published_at), reading_minutes: readMin(x.body_md), url: k.abs(`/blog/${u(x)}`), markdown: k.abs(`/blog/${u(x)}.md`) })) }, { url, env, rows: posts }));
    }
    let m = p.match(/^\/blog\/([a-z0-9-]{1,90})\.md$/);
    if (m) { const x = await getPost(env, k.dbSlug(m[1]), k.now().toISOString()); return x ? text(postMd(k, x), "text/markdown", 3600, { "x-robots-tag": "noindex" }) : k.notFound(); }
    m = p.match(/^\/blog\/([a-z0-9-]{1,90})\/?$/);
    if (m) return (await post(env, k.dbSlug(m[1]))) || k.notFound();
    return null;
  }
  return { handle, listPosts, fullPosts, card };
}
