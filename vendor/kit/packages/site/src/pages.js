/**
 * Inner pages: the terminal, the lab, the academy, partners, status, status board and brand pages (templates in
 * packages/site/pages/*.html) and the sectors, directory, legal notices, content, reference and apps pages (generators
 * in src/generators/). Every page is
 * rendered once per locale: the default locale at its path (/terminal/), the others under their prefix
 * (/ar/terminal/), with hreflang alternates, a language switch in the bar and that locale's scripts and styles.
 *
 * A page in the site config:  { type: "terminal", path: "/terminal/", content: { en: {…}, ar: {…} } }
 * Page templates see the script-template context (name, url, root, locale, t, color, …) plus:
 *   c.*                 this page's content (this locale)
 *   page.url, page.path, page.ogImage, page.ld (JSON-LD block), page.alternates, page.ogAlternates
 *   chrome.bar, chrome.footer, chrome.icons, chrome.preload   the shared inner-page chrome
 *   a.<stem>.<ext>      a local asset URL for this locale, with ?v=<hash> (a.terminal.js, a.lab-data.js)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./template.js";
import { fill } from "./locale.js";
import { ICONS } from "./icons.js";
import { renderSectors, SECTORS_SCRIPT } from "./generators/sectors.js";
import { renderDirectory, DIRECTORY_SCRIPT } from "./generators/directory.js";
import { renderContent } from "./generators/content.js";
import { renderReference } from "./generators/reference.js";
import { renderApps, APPS_SCRIPT } from "./generators/apps.js";
import { renderNotices } from "./generators/notices.js";
import { renderWidgetsPage } from "./generators/widgets.js";
import { renderWorkbenchPage } from "./generators/workbench.js";
import { shellMarkup } from "./shell-markup.js";
import { button } from "./html.js";
import { preferredSourceCard } from "./preferred.js";

export const PAGE_DIR = fileURLToPath(new URL("../pages/", import.meta.url));
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Page types: a template (with the script it needs) or a generator. `scripts` are generated with the page. */
export const PAGE_TYPES = {
  terminal: { template: "terminal.html", scripts: ["notify.js", "terminal.js", "totop.js"] },
  lab: { template: "lab.html", scripts: ["notify.js", "lab-data.js", "lab.js", "totop.js"], prepare: prepareLab },
  academy: { template: "academy.html", scripts: ["notify.js", "academy.js", "totop.js"], script: "academy.js", prepare: prepareAcademy },
  partners: { template: "partners.html", scripts: ["notify.js", "partners.js", "totop.js"], script: "partners.js" },
  status: { template: "status.html", scripts: ["status.js", "totop.js"], script: "status.js" },
  brand: { template: "brand.html", scripts: ["notify.js", "brand-page.js", "totop.js"], script: "brand-page.js", prepare: prepareBrand, partials: {
    figure: '<figure class="bg__tile{{#if .wide}} bg__tile--wide{{/if}}"><div class="bg__stage{{#if .dark}} bg__stage--dark{{/if}}{{#if .stage}} {{.stage}}{{/if}}">{{.media}}</div><figcaption><b>{{.title}}</b><span>{{.text}}</span><a class="bg__dl" href="{{.download|attr}}" download>{{c.downloadLabel}}</a></figcaption></figure>',
  } },
  sectors: { render: renderSectors, scripts: ["notify.js", "terminal.js", "totop.js", "sectors.js"], script: SECTORS_SCRIPT },
  directory: { render: renderDirectory, scripts: ["notify.js", "directory.js", "totop.js"], script: DIRECTORY_SCRIPT },
  // Surfaces of a product site (generators in src/generators/; styles in theme/surfaces.css):
  // content pages from structured blocks (a tree of pages under one path, "/" allowed), a developer portal's API
  // reference from OpenAPI documents, auth-gated app shells (console, admin, billing) and a status board.
  content: { render: renderContent, scripts: ["totop.js"], allowRoot: true },
  reference: { render: renderReference, scripts: ["totop.js"] },
  apps: { render: renderApps, scripts: ["apps.js", "totop.js"], script: APPS_SCRIPT },
  statusboard: { template: "statusboard.html", scripts: ["statusboard.js", "totop.js"], script: "statusboard.js" },
  notices: { render: renderNotices, scripts: ["totop.js"] },
  // Every widget of the project, generated from its widgets.spec.json (@saasreport/widgets; kit widgets build).
  // The workbench (@saasreport/workbench): a command line and panes, each pane with a source badge; from widgets.spec.json (export `workbench`).
  workbench: { render: renderWorkbenchPage, scripts: ["workbench.js", "totop.js"], script: "workbench.js", css: ["workbench.css"] },
  widgets: { render: renderWidgetsPage, scripts: ["widgets.js", "totop.js"], script: "widgets.js", css: ["widgets.css"] },
};

