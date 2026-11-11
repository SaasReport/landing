/**
 * kit site build [--config site.config.js] [--out site] [--check]
 *   Generates an @saasreport/site project (tokens, locales, content, script strings and data): the landing and inner pages,
 *   the client scripts and the theme CSS, once per locale, plus sitemap.<code>.xml when the project asks for it.
 *   --check writes nothing and exits 1 when a generated file differs from the one on disk (parity guard).
 * kit site check [--config site.config.js]   validates tokens, locale packs and content; exit 1 on problems.
 * kit site shell [--out site] [--exempt "api/**,…"]
 *   every built page carries the site shell (menu drawer + global search, src/shell.js) and the search index exists.
 * kit site shell-qa <url...> [--widths 390,1440] [--query word] [--playwright dir] [--chromium path]
 * kit site visual-qa [--out site] [--theme-only] [--viewports 390x844,1280x800] [--schemes light,dark] [--shots templates|all|none]
 *   [--shots-dir .visual-qa/shots] [--shot-height 2400] [--per-template 8] [--report .visual-qa/report.json] [--pages glob,…] [--exclude glob,…] [--playwright dir] [--chromium path]
 *   the rendered gate of the colour canon (docs/COLOUR.md): serves the built site locally, opens every page at each viewport
 *   and scheme and fails on contrast below AA against the effective background, form-control and focus-ring contrast,
 *   links told apart by colour alone, horizontal overflow, clipped or overlapping text, a missing web font, images
 *   without size, console errors and colour literals at runtime. Writes screenshots and a kit.visual-qa.v1 report.
 * kit site search-qa [--out site] [--config search-qa.json] [--viewports 390x844,1280x800] [--shots-dir .search-qa/shots] [--report .search-qa/report.json] [--playwright dir] [--chromium path]
 *   the rendered gate of the global search: serves the built site locally and, at each viewport, types queries with real keys
 *   (derived from the site's own index, plus search-qa.json, kit.search-qa.v1): results, <mark> highlight, one-edit typos,
 *   Arabic-script folding, empty state and one-character hint, combobox/listbox keyboard, key-to-frame latency (budget 130 ms),
 *   exactly one dialog on Ctrl+K, no sideways scroll at 390 px, no console errors. Writes screenshots and a report.
 * kit site contrast-qa <url...> [--widths 390] [--wait ms] [--playwright dir] [--chromium path]   text below WCAG AA
 *   in a real browser, per page and width: the menu, search and Sections buttons are visible, the menu opens with links, the
 *   search answers the query, and no fixed element shows and hides while the page scrolls. Exit 1 on any failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "../args.js";

async function loadSite(io, flags) {
  const file = String(flags.config || "site.config.js");
  const path = resolve(io.cwd, file);
  if (!existsSync(path)) throw new CliError(`no ${file} in ${io.cwd} (an @saasreport/site project: name, url, locales, tokens, content)`);
  let mod;
  try { mod = await import(pathToFileURL(path).href); }
  catch (e) { throw new CliError(`cannot load ${file}: ${e?.message || e}`); }
  const project = mod.default ?? mod.site;
  if (!project || typeof project !== "object") throw new CliError(`${file} must export the site project as its default export`);
  return project;
}

export async function site(io, { _: [sub = "build", ...rest], flags }) {
  if (sub === "shell") return shellCheck(io, flags);
  if (sub === "shell-qa") return shellQa(io, rest, flags);
  if (sub === "contrast-qa") return contrastQa(io, rest, flags);
  if (sub === "visual-qa") return visualQaCmd(io, flags);
  if (sub === "search-qa") return searchQaCmd(io, flags);
  const { buildSite, compareSite, checkProject } = await import("@saasreport/site");   // only this command needs it
  const project = await loadSite(io, flags);
  const problems = checkProject(project);
  if (problems.length) {
    io.err(`${problems.length} problem${problems.length === 1 ? "" : "s"} in the site project:`);
    for (const p of problems) io.err(`  - ${p}`);
    return 1;
  }
  if (sub === "check") { io.out(`ok: ${Object.keys(project.content).join(", ")}; tokens, locales and content valid.`); return 0; }
  if (sub !== "build") throw new CliError(`unknown site command "${sub}" (build, check, shell, shell-qa, contrast-qa, visual-qa, search-qa)`);
  const check = Boolean(flags.check);
  // the project's own files (view and asset sources) are relative to its config, wherever the command runs from
  const { dirname } = await import("node:path");
  const { files, out, locales } = buildSite(project, { root: dirname(resolve(io.cwd, String(flags.config || "site.config.js"))), outDir: flags.out ? resolve(io.cwd, String(flags.out)) : undefined, write: !check });
  if (check) {
    const diff = compareSite(files, out).filter((r) => r.status !== "same");
    for (const r of diff) io.err(`  ${r.status}: ${r.file}`);
    if (diff.length) { io.err(`${diff.length} generated file${diff.length === 1 ? "" : "s"} out of date (run kit site build)`); return 1; }
    io.out(`ok: ${Object.keys(files).length} files up to date (${locales.map((l) => `${l.code} ${l.path}`).join(", ")})`);
    return 0;
  }
  io.out(`wrote ${Object.keys(files).length} files to ${out}: ${Object.keys(files).join(", ")}`);
  return 0;
}

const list = (v) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);

async function shellCheck(io, flags) {
  const { checkShell } = await import("@saasreport/site");
  const dir = resolve(io.cwd, String(flags.out || "site"));
  if (!existsSync(dir)) throw new CliError(`no ${dir}: build the site first`);
  const { pages, problems } = checkShell(dir, { exempt: list(flags.exempt) });
  if (problems.length) { for (const p of problems.slice(0, 50)) io.err(`  - ${p}`); io.err(`kit site shell: ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${pages} pages`); return 1; }
  io.out(`ok: ${pages} pages carry the menu, the search and Sections; the index is there`);
  return 0;
}

async function shellQa(io, urls, flags) {
  if (!urls.length) throw new CliError("kit site shell-qa <url...>: give the pages to open");
  const { shellProbe, fixedFlicker } = await import("@saasreport/site");
  const { loadPlaywright } = await import("./diagrams.js");
  const { playwright, chromium } = await loadPlaywright(io, flags);
  const widths = list(flags.widths || "390,1440").map(Number);
  const browser = await playwright.chromium.launch(chromium ? { executablePath: chromium } : {});
  let bad = 0;
  try {
    for (const url of urls) for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(url, { waitUntil: "networkidle" });
      const query = String(flags.query || (await page.title()).split(/[\s—|·:]+/).find((w) => w.length > 3) || "a");
      const r = await shellProbe(page, { query });
      const flicker = await fixedFlicker(page);
      const fail = [!r.menu && "no visible menu button", !r.drawer && "the menu does not open", !r.search && "no visible search button", !r.sections && "no visible Sections control", !r.results && `no results for "${query}"`, flicker.length && `shows and hides on scroll: ${flicker.join(", ")}`].filter(Boolean);
      if (fail.length) bad++;
      (fail.length ? io.err : io.out)(`  ${fail.length ? "FAIL" : "ok  "} ${width}px ${url}${fail.length ? `: ${fail.join("; ")}` : ` (sections, menu ${r.drawer} links, ${r.results} results for "${query}")`}`);
      await page.close();
    }
  } finally { await browser.close(); }
  if (bad) { io.err(`kit site shell-qa: ${bad} page view${bad === 1 ? "" : "s"} failed`); return 1; }
  io.out(`ok: ${urls.length * widths.length} page views, menu and search work, nothing flickers`);
  return 0;
}

async function contrastQa(io, urls, flags) {
  if (!urls.length) throw new CliError("kit site contrast-qa <url...>: give the pages to open");
  const { contrastProbe } = await import("@saasreport/site");
  const { loadPlaywright } = await import("./diagrams.js");
  const { playwright, chromium } = await loadPlaywright(io, flags);
  const widths = list(flags.widths || "390").map(Number);
  const wait = Number(flags.wait || 2500);   // animated views (terminal tours) render a few states before the check
  const browser = await playwright.chromium.launch(chromium ? { executablePath: chromium } : {});
  let bad = 0;
  try {
    for (const url of urls) for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, bypassCSP: true });   // the probe evaluates its colour math in the page
      await page.goto(url, { waitUntil: "networkidle" });
      const seen = new Map();
      for (let i = 0; i < 3; i++) { await page.waitForTimeout(wait / 3); for (const r of await contrastProbe(page)) seen.set(`${r.path}|${r.color}|${r.background}`, r); }
      if (seen.size) bad++;
      (seen.size ? io.err : io.out)(`  ${seen.size ? "FAIL" : "ok  "} ${width}px ${url}${seen.size ? `: ${seen.size} text${seen.size === 1 ? "" : "s"} below AA` : ""}`);
      for (const r of seen.values()) io.err(`      ${r.ratio}:1 (needs ${r.need}) ${r.color} on ${r.background}: ${r.path} "${r.text}"`);
      await page.close();
    }
  } finally { await browser.close(); }
  if (bad) { io.err(`kit site contrast-qa: ${bad} page view${bad === 1 ? "" : "s"} below WCAG AA`); return 1; }
  io.out(`ok: ${urls.length * widths.length} page views, every text meets WCAG AA`);
  return 0;
}

async function searchQaCmd(io, flags) {
  const { searchQa, readConfig } = await import("../search-qa.js");
  const { loadPlaywright } = await import("./diagrams.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const outDir = resolve(io.cwd, String(flags.out || "site"));
  if (!existsSync(resolve(outDir, "search-index.json"))) throw new CliError(`no ${outDir}/search-index.json: build the site first (kit site build)`);
  const cfgFile = resolve(io.cwd, String(flags.config || "search-qa.json"));
  const config = readConfig(cfgFile);
  const { bundled } = await import("../bundled.js");
  const kit = bundled(), schema = kit.byName("search-qa");
  const bad = kit.validator.validate(config, schema);
  if (bad.length) throw new CliError(`${cfgFile} does not match kit.search-qa.v1:\n${bad.slice(0, 10).map((p) => `  ${p.path || "/"}: ${p.message}`).join("\n")}`);
  const { playwright, chromium } = await loadPlaywright(io, flags);
  const viewports = list(flags.viewports || "390x844,1280x800").map((v) => { const m = /^(\d+)x(\d+)$/.exec(v); if (!m) throw new CliError(`--viewports: "${v}" is not WIDTHxHEIGHT`); return [+m[1], +m[2]]; });
  const shotsDir = flags["shots-dir"] === "none" ? undefined : resolve(io.cwd, String(flags["shots-dir"] || ".search-qa/shots"));
  const reportFile = resolve(io.cwd, String(flags.report || ".search-qa/report.json"));
  const report = await searchQa({ outDir, playwright, chromium, viewports, config, shotsDir, log: (m) => io.out(m) });
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  if (!report.ok) {
    for (const f of report.failures.slice(0, 60)) io.err(`  ${f.kind} (${f.viewport}): ${f.message}`);
    io.err(`kit site search-qa: ${report.failures.length} finding${report.failures.length === 1 ? "" : "s"}; report ${reportFile}`);
    return 1;
  }
  io.out(`ok: ${report.cases.length} queries at ${report.viewports.join(", ")} (${Object.entries(report.latencyMs).map(([v, l]) => `${v} median ${l.median} ms`).join("; ")}); results, highlight, typo, folding, empty state, keyboard, one dialog on Ctrl+K and layout pass; report ${reportFile}`);
  return 0;
}

async function visualQaCmd(io, flags) {
  const { visualQa } = await import("../visual-qa.js");
  const { loadPlaywright } = await import("./diagrams.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const outDir = resolve(io.cwd, String(flags.out || "site"));
  if (!existsSync(outDir)) throw new CliError(`no ${outDir}: build the site first`);
  const { playwright, chromium } = await loadPlaywright(io, flags);
  const viewports = list(flags.viewports || "390x844,1280x800").map((v) => { const m = /^(\d+)x(\d+)$/.exec(v); if (!m) throw new CliError(`--viewports: "${v}" is not WIDTHxHEIGHT`); return [+m[1], +m[2]]; });
  const shotsDir = flags.shots === "none" ? undefined : resolve(io.cwd, String(flags["shots-dir"] || ".visual-qa/shots"));
  const reportFile = resolve(io.cwd, String(flags.report || ".visual-qa/report.json"));
  let allow = [];
  try { allow = (JSON.parse(readFileSync(resolve(io.cwd, "canon.allow.json"), "utf8")).entries || []).filter((e) => e.category === "contrast"); } catch { /* no allow-list: no declared exceptions */ }
  const report = await visualQa({ outDir, playwright, chromium, allow, theme: flags["no-theme"] === undefined, pagesPass: flags["theme-only"] === undefined, viewports, schemes: list(flags.schemes || "light,dark"), shots: String(flags.shots || "templates"), shotsDir, shotHeight: Number(flags["shot-height"] || 2400), perTemplate: flags["per-template"] === undefined ? 8 : Number(flags["per-template"]),
    include: list(flags.pages), exclude: list(flags.exclude), log: (m) => (flags.verbose ? io.out(m) : (m.includes("FAIL") && io.err(m))) });
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  for (const n of report.notes) io.out(`  note: ${n}`);
  if (!report.ok) {
    const shown = new Map();
    for (const f of report.failures) { const k = `${f.kind}|${f.message}|${f.path}`; const e = shown.get(k) || { ...f, views: [] }; e.views.push(`${f.viewport} ${f.scheme} ${f.url}`); shown.set(k, e); }
    for (const e of [...shown.values()].slice(0, 80)) io.err(`  ${e.kind}: ${e.message}${e.path ? ` [${e.path}]` : ""}${e.text ? ` "${e.text}"` : ""} (${e.views.length} view${e.views.length === 1 ? "" : "s"}, e.g. ${e.views[0]})`);
    io.err(`kit site visual-qa: ${report.failures.length} finding${report.failures.length === 1 ? "" : "s"} (${Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join(", ")}) in ${report.views} page views; report ${reportFile}`);
    return 1;
  }
  io.out(`ok: ${report.pages} pages, ${report.views} views (${report.viewports.join(", ")}; ${report.schemes.join(", ")}), contrast, controls, focus, links, overflow, text, fonts, images, console and runtime literals pass; report ${reportFile}`);
  return 0;
}
