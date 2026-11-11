/**
 * Citations and official sources for review-gated series. The shape, per content item:
 *   sources:   [{ title, url (https), archived? }]
 *   citations: [{ source (index into sources), page? (PDF page), node? (a document-tree node id or title),
 *                 quote (an exact passage of the source, at least 20 characters), verified: { sha256, at: "YYYY-MM-DD" } }]
 * An item is **officially cited** when every source is published on an official domain and every source is backed by at
 * least one verified citation. Which domains are official is project config (`sources.official` in kit.config.js, or
 * `officialDomains` here): nothing is hardcoded in the kit.
 */

/** The original URL behind a Wayback link (web.archive.org/web/<timestamp>[id_]/<url>), else the URL itself. */
export const originalUrl = (u) => {
  const m = /^https:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(.+)$/.exec(u || "");
  return m ? (/^https?:\/\//.test(m[1]) ? m[1] : `https://${m[1]}`) : u;
};

/** Is `u` (or the page a Wayback link archives) on one of `domains` (a domain or any of its subdomains; "www." ignored)? */
export function hasOfficialHost(u, domains = []) {
  try {
    const host = new URL(originalUrl(u)).hostname.replace(/^www\./, "");
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch { return false; /* not a URL: it is not on any of the domains */ }
}

/** Problems with an item's citations ([] when fine or absent). */
export function checkCitations(x) {
  if (x.citations == null) return [];
  const at = x.date || "?", n = x.sources?.length || 0, p = [];
  if (!Array.isArray(x.citations)) return [`${at}: citations must be an array`];
  x.citations.forEach((c, i) => {
    if (!Number.isInteger(c?.source) || c.source < 0 || c.source >= n) p.push(`${at}: citation ${i + 1} source must index sources`);
    if (typeof c?.quote !== "string" || c.quote.trim().length < 20) p.push(`${at}: citation ${i + 1} needs a quote of at least 20 chars`);
    if (c?.page != null && !(Number.isInteger(c.page) && c.page > 0)) p.push(`${at}: citation ${i + 1} page must be a positive integer`);
    if (!/^[0-9a-f]{64}$/.test(c?.verified?.sha256 || "") || !/^\d{4}-\d{2}-\d{2}$/.test(c?.verified?.at || "")) p.push(`${at}: citation ${i + 1} needs verified { sha256, at }`);
  });
  return p;
}

/** Official sources only (on `domains`), each cited by at least one verified citation. */
export function officiallyCited(x, domains = []) {
  const src = x.sources || [], cit = Array.isArray(x.citations) ? x.citations : [];
  if (!src.length || !src.every((s) => hasOfficialHost(s.url, domains)) || checkCitations(x).length) return false;
  return src.every((_, i) => cit.some((c) => c.source === i));
}

/** The official domains of a config (`sources.official`), or [] . */
export const officialDomains = (config) => (Array.isArray(config?.sources?.official) ? config.sources.official : []);

/**
 * Citation helpers bound to a list of official domains (or a config with `sources.official`):
 *   const { hasOfficialHost, officiallyCited } = citations({ officialDomains: ["regulator.example"] });
 */
export function citations(opts = {}) {
  const domains = Array.isArray(opts) ? opts : opts.officialDomains ?? officialDomains(opts.config ?? opts);
  return {
    OFFICIAL_DOMAINS: domains, originalUrl, checkCitations,
    hasOfficialHost: (u) => hasOfficialHost(u, domains),
    officiallyCited: (x) => officiallyCited(x, domains),
  };
}