/** The lab page shows "0 of n" missions before its script runs. */
function prepareLab(ctx) {
  const n = (ctx.project.assets?.["lab.js"]?.strings?.[ctx.L.code]?.missions || []).length;
  ctx.lab = { zero: ctx.L.toDigits(0), progress: fill(ctx.c.missions.progress, { done: ctx.L.toDigits(0), total: ctx.L.toDigits(n) }) };
}
/** Academy paths: "8 steps" from the number of steps. */
function prepareAcademy(ctx) {
  const c = ctx.c;
  ctx.c = { ...c, paths: { ...c.paths, items: c.paths.items.map((p) => ({ ...p, stepsLabel: p.stepsLabel ?? fill(c.paths.steps, { count: ctx.L.toDigits(p.steps.length) }) })) } };
}
/** Brand guide: the tab buttons (rows of labels, the first selected). */
function prepareBrand(ctx) {
  let first = true;
  const rows = ctx.c.tabs.length && ctx.c.tabs.every(Array.isArray) ? ctx.c.tabs : [ctx.c.tabs];
  ctx.brand = { tabRows: rows.map((r) => r.map((label) => { const x = { label, selected: String(first) }; first = false; return x; })) };
}

/** The icon sprite (kit icons plus the project's). */
export function sprite(project) {
  const icons = { ...ICONS, ...(project.icons || {}) };
  return [
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true">`,
    `  <defs>`,
    ...Object.entries(icons).map(([k, v]) => `    <symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`),
    `  </defs>`,
    `</svg>`,
  ].join("\n");
}

export const readPageTemplate = (file) => readFileSync(`${PAGE_DIR}${file}`, "utf8");

/** The shared chrome of inner pages for one locale: icons, font preload, the top bar and the footer. */
export function pageChrome({ project, tokens, L, loc, site, switcher = [], pathFor, asset = (h) => `${h}?v=0` }) {
  const pc = project.pageChrome || {};
  const s = pc.strings?.[loc.code] || {};
  const icons = (pc.icons || tokens.icons).map((i) => `<link rel="${i.rel}" href="${esc(i.href)}"${i.sizes ? ` sizes="${i.sizes}"` : ""}${i.type ? ` type="${i.type}"` : ""}>`).join("")
    + (tokens.manifest ? `<link rel="manifest" href="${esc(tokens.manifest)}">` : "");
  const preload = (pc.preload || tokens.font.preload.slice(0, 1)).map((src) => `<link rel="preload" href="${esc(src)}" as="font" type="font/${src.split(".").pop()}" crossorigin>`).join("\n");
  const logo = tokens.logo.nav;
  // The header of every inner page is the landing's header (src/page.js nav()): the same classes, the same logo, the
  // same call to action and the same shell buttons, so a reader sees one header on every page of the site. The page's
  // own links sit where the landing's links sit (hidden on narrow screens, where the menu carries them). A modal call
  // to action of the landing opens that modal on the home page (<home>#<modal>; the landing opens a modal from the hash).
  const cta = ctaFor(project, loc).map((a) => button(ctaHref(a, loc.path), { size: "sm" }));
  const bar = (links = [], path) => [
    `<header class="nav is-stuck kpage__nav">`,
    `  <div class="wrap nav__in">`,
    `    <a class="brand" href="${esc(loc.path)}" aria-label="${esc(`${site.name} — ${s.home ?? L.t("home")}`)}"><img class="brand__logo" src="${esc(logo.src)}" alt="${esc(site.name)}" width="${logo.width}" height="${logo.height}"></a>`,
    `    <nav class="nav__links" aria-label="${esc(s.nav ?? L.t("navMain"))}">${links.map((l) => `<a href="${esc(l.href)}">${l.label}</a>`).join("")}</nav>`,
    `    <div class="nav__cta">`,
    ...switcher.map((x) => `      <a class="btn btn--ghost btn--sm" href="${esc(pathFor(x, path))}" hreflang="${esc(x.hreflang)}" lang="${esc(x.lang)}" aria-label="${esc(`${L.t("language")}: ${x.name}`)}">${x.name}</a>`),
    ...cta.map((b) => `      ${b}`),
    `      <span class="kshell__btns">${shell(links, path).buttons}</span>`,
    `    </div>`,
    `  </div>`,
    `</header>`,
    shell(links, path).panels,
  ].join("\n");
  // the site shell (src/shell.js): the project's whole menu and the global search, on every inner page
  const shell = (links = [], path = "/") => shellMarkup({
    menu: menuFor(project, loc.code), t: L.t, home: loc.path, script: asset("/shell.js"), cta: cta.join(""),
    links: [...links, ...switcher.map((x) => ({ href: pathFor(x, path), label: x.name }))],
  });
  // "Add to Google preferred sources" above the footer line (project.preferredSource, placement "footer")
  const pref = preferredSourceCard(project.preferredSource, { placement: "footer", code: loc.code, name: site.name, url: project.url, digits: (v) => String(v).replace(/[0-9]+/g, (d) => L.toDigits(d)) });
  const footer = (note = "") => `<footer class="tpage__foot"><div class="wrap">${pref}${s.footer ?? `© ${site.name}`}${note}</div></footer>`;
  return { icons, preload, bar, footer, strings: { home: s.home ?? L.t("home"), ...s } };
}

