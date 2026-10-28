/**
 * The Markdown diagram pairing standard (docs/DIAGRAMS.md, "Markdown pairing").
 *
 * A viewer that cannot draw Mermaid (the Claude mobile app's Markdown viewer) shows a ```mermaid fence as raw code, init and
 * header lines included. So in every Markdown file the RENDERED IMAGE comes first and the source second, collapsed:
 *
 *   ![<title> (<id>)](<relative path to the stored PNG under docs/diagrams/>)
 *
 *   <details><summary>Mermaid source (<id>)</summary>
 *
 *   ```mermaid
 *   %%{init …}%%
 *   %% kit:diagram {…}
 *   …
 *   ```
 *
 *   </details>
 *
 * GitHub still draws the fence when the details are opened. The pairing is generated (`kit diagrams render`, `kit diagrams
 * migrate`), never written by hand, and `kit diagrams check` fails when it is missing or stale. The PNG is the sibling
 * docs/diagrams/<stem>.png when a .mmd there has the same source (header aside), else docs/diagrams/blocks/<id>.png, rendered
 * from the block and stamped with its source hash and id. Every path is relative, so the same Markdown works on GitHub and in
 * a viewer. `kit docs export-view` makes a self-contained copy (images inlined) for viewers that cannot load relative images.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { DIAGRAM_DIR, themeResolver, mermaidBlocks, mmdFiles, pngOf, readStamp, sourceHash, stampProblem } from "./diagrams.js";
import { readHeader } from "./diagram-header.js";

export const BLOCK_IMAGE_DIR = `${DIAGRAM_DIR}/blocks`;
const IMAGE_LINE = /^[ \t]*!\[(.*)\]\(([^)\s]*)\)[ \t]*$/;
const SUMMARY_LINE = /^[ \t]*<details>\s*<summary>Mermaid source \((.*)\)<\/summary>[ \t]*$/;
const CLOSE_LINE = /^[ \t]*<\/details>[ \t]*$/;
const ABSOLUTE = /^(?:\/|~|[A-Za-z]:[\\/]|file:|[A-Za-z][A-Za-z0-9+.-]*:\/\/|data:)/;

/** The source without its `%% kit:diagram` header line: what two copies of one diagram have in common. */
export const bodyOf = (source) => source.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*%%\s*kit:diagram\b/.test(l)).join("\n").trimEnd();
export const bodyHash = (source) => createHash("sha256").update(bodyOf(source)).digest("hex");

const altOf = (h) => `${h.title} (${h.id})`.replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim();

/** The canonical pairing text for one block (no trailing newline): image, collapsed source. */
export function pairingText({ indent = "", alt, path, id, fence }) {
  const ind = (l) => (l ? indent + l : "");
  return [
    `![${alt}](${path})`, "",
    `<details><summary>Mermaid source (${id})</summary>`, "",
    ...fence.split("\n"), "",
    "</details>",
  ].map(ind).join("\n");
}

/**
 * Every mermaid block of a Markdown text with the pairing around it:
 * { fenceStart, fenceEnd, indent, body, bodyStart, regionStart, regionEnd, image: { alt, path } | null, details: { id } | null }
 * (region: from the image line (or the details, or the fence) to the closing </details> (or the fence)).
 */
