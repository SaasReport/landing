/**
 * Diagrams in a project's brand theme.
 *
 * The theme is one file per project, `docs/diagrams/theme.init` in the project's main repo, derived from the
 * project's brand tokens:
 *
 *   %%{init: {"theme":"base","themeVariables":{...}}}%%          line 1: the Mermaid init line every diagram starts with
 *   classDef accent fill:#…,stroke:#…,color:#…                    the classes diagrams use (replaced wherever defined)
 *   classDef muted  fill:#…,stroke:#…,color:#…,stroke-dasharray:4 3
 *   %% kit:theme {"project":"saasreport"}                     which project's theme this is (generated, never guessed from a git remote)
 *   %% font: "Vazirmatn" site/fonts/Vazirmatn-Regular.ttf          font files the renderer loads (repo-relative)
 *
 * The theme a diagram is drawn in is chosen by the PROJECT IN ITS HEADER, not by the repository it is rendered in: the repository's
 * own project uses this file, another registered project uses its vendored theme (packages/core/registry/themes, `themeResolver`),
 * and a project with no theme is refused (never drawn in another organisation's colours).
 *
 * Diagrams are `docs/diagrams/*.mmd` (each with a sibling .png) and the ```mermaid blocks of the repo's Markdown
 * files (vendor/ and node_modules/ are skipped: they belong to other projects). Every PNG carries a tEXt chunk
 * `kit-diagram` = `sha256:<hash of its .mmd>`, so "the PNG is older than its source" is a content check that git
 * checkouts (which reset file times) cannot fool.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, extname, basename } from "node:path";
import { readHeader } from "./diagram-header.js";
import { bestText } from "./contrast.js";
import { bundled } from "./bundled.js";
import { resolveProjectName, vendoredTheme } from "./diagram-themes.js";
import { MAX_CSS_HEIGHT, MAX_CSS_WIDTH, footerHash, footerLines, paletteProblems, themeRoleProblems } from "./diagram-gates.js";
import { gitEnv } from "./git.js";

export const THEME_FILE = "docs/diagrams/theme.init";
export const DIAGRAM_DIR = "docs/diagrams";
export const THEME_DECL = "kit:theme";
export const STAMP_KEY = "kit-diagram";
export const STAMP_ID_KEY = "kit-diagram-id";
export const STAMP_PIXELS_KEY = "kit-diagram-pixels";
export const STAMP_THEME_KEY = "kit-diagram-theme";
export const STAMP_FOOTER_KEY = "kit-diagram-footer";
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", ".kit", ".wrangler"]);   // .kit: the kit's source checkout, its diagrams are the kit's
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

/**
 * theme.init text from a project's brand tokens, so every project's theme has the same shape and only brand values
 * differ. `c`: { accent (node fill), onAccent (text on it: AA), accentLine? (note border, default accent), accentTint (notes),
 * ink, rail, railDark, bg, sink, surface }. `font`: { family, path }.
 * `notes`: comment lines (where each value comes from). `project`: the registry key this theme belongs to (written as the `kit:theme` declaration).
 */
export function themeInit(c, font, notes = [], { project } = {}) {
  for (const k of ["onAccent", "surface", "accent", "accentTint", "ink", "rail", "railDark", "bg", "sink"]) if (!c[k]) throw new Error(`themeInit: the colour ${k} is required (the tokens decide it; there is no default)`);
  const on = c.onAccent, surface = c.surface, line = c.accentLine || c.accent;
  const v = {
    fontFamily: `${font.family}, Arial, sans-serif`, fontSize: "15px",
    textColor: c.ink, stateLabelColor: c.ink, transitionLabelColor: c.ink, background: c.bg,
    primaryColor: surface, primaryTextColor: c.ink, primaryBorderColor: c.ink, lineColor: c.railDark,
    secondaryColor: c.sink, tertiaryColor: c.bg, clusterBkg: c.sink, clusterBorder: c.rail, edgeLabelBackground: c.bg,
    titleColor: c.ink, actorBkg: c.ink, actorBorder: c.ink, actorTextColor: surface, actorLineColor: c.rail,
    signalColor: c.ink, signalTextColor: c.ink, labelBoxBkgColor: c.bg, labelBoxBorderColor: c.rail,
    noteBkgColor: c.accentTint, noteBorderColor: line, sequenceNumberColor: surface, stateBkg: surface, stateBorder: c.ink,
    transitionColor: c.railDark, specialStateColor: c.accent,
  };
  return [
    `%%{init: ${JSON.stringify({ theme: "base", themeVariables: v })}}%%`,
    `classDef accent fill:${c.accent},stroke:${c.accent},color:${on},stroke-width:2px`,
    `classDef muted fill:${surface},stroke:${c.rail},color:${c.railDark},stroke-dasharray:4 3`,
    ...(project ? [`%% ${THEME_DECL} ${JSON.stringify({ project })}`] : []),
    ...notes.map((n) => `%% ${n}`),
    `%% font: "${font.family}" ${font.path}`,
    "",
  ].join("\n");
}