/**
 * A landing call to action on another page: a modal opens on the locale's home page (<home>#<modal>) and a fragment
 * (#pricing) is the landing's section, so both point at the home page; any other href stays as it is.
 */
export const ctaHref = (a, home) => (a.modal && !a.href ? { ...a, href: `${home}#${a.modal}`, modal: undefined } : a.href?.startsWith("#") ? { ...a, href: `${home}${a.href}` } : a);

/** The header's call to action for one locale: project.pageChrome.cta[<locale>], else the landing's (content.nav.cta). */
export const ctaFor = (project, loc) => project.pageChrome?.cta?.[loc.code] ?? project.content?.[loc.code]?.nav?.cta ?? [];

/** The project's menu for one locale: project.menu is a list, or { <locale>: list }. */
export const menuFor = (project, code) => (Array.isArray(project.menu) ? project.menu : project.menu?.[code] ?? footerMenu(project, code));

/**
 * A project without a menu (no page registry yet): the drawer carries the landing's footer columns, the site map the
 * landing already has, so the menu is never empty and is the same on every page. Landing anchors (#modules) and
 * modals (privacy) point at the home page of the locale (/#modules), so they work from every page.
 */
function footerMenu(project, code) {
  const content = project.content?.[code];
  const cols = content?.footer?.columns;
  if (!Array.isArray(cols)) return [];
  const locs = (project.locales || []).map((x) => (typeof x === "string" ? { code: x } : x));
  const i = Math.max(0, locs.findIndex((x) => x.code === code));
  const home = locs[i]?.path ?? (i === 0 ? "/" : `/${code}/`);
  const href = (l) => (l.href ? (l.href.startsWith("#") ? `${home}${l.href}` : l.href) : l.modal ? `${home}#${l.modal}` : null);
  return cols.map((c) => ({ label: c.title, groups: [{ items: (c.links || []).map((l) => ({ label: l.label, href: href(l) })).filter((l) => l.href) }] }))
    .filter((m) => m.groups[0].items.length);
}

/** JSON-LD of an inner page: WebPage (or CollectionPage, with an ItemList) + BreadcrumbList. */
export function pageLd({ type = "WebPage", name, description, url, L, siteUrl, homeUrl, publisher = false, crumbs, mainEntity, extra = {} }) {
  const root = siteUrl.replace(/\/$/, "");
  const graph = [
    { "@type": type, name, ...(description ? { description } : {}), url, inLanguage: L.intl, isPartOf: { "@id": `${homeUrl}#website` }, ...(publisher ? { publisher: { "@id": `${root}/#org` } } : {}), ...(mainEntity ? { mainEntity } : {}), ...extra },
    { "@type": "BreadcrumbList", itemListElement: crumbs.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: u })) },
  ];
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`;
}

/** hreflang link lines (each on its own line, joined after the robots meta) and og:locale:alternate metas. */
export function pageAlternates(alts, L) {
  if (!alts.length) return { alternates: "", ogAlternates: "" };
  return {
    alternates: alts.map((a) => `\n<link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.url)}">`).join(""),
    ogAlternates: alts.filter((a) => a.og && a.og !== L.og).map((a) => `<meta property="og:locale:alternate" content="${a.og}">`).join(""),
  };
}

/**
 * Render one template page for one locale → { "<path>index.html": html }. `ctx` is the base context plus
 * chrome, a (asset URLs), alternates for this page and the page's URL.
 */
export function renderTemplatePage(def, page, ctx) {
  const c = ctx.c;
  const meta = c.meta || {};
  const full = {
    ...ctx,
    partials: def.partials || {},
    chrome: { ...ctx.chrome, bar: ctx.chrome.bar(c.bar, page.path), footer: ctx.chrome.footer(c.footNote), sprite: sprite(ctx.project) },
    page: {
      ...ctx.page,
      ld: meta.ld ? pageLd({ name: meta.ld.name ?? meta.title, url: ctx.page.url, L: ctx.L, siteUrl: ctx.url, homeUrl: ctx.homeUrl, publisher: meta.ld.publisher, crumbs: [[ctx.chrome.strings.home, ctx.homeUrl], [meta.ld.crumb, ctx.page.url]] }) : "",
    },
  };
  def.prepare?.(full, page);
  return renderTemplate(readPageTemplate(page.template || def.template), full, `${page.type} page`);
}
