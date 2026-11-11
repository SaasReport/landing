/**
 * The kit theme's own reviewed contrast entries (packages/site/theme/contrast.json: declared surfaces and containers, and exceptions,
 * each with its reason). They are the kit's: they excuse a pair only in a sheet that IS one of the kit's theme templates, matched
 * exactly (never by a file name a project may share), and each entry is then handed to that sheet's own path, so the one matcher
 * of the gates (file, match, context) applies and nothing else is excused. A project's exceptions are its canon.allow.json.
 *
 *   kitEntries()            → the entries as written (the file is a theme template of @saasreport/site)
 *   kitTemplateOf(text)     → the theme template a stylesheet was rendered from ("directory.css"), or "" when it is not one of the kit's
 *   themeEntries(sheets)    → [{ ...entry, file: <the sheet's own path> }] for every sheet that is a kit template
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { THEME_CSS, EXTRA_THEME, readTheme } from "@saasreport/site";

const require = createRequire(import.meta.url);
let cache = null;

/** The kit theme's entries, resolved through the @saasreport/site export; a missing or unparsable file is an error, never an empty list. */
export function kitEntries() {
  if (cache) return cache;
  const file = require.resolve("@saasreport/site/theme/contrast.json");
  const data = JSON.parse(readFileSync(file, "utf8"));   // throws on a parse error
  if (!Array.isArray(data.entries)) throw new Error(`${file}: "entries" must be an array`);
  const templates = new Set([...THEME_CSS, ...Object.keys(EXTRA_THEME)]);
  for (const e of data.entries) if (!templates.has(e.file)) throw new Error(`${file}: ${e.match}: "${e.file}" is not a theme template of @saasreport/site`);
  return (cache = data.entries);
}

const literals = new Map();
/** The text between a template's {{placeholders}}: what any sheet rendered from it contains, in order. */
const fragmentsOf = (file) => { if (!literals.has(file)) literals.set(file, readTheme(file).split(/\{\{[\w.|]+\}\}/).filter((x) => x.trim())); return literals.get(file); };
export function kitTemplateOf(text) {
  for (const file of [...THEME_CSS, ...Object.keys(EXTRA_THEME)]) {
    let at = 0, ok = true;
    for (const frag of fragmentsOf(file)) { const i = text.indexOf(frag, at); if (i < 0) { ok = false; break; } at = i + frag.length; }
    if (ok) return file;
  }
  return "";
}

export function themeEntries(sheets) {
  const out = [], entries = kitEntries();
  for (const s of sheets) {
    const tpl = kitTemplateOf(s.text);
    if (tpl) for (const e of entries) if (e.file === tpl) out.push({ ...e, file: s.path || s.file, inheritedFromKit: true });
  }
  return out;
}
