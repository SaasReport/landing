/** Validation of a site project: tokens, locale packs and the landing content of every locale. */
import { validateSchema } from "./schema.js";
import { MENU_SCHEMA } from "./shell-markup.js";
import { SEARCH_CONFIG_SCHEMA } from "./shell.js";
import { PREFERRED_SOURCE_SCHEMA, checkPreferredSource } from "./preferred.js";
import { checkTokens, resolveTokens } from "./tokens.js";
import { checkLocale, createLocale, LOCALES } from "./locale.js";
import { resolveCalendarConfig } from "@saasreport/calendar/config";
import { SECTIONS } from "./sections/index.js";
import { ASSETS, checkAssets } from "./assets.js";
import { PAGE_TYPES } from "./pages.js";
import { checkContent } from "./generators/content.js";
import { checkReference } from "./generators/reference.js";
import { checkApps } from "./generators/apps.js";
import { checkNoticesPage } from "./generators/notices.js";
import { checkWidgetsPage } from "./generators/widgets.js";
import { kitRegistry, unionRegistries, isRegistry } from "../../widgets/src/registry.js";
import { checkWorkbenchPage } from "./generators/workbench.js";

/** Fields each section type needs (dotted paths). */
export const REQUIRED = {
  hero: ["eyebrow", "title", "actions", "mock.bar", "mock.steps", "mock.stats"],
  audience: ["label", "title", "items"],
  cards: ["items"],
  approach: ["head.title", "flow"],
  roles: ["items"],
  domains: ["items", "go"],
  stepper: ["label", "steps", "exampleLabel", "outputsLabel"],
  packs: ["tabs"],
  lifecycle: ["send", "demo"],
  simulation: ["modes", "modesLabel", "scenarios", "scenariosLabel", "run", "console.title", "console.empty"],
  usecases: ["items"],
  apps: ["items", "play", "reset"],
  mount: ["class"],
  calendar: ["mount", "engine.code", "engine.channels"],
  stage: ["view"],
  agentic: ["checks", "toggle", "run", "agents", "agent.flow"],
  dashboard: ["kpis", "chart.title", "chart.series", "recent.items", "widgets"],
  terminal: ["tour", "verbs"],
  developers: ["langs", "portal.views", "portal.active", "portal.endpoint"],
  playground: ["search", "env.options", "connector.options", "send", "request.tabs", "response.tabs", "response.langs", "history"],
  architecture: ["layers", "hint"],
  ecosystem: ["nodes"],
  marketplace: ["filters", "adapter", "registry.columns", "registry.rows"],
  governance: ["chain", "controls"],
  compare: ["columns", "rows"],
  band: ["title", "actions"],
  brand: ["eyebrow", "title", "action"],
  explore: ["items"],
  blog: [],
  podcasts: ["coverAlt"],
  glossary: ["href", "categories", "categoriesLabel"],
  events: ["subscribe.id", "subscribe.form", "subscribe.title", "subscribe.submit"],
  faq: ["head.title", "items"],
  final: ["eyebrow", "title", "text"],
};

const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const empty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Every modal a call to action or link opens ({ modal: "id" }), anywhere in the content. */
function modalRefs(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => modalRefs(x, out));
  else if (node && typeof node === "object") {
    if (typeof node.modal === "string") out.add(node.modal);
    Object.values(node).forEach((x) => modalRefs(x, out));
  } else if (typeof node === "string") for (const m of node.matchAll(/data-modal="([\w-]+)"/g)) out.add(m[1]);
  return out;
}

