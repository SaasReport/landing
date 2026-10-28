/**
 * The theme's CSS files are templates (packages/site/theme/*.css) with {{placeholders}}:
 *   {{banner}}                 the file's first comment (tokens.css.banners[file] or a generic one)
 *   {{fontFaces}}              @font-face rules from tokens.font.faces
 *   {{colorVars}}              the colour roles as --c-<name> custom properties: the ONE place a colour literal is written
 *   {{color.accent}}           var(--c-accent): a token (and the derived colours, tokens.js derivedColors: {{color.onAccent}}); {{wash.accent}} a
 *                              wash's opacity in percent (tokens.js WASHES, the map the contrast check composites); opacity for color-mix(in srgb, {{color.accent}} {{wash.accent}}%, transparent)
 *   {{font.sans}} {{radius.btn}} {{note.railFrame}} {{motion.ui}} {{motion.easing}} {{picker.tag}} {{picker.prefix}}
 *   {{locale.counter}} {{locale.arrow.next}} {{locale.dir}}   from the locale pack (CSS counter style, reading-direction arrows, direction)
 *   {{t.apiLogEmpty|css}}      a chrome string, escaped for a CSS string
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { themeTemplate } from "../../widgets/src/theme.js";
import { rgb, fontFaces, colorVars, colorRefs, WASHES } from "./tokens.js";

export const THEME_DIR = fileURLToPath(new URL("../theme/", import.meta.url));
export const THEME_CSS = ["styles.css", "showcase.css", "terminal.css", "pages.css", "calendar.css", "calendar-page.css", "notify.css",
  "content.css", "podcast.css", "datepicker.css", "sectors.css", "directory.css", "lab.css", "surfaces.css"];

/** Theme files that live in another kit package (rendered with the same tokens), added when a page type needs them. */
export const EXTRA_THEME = {
  "widgets.css": fileURLToPath(new URL("../../widgets/theme/widgets.css", import.meta.url)),
  "workbench.css": fileURLToPath(new URL("../../workbench/theme/workbench.css", import.meta.url)),
};

/** A theme template; the widgets one is the engine's base plus every kit plugin's own styles. */
export const readTheme = (file, registry) => (file === "widgets.css" ? themeTemplate(registry) : readFileSync(EXTRA_THEME[file] || `${THEME_DIR}${file}`, "utf8"));

const FILTERS = {
  rgb,
  url: (v) => encodeURIComponent(v),
  css: (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a "),
};

/** Render one theme CSS template with tokens and a locale runtime. */
export function renderCss(template, { file, tokens, locale, name }) {
  const ctx = {
    color: colorRefs(tokens.color), wash: Object.fromEntries(Object.entries(WASHES).map(([k, w]) => [k, String(Math.round(w.alpha * 1000) / 10)])), radius: tokens.radius, font: tokens.font, note: tokens.css?.notes || {}, motion: tokens.motion, picker: tokens.picker,
    locale: { counter: locale.counter, arrow: locale.arrow, dir: locale.dir }, t: locale.strings,
  };
  return template.replace(/\{\{([\w.]+)(?:\|(\w+))?\}\}/g, (m, path, filter) => {
    if (path === "banner") return tokens.css?.banners?.[file] ?? `/* ${name} — ${file}, the site theme of @saasreport/site */`;
    if (path === "fontFaces") return fontFaces(tokens);
    if (path === "colorVars") return colorVars(tokens.color);
    const v = path.split(".").reduce((o, k) => (o == null ? o : o[k]), ctx);
    if (v == null) throw new Error(`${file}: unknown theme placeholder ${m}`);
    if (filter && !FILTERS[filter]) throw new Error(`${file}: unknown filter ${filter} in ${m}`);
    return filter ? FILTERS[filter](v) : String(v);
  });
}

/** Placeholders a template uses (for tests and docs). */
export const placeholders = (template) => [...new Set([...template.matchAll(/\{\{([\w.|]+)\}\}/g)].map((m) => m[1]))];
