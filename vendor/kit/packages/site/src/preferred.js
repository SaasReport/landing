/**
 * "Add to Google preferred sources": a small card with one button that opens Google's preferred-sources page for the
 * site's domain (https://google.com/preferences/source?q=<domain>), so a reader can ask Google to show the site first
 * in Top Stories. Config-driven: project.preferredSource (site.config.js, schema PREFERRED_SOURCE_SCHEMA) names the
 * domain (default: the host of project.url), where the card goes and its words per locale. No Node APIs: the static
 * pages (src/page.js, src/pages.js) and the Worker's pages (@saasreport/cloudflare shell) render the same card.
 *
 *   preferredSource: {
 *     domain: "example.org",                      // optional; the host of project.url (or the Worker's site.url)
 *     placements: ["footer", "blog", "podcasts"],   // footer: every page's footer; blog, podcasts: their index pages
 *     strings: { en: { title: "Add {name} to your Google preferred sources", text: "…", button: "Add to Google" } },
 *   }
 */
export const PREFERRED_SOURCE_URL = "https://google.com/preferences/source?q=";
export const PREFERRED_PLACEMENTS = ["footer", "blog", "podcasts", "events", "glossary"];

const STRINGS = {
  type: "object", required: ["title", "text", "button"], additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, description: "The card's heading; {name} is the site's name." },
    text: { type: "string", minLength: 1, description: "One sentence on what the reader gets; {name} and {domain} are filled." },
    button: { type: "string", minLength: 1, description: "The button's label." },
  },
};

/** JSON Schema 2020-12 of project.preferredSource (site config) and options.preferredSource (Worker). */
export const PREFERRED_SOURCE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", required: ["placements", "strings"], additionalProperties: false,
  properties: {
    domain: { type: "string", pattern: "^(?!https?:)(?!www\\.)[a-z0-9-]+(\\.[a-z0-9-]+)+$", description: "The domain Google lists as the source (no scheme, no www.); default: the host of the site's url." },
    placements: { type: "array", minItems: 1, uniqueItems: true, items: { enum: PREFERRED_PLACEMENTS } },
    strings: { type: "object", minProperties: 1, propertyNames: { pattern: "^[a-z]{2}(-[A-Za-z0-9]+)*$" }, additionalProperties: STRINGS },
  },
};

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STAR = '<svg class="kpref__star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';

/** The domain of a site: config.domain, else the host of its url without "www.". */
export const preferredDomain = (cfg, url) => cfg?.domain || (url ? new URL(url).host.replace(/^www\./, "") : "");

/** Google's preferred-sources link for a domain. */
export const preferredHref = (domain) => `${PREFERRED_SOURCE_URL}${encodeURIComponent(domain)}`;

/**
 * The card for one placement and locale, or "" when the placement is not configured (or the locale has no words).
 * `digits` turns Latin digits into the locale's own (Persian digits on a Persian site).
 */
export function preferredSourceCard(cfg, { placement, code, name, url, digits = (s) => s, id = `kpref-${placement}` }) {
  if (!cfg || !(cfg.placements || []).includes(placement)) return "";
  const s = cfg.strings?.[code] ?? cfg.strings?.[String(code || "").split("-")[0]];
  if (!s) return "";
  const domain = preferredDomain(cfg, url);
  const fill = (v) => digits(String(v).replace(/\{name\}/g, name).replace(/\{domain\}/g, domain));
  return `<aside class="kpref kpref--${esc(placement)}" aria-labelledby="${esc(id)}"><span class="kpref__ico">${STAR}</span><div class="kpref__body"><h2 class="kpref__title" id="${esc(id)}">${esc(fill(s.title))}</h2><p class="kpref__text">${esc(fill(s.text))}</p></div><a class="btn btn--primary kpref__btn" href="${esc(preferredHref(domain))}" target="_blank" rel="noopener">${STAR}<span>${esc(fill(s.button))}</span></a></aside>`;
}

/** Problems with a preferredSource config: placements and the locales that must have words. */
export function checkPreferredSource(cfg, codes = []) {
  if (cfg == null) return [];
  const p = [];
  for (const c of codes) if (!cfg.strings?.[c]) p.push(`preferredSource.strings.${c}: missing (every locale of the site needs the card's words)`);
  return p;
}

/** The card's styles (theme variables, falling back to the Worker theme's), appended to styles.css and kit pages. */
export const PREFERRED_CSS = `.kpref{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px 16px;align-items:center;margin:28px 0 0;padding:20px;border:1px solid var(--line);border-radius:var(--r-card,var(--radius,14px));background:var(--surface);color:var(--text,var(--ink))}
.kpref__ico{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:color-mix(in srgb,var(--c-muted) 12%,transparent)}
.kpref__ico .kpref__star{width:26px;height:26px;fill:var(--accent-text,var(--accent))}
.kpref__title{margin:0 0 4px;font-size:18px;line-height:1.35}
.kpref__text{margin:0;color:var(--muted);font-size:15px;line-height:1.6}
.kpref__btn{grid-column:1/-1;justify-self:start;display:inline-flex;align-items:center;gap:8px;min-height:44px}
.kpref__btn .kpref__star{width:18px;height:18px;fill:currentColor}
.footer .kpref{margin:0 0 8px}
@media (max-width:640px){.kpref{grid-template-columns:minmax(0,1fr);justify-items:center;text-align:center}.kpref__btn{justify-self:stretch;justify-content:center}}`;