/** Problems with one locale's landing content. */
export function checkLanding(content, where = "content") {
  const p = [];
  if (!content || typeof content !== "object") return [`${where}: missing`];
  for (const k of ["meta.title", "meta.description", "nav.links", "nav.cta", "nav.drawer.links", "footer.columns", "footer.legal", "footer.logoAlt", "sections"]) {
    if (empty(get(content, k))) p.push(`${where}.${k}: missing`);
  }
  const ids = new Set();
  (content.sections || []).forEach((s, i) => {
    const at = `${where}.sections[${i}]${s?.id ? ` (#${s.id})` : ""}`;
    if (!SECTIONS[s?.type]) { p.push(`${at}: unknown type "${s?.type}"`); return; }
    for (const k of REQUIRED[s.type]) if (empty(get(s, k))) p.push(`${at}: ${s.type} needs ${k}`);
    if (s.id) { if (ids.has(s.id)) p.push(`${at}: duplicate id "${s.id}"`); ids.add(s.id); }
  });
  const modals = new Set();
  (content.modals || []).forEach((m, i) => {
    const at = `${where}.modals[${i}]`;
    for (const k of ["id", "titleId", "eyebrow", "title"]) if (empty(m[k])) p.push(`${at}: needs ${k}`);
    if (!m.doc && (empty(m.form) || empty(m.fields) || empty(m.submit))) p.push(`${at}: a form modal needs form, fields and submit`);
    if (modals.has(m.id)) p.push(`${at}: duplicate modal id "${m.id}"`);
    modals.add(m.id);
  });
  const forms = (content.modals || []).some((m) => !m.doc) || (content.sections || []).some((s) => s.type === "events");
  const refs = modalRefs(content);
  if (forms) refs.add("privacy");
  if ((content.modals || []).some((m) => m.consent === "terms")) refs.add("terms");
  for (const r of refs) if (!modals.has(r)) p.push(`${where}: opens modal "${r}", which is not defined in modals`);
  return p;
}

/** Problems with a whole project (tokens, locales, content of every locale). */
export function checkProject(project) {
  const p = [];
  if (!project || typeof project !== "object") return ["project: missing"];
  if (empty(project.name)) p.push("name: missing");
  if (!/^https:\/\/[^/]+/.test(project.url || "")) p.push("url: an https:// URL");
  p.push(...checkTokens(resolveTokens(project.tokens)));
  const locales = project.locales || [];
  if (!locales.length) p.push("locales: at least one (the first is the default, served at /)");
  const paths = new Set();
  locales.forEach((x, i) => {
    const o = typeof x === "string" ? { code: x } : x;
    if (!o.pack && !LOCALES[o.code]) { p.push(`locales[${i}]: unknown locale "${o.code}" (ship a pack, or use ${Object.keys(LOCALES).join(", ")})`); return; }
    let L;
    try { L = createLocale(o.pack || o.code, o.overrides, { calendar: o.calendar ?? project.calendar }); }
    catch (e) { p.push(`locales[${i}] (${o.code}): ${e.message}`); return; }
    p.push(...checkLocale(L, `locales[${i}] (${o.code})`));
    const path = o.path ?? (i === 0 ? "/" : `/${o.code}/`);
    if (!/^\/([\w-]+\/)*$/.test(path)) p.push(`locales[${i}]: path must look like / or /ar/`);
    if (paths.has(path)) p.push(`locales[${i}]: duplicate path ${path}`);
    paths.add(path);
    if (project.landing !== false) p.push(...checkLanding(project.content?.[o.code], `content.${o.code}`));
  });
  if (project.calendar != null) for (const q of resolveCalendarConfig(project.calendar).problems) p.push(`calendar: ${q}`);
  const codes = locales.map((x) => (typeof x === "string" ? x : x.code));
  p.push(...checkAssets(project.assets, codes));
  if (project.search != null) for (const e of validateSchema(project.search, SEARCH_CONFIG_SCHEMA)) p.push(`search${e.path === "/" ? "" : e.path}: ${e.message}`);
  if (project.menu != null) for (const e of validateSchema(project.menu, MENU_SCHEMA)) p.push(`menu${e.path === "/" ? "" : e.path}: ${e.message}`);
  if (project.preferredSource != null) {
    for (const e of validateSchema(project.preferredSource, PREFERRED_SOURCE_SCHEMA)) p.push(`preferredSource${e.path === "/" ? "" : e.path}: ${e.message}`);
    p.push(...checkPreferredSource(project.preferredSource, codes));
  }
  const pagePaths = new Set();
  const widgetsPages = (project.pages || []).filter((x) => x?.type === "widgets" && (x.registry === undefined || isRegistry(x.registry)));      // a malformed registry is reported by checkWidgetsPage
  if (widgetsPages.length > 1) for (const c of unionRegistries(widgetsPages.map((x) => x.registry || kitRegistry())).conflicts) p.push(`widgets pages: ${c}`);
  (project.pages || []).forEach((pg, i) => {
    const at = `pages[${i}]${pg?.type ? ` (${pg.type})` : ""}`;
    const def = PAGE_TYPES[pg?.type];
    if (!def) { p.push(`${at}: unknown page type (${Object.keys(PAGE_TYPES).join(", ")})`); return; }
    if (!(def.allowRoot && pg.path === "/") && !/^\/([\w-]+\/)+$/.test(pg.path || "")) p.push(`${at}: path must look like /terminal/`);
    if (pg.type === "content") for (const c of codes.filter((x) => pg.content?.[x])) p.push(...checkContent(Array.isArray(pg.pages) ? pg.pages : pg.pages?.[c], { base: pg.path, renderers: pg.renderers, where: at }));
    if (pg.type === "reference") p.push(...checkReference(pg.specs, at));
    if (pg.type === "apps") p.push(...checkApps(pg.surface, at));
    if (pagePaths.has(pg.path)) p.push(`${at}: duplicate path ${pg.path}`);
    pagePaths.add(pg.path);
    const covered = codes.filter((c) => pg.content?.[c]);
    if (!covered.length) p.push(`${at}: content for at least one locale (${codes.join(", ")})`);
    for (const c of covered) if (!pg.content[c].meta?.title && !def.render) p.push(`${at}: content.${c}.meta.title missing`);
    if (pg.type === "notices") p.push(...checkNoticesPage(pg).map((q) => `${at}: ${q}`));
    if (pg.type === "widgets") p.push(...checkWidgetsPage(pg, codes).map((q) => `${at}: ${q}`));
    if (pg.type === "workbench") p.push(...checkWorkbenchPage(pg, codes).map((q) => `${at}: ${q}`));
    for (const s of def.scripts) if (!ASSETS[s]) p.push(`${at}: needs ${s}, which the kit cannot generate`);
    for (const s of def.scripts) if (!["totop.js"].includes(s) && s !== def.script && !project.assets?.[s]) p.push(`${at}: needs assets["${s}"] (its strings and data) in the site config`);
  });
  return p;
}
