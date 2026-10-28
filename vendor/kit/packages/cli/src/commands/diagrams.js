/**
 * kit diagrams theme                 rewrite every diagram (docs/diagrams/*.mmd and ```mermaid blocks in Markdown) to
 *                                    the project's brand theme, docs/diagrams/theme.init (init line + classDefs)
 * kit diagrams render [files…] [--all] [--mermaid path] [--chromium path] [--playwright dir]
 *                                    apply the theme, write the lineage graph (docs/diagrams/lineage.mmd) and the index
 *                                    (docs/diagrams/README.md) from the diagram headers, then render each stale .mmd (or the
 *                                    files given, or --all) to its PNG, stamped with the source's hash and id; bundled
 *                                    Mermaid + local Chromium, no network
 *                                    The render gates refuse a diagram without the brand: a theme without colour roles or a font file, a font
 *                                    that is not a loaded face, text clipped, a diagram wider than 2400 px, a picture without the theme's
 *                                    background, ink or accent; every PNG carries the identity footer drawn from its header.
 * kit diagrams render --file <x.mmd> --out <dir> [--project p]
 *                                    the same for a diagram that lives outside docs/diagrams (a scratch deliverable)
 *                                    Every diagram is drawn in the theme of the PROJECT IN ITS HEADER: this repository's own project in its
 *                                    docs/diagrams/theme.init (which declares `%% kit:theme {"project":"<key>"}`), another registered project in its
 *                                    vendored theme (kit diagrams themes), a project with no theme is refused. `--project p` asserts the header's project.
 * kit diagrams derive [--config site.config.js] [--project key] [--check]
 *                                    write docs/diagrams/theme.init from an @saasreport/site project's tokens (color.*,
 *                                    font.sans and its 400 face) with the project declaration (kit.canon.json `project`, or --project);
 *                                    --check exits 1 when the file on disk differs
 * kit diagrams themes [--check]      the provenance of the vendored organisation themes (packages/core/registry/themes): exit 1 when a file
 *                                    differs from its recorded git blob id, or the registry and sources.json disagree
 * kit diagrams themes --sync <key> --from <file> --repo <owner/repo> --path <upstream path> --commit <sha> [--via copy|derive --source <file>] [--fonts-dir <dir>]
 *                                    refresh one vendored theme (a byte copy of the project's docs/diagrams/theme.init at that commit), its fonts and its record
 *                                    kit diagrams themes --sync <key> --from <file> --via provisional --note <reason> [--fonts-dir <dir>]   (a stand-in with no upstream)
 * kit diagrams migrate [--project key] [--out file]
 *                                    PROPOSE only: a worklist of the diagrams without a header (suggested id, project, identical bodies,
 *                                    mentioned paths) on stdout or in --out (outside the repository). It writes no header; the author does
 * kit diagrams check [--project key]
 *                                    exit 1 when a diagram's init line or theme classes differ from theme.init, a
 *                                    style line uses a colour outside the theme, a PNG is missing or older than its source
 *                                    (hash or id stamp), or the lineage rule is broken: a missing or invalid kit:diagram
 *                                    header, a duplicate id, a dangling reference, a cycle in derives_from / supersedes, a
 *                                    depicts path that does not exist, a stale generated index or lineage graph.
 *                                    and every Markdown mermaid block is paired: the rendered image first, relative path, alt = title + id,
 *                                    the source collapsed in <details> (the pairing standard, docs/DIAGRAMS.md). No warning level: a stub
 *                                    header that is not complete fails (there is no stub state)
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "../args.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { applyTheme, applyThemeToRepo, markdownFiles, mmdFiles, pngOf, renderSources, stampProblem, themeFromTokens, themeResolver, DIAGRAM_DIR, THEME_FILE } from "../diagrams.js";
import { resolveProjectName, syncTheme, themeSourceProblems, loadSources } from "../diagram-themes.js";
import { pairRepo } from "../diagram-pairing.js";
import { readHeader } from "../diagram-header.js";
import { checkDiagrams, syncDerived, entriesWithLineage, generateIndex, generateLineage, lineageProblems, lineageHeader, proposalText, proposeHeaders, projectOf, INDEX_FILE, LINEAGE_FILE } from "../diagram-lineage.js";

/** The PNG exists and is a valid, current product of kit diagrams render for this source and theme. */
function pngCurrent(png, source, t) {
  if (!existsSync(png)) return false;
  try { return stampProblem(readFileSync(png), { source, header: readHeader(source).header, theme: t }) === null; } catch { return false; /* a PNG whose stamp cannot be read is not current: it is rendered again */ }
}