/** Parses theme.init text → { init, initVars, classDefs: Map(name → def), fonts: [{ family, path }], palette: Set } */
export function parseTheme(text, file = THEME_FILE) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  const init = (lines[first] || "").trim();
  if (!/^%%\{init:.*\}%%$/.test(init)) throw new Error(`${file}: line 1 must be the Mermaid init line %%{init: {...}}%%`);
  let initVars;
  try { initVars = JSON.parse(init.slice("%%{init:".length, -"}%%".length)); }
  catch (e) { throw new Error(`${file}: the init line is not valid JSON (${e.message})`); }
  if (!initVars.themeVariables) throw new Error(`${file}: the init line has no themeVariables`);
  const classDefs = new Map();
  const fonts = [];
  let project = null;
  for (const raw of lines.slice(first + 1)) {
    const l = raw.trim();
    if (!l) continue;
    const decl = l.match(/^%%\s*kit:theme\s+(\{.*\})$/);
    if (!decl && /^%%\s*kit:theme\b/.test(l)) throw new Error(`${file}: the kit:theme declaration is {"project":"<registry key>"} and nothing else (got "${l}")`);
    if (decl) {
      let d;
      try { d = JSON.parse(decl[1]); } catch (e) { throw new Error(`${file}: the kit:theme declaration is not valid JSON (${e.message})`); }
      if (typeof d?.project !== "string" || !d.project || Object.keys(d).length !== 1) throw new Error(`${file}: the kit:theme declaration is {"project":"<registry key>"} and nothing else`);
      if (project !== null) throw new Error(`${file}: more than one kit:theme declaration`);
      project = d.project;
      continue;
    }
    const cd = l.match(/^classDef\s+(\S+)\s+(.+)$/);
    if (cd) { classDefs.set(cd[1], cd[2].trim()); continue; }
    const f = l.match(/^%%\s*font:\s*(?:"([^"]+)"|(\S+))\s+(\S+)$/);
    if (f) { fonts.push({ family: f[1] || f[2], path: f[3] }); continue; }
    if (l.startsWith("%%")) continue;   // a comment
    throw new Error(`${file}: unexpected line "${l}" (only classDef lines, %% font: lines and %% comments follow the init line)`);
  }
  const palette = new Set((text.match(HEX) || []).map((h) => h.toUpperCase()));
  // the hash is of what is drawn: the declaration says whose theme this is, not how it looks, so adding it repaints nothing
  const drawn = text.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*%%\s*kit:theme\s/.test(l)).join("\n");
  return { init, initVars, classDefs, fonts, palette, project, hash: createHash("sha256").update(drawn).digest("hex") };
}

export function loadTheme(root) {
  const path = join(root, THEME_FILE);
  if (!existsSync(path)) throw new Error(`no ${THEME_FILE} in ${root}: each project keeps its brand's diagram theme there (see the kit's docs/DIAGRAMS.md)`);
  return parseTheme(readFileSync(path, "utf8"));
}

/** Refusal text shared by render, theme and check when a repository's theme.init does not say whose it is. */
const noDeclaration = (file) => `${file} has no \`%% ${THEME_DECL} {"project":"<registry key>"}\` declaration: a repository states which project's theme it holds, never guessed from its git remote (kit diagrams derive writes it)`;

/**
 * Chooses the theme of a diagram from the PROJECT IN ITS HEADER (docs/DIAGRAMS.md, "each organisation's own colours"):
 * the repository's own project (declared in theme.init) draws in docs/diagrams/theme.init; another registered project in its vendored theme;
 * a registered project with no theme, or an unregistered one, is refused. There is no fallback to another project's colours.
 * → { own: { theme, project: { key, code } }, forProject(name), forSource(source), identify(initLine) → project key | null }
 */
