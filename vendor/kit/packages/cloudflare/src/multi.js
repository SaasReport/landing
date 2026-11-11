/**
 * A multi-locale site (site.locales in kit.config.js): one runtime per locale behind a router.
 *
 *   /…          the default locale (site.locales[0])            /ar/…   the "ar" runtime, which sees the path without "/ar"
 *   /sitemap.xml   every locale's pages, with hreflang alternates (x-default = the default locale)
 *   /llms.txt, /llms-full.txt   one file listing every locale        /robots.txt, /api/status, …   the default runtime
 *   /blog/ar/<slug>, /podcasts/ar/<slug>, /events/ar/<slug>   → 301 to /ar/blog/<slug>, … (links built from stored slugs,
 *                                                                 e.g. by @saasreport/channels announcements)
 *
 * Each runtime is an ordinary single-locale kit built from configFor(config, locale) and contentFor(config, content,
 * locale); `options` may carry localized values too ({ en: …, ar: … }). The daily cron publishes every locale, then
 * announces once; one PodcastWorkflow class serves every locale (the payload names it).
 */
import { configFor, contentFor, localesOf, localize, localeBase, llmsTxtLocales, sitemap as coreSitemap } from "@saasreport/core";
import { redirect, text } from "./util.js";
import { CATCHUP } from "./scheduled.js";

