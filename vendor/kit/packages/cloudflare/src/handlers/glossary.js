/**
 * Glossary from the term series (series with `glossary: true`):
 *   /glossary/            the taxonomy: categories and every term, a filter, the term of the day
 *   /glossary/<slug>      one term (DefinedTerm JSON-LD), its audio episode once published   (+ .md)
 *   /api/glossary         JSON: categories and terms          /api/glossary/today   today's term (+ episode)
 *   /taxonomy, /glossary  → /glossary/
 */
import { renderMarkdown } from "@saasreport/core";
import { esc, html, jsonRes, text, redirect, isoOfDay } from "../util.js";
import { icon } from "../shell.js";

export function termMd(k, g, x) {
  const rel = (x.related || []).map((s) => g.bySlug.get(s)).filter(Boolean);
  return `---
term: ${JSON.stringify(x.term)}
${x.en ? `english: ${JSON.stringify(x.en)}\n` : ""}category: ${JSON.stringify(g.categoryName(x.category))}
url: ${k.abs(`/glossary/${x.slug}`)}
source: ${k.config.llms.glossarySource ?? JSON.stringify(`${k.config.site.name} — ${k.t("glossary.title")}`)}
---

# ${x.term}${x.en ? ` (${x.en})` : ""}

> ${x.short || ""}

${x.definition || ""}
${rel.length ? `\n${k.config.llms.relatedLabel ?? k.t("glossary.related")}: ${rel.map((r) => `[${r.term}](${k.abs(`/glossary/${r.slug}.md`)})`).join(k.config.llms.relatedSep ?? ", ")}\n` : ""}`;
}

