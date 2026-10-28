/**
 * The one HTML shell every server-rendered page uses: head (meta, OG, Twitter, canonical, JSON-LD),
 * brand tokens from config.brand as CSS custom properties, nav from enabled features, footer.
 */
import { shellMarkup, SHELL_CSS } from "../../site/src/shell-markup.js";
import { preferredSourceCard, PREFERRED_CSS } from "../../site/src/preferred.js";
import { hreflangs } from "@saasreport/core";
import { esc, cssValue, kebab } from "./util.js";

export const VERSION = "0.1.0";

const ICON = {
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  rss: '<path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.3"/>',
  down: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.9 15.8 6.6M8.2 13.1l7.6 4.3"/>',
};
export const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[n] || ""}</svg>`;

/** Brand colors and fonts → `@font-face{…}:root{--accent:…;--font-body:…}` (brand.fonts.faces: self-hosted font files). */
export function brandCss(brand = {}) {
  const decl = [];
  for (const [k, v] of Object.entries(brand.colors || {})) if (v) decl.push(`--c-${kebab(k)}:${cssValue(v)}`);
  for (const [k, v] of Object.entries(brand.fonts || {})) if (v && k !== "href" && typeof v === "string") decl.push(`--font-${kebab(k)}:${cssValue(v)}`);
  if (brand.radius) decl.push(`--radius:${cssValue(brand.radius)}`);
  const faces = (Array.isArray(brand.fonts?.faces) ? brand.fonts.faces : []).map((f) =>
    `@font-face{font-family:"${cssValue(f.family).replace(/'/g, "")}";src:url("${String(f.src || "").replace(/["\\()\s]/g, "")}")${f.format ? ` format("${cssValue(f.format).replace(/'/g, "")}")` : ""};font-weight:${Number(f.weight) || 400};font-style:${f.style === "italic" ? "italic" : "normal"};font-display:swap}`).join("");
  return faces + (decl.length ? `:root{${decl.join(";")}}` : "");
}

/** Keys the browser scripts need (reactions, player, glossary filter). */
const CLIENT_KEYS = ["rx.like", "rx.noRatings", "rx.ratings", "rx.copied", "rx.copyFailed", "rx.error", "rx.rateLimited", "rx.rated", "rx.rateN",
  "podcasts.play", "podcasts.pause", "podcasts.playFailed", "glossary.none", "events.rsvpDone", "rx.native",
  "form.reference", "form.failed", "form.failedTitle", "form.error.consent_required", "form.error.missing_field", "form.error.invalid_email",
  "form.error.rate_limited", "form.error.event_unavailable"];

export function createShell(k) {
  const { config, t } = k;
  const site = config.site;
  const H = k.href;
  const asset = (name) => `${config.assets.base}/${name}?v=${VERSION}`;
  const locales = Array.isArray(site.locales) && site.locales.length > 1 ? site.locales : null;
  /** A multi-locale site: section index pages exist in every locale (hreflang alternates, switcher to the same page). */
  const SECTIONS = ["/", "/blog/", "/podcasts/", "/glossary/", "/events/"];
  const langName = (l) => { try { return new Intl.DisplayNames([l], { type: "language" }).of(l) || l; } catch { return l; /* this ICU has no display names: the tag itself is shown */ } };
  const alternates = (path) => (locales && SECTIONS.includes(path) ? hreflangs(k.rawConfig, path).map((a) => `<link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.href)}">`).join("") : "");
  const switcher = (path) => (locales ? `<nav class="kbar__langs" aria-label="${esc(t("nav.languages"))}">${locales.filter((l) => l !== site.localeKey)
    .map((l) => `<a href="${esc(`${l === site.defaultLocale ? "" : `/${l.toLowerCase()}`}${SECTIONS.includes(path) ? path : "/"}`)}" hreflang="${esc(l)}" lang="${esc(l)}">${esc(langName(l))}</a>`).join("")}</nav>` : "");
  const clientStrings = JSON.stringify({ lang: site.lang, ...Object.fromEntries(CLIENT_KEYS.map((key) => [key, t(key)])) }).replace(/</g, "\\u003c");

  const navItems = () => {
    const f = config.features, items = [];
    if (f.blog) items.push([H("/blog/"), t("nav.blog"), "blog"]);
    if (f.podcasts && Object.keys(config.shows).length) items.push([H("/podcasts/"), t("nav.podcasts"), "podcasts"]);
    if (f.glossary && config.series.some((s) => s.glossary)) items.push([H("/glossary/"), t("nav.glossary"), "glossary"]);
    if (f.events) items.push([H("/events/"), t("nav.events"), "events"]);
    for (const n of config.nav) items.push([n.href, n.label, n.key || n.href]);
    return items;
  };

  /** og.image (absolute) with optional width/height/type (from the page or options.shell.og): og:image:secure_url/type/width/height. */
  function metaTags({ title, description, canonical, og = {} }) {
    const so = config.shell.og || {};
    const img = og.image ? k.abs(og.image) : so.image ? k.abs(so.image) : site.ogImage ? k.abs(site.ogImage) : null;
    const ogt = esc(og.title || title), alt = esc(og.alt || og.title || title);
    const width = og.width ?? so.width, height = og.height ?? so.height, type = og.imageType ?? so.type;
    const imgTags = img ? `<meta property="og:image" content="${esc(img)}">${so.secure || og.secure ? `<meta property="og:image:secure_url" content="${esc(img)}">` : ""}${type ? `<meta property="og:image:type" content="${esc(type)}">` : ""}${width ? `<meta property="og:image:width" content="${esc(width)}">` : ""}${height ? `<meta property="og:image:height" content="${esc(height)}">` : ""}<meta property="og:image:alt" content="${alt}">` : "";
    const tags = [
      `<meta property="og:type" content="${esc(og.type || "website")}"><meta property="og:locale" content="${esc(site.ogLocale)}"><meta property="og:site_name" content="${esc(site.name)}">`,
      `<meta property="og:title" content="${ogt}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">`,
      imgTags,
      `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${ogt}"><meta name="twitter:description" content="${esc(description)}">${img ? `<meta name="twitter:image" content="${esc(img)}"><meta name="twitter:image:alt" content="${alt}">` : ""}${site.twitter ? `<meta name="twitter:site" content="${esc(site.twitter)}">` : ""}`,
    ];
    if (og.published) tags.push(`<meta property="article:published_time" content="${esc(og.published)}">${og.modified ? `<meta property="article:modified_time" content="${esc(og.modified)}">` : ""}${og.section ? `<meta property="article:section" content="${esc(og.section)}">` : ""}${(og.tags || []).map((x) => `<meta property="article:tag" content="${esc(x)}">`).join("")}`);
    if (og.audio) tags.push(`<meta property="og:audio" content="${esc(og.audio)}"><meta property="og:audio:secure_url" content="${esc(og.audio)}"><meta property="og:audio:type" content="audio/mpeg">`);
    return tags.filter(Boolean).join("\n");
  }

  /** Footer links: options.footer.items ([[href, label]] or [{href, label}]) replaces the default (home, sections, footer.links). */
  const footerItems = () => {
    const items = config.footer.items;
    if (Array.isArray(items)) return items.map((x) => (Array.isArray(x) ? x : [x.href, x.label]));
    return [[H("/"), t("nav.home")], ...navItems().map(([h, l]) => [h, l]), ...(config.footer.links || []).map((x) => [x.href, x.label])];
  };
  /** Footer note: options.footer.note (trusted HTML template: {year}, {localYear}, {name}, {rights}) or "© {year} {name}. {rights}". */
  const footerNote = () => {
    const now = k.now(), year = k.d(now.getUTCFullYear());
    const localYear = k.fmtPart(now.toISOString(), { year: "numeric" });
    const vars = { year, localYear, name: esc(site.org.name || site.name), rights: esc(t("footer.rights")) };
    const tpl = config.footer.note;
    return tpl ? String(tpl).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m)) : `© ${vars.year} ${vars.name}. ${vars.rights}`;
  };

  /**
   * @param {{title: string, description?: string, path: string, body: string, active?: string, jsonld?: object,
   *   head?: string, scripts?: string[], og?: object, robots?: string}} p
   */
  function page({ title, description = site.description, path, body, active, jsonld, head = "", scripts = [], og = {}, robots = config.shell.robots, after = "", placement }) {
    const canonical = k.abs(path);
    const sh = config.shell;
    const brand = brandCss(config.brand);
    const theme = config.brand.colors?.accent ? `<meta name="theme-color" content="${esc(cssValue(config.brand.colors.accent))}">` : "";
    const feeds = [config.features.blog ? `<link rel="alternate" type="application/rss+xml" title="${esc(config.blog.name || `${t("blog.title")} · ${site.name}`)}" href="${H("/blog/feed.xml")}">` : "", alternates(path)].join("");
    const L = sh.logo || (site.logo ? { src: site.logo } : null);
    const logo = L ? `<img class="kbar__logo" src="${esc(L.src)}" alt="${esc(L.alt || site.name)}"${L.width ? ` width="${esc(L.width)}"` : ""}${L.height ? ` height="${esc(L.height)}"` : ""}>` : `<span class="kbar__name">${esc(site.name)}</span>`;
    const fontLink = sh.fonts !== false && config.brand.fonts?.href ? `<link rel="stylesheet" href="${esc(config.brand.fonts.href)}">` : "";
    const extraCss = (sh.stylesheets || []).map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join("");
    const extraJs = (sh.scripts || []).map((h) => `<script src="${esc(h)}" defer></script>`).join("");
    // the site shell (menu drawer + global search over the static site's /search-index.json, @saasreport/site), the
    // same as on the static pages; shell: { search: false } turns it off for a Worker without a static site
    // the header's call to action (shell.cta, the landing's: [{ label, href | modal, style? }]); a modal opens on the
    // home page (/#<modal>), as on the static inner pages. Phones get it at the top of the drawer.
    const cta = (sh.cta || []).map((a) => `<a class="btn btn--${esc(a.style || "primary")} btn--sm${a.class ? ` ${esc(a.class)}` : ""}" href="${esc(a.href ? (a.href.startsWith("#") ? `${H("/")}${a.href}` : a.href) : `${H("/")}#${a.modal}`)}">${esc(a.label)}</a>`).join("");
    // "Add to Google preferred sources" (shell.preferredSource, the site config's preferredSource): on the index page
    // of a placement (blog, podcasts, …) at the end of the page, and in the footer of every page
    const pref = (where) => preferredSourceCard(sh.preferredSource, { placement: where, code: site.localeBase || site.locale, name: site.name, url: site.url, digits: (v) => String(v).replace(/[0-9]+/g, (n) => k.d(n)) });
    const prefPage = placement ? pref(placement) : "", prefFoot = pref("footer");
    const shell = sh.search === false ? {} : shellMarkup({ menu: sh.menu || [], t: (k) => t.opt(k) || k, home: H("/"), script: sh.shellScript || "/shell.js", cta, links: navItems().map(([href, label]) => ({ href, label: esc(label) })) });
    return `<!doctype html>
<html lang="${esc(site.localeBase)}" dir="${esc(site.dir)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">${theme}
<link rel="canonical" href="${esc(canonical)}"><meta name="robots" content="${esc(robots)}">
${metaTags({ title, description, canonical, og })}
${site.favicon ? `<link rel="icon" href="${esc(site.favicon)}">` : ""}${sh.head || ""}${feeds}
${fontLink}<link rel="stylesheet" href="${asset("kit.css")}">${extraCss}${brand ? `<style>${brand}</style>` : ""}${shell.panels ? `<style>${SHELL_CSS}</style>` : ""}${prefPage || prefFoot ? `<style>${PREFERRED_CSS}</style>` : ""}${head}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body class="kit">
<a class="skip" href="#main">${esc(t("skip"))}</a>
<header class="kbar${shell.buttons ? " kbar--shell" : ""}"><div class="wrap kbar__in">
  <a class="kbar__brand" href="${H("/")}">${logo}</a>
  <nav class="kbar__nav" aria-label="${esc(t("nav.label"))}">${navItems().map(([h, l, key]) => `<a href="${esc(h)}"${key === active ? ' aria-current="page"' : ""}>${esc(l)}</a>`).join("")}</nav>${switcher(path)}${shell.buttons ? `<div class="nav__cta">${cta}<span class="kshell__btns">${shell.buttons}</span></div>` : ""}
</div></header>${shell.panels || ""}
<main id="main">${body}${prefPage ? `\n<div class="wrap">${prefPage}</div>` : ""}${after ? `\n${after}` : ""}</main>
<footer class="kfoot"><div class="wrap kfoot__in">${prefFoot}
  <nav class="kfoot__links">${footerItems().map(([h, l]) => `<a href="${esc(h)}">${esc(l)}</a>`).join("")}${config.features.blog ? `<a href="${H("/blog/feed.xml")}">${icon("rss")}${esc(t("rss"))}</a>` : ""}</nav>
  <p>${footerNote()}</p>
</div></footer>
<div class="toast" role="status" aria-live="polite" hidden></div>
<script type="application/json" id="kit-strings">${clientStrings}</script>
<script src="${asset("format.js")}" defer></script><script src="${asset("kit.js")}" defer></script>${scripts.map((s) => `<script src="${asset(s)}" defer></script>`).join("")}${extraJs}
</body></html>`;
  }

  /**
   * The hero of a section page. Strings (all optional but the title): `<sec>.eyebrow`, `<sec>.heading` (default `<sec>.title`),
   * the lead (argument, or `<sec>.leadHtml`: trusted HTML from the config), `<sec>.note`.
   */
  function hero(sec, { lead = "", actions = "", vars } = {}) {
    const eyebrow = t.opt(`${sec}.eyebrow`, vars), heading = t.opt(`${sec}.heading`, vars) || t(`${sec}.title`, vars), note = t.opt(`${sec}.note`, vars);
    const leadHtml = t.opt(`${sec}.leadHtml`, vars);
    return `<section class="hero wrap">${eyebrow ? `<p class="eyebrow"><span class="dot"></span>${esc(eyebrow)}</p>` : ""}<h1>${esc(heading)}</h1>${leadHtml || lead ? `<p>${leadHtml || esc(lead)}</p>` : ""}${note ? `<p class="note">${esc(note)}</p>` : ""}${actions ? `\n  <div class="hero__act">${actions}</div>` : ""}</section>`;
  }
  /** Page title of a section index (`<sec>.pageTitle`, else "page.title") and of an item (`<sec>.itemTitle`, else "page.item"). */
  const pageTitle = (sec, title, vars = {}) => t(t.has(`${sec}.pageTitle`) ? `${sec}.pageTitle` : "page.title", { title, site: site.name, ...vars });
  const itemTitle = (sec, title, vars = {}) => t(t.has(`${sec}.itemTitle`) ? `${sec}.itemTitle` : "page.item", { title, site: site.name, ...vars });

  /**
   * A sign-up box (options.subscribe: { form, title, note, button, consent, privacyUrl, [variant]: { title, note } }) posting to
   * /api/forms/<form> (kit.js). The endpoint is the project's (e.g. a newsletter list); empty when not configured.
   */
  function subscribeBox(variant) {
    const S = config.subscribe;
    if (!S?.form) return "";
    const v = { ...S, ...(variant && S[variant] ? S[variant] : {}) };
    const consent = v.privacyUrl ? t("subscribe.consentLink", { link: `<a href="${esc(v.privacyUrl)}">${esc(t("subscribe.privacy"))}</a>` }) : esc(t("form.consent"));
    return `<section class="wrap"><section class="csub" aria-labelledby="csub-${esc(S.form)}"><div class="csub__copy"><h2 id="csub-${esc(S.form)}">${esc(v.title || t("subscribe.title"))}</h2>${v.note || t("subscribe.note") ? `<p>${esc(v.note || t("subscribe.note"))}</p>` : ""}</div>
<form class="form form--row" data-form="${esc(S.form)}" data-done="${esc(v.done || t("subscribe.done"))}" novalidate>
  <label><span>${esc(t("form.name"))}</span><input name="name" required maxlength="120" autocomplete="name"></label>
  <label><span>${esc(t("form.email"))}</span><input name="email" type="email" required maxlength="200" autocomplete="email" dir="ltr"></label>
  <input name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
  <label class="form__ok"><input type="checkbox" name="consent" required><span>${consent}</span></label>
  <button class="btn btn--primary" type="submit">${esc(v.button || t("subscribe.button"))}</button>
</form></section></section>`;
  }

  return { page, metaTags, asset, navItems, subscribeBox, hero, pageTitle, itemTitle };
}