export function pairedBlocks(text) {
  const out = [];
  for (const b of mermaidBlocks(text)) {
    const lineStart = (pos) => text.lastIndexOf("\n", pos - 1) + 1;
    const prevNonBlank = (pos) => {   // the nearest non-blank line before the line starting at pos
      let end = pos;
      while (end > 0) {
        const s = lineStart(end - 1);
        const line = text.slice(s, end).replace(/\n$/, "");
        if (line.trim()) return { start: s, line };
        end = s;
      }
      return null;
    };
    let regionStart = b.fenceStart - b.indent.length, regionEnd = b.fenceEnd, image = null, details = null;
    let before = prevNonBlank(b.fenceStart);
    const sm = before && before.line.match(SUMMARY_LINE);
    if (sm) {
      // the closing </details> must follow the fence
      const after = text.slice(b.fenceEnd).match(/^[ \t]*\n(?:[ \t]*\n)*([ \t]*<\/details>[ \t]*)/);
      if (after && CLOSE_LINE.test(after[1])) { details = { id: sm[1] }; regionStart = before.start; regionEnd = b.fenceEnd + after[0].length; before = prevNonBlank(before.start); }
    }
    const im = before && before.line.match(IMAGE_LINE);
    if (im) { image = { alt: im[1], path: im[2] }; regionStart = before.start; }
    out.push({ ...b, regionStart, regionEnd, image, details });
  }
  return out;
}

/** The mmd files by body hash: Map(bodyHash → mmd path), the first of equal ones. */
function mmdByBody(root) {
  const map = new Map();
  for (const f of mmdFiles(root)) {
    const h = bodyHash(readFileSync(join(root, f), "utf8"));
    if (!map.has(h)) map.set(h, f);
  }
  return map;
}

/** { png (repo-relative), own (a block-rendered PNG) } for a block: the sibling mmd with the same source, else its own. */
export function imageTarget(root, block, header, byBody = mmdByBody(root)) {
  const sib = byBody.get(bodyHash(block.body));
  if (sib) return { png: pngOf(sib), own: false };
  return { png: `${BLOCK_IMAGE_DIR}/${header.id}.png`, own: true };
}

const relTo = (mdFile, pngPath) => posix.relative(posix.dirname(mdFile) || ".", pngPath) || pngPath;

/**
 * The Markdown text with every block paired (image first, collapsed source). `headers`: (block index → header), blocks without
 * a valid header are left alone (reported by the header check). → { text, changed, targets: [{ png, own, source }] }
 */
export function pairMarkdown(root, mdFile, text, byBody = mmdByBody(root)) {
  const blocks = pairedBlocks(text);
  const targets = [];
  let out = "", at = 0;
  for (const b of blocks) {
    let header = null;
    try { header = JSON.parse((b.body.match(/^\s*%%\s*kit:diagram\s+(\{.*\})\s*$/m) || [])[1] || "null"); } catch { /* the header check reports it */ }
    if (!header || !header.id || !header.title) continue;
    const t = imageTarget(root, b, header, byBody);
    targets.push({ ...t, source: b.body, id: header.id });
    const fence = text.slice(b.fenceStart, b.fenceEnd).split("\n").map((l) => (b.indent && l.startsWith(b.indent) ? l.slice(b.indent.length) : l)).join("\n");
    out += text.slice(at, b.regionStart) + pairingText({ indent: b.indent, alt: altOf(header), path: relTo(mdFile, t.png), id: header.id, fence });
    at = b.regionEnd;
  }
  out += text.slice(at);
  return { text: out, changed: out !== text, targets };
}

/** Pairs every Markdown file of the repo on disk. → { changed: [files], targets: [{ png, own, source, id }] } (targets deduplicated by png). */
export function pairRepo(root, files, { dry = false } = {}) {
  const byBody = mmdByBody(root);
  const changed = [], targets = new Map();
  for (const f of files) {
    const p = join(root, f);
    const text = readFileSync(p, "utf8");
    if (!mermaidBlocks(text).length) continue;
    const r = pairMarkdown(root, f, text, byBody);
    for (const t of r.targets) if (!targets.has(t.png)) targets.set(t.png, t);
    if (r.changed) { changed.push(f); if (!dry) writeFileSync(p, r.text); }
  }
  return { changed, targets: [...targets.values()] };
}

/**
 * The pairing problems of one Markdown file: [{ file, problem }]. `entries`: its blocks' collected diagrams (header, where).
 * Fails when a block has no image before it, the image is empty-alt, absolute, missing, outside docs/diagrams/, stale against the
 * block, or the source is not collapsed in details with its id; finally when the text differs from what render writes.
 */