export function createGlossary(k, { player }) {
  const { t, d, config } = k;
  const H = k.href;
  const setId = () => k.abs("/glossary/#set");
  const setName = () => config.glossary.name || `${t("glossary.title")} · ${config.site.name}`;
  const ogOf = (o) => (o?.image ? { image: o.image, ...(o.alt ? { alt: o.alt } : {}) } : {});

  const [lw, lb] = k.where();
  const episodeOf = (env, g, slug) => (env.DB
    ? env.DB.prepare(`SELECT slug, number, title, summary, duration_ms, published_at FROM podcast_episodes WHERE series = ? AND source_ref = ? AND status = 'published'${lw} ORDER BY published_at DESC LIMIT 1`).bind(g.series.id, slug, ...lb).first()
    : null);
  const card = (x) => `<a class="gterm" data-gterm href="${H("/glossary/")}${esc(x.slug)}" data-q="${esc(`${x.term} ${x.en || ""} ${x.short || ""}`.toLowerCase())}"><b>${esc(x.term)}</b>${x.en ? `<span class="gterm__en" dir="ltr">${esc(x.en)}</span>` : ""}<span class="gterm__d">${esc(x.short || "")}</span></a>`;

  async function index(env) {
    const g = await k.c.glossary();
    const today = await k.c.termOfDay(k.today());
    const ep = today ? await episodeOf(env, g, today.term.slug) : null;
    const todayBox = today ? `<div class="gtoday" data-glossary-today><span class="kb">${esc(t("glossary.today"))}</span>
    <h2><a href="${H("/glossary/")}${esc(today.term.slug)}">${esc(today.term.term)}</a>${today.term.en ? ` <small dir="ltr">${esc(today.term.en)}</small>` : ""}</h2><p>${esc(today.term.short || "")}</p>
    ${ep && config.features.podcasts ? player(ep) : t.opt("glossary.todaySoon") ? `<p class="note">${esc(t("glossary.todaySoon", { n: today.number }))}</p>` : ""}</div>` : `<div class="gtoday gtoday--empty" data-glossary-empty hidden></div>`;
    const lead = config.glossary?.lead || t("glossary.lead", { terms: g.terms.length, cats: g.categories.length });
    const body = `
${k.hero("glossary", { lead, vars: { terms: g.terms.length, cats: g.categories.length } })}
<section class="wrap">
  ${todayBox}
  <label class="gsearch"><span class="sr-only">${esc(t("glossary.search"))}</span><input type="search" placeholder="${esc(t("glossary.searchPlaceholder"))}" data-gsearch autocomplete="off"></label>
  <nav class="chips" aria-label="${esc(t("glossary.categories"))}">${g.categories.map((c) => `<a class="chip" href="#${esc(c.key)}">${esc(c.name)} <small>${d(c.terms.length)}</small></a>`).join("")}</nav>
  ${g.categories.map((c) => `<section class="gcat" id="${esc(c.key)}" data-gcat><h2 class="sec">${esc(c.name)} <small>${esc(t("glossary.count", { n: c.terms.length }))}</small></h2>
    <div class="grid grid--3">${c.terms.map(card).join("")}</div></section>`).join("\n")}
  <p class="empty" data-gnone hidden>${esc(t("glossary.none"))}</p>
</section>`;
    const jsonld = k.graph({ "@type": "DefinedTermSet", "@id": setId(), name: setName(), description: t.opt("glossary.description", { terms: g.terms.length, cats: g.categories.length }) || lead, url: k.abs("/glossary/"), inLanguage: config.site.localeBase, publisher: k.orgRef(),
      hasDefinedTerm: g.terms.map((x) => ({ "@type": "DefinedTerm", "@id": k.abs(`/glossary/${x.slug}#term`), name: x.term, ...(x.en ? { alternateName: x.en } : {}), url: k.abs(`/glossary/${x.slug}`) })) },
    k.crumbs([[t("nav.home"), "/"], [t("glossary.title"), "/glossary/"]]));
    const description = t.opt("glossary.description", { terms: g.terms.length, cats: g.categories.length }) || lead;
    return html(k.page({ title: k.pageTitle("glossary", t("glossary.title")), description, path: "/glossary/", body, active: "glossary", jsonld, placement: "glossary", og: ogOf(config.glossary.og), scripts: ["podcast.js", "glossary.js"] }));
  }

  async function termPage(env, slug) {
    const g = await k.c.glossary();
    const x = g.bySlug.get(slug);
    if (!x) return null;
    const cat = g.categories.find((c) => c.key === x.category) || { key: x.category, name: x.category, terms: [] };
    const ep = await episodeOf(env, g, x.slug);
    const url = k.abs(`/glossary/${x.slug}`);
    const related = (x.related || []).map((s) => g.bySlug.get(s)).filter(Boolean);
    const siblings = cat.terms.filter((y) => y.slug !== x.slug && !(x.related || []).includes(y.slug)).slice(0, 8);
    const day = g.dayOf(x.slug);
    // glossary.soonOn ({date}; with {show}) replaces glossary.soon + the date when the project defines it.
    const soonDate = day != null && day > k.today() ? k.fmtDate(`${isoOfDay(day)}T12:00:00Z`) : "";
    const audio = !config.features.podcasts ? "" : ep ? `<h2 class="sec">${esc(t("glossary.listen"))}</h2>${player(ep, { big: true, title: false })}<p class="note"><a class="link" href="${H("/podcasts/")}${esc(k.urlSlug(ep.slug))}">${esc(t.opt("glossary.episodeLink", { title: ep.title, n: ep.number ?? "" }) || ep.title)}</a></p>`
      : t.opt("glossary.soonOn") && day != null ? `<p class="note">${icon("cal")} ${esc(t("glossary.soonOn", { date: soonDate ? t("glossary.onDate", { date: soonDate }) : "" }).replace(/\s+/g, " "))}</p>`
      : day != null && day >= k.today() ? `<p class="note">${icon("cal")} ${esc(t("glossary.soon"))} <time datetime="${isoOfDay(day)}">${esc(k.fmtDate(`${isoOfDay(day)}T12:00:00Z`))}</time></p>` : "";
    const body = `
<article class="wrap post">
  <nav class="crumbs" aria-label="${esc(t("crumbs"))}"><a href="${H("/glossary/")}">${esc(t("glossary.title"))}</a><span>/</span><a href="${H("/glossary/")}#${esc(cat.key)}">${esc(cat.name)}</a></nav>
  <header class="post__head"><span class="kb">${esc(cat.name)}</span><h1>${esc(x.term)}</h1>${x.en ? `<p class="gterm__en gterm__en--big" dir="ltr">${esc(x.en)}</p>` : ""}<p class="lead">${esc(x.short || "")}</p></header>
  <div class="post__grid">
    <div class="post__body">
      <div class="md">${renderMarkdown(x.definition || "", { origin: config.site.url }).html}</div>
      ${audio}
      ${related.length ? `<h2 class="sec">${esc(t("glossary.related"))}</h2><div class="grid grid--3">${related.map(card).join("")}</div>` : ""}
    </div>
    <aside class="aside"><b>${esc(cat.name)}</b><ol>${siblings.map((y) => `<li><a href="${H("/glossary/")}${esc(y.slug)}">${esc(y.term)}</a></li>`).join("")}</ol>
      <p class="note"><a class="link" href="${H("/glossary/")}">${esc(t("glossary.all", { n: g.terms.length }))}</a></p></aside>
  </div>
</article>`;
    const jsonld = k.graph({ "@type": "DefinedTerm", "@id": `${url}#term`, name: x.term, ...(x.en ? { alternateName: x.en } : {}), description: x.short || "", termCode: x.slug, url, inLanguage: config.site.localeBase,
      inDefinedTermSet: { "@type": "DefinedTermSet", "@id": setId(), name: setName(), url: k.abs("/glossary/") },
      ...(ep ? { subjectOf: { "@type": "PodcastEpisode", url: k.abs(`/podcasts/${k.urlSlug(ep.slug)}`), name: ep.title } } : {}) },
    k.crumbs([[t("nav.home"), "/"], [t("glossary.title"), "/glossary/"], [cat.name, `/glossary/#${cat.key}`], [x.term, `/glossary/${x.slug}`]]));
    const og = config.glossary.itemOg || config.glossary.og;
    return html(k.page({ title: k.itemTitle("glossary", t("glossary.whatIs", { term: x.term })), description: x.short || "", path: `/glossary/${x.slug}`, body, active: "glossary", jsonld,
      og: { type: "article", title: x.en ? `${x.term} (${x.en})` : x.term, alt: x.term, ...(og?.image ? { image: og.image } : {}), ...(ep ? { audio: k.abs(`/podcasts/audio/${k.urlSlug(ep.slug)}.mp3`) } : {}) },
      head: `<link rel="alternate" type="text/markdown" title="Markdown" href="${H("/glossary/")}${esc(x.slug)}.md">`, scripts: ["podcast.js"] }));
  }

  const apiTerm = (g, x) => { const day = g.dayOf(x.slug); return { slug: x.slug, term: x.term, en: x.en || null, category: x.category, category_name: g.categoryName(x.category), short: x.short || "",
    url: k.abs(`/glossary/${x.slug}`), markdown: k.abs(`/glossary/${x.slug}.md`), episode_date: day == null ? null : isoOfDay(day) }; };

  async function handle(request, env, url) {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const p = url.pathname;
    const g = await k.c.glossary();
    if (!g) return null;
    if (p === "/taxonomy" || p === "/taxonomy/" || p === "/glossary") return redirect(H("/glossary/"));
    if (p === "/glossary/") return index(env);
    if (p === "/api/glossary") return jsonRes(await k.api("glossary", { ok: true, categories: g.categories.map((c) => ({ key: c.key, name: c.name, count: c.terms.length })), terms: g.terms.map((x) => apiTerm(g, x)) }, { url, env, glossary: g }));
    if (p === "/api/glossary/today") {
      const today = await k.c.termOfDay(k.today());
      if (!today) return jsonRes(await k.api("glossaryToday", { ok: true, term: null, number: null, episode: null }, { url, env, glossary: g }));
      const ep = await episodeOf(env, g, today.term.slug);
      return jsonRes(await k.api("glossaryToday", { ok: true, number: today.number, date: isoOfDay(k.today()), term: apiTerm(g, today.term),
        episode: ep ? { slug: k.urlSlug(ep.slug), title: ep.title, url: k.abs(`/podcasts/${k.urlSlug(ep.slug)}`), audio: k.abs(`/podcasts/audio/${k.urlSlug(ep.slug)}.mp3`), duration_ms: ep.duration_ms } : null },
        { url, env, glossary: g, term: today.term, episode: ep }), 200, { "cache-control": "public, max-age=300" });
    }
    let m = p.match(/^\/glossary\/([a-z0-9-]{1,90})\.md$/);
    if (m) { const x = g.bySlug.get(m[1]); return x ? text(termMd(k, g, x), "text/markdown", 3600, { "x-robots-tag": "noindex" }) : k.notFound(); }
    m = p.match(/^\/glossary\/([a-z0-9-]{1,90})\/?$/);
    if (m) return (await termPage(env, m[1])) || k.notFound();
    return null;
  }
  return { handle };
}
