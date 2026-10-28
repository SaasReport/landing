/**
 * buildSite(project, { root, write }) → { files: { "index.html": …, "styles.css": …, "ar/index.html": … }, out, locales, sitemap }
 *
 * One landing page per locale (the first locale at "/", the others at their path, e.g. "/ar/"), with hreflang
 * alternates and a language switcher when there are several; the theme CSS rendered from the tokens and the client
 * scripts rendered from their templates, strings and data (a locale whose file differs, e.g. other digits or strings,
 * gets its own "styles.<code>.css" / "terminal.<code>.js"); the inner pages (terminal, lab, academy, partners, status,
 * brand, sectors, directory) once per locale. Local CSS/JS links get a ?v=<content hash> cache-buster, from the
 * generated files or the files already in the output directory. `sitemap` lists every page with its alternates; with
 * `project.sitemap` set, each locale also gets a sitemap.<code>.xml.
 *
 * Markdown twins (on unless `project.markdown === false`): every indexable page (not noindex, not `page.markdown: false`,
 * not under `project.markdown.exclude`) gets `<path>/index.md` with the same content, generated from the built page,
 * and a `<link rel="alternate" type="text/markdown">` to it; `md-twins.json` (kit.md-twins.v1) lists them for the Worker's
 * llms.txt / llms-full.txt. With `project.markdown.llms` ({ about, intro } or true) a static-only site also gets its own
 * llms.txt and llms-full.txt. `twins` in the result lists them.
 */
import { formatForBrowser } from "@saasreport/format/browser";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeSearchIndex, searchOptions, SHELL_CSS } from "./shell.js";
import { PREFERRED_CSS } from "./preferred.js";
import { REGISTRY_CSS } from "./registry-markup.js";
import { trademarker } from "./trademark.js";
import { dirname, join, resolve } from "node:path";
import { createLocale } from "./locale.js";
import { resolveTokens, colorRefs, colorRoles } from "./tokens.js";
import { renderCss, readTheme, THEME_CSS } from "./css.js";
import { kitRegistry, unionRegistries } from "../../widgets/src/registry.js";
import { renderPage } from "./page.js";
import { renderAsset, widgetRuntimeFiles } from "./assets.js";
import { PAGE_TYPES, pageChrome, pageAlternates, renderTemplatePage } from "./pages.js";
import { checkProject } from "./validate.js";
import { pageMarkdown, twinPath, linkTwin, llmsIndex, llmsFullText } from "./markdown.js";

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

/** Normalise a project's locales to [{ code, path, overrides, L }]. */
export function projectLocales(project) {
  return (project.locales || ["en"]).map((x, i) => {
    const o = typeof x === "string" ? { code: x } : x;
    const path = o.path ?? (i === 0 ? "/" : `/${o.code}/`);
    return { ...o, path, L: createLocale(o.pack || o.code, o.overrides, { calendar: o.calendar ?? project.calendar }) };
  });
}

const nameFor = (project, code) => (typeof project.name === "string" ? project.name : project.name?.[code] ?? Object.values(project.name || {})[0]);

/**
 * Every script to generate: project.assets plus the scripts of the configured pages (a page's own script takes
 * its strings from the page content's `script` field, per locale).
 */
export function projectAssets(project, locales) {
  const cfg = { "shell.js": {}, ...(project.assets || {}) };   // every page carries the shell (src/shell.js)
  for (const page of project.pages || []) {
    const def = PAGE_TYPES[page.type];
    if (!def?.script || cfg[def.script]) continue;
    cfg[def.script] = {
      strings: Object.fromEntries(locales.map((l) => [l.code, page.content?.[l.code]?.script ?? {}])),
      ...(page.script || {}),
    };
  }
  return cfg;
}

/** The shared template context of one locale (scripts and pages). */
export function baseContext(project, tokens, loc) {
  const L = loc.L;
  const url = project.url.replace(/\/$/, "");
  return {
    name: nameFor(project, loc.code), url, root: loc.path, homeUrl: url + loc.path,
    locale: L, L, t: L.strings, tz: project.timeZone || "UTC", ns: { global: "Kit", key: "kit", ...(project.namespace || {}) },
    color: colorRefs(tokens.color), colorHex: colorRoles(tokens.color), radius: tokens.radius, font: tokens.font, logo: tokens.logo, images: tokens.images, tokens,
  };
}