export function pairingProblems(root, mdFile, text, byBody = mmdByBody(root), themes = themeResolver(root)) {
  const problems = [];
  const blocks = pairedBlocks(text);
  const canonical = pairMarkdown(root, mdFile, text, byBody);
  blocks.forEach((b, i) => {
    const where = `${mdFile} (mermaid block ${i + 1})`;
    const P = (m) => problems.push({ file: where, problem: m });
    if (!b.image) { P("no rendered image before the Mermaid block: a viewer that cannot draw Mermaid (the mobile app) shows raw code. kit diagrams render adds the image-first pairing"); return; }
    const { alt, path } = b.image;
    if (!alt.trim()) P("the image has empty alt text (it is the diagram title and id: kit diagrams render writes it)");
    if (ABSOLUTE.test(path)) { P(`image path ${path} is absolute or a URL: use a path relative to this file so the same Markdown works on GitHub and in a viewer`); return; }
    const abs = resolve(root, dirname(mdFile), decodeURI(path));
    const rel = relative(root, abs).split("\\").join("/");
    if (rel.startsWith("..") || !rel.startsWith(`${DIAGRAM_DIR}/`) || !rel.endsWith(".png")) { P(`image ${path} is not a PNG under ${DIAGRAM_DIR}/ (diagrams are stored there)`); return; }
    if (!existsSync(abs)) { P(`image ${path} does not exist (kit diagrams render)`); return; }
    let png;
    try { png = readFileSync(abs); } catch { P(`image ${path} cannot be read`); return; }
    const own = rel.startsWith(`${BLOCK_IMAGE_DIR}/`);
    if (own) {
      let theme;
      try { theme = themes.forSource(b.body); } catch (e) { P(e.message); return; }
      const sp = stampProblem(png, { source: b.body, header: readHeader(b.body).header, theme });
      if (sp) P(`image ${path}: ${sp}`);
    } else {
      let stamp = null;
      try { stamp = readStamp(png); } catch { P(`image ${path} is not a PNG`); return; }
      const sib = join(root, rel.replace(/\.png$/, ".mmd"));
      const sibSrc = existsSync(sib) ? readFileSync(sib, "utf8") : null;
      if (stamp !== sourceHash(b.body) && !(sibSrc !== null && bodyHash(sibSrc) === bodyHash(b.body) && stamp === sourceHash(sibSrc))) P(`image ${path} is stale: it was rendered from a different source than this block (kit diagrams render)`);
    }
    if (!b.details) P(`the Mermaid source is not collapsed in <details><summary>Mermaid source (id)</summary> (kit diagrams render writes it)`);
  });
  if (blocks.length && canonical.changed && !problems.length) problems.push({ file: mdFile, problem: "the diagram pairing differs from what kit diagrams render writes (alt text, summary or path): never edit it by hand" });
  return problems;
}

/**
 * PNGs under docs/diagrams that no diagram owns: not the sibling of a .mmd and not the image of a paired Markdown block. A picture
 * nobody can regenerate from a source is not a diagram of the repository (and may be a product of another renderer).
 * `mdFiles`: the Markdown files of the repository. → [repo-relative path]
 */
export function orphanPngs(root, mdFiles) {
  const owned = new Set(mmdFiles(root).map(pngOf));
  for (const f of mdFiles) {
    const text = readFileSync(join(root, f), "utf8");
    for (const b of pairedBlocks(text)) if (b.image && !ABSOLUTE.test(b.image.path)) owned.add(relative(root, resolve(root, dirname(f), decodeURI(b.image.path))).split("\\").join("/"));
  }
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (name.endsWith(".png") && !owned.has(rel)) out.push(rel);
    }
  };
  if (existsSync(join(root, DIAGRAM_DIR))) walk(DIAGRAM_DIR);
  return out.sort();
}
