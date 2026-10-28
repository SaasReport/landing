/**
 * Content tags on the Worker (docs/TAGS.md): the project's vocabulary (kit.content-tags.v1, createKit options.tags) is compiled once
 * per locale (k.tags); this module turns it into what a reader and a client see.
 *
 *   createTags(k)        → the helpers every handler shares: chips, the filter bar, the filter itself, the tags of episodes and posts
 *   createTagPages(k, …) → GET /tags/, /tags/<id>/, /api/tags, /api/tags/<id>
 *
 * Tags of an episode: the item's own (a topic or term of the content pack) when it names any, else its series'; an episode made from a
 * post carries the post's. A post's are its `tags` column. A tag id outside the vocabulary is shown as a neutral chip and never linked:
 * `kit check tags` keeps a project from publishing one, so it only appears for rows older than the vocabulary.
 */
import { effectiveTags, matchesQuery, TAG_COLOURS, MAX_FILTER_TAGS, FILTER_TAG_ID_MAX } from "@saasreport/core/tags";
import { esc, html, json, jsonRes, parseJSON, redirect } from "./util.js";

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_ROWS = 5000;

export function createTags(k) {
  const { config, t } = k;
  const V = k.tags;
  const H = (path) => k.href(path);   // k.href is set after this module is created

  /** The ?tag=…&show=…&kind=…&q=… of a request: { tags: [id], show, kind, q } (an id that cannot be a tag id is dropped). */
  const parseFilter = (url) => {
    const p = url.searchParams;
    const tags = [...new Set(p.getAll("tag").filter((x) => ID.test(x) && x.length <= FILTER_TAG_ID_MAX))].slice(0, MAX_FILTER_TAGS);
    const one = (name) => { const v = p.get(name); return v && /^[a-z0-9_-]{1,40}$/.test(v) ? v : null; };
    return { tags, show: one("show"), kind: one("kind"), q: (p.get("q") || "").trim().slice(0, 100) };
  };
  const active = (f) => Boolean(f.tags.length || f.show || f.q);
  /** The query string of a filter state (a fixed order: show, kind, tags, q); "" when empty. */
  const qs = (f) => {
    const parts = [f.show && `show=${encodeURIComponent(f.show)}`, f.kind && `kind=${encodeURIComponent(f.kind)}`, ...f.tags.map((x) => `tag=${x}`), f.q && `q=${encodeURIComponent(f.q)}`].filter(Boolean);
    return parts.length ? `?${parts.join("&")}` : "";
  };
  const link = (path, f) => `${H(path)}${qs(f)}`;

  /** Search text of a row: its title and summary, and the labels of its tags (unknown ids as they are). */
  const labelsOf = (ids) => { const r = V.resolve(ids); return [...r.known.map((x) => x.label), ...r.unknown]; };
  const parts = (row, ids) => [row.title, row.summary, ...labelsOf(ids)];
  /** Rows matching a filter (tags: all of them; q: every word); `tagsOf(row)` → ids. */
  const matching = (rows, f, tagsOf) => rows.filter((row) => {
    const ids = tagsOf(row);
    return f.tags.every((x) => ids.includes(x)) && matchesQuery(f.q, parts(row, ids));
  });

  /** <ul class="tags"> of chips: a link to the tag page for a declared tag, a neutral span for anything else. */
  const chips = (ids, { cls = "" } = {}) => {
    const { known, unknown } = V.resolve(ids);
    if (!known.length && !unknown.length) return "";
    return `<ul class="tags${cls ? ` ${cls}` : ""}" aria-label="${esc(t("tags.aria"))}">${known.map((x) => `<li><a class="tg tg--${x.colour}" href="${esc(H(`/tags/${x.id}/`))}">${esc(x.label)}</a></li>`).join("")}${unknown.map((x) => `<li><span class="tg tg--unknown">${esc(x)}</span></li>`).join("")}</ul>`;
  };

  /**
   * The filter bar: a search form (works with no script), the shows and kinds as toggles, the topics as coloured toggles.
   * `tagIds`: the topics present in the listing; `groups`: [{ param, items: [[value, label]] }] for the show / kind toggles.
   */
  const bar = ({ path, filter, tagIds, toggles = [], catalogue = false }) => {
    const present = tagIds.map((id) => V.get(id)).filter(Boolean);
    const hidden = [filter.show && ["show", filter.show], filter.kind && ["kind", filter.kind], ...filter.tags.map((x) => ["tag", x])].filter(Boolean)
      .map(([n, v]) => `<input type="hidden" name="${n}" value="${esc(v)}">`).join("");
    const toggle = (param, value, label) => {
      const on = filter[param] === value;
      const next = { ...filter, [param]: on ? null : value };
      return `<li><a class="chip" href="${esc(link(path, next))}" role="button" aria-pressed="${on}" data-param="${param}" data-value="${esc(value)}">${esc(label)}</a></li>`;
    };
    const tagToggle = (x) => {
      const on = filter.tags.includes(x.id);
      const next = { ...filter, tags: on ? filter.tags.filter((y) => y !== x.id) : [...filter.tags, x.id] };
      return `<li><a class="tg tg--${x.colour}" href="${esc(link(path, next))}" role="button" aria-pressed="${on}" data-tag="${x.id}">${esc(x.label)}</a></li>`;
    };
    const rows = toggles.filter((g) => g.items.length > 1 || filter[g.param]).map((g) => `<ul class="chips tagbar__row" role="group" aria-label="${esc(g.label)}">${g.items.map(([v, l]) => toggle(g.param, v, l)).join("")}</ul>`).join("");
    const reset = active(filter) || filter.kind ? `<a class="tagbar__clear" href="${esc(H(path))}">${esc(t("tags.clear"))}</a>` : "";
    return `<form class="tagbar wrap" method="get" action="${esc(H(path))}" role="search" data-tagbar${catalogue ? ' data-catalogue="complete"' : ""}>
  <label class="sr-only" for="tagbar-q">${esc(t("tags.searchLabel"))}</label>
  <div class="tagbar__search"><input id="tagbar-q" type="search" name="q" value="${esc(filter.q)}" placeholder="${esc(t("tags.placeholder"))}" autocomplete="off" data-tag-q>${hidden}<button class="btn btn--ghost btn--sm" type="submit">${esc(t("tags.search"))}</button>${reset}</div>
  ${rows}${present.length ? `<ul class="tags tagbar__tags" role="group" aria-label="${esc(t("tags.topics"))}">${present.map(tagToggle).join("")}</ul>` : ""}
</form>`;
  };

  /* ------------------------------------------------------------------ the tags of episodes and posts */
  const seriesTags = (id) => config.series.find((s) => s.id === id)?.tags;
  const itemIndex = new Map();
  /** The tags a series' items name themselves: Map(ref → ids) over slug, date and month (the refs an episode row stores). */
  const itemTagsOf = (seriesId) => {
    if (!itemIndex.has(seriesId)) {
      itemIndex.set(seriesId, k.c.items(seriesId).then((items) => {
        const m = new Map();
        for (const it of items) if (it && Array.isArray(it.tags) && it.tags.length) for (const key of [it.slug, it.date, it.month]) if (key) m.set(String(key), it.tags);
        return m;
      }).catch((e) => { itemIndex.delete(seriesId); throw e; }));
    }
    return itemIndex.get(seriesId);
  };
  /** Map(slug → [tag id]) for episode rows { slug, series, source_type, source_ref }. */
  async function episodeTags(env, rows) {
    const out = new Map();
    const fromPost = rows.filter((e) => e.source_type === "post" && e.source_ref);
    const posts = new Map();
    const refs = [...new Set(fromPost.map((e) => e.source_ref))];
    for (let i = 0; i < refs.length; i += 50) {
      const chunk = refs.slice(i, i + 50);
      const r = await env.DB.prepare(`SELECT slug, tags FROM posts WHERE slug IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      for (const p of r.results || []) posts.set(p.slug, parseJSON(p.tags, []));
    }
    for (const e of rows) {
      const own = e.source_type === "post" ? posts.get(e.source_ref) : (await itemTagsOf(e.series)).get(String(e.source_ref));
      out.set(e.slug, effectiveTags(seriesTags(e.series), own));
    }
    return out;
  }
  const postTags = (p) => parseJSON(p.tags, []);

  /** Tag labels for an RSS item, a Markdown twin or an llms.txt line. */
  const labelList = (ids) => labelsOf(ids);
  /** `tags:` and `tag_ids:` lines for a Markdown front matter ("" without tags). */
  const list = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  const front = (ids) => (ids.length ? `tags: ${list(labelsOf(ids))}\ntag_ids: ${list(ids)}\n` : "");
  /** " (tags: A, B)" for an llms.txt description ("" without tags). */
  const note = (ids) => (ids.length ? ` (tags: ${labelsOf(ids).join(", ")})` : "");

  /** The per-state plural of a count, "1 podcast, 2 posts" (zero parts left out). */
  const plural = new Intl.PluralRules(config.site.lang);
  const n = (key, count) => { const cat = plural.select(count); return t(t.has(`${key}.${cat}`) ? `${key}.${cat}` : `${key}.other`, { n: count }); };
  const countText = (c) => [c.podcasts && n("tags.nPodcasts", c.podcasts), c.posts && n("tags.nPosts", c.posts)].filter(Boolean).join(t("tags.countSep"));

  return { on: Boolean(V), V, parseFilter, active, qs, link, matching, parts, chips, bar, episodeTags, postTags, labelList, front, note, countText, MAX_ROWS };
}

/* ====================================================================== the tag pages and the JSON API */
export function createTagPages(k, T, { podcasts, blog }) {
  const { config, t } = k;
  const V = k.tags;
  const H = (path) => k.href(path);   // k.href is set after this module is created
  const loc = k.loc?.db ?? null;
  const u = (r) => k.urlSlug(r.slug);

  /** Every published episode and post with its tag ids: { episodes: [row + tags], posts: [row + tags] }. */
  async function catalogue(env) {
    const eps = config.features.podcasts ? await podcasts.listEpisodes(env, { limit: T.MAX_ROWS, locale: loc }) : [];
    const tagMap = await T.episodeTags(env, eps);
    const [lw, lb] = k.where();
    const posts = config.features.blog
      ? ((await env.DB.prepare(`SELECT slug, kind, title, summary, tags, published_at FROM posts WHERE status = 'published' AND published_at <= ?${lw} ORDER BY published_at DESC LIMIT ${T.MAX_ROWS}`).bind(k.now().toISOString(), ...lb).all()).results || [])
      : [];
    return { episodes: eps.map((e) => ({ ...e, tags: tagMap.get(e.slug) || [] })), posts: posts.map((p) => ({ ...p, tags: T.postTags(p) })) };
  }
  const counts = (cat) => {
    const c = new Map(V.tags.map((x) => [x.id, { podcasts: 0, posts: 0 }]));
    for (const e of cat.episodes) for (const id of new Set(e.tags)) if (c.has(id)) c.get(id).podcasts++;
    for (const p of cat.posts) for (const id of new Set(p.tags)) if (c.has(id)) c.get(id).posts++;
    return c;
  };
  const tagJson = (x, c) => ({ id: x.id, label: x.label, description: x.description, group: x.group, group_label: x.groupLabel, colour: x.colour, counts: c, url: k.abs(`/tags/${x.id}/`) });

  async function index(env) {
    const cat = await catalogue(env), c = counts(cat);
    const sections = V.groups.map((g) => {
      const list = V.tags.filter((x) => x.group === g.id);
      return `<section class="wrap tagindex"><h2 class="sec">${esc(g.label)}</h2><ul class="taglist">${list.map((x) => {
        const text = T.countText(c.get(x.id));
        return `<li><a class="tg tg--${x.colour}" href="${esc(H(`/tags/${x.id}/`))}">${esc(x.label)}</a>${text ? ` <small>${esc(text)}</small>` : ""}<p>${esc(x.description)}</p></li>`;
      }).join("")}</ul></section>`;
    }).join("\n");
    const body = `${k.hero("tags", { lead: t("tags.lead") })}\n${sections}`;
    return html(k.page({ title: k.pageTitle("tags", t("tags.title")), description: t("tags.description"), path: "/tags/", body, active: "tags", placement: "tags",
      jsonld: k.graph(k.crumbs([[t("nav.home"), "/"], [t("tags.title"), "/tags/"]])) }), 200, { "cache-control": "public, max-age=300" });
  }

  async function one(env, id) {
    const x = V.get(id);
    if (!x) return null;
    const cat = await catalogue(env);
    const eps = cat.episodes.filter((e) => e.tags.includes(id)), ps = cat.posts.filter((p) => p.tags.includes(id));
    const fullPosts = ps.length ? await blog.fullPosts(env, ps.map((p) => p.slug)) : [];
    const body = `<section class="hero wrap"><p class="eyebrow"><a href="${esc(H("/tags/"))}">${esc(t("tags.title"))}</a> / ${esc(x.groupLabel)}</p><h1><span class="tg tg--${x.colour} tg--lg">${esc(x.label)}</span></h1><p>${esc(x.description)}</p></section>
${eps.length ? `<section class="wrap"><h2 class="sec">${esc(t("tags.podcasts"))}</h2><div class="eplist">${eps.map((e) => podcasts.card(e, { tags: e.tags })).join("")}</div></section>` : ""}
${fullPosts.length ? `<section class="wrap"><h2 class="sec">${esc(t("tags.posts"))}</h2><div class="grid">${fullPosts.map((p) => blog.card(p)).join("")}</div></section>` : ""}
${!eps.length && !fullPosts.length ? `<section class="wrap"><p class="empty empty--box">${esc(t("tags.empty"))}</p></section>` : ""}`;
    return html(k.page({ title: k.itemTitle("tags", x.label), description: x.description, path: `/tags/${id}/`, body, active: "tags", scripts: eps.length ? ["podcast.js"] : [],
      jsonld: k.graph({ "@type": "CollectionPage", "@id": `${k.abs(`/tags/${id}/`)}#page`, name: x.label, description: x.description, url: k.abs(`/tags/${id}/`), inLanguage: config.site.localeBase, isPartOf: { "@id": k.abs("/tags/") } },
        k.crumbs([[t("nav.home"), "/"], [t("tags.title"), "/tags/"], [x.label, `/tags/${id}/`]])) }), 200, { "cache-control": "public, max-age=300" });
  }

  async function apiIndex(env, url) {
    const cat = await catalogue(env), c = counts(cat);
    return jsonRes(await k.api("tags", { ok: true, groups: V.groups, tags: V.tags.map((x) => tagJson(x, c.get(x.id))) }, { url, env }));
  }
  async function apiOne(env, url, id) {
    const x = V.get(id);
    if (!x) return null;
    const cat = await catalogue(env), c = counts(cat);
    const eps = cat.episodes.filter((e) => e.tags.includes(id)), ps = cat.posts.filter((p) => p.tags.includes(id));
    return jsonRes(await k.api("tag", { ok: true, tag: tagJson(x, c.get(id)),
      podcasts: eps.map((e) => ({ slug: u(e), show: e.show, series: e.series, title: e.title, summary: e.summary, published_at: e.published_at, url: k.abs(`/podcasts/${u(e)}`), tags: e.tags })),
      posts: ps.map((p) => ({ slug: u(p), kind: p.kind, title: p.title, summary: p.summary, published_at: p.published_at, url: k.abs(`/blog/${u(p)}`), tags: p.tags })) }, { url, env }));
  }

  /** Sitemap entries of the tag pages. */
  const sitemapUrls = () => [{ loc: "/tags/", lastmod: null, changefreq: "weekly", priority: "0.5" }, ...V.tags.map((x) => ({ loc: `/tags/${x.id}/`, lastmod: null, changefreq: "weekly", priority: "0.5" }))];

  async function handle(request, env, url) {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const p = url.pathname;
    if (p === "/tags") return redirect(`${H("/tags/")}${url.search}`);
    if (p === "/tags/") return index(env);
    if (p === "/api/tags") return apiIndex(env, url);
    let m = p.match(/^\/api\/tags\/([a-z0-9-]{1,48})$/);
    if (m) return (await apiOne(env, url, m[1])) || json({ ok: false, error: "not_found" }, 404);
    m = p.match(/^\/tags\/([a-z0-9-]{1,48})\/?$/);
    if (m) return p.endsWith("/") ? (await one(env, m[1])) || k.notFound() : redirect(`${H(`/tags/${m[1]}/`)}`);
    return null;
  }
  return { handle, sitemapUrls, catalogue };
}

export { TAG_COLOURS };
