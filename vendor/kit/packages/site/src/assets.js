/**
 * Client scripts as templates: the demo engines (terminal, lab, notifications), the page helpers (back to top and
 * the section index) and the scripts of the inner pages. Each is rendered per locale with the project's tokens,
 * locale pack, strings and data, so the browser gets plain external files (CSP script-src 'self'): no inline
 * JSON, no runtime string tables.
 *
 * Context of every script template:
 *   name, url, root            site name (this locale), site URL, this locale's path prefix ("/" or "/ar/")
 *   locale.*                   the locale runtime: dir, lang, intl, numberIntl, dateIntl, dateIntlLatn, digitChars, …
 *   t.*                        the locale pack's chrome strings (back to top, close, …)
 *   color.*, radius.*, logo.*  design tokens
 *   tz, ns.global, ns.key      the project's time zone and script namespace (window.<global>Notify, "<key>-…" keys)
 *   s.*, d.*                   this script's strings (for this locale) and data, from the project config
 *   banner                     the file's first comment
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./template.js";
import { runtimeFiles } from "../../widgets/src/theme.js";
import { validateSchema } from "./schema.js";
import NOTIFY_SCHEMA from "../schema/terminal-notify.schema.json" with { type: "json" };
import { runtimeSource as workbenchRuntime } from "../../workbench/src/runtime.js";

/** JSON Schemas of asset data a project gives (validated by checkAssets). */
export const ASSET_SCHEMAS = { "terminal.js#notify": NOTIFY_SCHEMA };

export const ASSET_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
export const readAsset = (file) => readFileSync(`${ASSET_DIR}${file}`, "utf8");

/**
 * The terminal engine (head, shared helpers, shell) and the one view the kit ships: notify, a pure primitive whose
 * scenarios are the project's own (data.notify, generated from widgets.spec.json by `kit widgets build`). Every other
 * view is the project's: `views: [{ id, file }]` (docs/WIDGETS.md: widgets carry no default content). The views the
 * kit used to ship (payments, treasury, escrow, lending, trade, sukuk, …) now live with the sample project
 * (examples/site-sample/terminal/) as its content.
 */
export const TERMINAL_VIEWS = ["notify"];
export const TERMINAL_PARTS = [
  { file: "terminal/_head.js" },
  { file: "terminal/_stream.js" },
  { file: "terminal/notify.js", view: "notify" },
  { file: "terminal/_shell.js" },
];
/** @deprecated Roles are the project's own (data.cast is a free map of role → player slug); kept for old imports. */
export const CAST_ROLES = ["bank1", "bank2", "bank3", "bank4", "bank5", "bank6", "bank7", "bank8", "psp1", "psp2", "wallet1", "wallet2", "exchange", "broker", "insurer"];
/** @deprecated The lab's missions are the project's template's own; kept for old imports. */
export const LAB_MISSIONS = ["list", "balance", "pay", "replay", "fail", "events", "real"];

const viewId = (v) => (typeof v === "string" ? v : v.id);

function prepareTerminal(ctx, cfg) {
  const d = ctx.d, names = ctx.s._head?.players || {};
  d.playerRows = (d.players || []).map((row, r) => row.map((p, i) => ({ key: /^[A-Za-z_$][\w$]*$/.test(p.slug) ? p.slug : JSON.stringify(p.slug), slug: p.slug, name: names[p.slug] ?? p.slug, color: p.color ?? `chart${((r * 7 + i) % 6) + 1}` })));   // a player's colour is a role (default: a chart series by position), never a brand hex
  if (!d.order) d.order = (cfg.views || TERMINAL_VIEWS).map(viewId);
  // the hub of the network views shows the brand icon (the mark, not the wordmark): the project's data, else its token
  if (!d.icon) d.icon = ctx.logo?.icon?.src;
}

function prepareLabData(ctx) {
  const names = ctx.s.banks || {};
  ctx.d.banks = (ctx.d.banks || []).map((b) => ({ ...b, name: names[b.slug] ?? b.slug }));
}

function prepareLab(ctx) {
  // m.<id>: true for each mission the project's strings list (its template checks those ids).
  ctx.m = Object.fromEntries((ctx.s.missions || []).map((m) => [m.id, true]));
}

/**
 * The scripts the kit can generate. `file` is the template (or `parts` for the terminal); `prepare` adds derived
 * values to the context; `strings`/`data` come from the project (assets[name] in the site config).
 */
