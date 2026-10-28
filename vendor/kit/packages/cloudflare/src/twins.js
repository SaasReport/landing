/**
 * Markdown twins of the static pages (@saasreport/site buildSite writes <path>/index.md next to every indexable page and lists
 * them in /md-twins.json, schema kit.md-twins.v1). The Worker:
 *   - serves a twin from the static assets with `content-type: text/markdown; charset=utf-8`, a canonical Link header to
 *     its HTML page and `x-robots-tag: noindex` (the HTML page is the one to index);
 *   - answers /<path>.md with /<path>/index.md (both spellings work; /index.md is the landing's twin);
 *   - checks /<path>/index.md against the static twins before the feature routes, so /blog/index.md, /glossary/index.md
 *     and /podcasts/index.md (static section pages) are served even though those routes own the prefix;
 *   - lists the twins in llms.txt and puts their Markdown into llms-full.txt (discovery.js, multi.js).
 * Opt-out: `llms.pages: false` in the Worker options keeps the twins out of llms.txt; `markdown: false` in site.config.js
 * stops the build from writing them.
 */
export const TWINS_PATH = "/md-twins.json";
export const TWINS_SCHEMA = "kit.md-twins.v1";
const TTL_MS = 60_000;

const mdHeaders = (res, htmlUrl) => {
  const out = new Response(res.body, res);
  out.headers.set("content-type", "text/markdown; charset=utf-8");
  out.headers.set("x-robots-tag", "noindex");
  out.headers.set("access-control-allow-origin", "*");
  if (htmlUrl) out.headers.set("link", `<${htmlUrl}>; rel="canonical"`);
  return out;
};

/** The HTML page a twin path belongs to: "/terminal/index.md" → "/terminal/", "/index.md" → "/". */
export const pageOfTwin = (path) => path.replace(/index\.md$/, "").replace(/\.md$/, "/");

export function createTwins(k) {
  const { config } = k;
  let cache = null;

  /** The twins listed in md-twins.json ([] when the build wrote none, the assets are missing or llms.pages is false). */
  async function list(env = {}) {
    if (config.llms?.pages === false || !env.ASSETS?.fetch) return [];
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) return cache.pages;
    let pages = [];
    try {
      const r = await env.ASSETS.fetch(new Request(`${config.site.url}${TWINS_PATH}`));
      if (r.ok) {
        const j = await r.json();
        if (j?.schema === TWINS_SCHEMA && Array.isArray(j.pages)) pages = j.pages.filter((p) => p && typeof p.md === "string" && typeof p.title === "string");
      }
    } catch { /* no manifest: no twins */ }
    cache = { at: now, pages };
    return pages;
  }

  /** One twin's Markdown, read from the static assets (null when it is missing). */
  async function markdown(env, twin) {
    if (!env.ASSETS?.fetch) return null;
    try {
      const r = await env.ASSETS.fetch(new Request(`${config.site.url}${new URL(twin.md, config.site.url).pathname}`));
      return r.ok ? await r.text() : null;
    } catch (e) { console.error(`twins: ${twin.md} could not be read`, e); return null; }
  }

  /** A GET/HEAD of a *.md path the router did not own: the twin, or its /<path>/index.md spelling; null otherwise. */
  async function serve(request, env, url) {
    if (!env.ASSETS?.fetch || !url.pathname.endsWith(".md") || !["GET", "HEAD"].includes(request.method)) return null;
    const p = url.pathname;
    let res = await env.ASSETS.fetch(request);
    let path = p;
    if (res.status === 404 && !p.endsWith("/index.md")) {
      const alias = new URL(url);
      alias.pathname = `${p.slice(0, -3)}/index.md`;
      const r2 = await env.ASSETS.fetch(new Request(alias.toString(), request));
      if (r2.ok || r2.status === 304) { res = r2; path = alias.pathname; }
    }
    if (!(res.ok || res.status === 304)) return res;
    return mdHeaders(res, k.abs(pageOfTwin(path)));
  }

  return { list, markdown, serve, reset: () => { cache = null; } };
}