export function themeResolver(root, kit = bundled()) {
  const ownTheme = loadTheme(root);
  if (!ownTheme.project) throw new Error(noDeclaration(THEME_FILE));
  const ownProject = resolveProjectName(ownTheme.project, kit.registry);
  if (!ownProject) throw new Error(`${THEME_FILE}: the kit:theme declaration names "${ownTheme.project}", which is not a project of the registry (packages/core/registry/projects.json) nor kit`);
  const cache = new Map([[ownProject.key, ownTheme]]);
  const vendored = (key) => {
    if (cache.has(key)) return cache.get(key);
    const v = vendoredTheme(key, kit);
    if (!v) return null;
    const t = parseTheme(v.text, `packages/core/registry/${kit.registry.projects.find((p) => p.key === key).theme}`);
    t.project = key; t.fontFiles = v.fontFiles;
    cache.set(key, t);
    return t;
  };
  const forProject = (name) => {
    const p = resolveProjectName(name, kit.registry);
    if (!p) throw new Error(`project "${name}" is not a project of the registry (packages/core/registry/projects.json) and not kit: there is no theme to draw its diagram in`);
    if (p.key === ownProject.key) return ownTheme;
    const t = p.project?.theme ? vendored(p.key) : null;
    if (!t) throw new Error(`project ${p.key} is registered but has no vendored theme (projects.json has no \`theme\` for it), and this repository's theme is ${ownProject.key}'s: its diagram is refused, never drawn in another project's colours (vendor its theme: kit diagrams themes --sync ${p.key} --from <its docs/diagrams/theme.init>)`);
    return t;
  };
  return {
    own: { theme: ownTheme, project: ownProject },
    forProject,
    /** A source without a valid header has no project: it is checked on the repository's own theme (the missing header is reported on its own). */
    forSource: (source) => { const pr = readHeader(source).header?.project; return pr ? forProject(pr) : ownTheme; },
    /** The project whose theme has this init line (own or vendored), or null. */
    identify: (line) => {
      if (ownTheme.init === line) return ownProject.key;
      for (const p of kit.registry.projects) if (p.theme) { try { if (forProject(p.key).init === line) return p.key; } catch { /* a broken vendored theme is reported where it is used */ } }
      return null;
    },
  };
}

/** The diagram text with the theme's init line (replaced or prepended) and the theme's classDefs. */
export function applyTheme(source, theme) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first].trim().startsWith("%%{init")) {
    lines[first] = lines[first].match(/^\s*/)[0] + theme.init;
  } else {
    const indent = first >= 0 ? lines[first].match(/^\s*/)[0] : "";
    lines.splice(Math.max(first, 0), 0, indent + theme.init);
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)classDef\s+(\S+)\s+\S/);
    if (m && theme.classDefs.has(m[2])) lines[i] = `${m[1]}classDef ${m[2]} ${theme.classDefs.get(m[2])}`;
  }
  // a class the diagram uses (`class a,b accent`, `a:::accent`) but never defines would draw as a default grey box: add the theme's definition
  const body = lines.filter((l) => !/^\s*%%/.test(l));
  const kind = (body.find((l) => l.trim()) || "").trim();
  if (/^(flowchart|graph|stateDiagram)/.test(kind)) {
    const defined = new Set(lines.map((l) => l.match(/^\s*classDef\s+(\S+)/)?.[1]).filter(Boolean));
    const indent = (body.find((l) => /^\s+\S/.test(l)) || "  ").match(/^\s*/)[0];
    for (const [name, def] of theme.classDefs) {
      const used = body.some((l) => new RegExp(`^\\s*class\\s+[^\\n]*\\b${name}\\s*$`).test(l) || new RegExp(`:::${name}\\b`).test(l));
      if (used && !defined.has(name)) { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(`${indent}classDef ${name} ${def}`, ""); }
    }
  }
  return lines.join("\n");
}

/** Problems of one diagram's text against the theme (init line, theme classes, colours in style lines). */
export function diagramProblems(source, theme) {
  const out = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const first = lines.find((l) => l.trim());
  if (!first || !first.trim().startsWith("%%{init")) out.push("no init line (the theme's line 1 must start the diagram)");
  else if (first.trim() !== theme.init) out.push("init line differs from the theme");
  for (const l of lines) {
    const t = l.trim();
    const m = t.match(/^classDef\s+(\S+)\s+(.+)$/);
    if (m && theme.classDefs.has(m[1]) && m[2].trim() !== theme.classDefs.get(m[1])) out.push(`classDef ${m[1]} differs from the theme`);
    if (/^(classDef|style|linkStyle)\s/.test(t)) {
      for (const h of t.match(HEX) || []) if (!theme.palette.has(h.toUpperCase())) out.push(`colour ${h} is not in the theme ("${t.slice(0, 60)}")`);
    }
  }
  // the organisation's colour is the brand, not decoration: every diagram marks its key node(s) with the theme's accent
  if (theme.classDefs.has("accent") && takesClasses(lines) && !USES_ACCENT.test(source)) out.push("the diagram carries none of the brand accent: mark its key node(s) with `class <ids> accent` (an all-white diagram is not in the organisation's colours)");
  return out;
}

