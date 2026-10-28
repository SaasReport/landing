// A tiny static site for the browser tests: one page of generated widgets, the runtime and the stylesheet rendered from tokens.
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildWidgets, renderWidgetsBody, themeTemplate, runtimeFiles, RUNTIME_FILE, RUNTIME_DIR } from "../../src/index.js";
import { renderCss } from "../../../site/src/css.js";
import { resolveTokens, colorVars } from "../../../site/src/tokens.js";
import { createLocale } from "../../../site/src/locale.js";

/** Write the page for one locale into `dir`; returns { dir, generated }. `css` is appended (a project's own overrides). */
export async function writeWidgetsSite(dir, specPath, { locale = "en", tokens = {}, css = "", filter = null, mode = "page" } = {}) {
  const built = await buildWidgets(specPath);
  const t = resolveTokens(tokens);
  const loc = built.generated.locales.find((l) => l.code === locale);
  mkdirSync(dir, { recursive: true });
  let body = renderWidgetsBody(built.generated, locale, { registry: built.registry });
  if (filter) body = filter(body);
  writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="${locale}" dir="${loc.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Widgets</title><link rel="stylesheet" href="/widgets.css"></head><body class="kw-body">${body}<script src="/widgets.js" defer></script></body></html>`);
  const rendered = renderCss(themeTemplate(built.registry), { file: "widgets.css", tokens: t, locale: createLocale(locale), name: "Test" });
  writeFileSync(join(dir, "widgets.css"), `:root{\n${colorVars(t.color)}\n}\nbody{margin:0;font-family:system-ui,sans-serif;background:var(--c-bg);color:var(--c-ink)}\n.kw-page{max-width:1000px}\n${rendered}\n${css}`);
  cpSync(RUNTIME_FILE, join(dir, "widgets.js"));
  for (const [rel, file] of runtimeFiles(built.registry)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); cpSync(file, join(dir, rel)); }
  cpSync(join(RUNTIME_DIR, "lib"), join(dir, "widgets/lib"), { recursive: true });
  const src = dirname(specPath);
  for (const f of readdirSync(src)) if (/\.(svg|png)$/.test(f)) cpSync(join(src, f), join(dir, f));
  return { dir, generated: built.generated, registry: built.registry };
}