export function buildSite(project, { root = process.cwd(), write = false, outDir } = {}) {
  const problems = checkProject(project);
  if (problems.length) {
    const e = new Error(`site project has problems:\n  - ${problems.join("\n  - ")}`);
    e.problems = problems;
    throw e;
  }
  const out = resolve(root, outDir || project.out || "site");
  const tokens = resolveTokens(project.tokens);
  const locales = projectLocales(project);
  // Page types that bring their own theme file (widgets.css) add it to the project's list.
  const themeFiles = [...new Set([...(project.css || THEME_CSS), ...(project.pages || []).flatMap((p) => PAGE_TYPES[p.type]?.css || [])])];
  // The plugin set of the site: the union over every widgets page's registry (the set checkProject validated), so no page's plugins ship without their CSS or runtime
  const widgetsRegistry = (project.pages || []).some((p) => p.type === "widgets" && p.registry) ? unionRegistries((project.pages || []).filter((p) => p.type === "widgets").map((p) => p.registry || kitRegistry())).registry : undefined;
  const files = {};
  // The brand mark is applied before any ?v hash is taken, so hashes always match what is written.
  const tm = trademarker(project.trademark) || ((f, b) => b);

  // Per-locale variants: the default locale's file under the plain name, another locale's only when it differs.
  const fileFor = {};
  const put = (i, loc, f, body) => {
    fileFor[loc.code] ??= {};
    const base = files[f];
    if (i === 0 || base === undefined) { files[f] = body; fileFor[loc.code][f] = f; return; }
    if (body === base) { fileFor[loc.code][f] = f; return; }
    const alt = f.replace(/\.(css|js)$/, `.${loc.code}.$1`);
    files[alt] = body;
    fileFor[loc.code][f] = alt;
  };

  // Theme CSS
  for (const [i, loc] of locales.entries()) {
    // styles.css carries the site shell's styles (src/shell-markup.js: one source for the site and the Worker)
    for (const f of themeFiles) put(i, loc, f, renderCss(readTheme(f, widgetsRegistry), { file: f, tokens, locale: loc.L, name: nameFor(project, locales[0].code) }) + (f === "styles.css" ? `\n/* ---------- site shell (src/shell-markup.js) ---------- */\n${SHELL_CSS}\n/* ---------- "Add to Google preferred sources" (src/preferred.js) ---------- */\n${PREFERRED_CSS}\n/* ---------- page registry: crumbs, hubs, related (src/registry-markup.js) ---------- */\n${REGISTRY_CSS}\n` : ""));
  }
  // Client scripts
  const assets = projectAssets(project, locales);
  const bases = locales.map((loc) => baseContext(project, tokens, loc));
  for (const [i, loc] of locales.entries()) {
    for (const [name, cfg] of Object.entries(assets)) put(i, loc, name, tm(name, renderAsset(name, cfg, bases[i], { root, code: loc.code })));
  }

  // The widget runtime's plugin modules (widgets/plugins/<id>.js, widgets/lib/*.js) sit next to widgets.js, loaded only when a widget of that archetype is on a page
  if (files["widgets.js"] !== undefined) for (const [rel, file] of widgetRuntimeFiles(widgetsRegistry)) files[rel] = readFileSync(file, "utf8");

  // A local asset link for a locale: its variant of the file, with ?v=<hash of the content>.
  const assetFor = (code) => (href) => {
    const m = /^\/([\w.-]+\.(?:css|js))(\?v=[a-z0-9]+)?$/.exec(href);
    if (!m) return href;
    const file = fileFor[code]?.[m[1]] ?? m[1];
    const body = files[file] ?? (existsSync(join(out, file)) ? tm(file, readFileSync(join(out, file), "utf8")) : null);
    return body == null ? `/${file}` : `/${file}?v=${hash(body)}`;
  };
  // a.<stem>.<ext> in page templates
  const assetTree = (code) => new Proxy({}, { get: (_, stem) => new Proxy({}, { get: (__, ext) => assetFor(code)(`/${String(stem)}.${String(ext)}`), has: () => true }), has: () => true });

  const siteUrl = project.url.replace(/\/$/, "");
  const alternatesOf = (path, codes) => {
    const ls = locales.filter((l) => codes.includes(l.code));
    return ls.length > 1 ? [...ls.map((l) => ({ hreflang: l.L.hreflang, og: l.L.og, url: siteUrl + l.path + path.replace(/^\//, "") })), { hreflang: "x-default", url: siteUrl + ls[0].path + path.replace(/^\//, "") }] : [];
  };
  const sitemap = [];

  // Landing page per locale
  const landing = alternatesOf("/", locales.map((l) => l.code));
  // project.landing === false: no landing; the project's own page at "/" is the home page
  for (const loc of project.landing === false ? [] : locales) {
    const L = loc.L;
    const content = project.content[loc.code];
    const site = { name: nameFor(project, loc.code), url: project.url };
    const styles = (project.styles || themeFiles.map((f) => `/${f}`)).map((href) => {
      const f = href.replace(/^\//, "");
      return fileFor[loc.code][f] ? `/${fileFor[loc.code][f]}` : href;
    });
    const scripts = (project.scripts || []).map((s) => (typeof s === "string" ? { src: s } : s))
      .map((s) => { const f = s.src.replace(/^\//, ""); return fileFor[loc.code][f] ? { ...s, src: `/${fileFor[loc.code][f]}` } : s; });
    const page = {
      project, site, content, L, t: L.t, d: L.toDigits, tokens, url: siteUrl + loc.path,
      alternates: landing, switcher: locales.length > 1 ? locales.filter((l) => l !== loc).map((l) => ({ path: l.path, hreflang: l.L.hreflang, lang: l.L.lang, name: l.L.name })) : [],
      styles, scripts, asset: assetFor(loc.code),
    };
    files[`${loc.path.replace(/^\//, "")}index.html`] = renderPage(page);
    sitemap.push({ locale: loc.code, loc: siteUrl + loc.path, alternates: landing });
  }

  // Inner pages per locale (a page is built for the locales its content covers)
  for (const page of project.pages || []) {
    const def = PAGE_TYPES[page.type];
    const codes = locales.filter((l) => page.content?.[l.code]).map((l) => l.code);
    const alts = alternatesOf(page.path, codes);
    for (const [i, loc] of locales.entries()) {
      if (!codes.includes(loc.code)) continue;
      const others = locales.filter((l) => l !== loc && codes.includes(l.code)).map((l) => ({ path: l.path, hreflang: l.L.hreflang, lang: l.L.lang, name: l.L.name }));
      const chrome = pageChrome({ project, tokens, L: loc.L, loc, site: { name: bases[i].name }, switcher: others, pathFor: (x, p) => x.path + p.replace(/^\//, ""), asset: assetFor(loc.code) });
      const ctx = {
        ...bases[i], c: page.content[loc.code], a: assetTree(loc.code), asset: assetFor(loc.code), chrome,
        page: { path: page.path, url: siteUrl + loc.path + page.path.replace(/^\//, ""), ogImage: siteUrl + (page.content[loc.code].meta?.ogImage || tokens.images.og.src), ...pageAlternates(alts, loc.L) },
        pathOf: (p) => loc.path + p.replace(/^\//, ""), alternatesOf: (p) => alternatesOf(p, codes), project,
      };
      const prefix = loc.path.replace(/^\//, "") + page.path.replace(/^\//, "");
      const produced = def.render ? def.render(page, ctx) : { "index.html": renderTemplatePage(def, page, ctx) };
      for (const [rel, body] of Object.entries(produced)) {
        files[prefix + rel] = body;
        // pages marked noindex (app shells, legal drafts) stay out of the sitemap
        if (rel.endsWith("index.html") && !/<meta name="robots" content="noindex/.test(body)) {
          const sub = rel.replace(/index\.html$/, "");
          sitemap.push({ locale: loc.code, loc: siteUrl + loc.path + page.path.replace(/^\//, "") + sub, alternates: alternatesOf(page.path + sub, codes) });
        }
      }
    }
  }

  if (project.sitemap) {
    for (const loc of locales) {
      const urls = sitemap.filter((u) => u.locale === loc.code);
      files[`sitemap.${loc.code}.xml`] = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
        ...urls.map((u) => [`  <url>`, `    <loc>${u.loc}</loc>`, ...u.alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.url}"/>`), `  </url>`].join("\n")),
        `</urlset>`, ``,
      ].join("\n");
    }
  }

  // The kit's one number formatter in the browser (CONSTITUTION.md §7): /format.js sets globalThis.KitFormat and every
  // page loads it before its own scripts, so client code formats numbers with it (never with Intl or toLocaleString).
  files["format.js"] = formatForBrowser({ locales });   // a site with no Persian or Arabic locale gets no Persian or Arabic tables
  const formatTag = `<script src="${assetFor(locales[0].code)("/format.js")}"></script>`;
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith(".html") || files[rel].includes(formatTag)) continue;
    files[rel] = files[rel].replace(/<script\b(?![^>]*\btype\s*=\s*["']?application\/(?:ld\+)?json)[^>]*\bsrc\s*=/i, (m) => `${formatTag}\n${m}`);
  }

  for (const rel of Object.keys(files)) files[rel] = tm(rel, files[rel]);

  const twins = markdownTwins(project, files, sitemap, siteUrl, locales);


  if (write) {
    for (const [rel, body] of Object.entries(files)) {
      const p = join(out, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    // the global search's static index over every page written (a project that adds pages after buildSite writes it
    // again once they are on disk: writeSearchIndex(out, searchOptions(project, …)))
    writeSearchIndex(out, searchOptions(project, { localePaths: locales.map((l) => l.path), homeLabel: locales[0].L.t("home") }));
  }
  return { files, out, locales: locales.map((l) => ({ code: l.code, path: l.path })), sitemap, twins };
}

export const TWINS_SCHEMA = "kit.md-twins.v1";
export const TWINS_FILE = "md-twins.json";

/**
 * Write the Markdown twin of every page in the sitemap (indexable pages only) into `files`, link it from the page and
 * list them in md-twins.json (and llms.txt / llms-full.txt when project.markdown.llms is set). Returns the twins.
 */
function markdownTwins(project, files, sitemap, siteUrl, locales) {
  const opt = project.markdown === false ? null : project.markdown === true || project.markdown == null ? {} : project.markdown;
  if (!opt) return [];
  const off = new Set((project.pages || []).filter((p) => p.markdown === false).map((p) => p.path));
  const exclude = [...(opt.exclude || []), ...off];
  const twins = [];
  for (const u of sitemap) {
    const path = u.loc.slice(siteUrl.length) || "/";
    const loc = locales.find((l) => l.code === u.locale);
    const inLocale = loc && loc.path !== "/" && path.startsWith(loc.path) ? `/${path.slice(loc.path.length)}` : path;
    if (exclude.some((x) => inLocale === x || inLocale.startsWith(x.endsWith("/") ? x : `${x}/`))) continue;
    const rel = `${path.replace(/^\//, "")}index.html`;
    if (files[rel] === undefined) continue;
    const md = twinPath(rel);
    const name = typeof project.name === "string" ? project.name : project.name?.[u.locale] ?? Object.values(project.name || {})[0];
    const t = pageMarkdown(files[rel], { url: u.loc, site: name });
    files[md] = t.markdown;
    files[rel] = linkTwin(files[rel], `/${md}`);
    twins.push({ locale: u.locale, path, url: u.loc, md: `${siteUrl}/${md}`, title: t.title, description: t.description, markdown: t.markdown });
  }
  files[TWINS_FILE] = `${JSON.stringify({ schema: TWINS_SCHEMA, site: siteUrl, pages: twins.map(({ markdown, ...x }) => ({ ...x, bytes: Buffer.byteLength(markdown) })) }, null, 2)}\n`;
  if (opt.llms) {
    const l = opt.llms === true ? {} : opt.llms;
    const name = typeof project.name === "string" ? project.name : project.name?.[locales[0].code] ?? Object.values(project.name || {})[0];
    const site = { name, about: l.about || "", intro: l.intro || "", optional: [{ title: "Full text", url: `${siteUrl}/llms-full.txt` }, ...(l.optional || [])] };
    files["llms.txt"] = llmsIndex(site, twins);
    files["llms-full.txt"] = llmsFullText({ ...site, optional: (l.optional || []) }, twins);
  }
  return twins;
}

/** Compare generated files with the ones on disk: [{ file, status: "same" | "differs" | "missing" }]. */
export function compareSite(files, out) {
  return Object.entries(files).map(([file, body]) => {
    const p = join(out, file);
    if (!existsSync(p)) return { file, status: "missing" };
    return { file, status: readFileSync(p, "utf8") === body ? "same" : "differs" };
  });
}
