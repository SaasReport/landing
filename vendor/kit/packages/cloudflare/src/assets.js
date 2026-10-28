/**
 * Browser assets of the kit (Node only — used by the CLI and tests, never bundled into the Worker).
 *
 * The Worker's pages reference `${assets.base}/<file>?v=<VERSION>` (default base "/kit"). The files are NOT embedded in the
 * Worker: `kit init` / `kit deploy` copy them into the site's static assets directory (Workers Static Assets), e.g.
 * `public/kit/`, via writeAssets(dir). The copies are generated, so re-running keeps them in sync with the package.
 *
 *   kit.css, kit.js, podcast.js, glossary.js, tags.js   from packages/cloudflare/assets/
 *   calendar.js    the @saasreport/calendar engine (browser copy, for the date picker and calendar pages)
 *   datepicker.js  the @saasreport/calendar date picker, importing "./calendar.js" and "./hijri.js"
 *   copy.js        the @saasreport/calendar copy (messages, holiday titles, picker words) as data
 *   hijri.js       the @saasreport/calendar Hijri conversions (no imports), for the date picker
 *   instant.js     the @saasreport/calendar Solar Hijri arithmetic (no imports), imported by calendar.js
 *   format.js      @saasreport/format as a classic script (globalThis.KitFormat): the one number formatter, loaded
 *                  before every other script of the Worker's pages (CONSTITUTION.md §7)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { formatForBrowser } from "@saasreport/format/browser";

export const OWN_ASSETS = ["kit.css", "kit.js", "podcast.js", "glossary.js", "tags.js"];
const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

/** Directory of @saasreport/calendar's sources. */
export function calendarSrcDir() {
  try { return dirname(fileURLToPath(import.meta.resolve("@saasreport/calendar"))); }
  catch { return dirname(createRequire(import.meta.url).resolve("@saasreport/calendar")); }
}

export const GENERATED = (from) => `/* GENERATED from @saasreport/calendar/src/${from} by @saasreport/cloudflare — do not edit here. */\n`;
/** The engine as a browser module. */
export const engineForBrowser = (src) => GENERATED("index.js") + src;
/** The relative modules a browser module imports ("./x.js"); every one must be an asset next to it. */
export const relativeImports = (src) => [...src.matchAll(/^\s*import\b[^;]*?from\s+"\.\/([^"]+)";/gm)].map((m) => m[1]);
/** The picker as a browser module that imports the engine copy next to it: the calendar's picker-core.js plus the
 *  registration statements of its picker.js (everything there but comments, imports and re-exports). */
export const pickerRegistration = (pickerSrc) => "\n" + pickerSrc.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => l.trim() && !/^(import|export \* from)\b/.test(l.trim())).join("\n") + "\n";
export const pickerForBrowser = (coreSrc, pickerSrc = "") => GENERATED("picker-core.js") + coreSrc.replace(/from "\.\/index\.js";/, 'from "./calendar.js";') + pickerRegistration(pickerSrc);

/** Every asset file: [{ path, content }] (paths relative to the assets base). */
export async function assetFiles({ calendar = true } = {}) {
  const files = await Promise.all(OWN_ASSETS.map(async (path) => ({ path, content: await readFile(join(ASSETS_DIR, path), "utf8") })));
  files.push({ path: "format.js", content: formatForBrowser() });
  if (calendar) {
    const dir = calendarSrcDir();
    files.push({ path: "calendar.js", content: engineForBrowser(readFileSync(join(dir, "index.js"), "utf8")) });
    files.push({ path: "copy.js", content: GENERATED("copy.js") + readFileSync(join(dir, "copy.js"), "utf8") });
    files.push({ path: "hijri.js", content: GENERATED("hijri.js") + readFileSync(join(dir, "hijri.js"), "utf8") });
    files.push({ path: "instant.js", content: GENERATED("instant.js") + readFileSync(join(dir, "instant.js"), "utf8") });
    files.push({ path: "datepicker.js", content: pickerForBrowser(readFileSync(join(dir, "picker-core.js"), "utf8"), readFileSync(join(dir, "picker.js"), "utf8")) });
  }
  return files;
}

/** Write the assets into a directory (e.g. "public/kit"). Returns the written paths. */
export async function writeAssets(dir, opts) {
  await mkdir(dir, { recursive: true });
  const files = await assetFiles(opts);
  for (const f of files) await writeFile(join(dir, f.path), f.content);
  return files.map((f) => join(dir, f.path));
}
