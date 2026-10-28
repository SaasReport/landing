/**
 * The widgets stylesheet template: the engine's base (theme/widgets.css) followed by each registered plugin's own `styles`
 * (a template with the same {{placeholders}}), so a plugin brings its presentation with it. Sites render the result with the
 * project's tokens (@saasreport/site renderCss).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { THEME_FILE, KIT_PLUGIN_DIR } from "./files.js";
import { kitRegistry } from "./registry.js";

export function themeTemplate(registry = kitRegistry()) {
  const parts = [readFileSync(THEME_FILE, "utf8")];
  for (const e of registry.entries()) {
    if (!e.plugin.styles) continue;
    parts.push(readFileSync(resolve(e.file ? dirname(e.file) : KIT_PLUGIN_DIR, e.plugin.styles), "utf8"));
  }
  return parts.join("\n");
}

/** The runtime modules a registry needs published next to widgets.js: [published path, file]. */
export function runtimeFiles(registry = kitRegistry()) {
  return registry.entries().filter((e) => e.plugin.runtime).map((e) => [`widgets/plugins/${e.plugin.id}.js`, resolve(e.file ? dirname(e.file) : KIT_PLUGIN_DIR, e.plugin.runtime)]);
}