/** The theme resolver of this repository: its own theme.init (with its project declaration) and the vendored themes of the registry. */
function themes(io) {
  try { return themeResolver(io.cwd); } catch (e) { throw new CliError(e.message); }
}
/** The theme of one source by its header's project; a refusal is a CliError. */
function themeOf(R, source, where) {
  try { return R.forSource(source); } catch (e) { throw new CliError(`${where}: ${e.message}`); }
}

/** Resolves a module path from the project first, then from the kit. */
function resolveFrom(io, spec) {
  for (const base of [join(io.cwd, "package.json"), import.meta.url]) {
    try { return createRequire(base).resolve(spec); } catch { /* not resolvable from this base: the next base is tried, and none is an error below */ }
  }
  return null;
}

async function renderDeps(io, flags) {
  if (io.renderDeps) return io.renderDeps;   // a test seam: the caller supplies the browser (a fake) and Mermaid path
  const env = io.env || {};
  const mermaidJs = flags.mermaid ? resolve(io.cwd, String(flags.mermaid)) : env.KIT_MERMAID || resolveFrom(io, "mermaid/dist/mermaid.min.js");
  if (!mermaidJs || !existsSync(mermaidJs)) throw new CliError("cannot find mermaid.min.js: pass --mermaid <path> or set KIT_MERMAID (npm i -D mermaid)");
  return { ...(await loadPlaywright(io, flags)), mermaidJs };
}

/** Playwright and the Chromium to drive: --playwright / KIT_PLAYWRIGHT / the project's or the kit's own install. */
export async function loadPlaywright(io, flags) {
  const env = io.env || {};
  const pwSpec = flags.playwright ? resolve(io.cwd, String(flags.playwright)) : env.KIT_PLAYWRIGHT || resolveFrom(io, "playwright");
  if (!pwSpec) throw new CliError("cannot find playwright: pass --playwright <dir> or set KIT_PLAYWRIGHT (npm i -D playwright)");
  let playwright;
  try {
    const entry = existsSync(pwSpec) && !pwSpec.endsWith(".js") && !pwSpec.endsWith(".mjs") ? createRequire(join(pwSpec, "package.json")).resolve("playwright") : pwSpec;
    playwright = await import(pathToFileURL(entry).href);
    playwright = playwright.chromium ? playwright : playwright.default;
  } catch (e) { throw new CliError(`cannot load playwright from ${pwSpec}: ${e.message}`); }
  const chromium = flags.chromium ? String(flags.chromium) : env.KIT_CHROMIUM || undefined;
  return { playwright, chromium };
}

/**
 * kit diagrams render --file <x.mmd> --out <dir> [--project p]: a diagram that lives outside the repository's docs/diagrams (a
 * scratch deliverable) rendered by the same command, theme and gates; the PNG is stamped like any other. The source is rewritten to
 * the project's theme in place; its header is validated against the repository's diagrams (unknown references fail).
 */
async function renderScratch(io, flags) {
  const R = themes(io);
  const pr = projectOf(io.cwd);
  const file = resolve(io.cwd, String(flags.file));
  if (!file.endsWith(".mmd") || !existsSync(file)) throw new CliError(`${flags.file}: not an existing .mmd file`);
  const raw = readFileSync(file, "utf8");
  const header = readHeader(raw).header;
  if (flags.project && header) {
    const want = resolveProjectName(String(flags.project)), got = resolveProjectName(header.project);
    if (!want) throw new CliError(`--project ${flags.project} is not a project of the registry (nor kit)`);
    if (want.key !== got?.key) throw new CliError(`--project ${flags.project}, but the header of ${flags.file} says project ${header.project}: the header's project picks the theme`);
  }
  const t = themeOf(R, raw, String(flags.file));
  const source = applyTheme(raw, t);
  const hd = readHeader(source);
  const entry = { file: "(scratch)", block: null, where: String(flags.file), source, mmd: true, ...hd };
  const check = lineageProblems(io.cwd, [...entriesWithLineage(io.cwd, pr?.code), entry], { code: pr?.code });
  const mine = check.problems.filter((p) => p.file === entry.where);
  if (mine.length) { for (const p of mine) io.err(`  ${p.file}: ${p.problem}`); throw new CliError(`${mine.length} header problem${mine.length === 1 ? "" : "s"}: a diagram carries a valid kit:diagram header, reviewed, project one of the registry`); }
  const dir = flags.out ? resolve(io.cwd, String(flags.out)) : dirname(file);
  const out = join(dir, `${basename(file, ".mmd")}.png`);
  writeFileSync(file, source);
  const [r] = await renderSources(io.cwd, [{ label: String(flags.file), source, out, id: hd.header.id, theme: t }], t, await renderDeps(io, flags));
  if (!r.ok) { io.err(`  invalid: ${r.file}: ${r.error}`); return 1; }
  io.out(`rendered: ${out}\nLook at it before sending it (${hd.header.project}'s brand colours, font, footer, nothing clipped).`);
  return 0;
}

