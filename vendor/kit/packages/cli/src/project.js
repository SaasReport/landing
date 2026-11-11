/**
 * A kit project on disk: kit.config.js (default export), content/index.js (optional; series `source` modules are
 * resolved too), wrangler.toml. Episodes are built exactly as the Worker builds them: through
 * @saasreport/cloudflare's createKit (calendar segment included), without Workers bindings.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, loadContent, planner, KitConfigError, isMultiLocale, localesOf, configFor, contentFor, localeBase } from "@saasreport/core";
import { createKit } from "@saasreport/cloudflare";
import { CliError } from "./args.js";
import { parseToml } from "./toml.js";
import { readWranglerRaw } from "./wrangler-config.js";

/** Load and validate a project. Throws CliError (config problems listed) when something is wrong. */
export async function loadProject(dir, { config: file = "kit.config.js", content: contentOverride } = {}) {
  // If the Worker imports a composed content pack, CLI checks and drills must
  // load that same pack. Explicit --content overrides still take precedence.
  const contentFile = contentOverride ?? (existsSync(resolve(dir, "src/kit/content.js")) ? "src/kit/content.js" : "content/index.js");
  const path = resolve(dir, file);
  if (!existsSync(path)) throw new CliError(`no ${file} in ${dir} (run \`kit init\` first, or pass --cwd <dir>)`);
  let mod;
  try { mod = await import(pathToFileURL(path).href); }
  catch (e) {
    if (e instanceof KitConfigError || e?.name === "KitConfigError") throw new CliError(e.message);
    throw new CliError(`cannot load ${file}: ${e?.message || e}`);
  }
  const raw = mod.default ?? mod.config;
  if (!raw || typeof raw !== "object") throw new CliError(`${file} must export the config as its default export`);
  let config;
  try { config = defineConfig(raw); }
  catch (e) { if (e instanceof KitConfigError || e?.name === "KitConfigError") throw new CliError(e.message); throw e; }
  let content = {};
  const cpath = resolve(dir, contentFile);
  if (existsSync(cpath)) {
    try { const m = await import(pathToFileURL(cpath).href); content = m.default ?? m.content ?? {}; }
    catch (e) { throw new CliError(`cannot load ${contentFile}: ${e?.message || e}`); }
  }
  try { content = await loadContent(config, content); }
  catch (e) { throw new CliError(`cannot load a series source: ${e?.message || e}`); }
  return { dir: resolve(dir), file: path, config, content };
}

/** wrangler.toml as an object ({} when missing). */
export function readWrangler(dir) {
  // the canonical reader (wrangler-config.js); the site's own config at the root, TOML or JSON(C)
  const p = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find((f) => existsSync(f));
  return p ? readWranglerRaw(p) : {};
}

/**
 * One locale of a multi-locale project (--locale): { ...project, locale, base, config, content } with that locale's config
 * and content pack; `root` keeps the whole project. Without a locale: the default one. A single-locale project is returned
 * as it is (a --locale other than its own is an error).
 */
export function projectFor(project, locale) {
  const root = project.root || project;
  if (!isMultiLocale(root.config)) {
    if (locale != null && String(locale) !== root.config.site.locale && String(locale) !== root.config.site.locale.split(/[-_]/)[0]) throw new CliError(`--locale ${locale}: this site publishes in one language (${root.config.site.locale}); add site.locales to kit.config.js for more`);
    return project;
  }
  const l = locale == null ? root.config.site.defaultLocale : String(locale);
  const all = localesOf(root.config);
  if (!all.includes(l)) throw new CliError(`unknown locale "${l}" (site.locales: ${all.join(", ")})`);
  return { ...root, root, locale: l, base: localeBase(l, root.config.site.defaultLocale), config: configFor(root.config, l), content: contentFor(root.config, root.content, l) };
}

const kits = new WeakMap();
/**
 * The Worker runtime of a project, in Node (no bindings): the planner and the exact episode builder the daily cron
 * and the admin API use (`episodeFor`: `episodeFromItem` from @saasreport/podcast with the runtime's calendar segment and glossary categories).
 * A locale of a multi-locale project (projectFor) gets that locale's runtime.
 */
export function runtime(project) {
  const root = project.root || project;
  if (!kits.has(root)) kits.set(root, createKit(root.config, root.content, { deps: { createPodcastWorkflow: null, announcePending: null } }));
  const kit = kits.get(root);
  const k = project.locale && kit.locales ? kit.locales[project.locale].context : kit.context;
  const plan = planner(project.config, project.content);
  const cache = new Map();
  /** Episode for a planner entry, as the Worker builds it (handlers/podcasts.js episodeFor). */
  function episode(series, entry) {
    const s = typeof series === "string" ? project.config.series.find((x) => x.id === series) : series;
    if (!s?.podcast || !entry?.item) return null;
    const key = `${s.id}:${entry.slug}`;
    if (!cache.has(key)) {
      cache.set(key, k.episodeFor(s, entry.item, { number: entry.number ?? null, ref: entry.key ?? null }));
    }
    return cache.get(key);
  }
  return { kit, plan, episode };
}
