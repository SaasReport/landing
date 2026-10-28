/**
 * Each organisation's own diagram colours, vendored with provenance (docs/DIAGRAMS.md, "each organisation's own colours").
 *
 * A project keeps its theme in its own main repository (docs/diagrams/theme.init, derived from its brand tokens). The kit holds a
 * view of each, so a diagram whose header says `project: acme` is drawn in Acme's colours wherever it is rendered:
 *
 *   packages/core/registry/projects.json       the project's `theme`: its vendored file (themes/<key>.init)
 *   packages/core/registry/themes/<key>.init   the vendored theme (a byte copy, or the derive output; never hand-edited)
 *   packages/core/registry/themes/fonts/<key>/ the font files its `%% font:` lines load
 *   packages/core/registry/themes/sources.json the provenance: repo, path, upstream commit, git blob ids (theme-sources schema)
 *
 * This module reads and writes those files and knows nothing of Mermaid: diagrams.js parses the text and picks the theme.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatProblems } from "@saasreport/core/schema";
import { bundled } from "./bundled.js";

export const THEMES_DIR = "themes";
export const SOURCES_FILE = "themes/sources.json";
export const KIT_PROJECT = "kit";

/** The git blob id of some content: sha1 of "blob <length>\0<content>", what `git hash-object` prints. */
export function gitBlobId(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** The registry project a name refers to: its key, its short code (saasreport) or `kit`. → { key, code, project } or null. `project`: the registry entry (none for kit). */
export function resolveProjectName(name, registry = bundled().registry) {
  if (name === KIT_PROJECT) return { key: KIT_PROJECT, code: KIT_PROJECT, project: null };
  for (const p of registry.projects) {
    const code = p.short ? p.short.replace(/-$/, "") : p.key;
    if (name === p.key || name === code) return { key: p.key, code, project: p };
  }
  return null;
}

/**
 * Other registered projects' repositories that a header points into (depicts ref/path, https lineage parents): a diagram whose
 * header says project X but whose `depicts` is a repository of project Y is Y's diagram drawn in X's colours (a diagram of another project labelled
 * kit came out in the kit's colours). A repository belongs to a project by its registry `github` list; an organisation that owns
 * repositories of exactly one project is that project's. → [{ field, text, repo, project }]
 */
export function foreignProjectRefs(header, registry = bundled().registry) {
  const own = resolveProjectName(header?.project, registry)?.key ?? header?.project;
  const repoOwner = new Map(), orgs = new Map();
  for (const p of registry.projects) for (const slug of p.github || []) {
    repoOwner.set(slug.toLowerCase(), p.key);
    const org = slug.split("/")[0].toLowerCase();
    orgs.set(org, orgs.has(org) && orgs.get(org) !== p.key ? null : p.key);
  }
  const strings = [];
  const add = (field, v) => { if (typeof v === "string") strings.push([field, v]); };
  (header?.depicts || []).forEach((d, i) => { add(`depicts[${i}].ref`, d?.ref); add(`depicts[${i}].path`, d?.path); });
  (header?.lineage?.derives_from || []).forEach((r, i) => add(`lineage.derives_from[${i}]`, r));
  const found = [];
  for (const [field, text] of strings) {
    for (const m of text.matchAll(/(?<![\w.@-])([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+)/g)) {
      const slug = `${m[1]}/${m[2]}`.toLowerCase();
      const project = repoOwner.get(slug) ?? orgs.get(m[1].toLowerCase());
      if (project && project !== own) found.push({ field, text, repo: `${m[1]}/${m[2]}`, project });
    }
  }
  return found;
}

const registryPath = (kit, rel) => join(kit.registryDir, rel);

/** The provenance document (validated against the theme-sources schema): { doc, problems: [string] }. */
export function loadSources(kit = bundled()) {
  const f = registryPath(kit, SOURCES_FILE);
  if (!existsSync(f)) return { doc: { $schema: "", themes: [] }, problems: [`packages/core/registry/${SOURCES_FILE} does not exist (kit diagrams themes --sync writes it)`] };
  let doc;
  try { doc = JSON.parse(readFileSync(f, "utf8")); } catch (e) { return { doc: { themes: [] }, problems: [`packages/core/registry/${SOURCES_FILE} is not valid JSON (${e.message})`] }; }
  const problems = formatProblems(kit.validator.validate(doc, kit.byName("theme-sources"))).map((p) => `${SOURCES_FILE}: ${p}`);
  return { doc, problems };
}

/**
 * Every provenance problem of the vendored themes: [string]. Registry and sources agree (a project with a `theme` has a source
 * record and the file, and the reverse), each record's repository belongs to its project, and every recorded blob id equals the
 * blob id of the file on disk: a hand edit of a vendored theme or font fails here.
 */
export function themeSourceProblems(kit = bundled()) {
  const { doc, problems: out } = loadSources(kit);
  if (out.length) return out;
  const P = (m) => out.push(m);
  const byProject = new Map();
  for (const t of doc.themes) {
    if (byProject.has(t.project)) P(`${SOURCES_FILE}: project ${t.project} is recorded twice`);
    byProject.set(t.project, t);
  }
  const themed = kit.registry.projects.filter((p) => p.theme);
  for (const p of themed) {
    const rec = byProject.get(p.key);
    if (!rec) { P(`project ${p.key} names the theme ${p.theme} but ${SOURCES_FILE} records no source for it`); continue; }
    const file = registryPath(kit, p.theme);
    if (!existsSync(file)) { P(`project ${p.key}: ${p.theme} does not exist`); continue; }
    if (rec.via !== "provisional" && !(p.github || []).includes(rec.repo)) P(`project ${p.key}: the recorded source repository ${rec.repo} is not one of its github repositories in projects.json`);
    const have = gitBlobId(readFileSync(file));
    if (have !== rec.blob) P(`project ${p.key}: ${p.theme} has blob ${have} but ${SOURCES_FILE} records ${rec.blob}: a vendored theme is never edited by hand (kit diagrams themes --sync ${p.key} --from <the project's docs/diagrams/theme.init>)`);
    const text = readFileSync(file, "utf8");
    const wanted = fontPaths(text);
    for (const w of wanted) if (!rec.fonts.some((f) => f.theme_path === w)) P(`project ${p.key}: the theme loads the font ${w} but ${SOURCES_FILE} records no vendored file for it`);
    for (const f of rec.fonts) {
      const ff = registryPath(kit, `${THEMES_DIR}/${f.file}`);
      if (!wanted.includes(f.theme_path)) P(`project ${p.key}: ${SOURCES_FILE} records the font ${f.theme_path}, which the theme does not load`);
      if (!existsSync(ff)) { P(`project ${p.key}: the vendored font ${f.file} does not exist`); continue; }
      const fb = gitBlobId(readFileSync(ff));
      if (fb !== f.blob) P(`project ${p.key}: the font ${f.file} has blob ${fb} but ${SOURCES_FILE} records ${f.blob}`);
    }
  }
  for (const key of byProject.keys()) if (!themed.some((p) => p.key === key)) P(`${SOURCES_FILE} records a source for ${key}, which has no \`theme\` in projects.json`);
  return out;
}

/** The font paths of a theme's `%% font: "Family" path` lines. */
export function fontPaths(text) {
  return text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim().match(/^%%\s*font:\s*(?:"[^"]+"|\S+)\s+(\S+)$/)?.[1]).filter(Boolean);
}

/**
 * The vendored theme of a registry project: { text, file, fontFiles: Map(theme path → absolute file) }, or null when the project
 * names none. Throws when the files do not match their recorded provenance (hand-edited) or a font is missing.
 */
export function vendoredTheme(project, kit = bundled()) {
  const entry = kit.registry.projects.find((p) => p.key === project);
  if (!entry?.theme) return null;
  const problems = themeSourceProblems(kit).filter((m) => m.includes(`project ${project}`) || m.includes(entry.theme));
  if (problems.length) throw new Error(`the vendored theme of ${project} is not what its provenance records: ${problems.join("; ")}`);
  const { doc } = loadSources(kit);
  const rec = doc.themes.find((t) => t.project === project);
  const file = registryPath(kit, entry.theme);
  return { text: readFileSync(file, "utf8"), file, fontFiles: new Map(rec.fonts.map((f) => [f.theme_path, registryPath(kit, `${THEMES_DIR}/${f.file}`)])) };
}

/**
 * kit diagrams themes --sync <key> --from <file>: refreshes one vendored theme, its fonts and its provenance record.
 * `opts`: { from (the theme file), fontsDir (a directory holding the font files by basename), repo, path, commit, via, source
 * (via derive: the source file at path, at commit, the theme was derived from; its blob is recorded as source_blob), note (via provisional:
 * a stand-in with no upstream, no repo, path or commit, and the reason it waits for the owner's brand kit) }.
 * Writes packages/core/registry/themes/<key>.init byte for byte, copies the fonts it loads, rewrites that project's record in sources.json.
 */
export function syncTheme(key, opts, kit = bundled()) {
  const entry = kit.registry.projects.find((p) => p.key === key);
  if (!entry) throw new Error(`${key} is not a project of the registry (packages/core/registry/projects.json)`);
  if (!entry.theme) throw new Error(`project ${key} has no \`theme\` in projects.json: add "theme": "${THEMES_DIR}/${key}.init" first (the registry links a project to its vendored file)`);
  const via = opts.via || "copy";
  if (!["copy", "derive", "provisional"].includes(via)) throw new Error(`--via is copy, derive or provisional (got ${via})`);
  const provisional = via === "provisional";
  if (provisional && !opts.note) throw new Error("--via provisional needs --note <why the theme is provisional and what it waits for>: a stand-in with no upstream says so on the record");
  if (provisional && (opts.repo || opts.path || opts.commit)) throw new Error("--via provisional has no upstream: pass no --repo, --path or --commit (a copy replaces it once the project publishes its theme.init)");
  for (const k of provisional ? ["from"] : ["from", "repo", "path", "commit"]) if (!opts[k]) throw new Error(`--${k} is required: the provenance record names where the theme came from, never guessed`);
  if (!provisional && !(entry.github || []).includes(opts.repo)) throw new Error(`--repo ${opts.repo} is not one of ${key}'s github repositories in projects.json (${(entry.github || []).join(", ") || "none"})`);
  if (!provisional && !/^[0-9a-f]{40}$/.test(opts.commit)) throw new Error(`--commit must be the full 40-hex upstream commit (got ${opts.commit})`);
  if (via === "derive" && !opts.source) throw new Error("--via derive needs --source <the upstream file at --path, at --commit>: its blob is recorded with the theme, so which upstream file it was derived from is on the record (re-deriving it is a check of its own: the project publishing its theme.init makes it a copy)");
  const bytes = readFileSync(opts.from);
  const fonts = [];
  for (const themePath of fontPaths(bytes.toString("utf8"))) {
    if (!opts.fontsDir) throw new Error(`the theme loads the font ${themePath}: pass --fonts-dir <directory holding ${basename(themePath)}>`);
    const src = join(opts.fontsDir, basename(themePath));
    if (!existsSync(src)) throw new Error(`the theme loads the font ${themePath} but ${src} does not exist`);
    fonts.push({ theme_path: themePath, file: `fonts/${key}/${basename(themePath)}`, src });
  }
  const dest = registryPath(kit, entry.theme);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  const records = fonts.map(({ src, ...rec }) => {
    const to = registryPath(kit, `${THEMES_DIR}/${rec.file}`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    return { ...rec, blob: gitBlobId(readFileSync(to)) };
  });
  const sf = registryPath(kit, SOURCES_FILE);
  const doc = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8")) : { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/theme-sources.schema.json", themes: [] };
  const upstream = provisional ? { note: opts.note } : { repo: opts.repo, path: opts.path, commit: opts.commit };
  const rec = { project: key, via, ...upstream, blob: gitBlobId(bytes), ...(via === "derive" ? { source_blob: gitBlobId(readFileSync(opts.source)) } : {}), fonts: records };
  const rest = doc.themes.filter((t) => t.project !== key);
  doc.themes = [...rest, rec].sort((a, b) => a.project.localeCompare(b.project));
  writeFileSync(sf, `${JSON.stringify(doc, null, 2)}\n`);
  return { theme: entry.theme, record: rec };
}