export function buildMultiKit(root, content, options, buildLocaleKit) {
  const locales = localesOf(root), def = root.site.defaultLocale;
  const { deps = {}, ...rest } = options;
  const kits = {};
  for (const l of locales) {
    const base = localeBase(l, def);
    const local = localize(rest, l, locales, def);
    kits[l] = buildLocaleKit(configFor(root, l), contentFor(root, content, l), {
      ...local, deps, locale: { key: l, base, prefix: base ? `${base.slice(1)}/` : "", db: base ? l : "", multi: true },
    });
  }
  const D = kits[def];
  const others = locales.filter((l) => l !== def).map((l) => ({ l, base: localeBase(l, def) }));

  /** One sitemap: every locale's URLs; a path present in two or more locales lists all of them as hreflang alternates. */
  async function sitemap(env) {
    const per = await Promise.all(locales.map(async (l) => ({ l, base: localeBase(l, def), urls: await kits[l].discovery.sitemapUrls(env) })));
    const has = new Map();
    for (const p of per) for (const x of p.urls) { if (!has.has(x.loc)) has.set(x.loc, new Set()); has.get(x.loc).add(p.l); }
    const urls = per.flatMap((p) => p.urls.map((x) => {
      const set = has.get(x.loc);
      const alternates = set.size > 1 ? [...locales.filter((l) => set.has(l)).map((l) => ({ hreflang: l, href: `${localeBase(l, def)}${x.loc}` })),
        ...(set.has(def) ? [{ hreflang: "x-default", href: x.loc }] : [])] : undefined;
      return { ...x, loc: `${p.base}${x.loc}`, ...(alternates ? { alternates } : {}) };
    }));
    return new Response(coreSitemap(urls, { base: root.site.root || root.site.url }), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }

  /** llms.txt / llms-full.txt listing every locale (options.llms.build on the default locale replaces it, as on a single-locale site). */
  async function llms(env, full) {
    if (typeof D.config.llms.build === "function") return D.fetch(new Request(`${root.site.url}/${full ? "llms-full" : "llms"}.txt`), env);
    const parts = await Promise.all(locales.map((l) => kits[l].discovery.llms(env, full)));
    // The static pages' Markdown twins (one md-twins.json for the whole site) are listed once, with the default locale.
    const pages = await D.twins.list(env);
    if (pages.length && parts[0]) {
      parts[0].sections.push({ title: D.config.llms.pagesTitle || "Pages (Markdown)", links: pages.map((x) => ({ title: x.title, url: x.md, description: x.description })) });
      if (full) parts[0].docs = [...(await D.discovery.twinDocs(env, pages)), ...(parts[0].docs || [])];
    }
    const optional = { title: "Optional", links: [{ title: "Full text", url: "/llms-full.txt" }, ...(D.config.features.sitemap ? [{ title: "Sitemap", url: "/sitemap.xml" }] : [])] };
    const body = llmsTxtLocales(root, parts, { intro: parts[0]?.intro || "", full })
      + (full ? "" : `## ${optional.title}\n${optional.links.map((x) => `- [${x.title}](${root.site.url}${x.url})`).join("\n")}\n`);
    return text(body, "text/markdown", 3600, { "x-robots-tag": "noindex" });
  }

  async function fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (!(D.config.site.host && url.host === `www.${D.config.site.host}`)) {
      if (p === "/sitemap.xml" && D.config.features.sitemap) return sitemap(env);
      if ((p === "/llms.txt" || p === "/llms-full.txt") && D.config.features.llms) return llms(env, p === "/llms-full.txt");
      const m = p.match(/^\/(blog|podcasts|events)\/([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\/([a-z0-9-]{1,90})(\/?|\.md)$/);
      const hit = m && others.find((o) => o.base === `/${m[2]}`);
      if (hit) return redirect(`${hit.base}/${m[1]}/${m[3]}${m[4]}${url.search}`);
      for (const o of others) {
        if (p !== o.base && !p.startsWith(`${o.base}/`)) continue;
        const inner = new URL(url);
        inner.pathname = p.slice(o.base.length) || "/";
        // Static files (the landing at /ar/, …) are still served at the requested path. A locale's Markdown server asks its assets for exactly
        // two paths, both relative to the locale: the request's own path, which goes out as the original request, and the /x.md -> /x/index.md
        // alias, which is looked up under the locale's prefix. The two are matched exactly, never by guessing whether a path "already"
        // carries the prefix (a page named like its locale, /ar/ar.md, would be misread). Any other request passes through as asked.
        const aliasPath = inner.pathname.endsWith(".md") && !inner.pathname.endsWith("/index.md") ? `${inner.pathname.slice(0, -3)}/index.md` : null;
        const toLocale = (r) => {
          const src = r instanceof Request ? r : new Request(r);
          const u = new URL(src.url);
          if (u.pathname === inner.pathname && u.search === inner.search) return request;
          if (aliasPath !== null && u.pathname === aliasPath) { u.pathname = `${o.base}${u.pathname}`; return new Request(u.toString(), src); }
          return src;
        };
        const env2 = env.ASSETS?.fetch ? { ...env, ASSETS: { fetch: (r) => env.ASSETS.fetch(toLocale(r)) } } : env;
        return kits[o.l].fetch(new Request(inner.toString(), request), env2, ctx);
      }
    }
    return D.fetch(request, env, ctx);
  }

  /** The daily run of every locale (default locale first), then one round of channel announcements. */
  async function runDaily(env, opts = {}) {
    const { day = D.context.today(), scheduledAt = null, origin = "cron" } = opts;
    if (opts.missedDate != null || opts.only != null || origin === "catchup") throw new Error('runDaily: origin "catchup", missedDate and only belong to the catch-up window the run itself makes, never asked for');
    const reports = {};
    for (const l of locales) reports[l] = await kits[l].runDaily(env, { day, announce: false, scheduledAt, origin, catchup: false });
    const report = { day, locales: reports, posts: [], episodes: [], skipped: [], errors: [], channels: null };
    for (const r of Object.values(reports)) { report.posts.push(...r.posts); report.episodes.push(...r.episodes); report.skipped.push(...r.skipped); report.errors.push(...r.errors); }
    if (deps.announcePending) {
      try { report.channels = await deps.announcePending(env, D.context.rawConfig, { when: (row) => D.context.fmtWhen(row.starts_at) }); }
      catch (err) { const e = { step: "channels", error: String(err?.message || err).slice(0, 300) }; report.errors.push(e); console.error("[kit] daily error", JSON.stringify({ day, ...e })); }   // each locale's run logs its own
    }
    // each locale fills its own gaps (origin catchup), after today's run: the same entry point for the cron and an admin run
    if (opts.catchup !== false) { report.catchup = {}; for (const l of locales) report.catchup[l] = await kits[l][CATCHUP](env, { today: day, scheduledAt }); }
    return report;
  }
  function scheduled(event, env, ctx) {
    const when = event?.scheduledTime ? new Date(event.scheduledTime) : D.context.now();
    const p = runDaily(env, { day: D.context.dayOf(when), scheduledAt: when });
    ctx?.waitUntil?.(p.catch((e) => console.error("[kit] daily failed", String(e?.stack || e))));
    return p;
  }

  let PodcastWorkflow;
  if (deps.createPodcastWorkflow && D.context.workflowOptions) {
    PodcastWorkflow = deps.createPodcastWorkflow({ ...D.context.workflowOptions, locales: Object.fromEntries(locales.map((l) => [l, kits[l].context.workflowOptions])) });
  }

  return { fetch, scheduled, runDaily, PodcastWorkflow, config: D.config, handlers: D.handlers, context: D.context, discovery: D.discovery, twins: D.twins, meta: D.meta, calendarFeeds: D.calendarFeeds, locales: kits, sitemap, llms };
}
