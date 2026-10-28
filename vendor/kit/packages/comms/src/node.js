/**
 * Node helpers: write a project's spec files, its two wrangler.toml files and HTML previews.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { specFiles } from "./specs.js";
import { wranglerToml } from "./wrangler.js";
import { renderPreviews, previewIndex } from "./preview.js";

/** Write manifest.json, blocks.json, links.json and providers.json into dir. Returns the files written. */
export function writeSpecs(config, dir) {
  mkdirSync(dir, { recursive: true });
  const files = specFiles(config);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return Object.keys(files).map((f) => join(dir, f));
}

/** Write the wrangler.toml of each Worker: { "comms-engine": path, "mail-sender": path }. */
export function writeWrangler(config, paths) {
  for (const [kind, path] of Object.entries(paths)) writeFileSync(path, wranglerToml(config, kind));
  return Object.values(paths);
}

/** Which of the given files differ from what the config generates (for a --check mode in CI). */
export function staleFiles(config, { specsDir, wrangler = {} }) {
  const want = {};
  if (specsDir) for (const [f, t] of Object.entries(specFiles(config))) want[join(specsDir, f)] = t;
  for (const [kind, path] of Object.entries(wrangler)) want[path] = wranglerToml(config, kind);
  return Object.entries(want).filter(([p, t]) => !existsSync(p) || readFileSync(p, "utf8") !== t).map(([p]) => p);
}

/** Write <dir>/<template_id>.html (and .txt) for every template; returns the previews. */
export function writePreviews(config, dir, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const previews = renderPreviews(config, opts);
  for (const p of previews) {
    writeFileSync(join(dir, `${p.template_id}.html`), p.html);
    writeFileSync(join(dir, `${p.template_id}.txt`), `Subject: ${p.subject}\n\n${p.text}`);
  }
  return previews;
}

export { previewIndex };