export const ASSETS = {
  "notify.js": { file: "notify.js", prepare: (ctx) => { ctx.d = { ...NOTIFY_DATA, ...ctx.d }; } },
  "totop.js": { file: "totop.js" },
  // the landing's behaviours (reveal, counters, tabs, stepper, modals, mega menus, nav, section index): no copy, see assets/landing.js
  "landing.js": { file: "landing.js" },
  // the site shell on every page: menu drawer + global search (src/shell.js)
  "shell.js": { file: "shell.js" },
  // The widget runtime (@saasreport/widgets): a plain script, no project strings (the page holds every word).
  "widgets.js": { path: fileURLToPath(new URL("../../widgets/assets/widgets.js", import.meta.url)) },
  // The workbench runtime (@saasreport/workbench): generated from its sources, no project strings (the page embeds every word).
  "workbench.js": { generate: workbenchRuntime, raw: true },
  "terminal.js": { parts: TERMINAL_PARTS, views: TERMINAL_VIEWS, prepare: prepareTerminal },
  // The lab's engine and seed are the project's templates (`template`): the kit ships no lab content.
  "lab-data.js": { needsTemplate: true, prepare: prepareLabData },
  "lab.js": { needsTemplate: true, prepare: prepareLab },
  "academy.js": { file: "pages/academy.js" },
  "partners.js": { file: "pages/partners.js" },
  "status.js": { file: "pages/status.js" },
  "brand-page.js": { file: "pages/brand-page.js" },
  "sectors.js": { file: "pages/sectors.js" },
  "directory.js": { file: "pages/directory.js" },
  "apps.js": { file: "pages/apps.js", prepare: (ctx) => { ctx.s = { ...APPS_STRINGS, ...ctx.s }; } },
  "statusboard.js": { file: "pages/statusboard.js", prepare: (ctx) => { ctx.s = { ...STATUSBOARD_STRINGS, ...ctx.s }; ctx.d = { ...ctx.d, sources: { ...STATUSBOARD_SOURCES, ...(ctx.d.sources || {}) } }; } },
};

/** Defaults of the notification component: at most `max` on screen, auto-dismiss after `timeout` ms (`errorTimeout` for
 *  errors), `exitMs` for the leave transition (match the theme's motion.ui). */
export const NOTIFY_DATA = { max: 4, timeout: 5200, errorTimeout: 9000, exitMs: 220 };

/** Default English strings of the app shells' script (a project overrides any of them per locale). */
export const APPS_STRINGS = {
  signedInAs: "Signed in as", notSignedIn: "Not signed in.", preview: "Preview: sign in on", loadFailed: "The sign-in service could not be loaded.",
  unavailable: "Not available", noData: "This view has no data endpoint of its own.", moreRows: "more rows not shown.", error: "error", signOut: "Sign out",
};
/** Default sources and English strings of the status board's script. */
export const STATUSBOARD_SOURCES = { components: "/api/status/components", monitor: "/api/status", build: "/status.json" };
export const STATUSBOARD_STRINGS = {
  operational: "Operational", maintenance: "Maintenance", degraded: "Degraded performance", partial: "Partial outage", major: "Major outage",
  noComponents: "The component list is not available here.", noRuns: "No journey run is recorded yet.", noChecks: "No build checks are published.",
  affected: "component(s) affected", allNormal: "All systems normal", checksPass: "Every site check passes", someFailed: "Some checks failed", title: "Status",
  components: "Components", of: "of", operationalLower: "operational", notAvailable: "Not available here", lastRun: "Last journey run", noRunYet: "No run yet",
  lastBuild: "Last build", unknown: "Unknown", buildChecks: "Build checks", checksLower: "checks",
};

/** The template source of an asset for a project (terminal: the engine parts, the kit's notify view if chosen, and
 *  the project's views in the order given). */