export async function diagrams(io, { _: [sub = "check", ...files], flags }) {
  if (sub === "theme") {
    let changed;
    try { changed = applyThemeToRepo(io.cwd, themes(io)); } catch (e) { throw e instanceof CliError ? e : new CliError(e.message); }
    for (const f of changed) io.out(`  themed: ${f}`);
    io.out(`ok: ${changed.length} file${changed.length === 1 ? "" : "s"} rewritten to the theme of their header's project`);
    return 0;
  }
  if (sub === "render" && flags.file) return renderScratch(io, flags);
  if (sub === "render") {
    const R = themes(io);
    const t = R.own.theme;
    try { applyThemeToRepo(io.cwd, R); } catch (e) { throw new CliError(e.message); }
    const pr = projectOf(io.cwd, flags.project);
    if (!pr) throw new CliError("cannot tell the project of this repository (kit.canon.json `project`, or --project)");
    for (const w of syncDerived(io.cwd)) io.out(`  regenerated from its derives_from parent: ${w}`);
    const heads = lineageProblems(io.cwd, entriesWithLineage(io.cwd, pr.code), { code: pr.code });
    if (heads.problems.length) {
      for (const p of heads.problems) io.err(`  ${p.file}: ${p.problem}`);
      throw new CliError(`${heads.problems.length} header problem${heads.problems.length === 1 ? "" : "s"}: every diagram carries a kit:diagram header (kit diagrams migrate lists the diagrams without one; the author writes it)`);
    }
    const lineage = generateLineage(entriesWithLineage(io.cwd, pr.code).filter((e) => e.header && !e.header.generated), t, pr.code);
    const lf = join(io.cwd, LINEAGE_FILE);
    if (!existsSync(lf) || readFileSync(lf, "utf8") !== lineage) { writeFileSync(lf, lineage); io.out(`  generated: ${LINEAGE_FILE}`); }
    let list = files.length ? files.map((f) => relative(io.cwd, resolve(io.cwd, f))) : mmdFiles(io.cwd);
    for (const f of list) if (!f.endsWith(".mmd") || !existsSync(join(io.cwd, f))) throw new CliError(`${f}: not a .mmd file`);
    if (!files.length && !flags.all) {
      list = list.filter((f) => {
        const src = readFileSync(join(io.cwd, f), "utf8");
        return !pngCurrent(join(io.cwd, pngOf(f)), src, themeOf(R, src, f));
      });
    }
    const writeIndex = () => {
      const text = generateIndex(entriesWithLineage(io.cwd, pr.code).map((e) => (e.file === LINEAGE_FILE ? { ...e, header: lineageHeader(pr.code) } : e)), { projectName: pr.key });
      const xf = join(io.cwd, INDEX_FILE);
      if (!existsSync(xf) || readFileSync(xf, "utf8") !== text) { writeFileSync(xf, text); io.out(`  generated: ${INDEX_FILE}`); }
    };
    if (!files.length && !list.includes(LINEAGE_FILE) && !flags.all) {
      if (!pngCurrent(join(io.cwd, pngOf(LINEAGE_FILE)), lineage, t)) list.push(LINEAGE_FILE);
    }
    // the Markdown pairing (docs/DIAGRAMS.md): image first, source collapsed; blocks no .mmd covers get docs/diagrams/blocks/<id>.png
    const pairing = pairRepo(io.cwd, markdownFiles(io.cwd));
    for (const f of pairing.changed) io.out(`  paired: ${f}`);
    const fresh = (png, source) => pngCurrent(join(io.cwd, png), source, themeOf(R, source, png));
    const blockItems = pairing.targets.filter((x) => x.own && (flags.all || !fresh(x.png, x.source))).map((x) => ({ label: x.png, source: x.source, out: x.png, id: x.id, theme: themeOf(R, x.source, x.png) }));
    if (!list.length && !blockItems.length) { writeIndex(); io.out(`ok: every PNG in ${DIAGRAM_DIR} is up to date`); return 0; }
    const items = [...list.map((f) => { const src = readFileSync(join(io.cwd, f), "utf8"); return { label: f, source: src, out: pngOf(f), id: readHeader(src).header?.id, theme: themeOf(R, src, f) }; }), ...blockItems];
    const results = await renderSources(io.cwd, items, t, await renderDeps(io, flags));
    writeIndex();
    let bad = 0;
    for (const r of results) {
      if (r.ok) io.out(`  rendered: ${r.file.endsWith(".mmd") ? pngOf(r.file) : r.file}`);
      else { bad++; io.err(`  invalid: ${r.file}: ${r.error}`); }
    }
    io.out(`${results.length - bad} rendered, ${bad} failed. Look at every PNG before committing it.`);
    return bad ? 1 : 0;
  }
  if (sub === "derive") {
    const file = String(flags.config || "site.config.js");
    const path = resolve(io.cwd, file);
    if (!existsSync(path)) throw new CliError(`no ${file} in ${io.cwd}: derive reads the brand tokens of an @saasreport/site project`);
    const mod = await import(pathToFileURL(path).href);
    const project = mod.default ?? mod.site;
    const declared = projectOf(io.cwd, flags.project);
    const pk = declared && resolveProjectName(declared.key);
    if (!pk) throw new CliError("cannot tell the project of this repository (kit.canon.json `project`, or --project <registry key>): the theme declares whose it is, never guessed from a git remote");
    let text;
    try { text = themeFromTokens(project.tokens, { root: io.cwd, name: project.name, source: file, project: pk.key }); } catch (e) { throw new CliError(e.message); }
    const out = join(io.cwd, THEME_FILE);
    if (flags.check) {
      const cur = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (cur !== text) { io.err(`${THEME_FILE} differs from the brand tokens in ${file} (run kit diagrams derive)`); return 1; }
      io.out(`ok: ${THEME_FILE} matches the brand tokens`);
      return 0;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    io.out(`wrote ${THEME_FILE} from the tokens of ${file}`);
    return 0;
  }
  if (sub === "themes") {
    if (flags.sync) {
      const key = String(flags.sync);
      try {
        const r = syncTheme(key, { from: flags.from && resolve(io.cwd, String(flags.from)), repo: flags.repo && String(flags.repo), path: flags.path && String(flags.path), commit: flags.commit && String(flags.commit), via: flags.via && String(flags.via), source: flags.source && resolve(io.cwd, String(flags.source)), note: flags.note && String(flags.note), fontsDir: flags["fonts-dir"] && resolve(io.cwd, String(flags["fonts-dir"])) });
        io.out(`synced ${key}: ${r.theme} (blob ${r.record.blob}) ${r.record.repo ? `from ${r.record.repo}@${r.record.commit.slice(0, 7)} ${r.record.path}` : "with no upstream"} (${r.record.via}); ${r.record.fonts.length} font file${r.record.fonts.length === 1 ? "" : "s"}`);
      } catch (e) { throw new CliError(e.message); }
    }
    const problems = themeSourceProblems().filter((p) => !flags.sync || p.includes(`project ${flags.sync}`));
    for (const p of problems) io.err(`  ${p}`);
    if (problems.length) { io.err(`${problems.length} vendored theme problem${problems.length === 1 ? "" : "s"}`); return 1; }
    const { doc } = loadSources();
    if (!flags.sync) io.out(`ok: ${doc.themes.length} vendored organisation themes match their recorded provenance (${doc.themes.map((t) => t.project).join(", ")})`);
    return 0;
  }
  if (sub === "migrate") {
    // PROPOSE only: a worklist of headerless diagrams on stdout or in --out (outside the repository). No header, no file in the repo.
    const pr = projectOf(io.cwd, flags.project);
    if (!pr) throw new CliError("cannot tell the project of this repository (kit.canon.json `project`, or --project <key>)");
    const { proposals, problems } = proposeHeaders(io.cwd, { code: pr.code });
    for (const p of problems) io.err(`  ${p.file}: ${p.problem}`);
    const text = proposalText(proposals);
    if (flags.out) {
      const out = resolve(io.cwd, String(flags.out));
      const rel = relative(io.cwd, out);
      if (!rel.startsWith("..") && !rel.startsWith("/")) throw new CliError(`--out ${flags.out} is inside the repository: the worklist is written outside it (a repository never holds a half-migrated state)`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${text}\n`);
      io.out(`wrote the worklist (${proposals.length} diagram${proposals.length === 1 ? "" : "s"}) to ${out}; the repository is unchanged`);
    } else io.out(text);
    return problems.length ? 1 : 0;
  }
  if (sub === "check") {
    const { problems, counts } = checkDiagrams(io.cwd, { project: flags.project });
    for (const p of problems) io.err(`  ${p.file}: ${p.problem}`);
    if (problems.length) {
      io.err(`${problems.length} diagram problem${problems.length === 1 ? "" : "s"} (fix: write the header, then kit diagrams render; kit diagrams migrate lists headerless diagrams)`);
      return 1;
    }
    io.out(`ok: ${counts.mmd} diagrams and ${counts.blocks} Markdown mermaid blocks follow docs/diagrams/theme.init and carry valid headers (${counts.ids} unique ids); every PNG matches its source`);
    return 0;
  }
  throw new CliError(`unknown diagrams command "${sub}" (theme, derive, themes, render, migrate, check)`);
}