/** The diagram's type takes node classes (flowchart, graph, stateDiagram, classDiagram); others draw in the theme's own roles. */
const takesClasses = (lines) => /^(flowchart|graph|stateDiagram|classDiagram)\b/.test(lines.find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() || "");

/** The source marks a node with the theme's accent class (class a,b accent or a:::accent). */
export const USES_ACCENT = { test: (source) => source.split("\n").some((l) => !l.trim().startsWith("%%") && (/^\s*class\s+\S+\s+accent\b/.test(l) || /:::accent\b/.test(l))) };

export function sourceHash(source) {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

// ---- PNG tEXt stamp ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png) {
  if (!png.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  const out = [];
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p);
    const type = png.toString("latin1", p + 4, p + 8);
    out.push({ type, start: p, end: p + 12 + len, data: png.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

/** The PNG with the tEXt chunks `kit-diagram` (the source hash) and, when `id` is given, `kit-diagram-id` (the header's id), replacing earlier ones, before IEND. */
export function stampPng(png, hash, id, extra = {}) {
  const mine = (c) => c.type === "tEXt" && [STAMP_KEY, STAMP_ID_KEY, STAMP_PIXELS_KEY, STAMP_THEME_KEY, STAMP_FOOTER_KEY].some((k) => c.data.toString("latin1").startsWith(`${k}\0`));
  const cs = chunks(png).filter((c) => !mine(c));
  const text = (key, value) => {
    const data = Buffer.from(`${key}\0${value}`, "latin1");
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write("tEXt", 4, "latin1");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    return chunk;
  };
  const stamps = [text(STAMP_KEY, `sha256:${hash}`), ...(id ? [text(STAMP_ID_KEY, id)] : []), text(STAMP_PIXELS_KEY, `sha256:${pixelHash(png)}`), ...(extra.theme ? [text(STAMP_THEME_KEY, `sha256:${extra.theme}`)] : []), ...(extra.footer ? [text(STAMP_FOOTER_KEY, `sha256:${extra.footer}`)] : [])];
  const parts = [SIG];
  for (const c of cs) { if (c.type === "IEND") parts.push(...stamps); parts.push(png.subarray(c.start, c.end)); }
  return Buffer.concat(parts);
}

/** sha256 of a PNG's image data (IHDR + every IDAT chunk): what a later edit of the picture changes, whatever the stamps say. */
export function pixelHash(png) {
  const h = createHash("sha256");
  for (const c of chunks(png)) if (c.type === "IHDR" || c.type === "IDAT") h.update(c.data);
  return h.digest("hex");
}

/** The pixel hash stamped into the PNG (`kit-diagram-pixels`), or null. */
export function readStampPixels(png) {
  for (const c of chunks(png)) {
    if (c.type !== "tEXt") continue;
    const s = c.data.toString("latin1");
    if (s.startsWith(`${STAMP_PIXELS_KEY}\0sha256:`)) return s.slice(STAMP_PIXELS_KEY.length + 8);
  }
  return null;
}

const readKey = (png, key) => { for (const c of chunks(png)) { if (c.type !== "tEXt") continue; const t = c.data.toString("latin1"); if (t.startsWith(`${key}\0sha256:`)) return t.slice(key.length + 8); } return null; };
/** The theme hash stamped into the PNG (`kit-diagram-theme`), or null. */
export const readStampTheme = (png) => readKey(png, STAMP_THEME_KEY);
/** The footer hash stamped into the PNG (`kit-diagram-footer`), or null. */
export const readStampFooter = (png) => readKey(png, STAMP_FOOTER_KEY);

/**
 * Why a PNG is not a valid product of `kit diagrams render` (null when it is): every stamp present (source hash, id, pixel hash,
 * theme hash, footer hash) and current against the source, its header, the theme and the pixels. A PNG made by any other renderer has none.
 */
export function stampProblem(png, { source, header, theme }) {
  const miss = [];
  if (readStamp(png) === null) miss.push("source hash");
  if (readStampId(png) === null) miss.push("id");
  if (readStampPixels(png) === null) miss.push("pixel hash");
  if (readStampTheme(png) === null) miss.push("theme hash");
  if (readStampFooter(png) === null) miss.push("footer hash");
  if (miss.length) return `PNG has no kit stamp (${miss.join(", ")}): it was not made by kit diagrams render, so it cannot pass (render it with kit diagrams render)`;
  if (readStamp(png) !== sourceHash(source)) return "PNG is older than its source (rendered from a different source)";
  if (header && readStampId(png) !== header.id) return `PNG is stamped with id ${readStampId(png)}, the header says ${header.id}`;
  if (theme && readStampTheme(png) !== theme.hash) return "PNG was rendered with another theme than docs/diagrams/theme.init (kit diagrams render --all)";
  if (header && readStampFooter(png) !== footerHash(header)) return "PNG's identity footer differs from its header (kit diagrams render)";
  return pixelProblem(png);
}

/** Problem text when a PNG's pixels differ from its stamp (edited after render) or carry none, else null. */
export function pixelProblem(png) {
  const want = readStampPixels(png);
  if (!want) return "PNG has no pixel stamp (kit diagrams render adds it)";
  return want === pixelHash(png) ? null : "PNG was edited after it was rendered: its image data differs from the stamp (kit diagrams render --all)";
}

export function readStamp(png) {
  for (const c of chunks(png)) {
    if (c.type !== "tEXt") continue;
    const s = c.data.toString("latin1");
    if (s.startsWith(`${STAMP_KEY}\0sha256:`)) return s.slice(STAMP_KEY.length + 8);
  }
  return null;
}

/** The id stamped into the PNG (`kit-diagram-id`), or null. */
export function readStampId(png) {
  for (const c of chunks(png)) {
    if (c.type !== "tEXt") continue;
    const s = c.data.toString("latin1");
    if (s.startsWith(`${STAMP_ID_KEY}\0`)) return s.slice(STAMP_ID_KEY.length + 1);
  }
  return null;
}

// ---- discovery ----
function walkMd(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkMd(root, p, out);
    else if (name.endsWith(".md")) out.push(relative(root, p));
  }
  return out;
}

export function markdownFiles(root) {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8", env: gitEnv() });
  const list = git.status === 0 ? git.stdout.split("\0").filter(Boolean) : walkMd(root);
  return list.filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)) && existsSync(join(root, f))).sort();
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*(.*)$/;