export function assetSource(name, cfg = {}, root = process.cwd()) {
  const def = ASSETS[name];
  if (!def) throw new Error(`unknown asset ${name} (known: ${Object.keys(ASSETS).join(", ")})`);
  if (def.generate) return def.generate();
  if (cfg.template) return readFileSync(resolve(root, cfg.template), "utf8");
  if (def.needsTemplate) throw new Error(`assets.${name}: give the project's own template (\`template\`); the kit ships no ${name} content`);
  if (def.path) return readFileSync(def.path, "utf8");
  if (!def.parts) return readAsset(def.file);
  const chosen = (cfg.views || []).map((v) => (typeof v === "string" ? { id: v } : v));
  const [head, ...rest] = def.parts;
  const shell = rest.pop();
  let out = readAsset(head.file);
  for (const p of rest) if (!p.view) out += readAsset(p.file);
  for (const v of chosen) {
    if (v.file) { out += readFileSync(resolve(root, v.file), "utf8"); continue; }
    const part = rest.find((p) => p.view === v.id);
    if (part) out += readAsset(part.file);
  }
  return out + readAsset(shell.file);
}

/** Problems with a project's asset config (unknown assets, views, missions, cast roles). */
export function checkAssets(assets = {}, codes = []) {
  const p = [];
  for (const [name, cfg] of Object.entries(assets)) {
    if (!ASSETS[name]) { p.push(`assets.${name}: unknown (known: ${Object.keys(ASSETS).join(", ")})`); continue; }
    if (name === "terminal.js") {
      const views = cfg.views || [];
      const ids = new Set(views.map(viewId));
      if (!views.length) p.push("assets.terminal.js: views: the project's views ({ id, file }) and/or the kit's notify view; the kit ships no other view");
      for (const v of views) if (typeof v === "object" ? !v.id || (!v.file && !TERMINAL_VIEWS.includes(v.id)) : !TERMINAL_VIEWS.includes(v)) p.push(`assets.terminal.js: view ${JSON.stringify(v)} is not a kit view (${TERMINAL_VIEWS.join(", ")}); give the project's views as { id, file }`);
      for (const o of cfg.data?.order || []) if (!ids.has(o)) p.push(`assets.terminal.js: data.order lists "${o}", which is not among the views`);
      for (const code of codes) for (const row of cfg.strings?.[code]?._shell?.commands || []) for (const c of row) if (!ids.has(c[1])) p.push(`assets.terminal.js: strings.${code} command "${c[0]}" opens view "${c[1]}", which is not among the views`);
      for (const [role, slug] of Object.entries(cfg.data?.cast || {})) {
        if (!/^[a-z][a-z0-9-]*$/.test(slug)) p.push(`assets.terminal.js: cast.${role} "${slug}" must be a lower-case slug`);
      }
      if (views.some((v) => v === "notify") && cfg.data?.notify == null) p.push("assets.terminal.js: the kit's notify view needs data.notify (the project's scenarios: kit widgets build exports them as terminal-notify)");
      if (cfg.data?.notify != null) for (const q of validateSchema(cfg.data.notify, NOTIFY_SCHEMA)) p.push(`assets.terminal.js: data.notify${q.path === "/" ? "" : q.path}: ${q.message}`);
      if (cfg.data?.notify != null && !ids.has("notify")) p.push("assets.terminal.js: data.notify is given but the notify view is not among the views");
    }
    if (ASSETS[name].needsTemplate && !cfg.template) p.push(`assets.${name}: needs the project's own template (\`template\`); the kit ships no ${name} content`);
  }
  return p;
}

/** Render one asset for one locale. `base` is the shared context (name, url, locale, t, tokens, tz, ns). */
export function renderAsset(name, cfg = {}, base, { root = process.cwd(), code } = {}) {
  const def = ASSETS[name];
  const src = assetSource(name, cfg, root);
  if (def.raw) return src;
  const ctx = { ...base, s: cfg.strings?.[code] ?? {}, d: structuredClone(cfg.data ?? {}), file: name };
  ctx.banner = cfg.banner ?? `/* ${base.name} — ${name}, generated by @saasreport/site */`;
  def.prepare?.(ctx, cfg);
  return renderTemplate(src, ctx, name);
}

/** The widget runtime's module tree (assets/widgets/**), as [published path, file]: plugins/<id>.js and lib/*.js next to widgets.js. */
export function widgetRuntimeFiles(registry = null) {
  const root = fileURLToPath(new URL("../../widgets/assets/widgets/", import.meta.url));
  const walk = (dir, rel = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : [[`widgets/${rel}${e.name}`, join(dir, e.name)]]));
  const own = registry ? runtimeFiles(registry).filter(([, file]) => !file.startsWith(root)) : [];      // a project's own plugins' runtime modules
  return [...(existsSync(root) ? walk(root) : []), ...own];
}

export { existsSync };
