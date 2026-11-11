/**
 * writeTwins(dir, { url, name, exclude, llms }) — Markdown twins for every page already in a built output directory,
 * including pages buildSite did not write (hand-made pages, pages a project's own build script generates). Node only.
 *
 * For each <path>/index.html that is not noindex and not excluded: writes <path>/index.md (pageMarkdown), adds the
 * <link rel="alternate" type="text/markdown"> to the HTML (once), and rewrites md-twins.json (kit.md-twins.v1) listing
 * every twin in the directory, sorted by path (each twin's locale is its page's <html lang>, else `locale`). With `llms` ({ about, intro } or true) it also writes llms.txt and
 * llms-full.txt (for a site whose Worker does not serve them). Returns the twins. Idempotent: running it twice changes nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pageMarkdown, twinPath, linkTwin, llmsIndex, llmsFullText } from "./markdown.js";
import { TWINS_FILE, TWINS_SCHEMA } from "./build.js";

const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f === "index.html") out.push(p);
  }
  return out;
};

export function writeTwins(dir, { url, name = "", exclude = [], locale = "", llms = null } = {}) {
  if (!url) throw new Error("writeTwins: url (the site URL) is required");
  const site = String(url).replace(/\/$/, "");
  const twins = [];
  for (const file of walk(dir).sort()) {
    const rel = relative(dir, file).split(sep).join("/");
    const path = `/${rel.replace(/index\.html$/, "")}`;
    if (exclude.some((x) => path === x || path.startsWith(x.endsWith("/") ? x : `${x}/`))) continue;
    if (path === "/404/") continue;
    const html = readFileSync(file, "utf8");
    if (/<meta name="robots" content="[^"]*noindex/i.test(html)) continue;
    const md = twinPath(rel);
    const t = pageMarkdown(html, { url: site + path, site: name });
    if (!existsSync(join(dir, md)) || readFileSync(join(dir, md), "utf8") !== t.markdown) writeFileSync(join(dir, md), t.markdown);
    const linked = linkTwin(html, `/${md}`);
    if (linked !== html) writeFileSync(file, linked);
    const lang = /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1];
    twins.push({ locale: lang || locale, path, url: site + path, md: `${site}/${md}`, title: t.title, description: t.description, markdown: t.markdown });
  }
  twins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(join(dir, TWINS_FILE), `${JSON.stringify({ schema: TWINS_SCHEMA, site, pages: twins.map(({ markdown, ...x }) => ({ ...x, bytes: Buffer.byteLength(markdown) })) }, null, 2)}\n`);
  if (llms) {
    const l = llms === true ? {} : llms;
    const s = { name, about: l.about || "", intro: l.intro || "", optional: [{ title: "Full text", url: `${site}/llms-full.txt` }, ...(l.optional || [])] };
    writeFileSync(join(dir, "llms.txt"), llmsIndex(s, twins));
    writeFileSync(join(dir, "llms-full.txt"), llmsFullText({ ...s, optional: l.optional || [] }, twins));
  }
  return twins;
}