/**
 * Every fenced code block of a Markdown text, parsed the CommonMark way (a backtick or tilde fence of 3 or more, an info string,
 * closed by the same character at least as long; a fence of another language can contain mermaid fences as text): [{ info, lang,
 * indent, char, len, fenceStart, fenceEnd, start, end, body, closed }]. `start`/`end`: the body (between the fence lines).
 */
export function fences(text) {
  const out = [];
  let pos = 0, open = null;
  for (const line of text.split("\n")) {
    const lineEnd = pos + line.length;
    if (!open) {
      const m = line.match(FENCE_OPEN);
      if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
        const info = m[3].trim();
        open = { info, lang: info.split(/[\s{]/)[0].toLowerCase(), indent: m[1], char: m[2][0], len: m[2].length, fenceStart: pos + m[1].length, start: lineEnd + 1 };
      }
    } else {
      const m = line.match(/^[ \t]*(`{3,}|~{3,})[ \t\r]*$/);
      if (m && m[1][0] === open.char && m[1].length >= open.len) {
        const at = pos + line.indexOf(m[1]);
        out.push({ ...open, end: pos, body: text.slice(open.start, pos), fenceEnd: at + m[1].length, closed: true });
        open = null;
      }
    }
    pos = lineEnd + 1;
  }
  if (open) out.push({ ...open, end: text.length, body: text.slice(open.start), fenceEnd: text.length, closed: false });
  return out;
}

/** ```mermaid blocks of a Markdown text (backtick or tilde fences, any case): [{ index, start, end, body, fenceStart, fenceEnd, indent }]. */
export function mermaidBlocks(text) {
  return fences(text).filter((f) => f.closed && f.lang === "mermaid").map((f) => ({ start: f.start, end: f.end, body: f.body, fenceStart: f.fenceStart, fenceEnd: f.fenceEnd, indent: f.indent }));
}

/** Fences that name Mermaid but are not a block the checks would read (an info string that is not exactly `mermaid`, an unclosed fence): [{ line, problem }]. */
export function badMermaidFences(text) {
  const out = [];
  for (const f of fences(text)) {
    const names = /mermaid/i.test(f.info);
    const line = text.slice(0, f.fenceStart).split("\n").length;
    if (names && f.lang !== "mermaid") out.push({ line, problem: `the fence info string "${f.info}" names Mermaid but is not exactly \`mermaid\`: write \`\`\`mermaid so the diagram is checked` });
    else if (f.lang === "mermaid" && !f.closed) out.push({ line, problem: "unterminated mermaid fence" });
  }
  return out;
}

export function mmdFiles(root) {
  const dir = join(root, DIAGRAM_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".mmd")).sort().map((f) => `${DIAGRAM_DIR}/${f}`);
}

export const pngOf = (mmd) => mmd.replace(/\.mmd$/, ".png");

/** Rewrites every .mmd and Markdown mermaid block to the theme of its own header's project. → list of changed files. */
export function applyThemeToRepo(root, themes = themeResolver(root)) {
  const changed = [];
  const themeOf = (source, where) => { try { return themes.forSource(source); } catch (e) { throw new Error(`${where}: ${e.message}`); } };
  for (const f of mmdFiles(root)) {
    const p = join(root, f);
    const src = readFileSync(p, "utf8");
    const next = applyTheme(src, themeOf(src, f));
    if (next !== src.replace(/\r\n/g, "\n")) { writeFileSync(p, next); changed.push(f); }
  }
  for (const f of markdownFiles(root)) {
    const p = join(root, f);
    const text = readFileSync(p, "utf8");
    const blocks = mermaidBlocks(text);
    if (!blocks.length) continue;
    let next = "", at = 0;
    blocks.forEach((b, i) => {
      const body = b.body.endsWith("\n") ? b.body.slice(0, -1) : b.body;
      next += text.slice(at, b.start) + applyTheme(body, themeOf(body, `${f} (mermaid block ${i + 1})`)) + (b.body.endsWith("\n") ? "\n" : "");
      at = b.end;
    });
    next += text.slice(at);
    if (next !== text) { writeFileSync(p, next); changed.push(f); }
  }
  return changed;
}

/** The problems of one diagram on the theme its header's project selects: { theme, problems }. A refused project is one problem. */
function sourceProblems(themes, source) {
  let th;
  try { th = themes.forSource(source); } catch (e) { return { theme: null, problems: [e.message] }; }
  const project = readHeader(source).header?.project;
  const problems = diagramProblems(source, th).map((m) => {
    if (m !== "init line differs from the theme") return m;
    const first = source.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim())?.trim();
    const other = themes.identify(first);
    return other && project ? `init line is ${other}'s theme, but the diagram's project is ${project}: a ${project} diagram is drawn in ${project}'s own colours (kit diagrams theme)` : m;
  });
  return { theme: th, problems };
}

/** All problems in a repo: [{ file, problem }]. */
export function checkRepo(root, kit = bundled()) {
  let themes;
  try { themes = themeResolver(root, kit); } catch (e) { return { theme: null, themes: null, problems: [{ file: THEME_FILE, problem: e.message }], counts: { mmd: 0, blocks: 0 } }; }
  const theme = themes.own.theme;
  const problems = themeRoleProblems(theme).map((m) => ({ file: THEME_FILE, problem: m }));
  const mmds = mmdFiles(root);
  for (const f of mmds) {
    const src = readFileSync(join(root, f), "utf8");
    const mine = sourceProblems(themes, src);
    for (const p of mine.problems) problems.push({ file: f, problem: p });
    if (!mine.theme) continue;
    if (mine.theme !== theme) for (const m of themeRoleProblems(mine.theme)) problems.push({ file: f, problem: `the vendored theme of project ${readHeader(src).header.project}: ${m}` });
    const png = join(root, pngOf(f));
    if (!existsSync(png)) { problems.push({ file: f, problem: `no ${basename(pngOf(f))} (render it: kit diagrams render)` }); continue; }
    let sp = null;
    try { sp = stampProblem(readFileSync(png), { source: src, header: readHeader(src).header, theme: mine.theme }); } catch (e) { problems.push({ file: pngOf(f), problem: e.message }); continue; }
    if (sp) problems.push({ file: pngOf(f), problem: sp });
  }
  let blocks = 0;
  for (const f of markdownFiles(root)) {
    const text = readFileSync(join(root, f), "utf8");
    mermaidBlocks(text).forEach((b, i) => {
      blocks++;
      for (const p of sourceProblems(themes, b.body).problems) problems.push({ file: `${f} (mermaid block ${i + 1})`, problem: p });
    });
  }
  return { theme, themes, problems, counts: { mmd: mmds.length, blocks } };
}

// ---- rendering (bundled Mermaid + local Chromium through Playwright; no network) ----
const FONT_FORMAT = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };

/**
 * Renders .mmd files to stamped PNGs. `deps`: { playwright, mermaidJs, chromium } (module object, path to
 * mermaid.min.js, optional Chromium executable). Returns [{ file, ok, error? }].
 */
export async function renderDiagrams(root, files, theme, deps) {
  return renderSources(root, files.map((f) => { const src = readFileSync(join(root, f), "utf8"); return { label: f, source: src, out: pngOf(f), id: readHeader(src).header?.id }; }), theme, deps);
}

/**
 * Renders diagram sources to stamped PNGs: `items` [{ label, source, out (repo-relative PNG path), id? }]. A .mmd file or a
 * Markdown block (docs/diagrams/blocks/<id>.png) alike. Returns [{ file: label, ok, error? }].
 */
export async function renderSources(root, items, theme, deps, { maxWidth = MAX_CSS_WIDTH, maxHeight = MAX_CSS_HEIGHT } = {}) {
  // an item may carry the theme of its own project (`item.theme`, chosen from its header); the others use `theme`
  const contexts = new Map();
  const contextOf = (th) => {
    if (contexts.has(th)) return contexts.get(th);
    // gate 1: the theme defines every colour role, the classes and a font file; there is no default look to fall back on
    const roleProblems = themeRoleProblems(th);
    if (roleProblems.length) throw new Error(`the theme${th.project ? ` of ${th.project}` : ` ${THEME_FILE}`} cannot render a diagram: ${roleProblems.join("; ")}`);
    const fontCss = th.fonts.map(({ family, path }) => {
      const abs = th.fontFiles?.get(path) ?? resolve(root, path);
      if (!existsSync(abs)) throw new Error(`${THEME_FILE}: font file ${path} not found`);
      const fmt = FONT_FORMAT[extname(abs).toLowerCase()] || "truetype";
      return `@font-face{font-family:"${family}";src:url(data:font/${fmt};base64,${readFileSync(abs).toString("base64")}) format("${fmt}")}`;
    }).join("");
    const v = th.initVars.themeVariables;
    const ctx = { fontCss, families: [...new Set(th.fonts.map((f) => f.family))], v, bg: v.background, ff: String(v.fontFamily).replace(/[<>{};]/g, "") };
    contexts.set(th, ctx);
    return ctx;
  };
  for (const it of items) contextOf(it.theme || theme);
  if (!items.length) contextOf(theme);
  const browser = await deps.playwright.chromium.launch(deps.chromium ? { executablePath: deps.chromium } : {});
  const results = [];
  try {
    for (const { label: f, source: src, out, id, theme: itemTheme } of items) {
      const th = itemTheme || theme;
      const { fontCss, families, v, bg, ff } = contextOf(th);
      const header = readHeader(src).header;
      if (!header) { results.push({ file: f, ok: false, error: "no kit:diagram header: the identity footer is drawn from it (kit diagrams migrate)" }); continue; }
      const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1200 } });
      try {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>${fontCss}body{margin:0;background:${bg};font-family:${ff};--mermaid-font-family:${ff}}#d{display:inline-block;padding:16px;min-width:360px}</style><div id="d"></div>`);
        await page.addScriptTag({ path: deps.mermaidJs });
        const res = await page.evaluate(async ({ code, families, lines, ff, rail, dim, ink }) => {
          // gate 2: every theme family is a LOADED face, not a fallback
          for (const fam of families) {
            await document.fonts.load(`15px "${fam}"`);
            if (!Array.from(document.fonts).some((x) => x.family.replace(/["']/g, "") === fam && x.status === "loaded")) return { ok: false, error: `font ${fam} is not loaded: a fallback face would be drawn` };
          }
          // eslint-disable-next-line no-undef
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, er: { useMaxWidth: false }, state: { useMaxWidth: false } });
          let svgText;
          try { svgText = (await mermaid.render("m", code)).svg; } catch (e) { return { ok: false, error: String(e?.message || e) }; } // eslint-disable-line no-undef
          const d = document.getElementById("d");
          d.innerHTML = svgText;
          const svg = d.querySelector("svg");
          const clipped = [];
          for (const fo of svg.querySelectorAll("foreignObject")) {
            const inner = fo.firstElementChild, r = fo.getBoundingClientRect();
            if (inner && (inner.scrollWidth > r.width + 1 || inner.scrollHeight > r.height + 1)) clipped.push((inner.textContent || "").trim().slice(0, 40));
          }
          const vb = svg.viewBox.baseVal;
          if (vb && vb.width) for (const t of svg.querySelectorAll("text")) {
            const b = t.getBBox();
            if (b.x < vb.x - 1 || b.y < vb.y - 1 || b.x + b.width > vb.x + vb.width + 1 || b.y + b.height > vb.y + vb.height + 1) clipped.push((t.textContent || "").trim().slice(0, 40));
          }
          // the identity footer, from the header: a thin rail line, the theme's font and colours, wrapped never clipped
          const w = Math.max(svg.getBoundingClientRect().width, 360);
          const foot = document.createElement("div");
          foot.id = "foot";
          foot.setAttribute("style", `margin-top:14px;border-top:1px solid ${rail};padding-top:8px;width:${w}px;font-family:${ff};font-size:13px;line-height:1.55;color:${dim};white-space:normal;overflow-wrap:anywhere`);
          lines.forEach((l, i) => { const e = document.createElement("div"); e.textContent = l.text; if (i === 0) e.setAttribute("style", `color:${ink};font-size:14px`); foot.appendChild(e); });
          d.appendChild(foot);
          return { ok: true, width: d.getBoundingClientRect().width, height: d.getBoundingClientRect().height, clipped };
        }, { code: src, families, lines: footerLines(header), ff, rail: v.clusterBorder, dim: v.lineColor, ink: v.textColor });
        if (!res.ok) { results.push({ file: f, ok: false, error: res.error }); continue; }
        if (res.clipped.length) { results.push({ file: f, ok: false, error: `text is clipped in ${res.clipped.length} place${res.clipped.length === 1 ? "" : "s"} (${res.clipped.slice(0, 3).map((t) => `"${t}"`).join(", ")})` }); continue; }
        if (res.width > maxWidth) { results.push({ file: f, ok: false, error: `the diagram is ${Math.round(res.width)} px wide, over the readable limit of ${maxWidth} px for a phone: split it or stack it top to bottom` }); continue; }
        if (res.height > maxHeight) { results.push({ file: f, ok: false, error: `the diagram is ${Math.round(res.height)} px tall, over the readable limit of ${maxHeight} px for a phone: split it, or summarise what carries no relationship` }); continue; }
        const png = await page.locator("#d").screenshot();
        // gate 3: the picture carries the theme's colours (background, ink, the accent where the source uses it), not a default look
        const colour = paletteProblems(png, th, src);
        if (colour.length) { results.push({ file: f, ok: false, error: colour.join("; ") }); continue; }
        mkdirSync(dirname(resolve(root, out)), { recursive: true });
        writeFileSync(resolve(root, out), stampPng(png, sourceHash(src), id ?? header.id, { theme: th.hash, footer: footerHash(header) }));
        results.push({ file: f, ok: true });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  return results;
}

/**
 * theme.init from @saasreport/site tokens: color.{accent, accentTint, ink, rail, railDark, bg, sink, surface} and the
 * weight-400 face of font.sans (its /fonts/… src looked up under public/, site/ or the repo root).
 */
export function themeFromTokens(tokens, { root, name = "this project", source = "site.config.js", project } = {}) {
  if (!project) throw new Error("themeFromTokens: the project (registry key) is required: the theme declares whose it is (kit.canon.json `project`, or --project)");
  const c = tokens?.color || {};
  for (const k of ["accent", "accentTint", "ink", "rail", "railDark", "bg", "sink"]) if (!c[k]) throw new Error(`the tokens have no color.${k}`);
  for (const k of ["surface"]) if (!c[k]) throw new Error(`the tokens have no color.${k}`);
  const onAccent = bestText(c.accent, [c.ink, c.surface, ...(c.onAccent ? [c.onAccent] : [])].filter(Boolean), "text-on-accent");
  const family = tokens.font?.sans;
  if (!family) throw new Error("the tokens have no font.sans");
  const faces = (tokens.font.faces || []).filter((f) => f.family === family);
  const face = faces.find((f) => Number(f.weight) === 400) || faces[0];
  if (!face) throw new Error(`the tokens have no font face for ${family}`);
  const rel = face.src.replace(/^\//, "").replace(/[?#].*$/, "");
  const path = ["public/", "site/", ""].map((d) => d + rel).find((p) => existsSync(join(root, p)));
  if (!path) throw new Error(`font file ${face.src} not found under public/, site/ or the repo root`);
  return themeInit({ ...c, onAccent }, { family, path }, [
    `${name}: the diagram theme, derived from the brand tokens in ${source} by kit diagrams derive. Do not edit by hand.`,
    `accent ${c.accent} (node fill, text ${onAccent}), tint ${c.accentTint} (notes), ink ${c.ink}, rail ${c.rail} / ${c.railDark}, background ${c.bg}, sink ${c.sink}.`,
  ], { project });
}
