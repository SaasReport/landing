/**
 * kit docs export-view: a self-contained copy of a Markdown file for a viewer that cannot load relative images or draw Mermaid
 * (the Claude mobile app's Markdown viewer shows a "Load Image" placeholder and the raw source of a ```mermaid fence).
 *
 *   images   every relative image becomes a base64 data URI (or, with `baseUrl`, an absolute URL for a PR body, where a relative
 *            path means nothing). Recognised: inline `![alt](path "title")`, reference-style `![alt][ref]` with its definition,
 *            and `<img src>`. Text inside code fences, inline code spans and HTML comments is never rewritten. An image used
 *            more than once is written once, as a reference definition at the end of the document, and referenced by its
 *            label (an `<img>` tag cannot reference, so each of its uses carries its own copy: use the Markdown syntax to
 *            share). Anything the exporter cannot make self-contained is an error: a `srcset`, an image that is missing, of an
 *            unsupported type, over the size limit, outside the repository (an absolute path, `..`, a symlink out, a
 *            `file:` URL), or a relative link to another Markdown file.
 *   mermaid  the pairing (image first, source collapsed in <details>) is kept; the fence inside it becomes a ```text fence so no
 *            viewer tries to draw it; a block with no pairing is an error (run kit diagrams render)
 *
 * There is no warning level: a size over the limit, an unresolved link or an image the exporter does not understand fails and
 * nothing is written. Indented code blocks are not recognised as code (use fences).
 *
 * Pure text in, text out: exportView(root, file, opts) → { text, images, problems, bytes }.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pairedBlocks } from "./diagram-pairing.js";
import { fences } from "./diagrams.js";

export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 8_000_000;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const REMOTE = /^(?:https?:|data:|\/\/|#|mailto:)/i;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TITLE = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)`;
const DEST = String.raw`<[^>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()]*)*`;
const INLINE_IMG = new RegExp(String.raw`!\[((?:[^\]\\]|\\.)*)\]\(\s*(${DEST})(?:\s+(${TITLE}))?\s*\)`, "g");
const REF_IMG = /!\[((?:[^\]\\]|\\.)*)\](?:\[((?:[^\]\\]|\\.)*)\])?(?!\(|:)/g;
const DEFINITION = new RegExp(String.raw`^([ \t]{0,3})\[((?:[^\]\\]|\\.)+)\]:[ \t]*(${DEST})(?:[ \t]+(${TITLE}))?[ \t]*$`, "gm");
const HTML_IMG = /<img\b[^>]*>/gi;
const label = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
const unangle = (d) => (d.startsWith("<") ? d.slice(1, -1) : d);

/** Bytes as a reader sees them: 640 B, 12.3 KB, 1.20 MB (never a rounded 0.0). */
export function fmtBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

/** Ranges [start, end) of the text that is code or a comment: fences, inline code spans, HTML comments. */
function protectedRanges(text) {
  const out = fences(text).map((f) => [f.fenceStart, f.fenceEnd]);
  const inFence = (i) => out.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) if (!inFence(m.index)) out.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) if (!inFence(m.index) && !out.some(([a, b]) => m.index >= a && m.index < b)) out.push([m.index, m.index + m[0].length]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** Replaces `re` matches that are not inside a protected range: fn(match) → string | undefined (keep). */
function replaceOutside(text, ranges, re, fn) {
  let out = "", at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index < at || ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const r = fn(m);
    if (r === undefined) continue;
    out += text.slice(at, m.index) + r;
    at = m.index + m[0].length;
  }
  return out + text.slice(at);
}

export function exportView(root, file, { baseUrl = null, maxImageBytes = MAX_IMAGE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const problems = [], images = [];
  const realRoot = realpathSync(root);
  const abs = resolve(root, file);
  if (!existsSync(abs)) return { text: "", images, problems: [`${file} does not exist`], bytes: 0 };
  const inside = (p) => { const r = relative(realRoot, realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  if (!inside(abs)) return { text: "", images, problems: [`${file} is outside the repository (${root}): only files of the repository are exported`], bytes: 0 };
  let text = readFileSync(abs, "utf8");

  // 1. mermaid fences: only inside a pairing (image first, collapsed); the fence language becomes text
  const blocks = pairedBlocks(text);
  let out = "", at = 0;
  blocks.forEach((b, i) => {
    if (!b.image || !b.details) { problems.push(`mermaid block ${i + 1} has no image-first pairing: run kit diagrams render`); return; }
    const fence = text.slice(b.fenceStart, b.fenceEnd).replace(/^([ \t]*)```mermaid[^\n]*/, "$1```text");
    out += text.slice(at, b.fenceStart) + fence;
    at = b.fenceEnd;
  });
  out += text.slice(at);
  text = out;

  // 2. images
  const ranges = protectedRanges(text);
  const cache = new Map();                 // resolved path → { rel, buf, mime } | null (a problem was reported)
  const uses = new Map();                  // path + title → { count, label }
  let total = 0;
  const load = (src) => {
    if (REMOTE.test(src)) return "remote";
    if (SCHEME.test(src)) { problems.push(`image ${src}: the ${src.match(SCHEME)[0]} scheme is not exportable (a relative path inside the repository, or an http(s) URL)`); return null; }
    if (/^(?:\/|~|[A-Za-z]:[\\/])/.test(src)) { problems.push(`image ${src}: an absolute path is not exportable (write a path relative to the Markdown file, inside the repository)`); return null; }
    let clean;
    try { clean = decodeURI(src.split("#")[0].split("?")[0]); } catch { clean = src.split("#")[0].split("?")[0]; }
    const path = resolve(dirname(abs), clean);
    if (cache.has(path)) return cache.get(path);
    let r = null;
    const lex = relative(root, path);
    if (lex.startsWith("..") || isAbsolute(lex)) problems.push(`image ${src} is outside the repository: only images inside it are exported`);
    else if (!existsSync(path)) problems.push(`image ${src} does not exist`);
    else if (!inside(path)) problems.push(`image ${src} is a symlink that leaves the repository: only images inside it are exported`);
    else if (!MIME[extname(path).toLowerCase()]) problems.push(`image ${src}: unsupported type ${extname(path) || "(none)"} (png, jpg, gif, webp, svg)`);
    else {
      const buf = readFileSync(path);
      if (buf.length > maxImageBytes) problems.push(`image ${src} is ${fmtBytes(buf.length)}, over the limit of ${fmtBytes(maxImageBytes)} per image: a viewer may not load it (make it smaller)`);
      else r = { rel: relative(realRoot, realpathSync(path)).split("\\").join("/"), buf, mime: MIME[extname(path).toLowerCase()], src };
    }
    cache.set(path, r);
    return r;
  };
  const dataUri = (r) => `data:${r.mime};base64,${r.buf.toString("base64")}`;
  const urlOf = (r) => `${baseUrl.replace(/\/+$/, "")}/${r.rel.split("/").map(encodeURIComponent).join("/")}?raw=true`;
  const target = (src, r) => (baseUrl ? urlOf(r) : dataUri(r));
  const note = (src, r) => images.push({ src, bytes: baseUrl ? 0 : r.buf.length, ...(baseUrl ? { url: urlOf(r) } : {}) });
  const emitted = (r) => { if (!baseUrl) total += r.buf.length; };

  // reference definitions used by an image: rewritten in place, once each
  const refLabels = new Set();
  for (const m of text.matchAll(REF_IMG)) if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) refLabels.add(label(m[2] || m[1]));
  const linkLabels = new Set();
  for (const m of text.matchAll(/(?<!!)\[((?:[^\]\\]|\\.)*)\]\[((?:[^\]\\]|\\.)*)\]/g)) if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) linkLabels.add(label(m[2] || m[1]));
  const defined = new Set();
  text = replaceOutside(text, ranges, DEFINITION, (m) => {
    const [, ind, lab, dest, title] = m;
    if (!refLabels.has(label(lab))) return undefined;
    defined.add(label(lab));
    const src = unangle(dest);
    if (linkLabels.has(label(lab))) { problems.push(`reference [${lab}] is used by an image and by a link: split it in two definitions`); return undefined; }
    const r = load(src);
    if (r === "remote" || r === null) return undefined;
    note(src, r); emitted(r);
    return `${ind}[${lab}]: ${target(src, r)}${title ? ` ${title}` : ""}`;
  });
  // an image that references a label with no definition cannot render in any viewer: report it
  for (const m of text.matchAll(REF_IMG)) if (!ranges.some(([a, b]) => m.index >= a && m.index < b) && !defined.has(label(m[2] || m[1])) && m[2] !== undefined) problems.push(`image reference [${m[2]}] has no definition`);

  // inline images; a file used more than once becomes one definition (data URI only)
  const counts = new Map();
  for (const m of text.matchAll(INLINE_IMG)) {
    if (ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const src = unangle(m[2]);
    if (REMOTE.test(src) || SCHEME.test(src) || /^(?:\/|~|[A-Za-z]:[\\/])/.test(src)) continue;
    const k = `${src.split("#")[0].split("?")[0]}\0${m[3] || ""}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const defs = [];
  text = replaceOutside(text, ranges, INLINE_IMG, (m) => {
    const [, alt, dest, title] = m;
    const src = unangle(dest);
    const r = load(src);
    if (r === "remote") return undefined;
    if (r === null) return undefined;
    const k = `${src.split("#")[0].split("?")[0]}\0${title || ""}`;
    if (!baseUrl && counts.get(k) > 1) {
      if (!uses.has(k)) { uses.set(k, { label: `kit-image-${uses.size + 1}` }); defs.push(`[${uses.get(k).label}]: ${dataUri(r)}${title ? ` ${title}` : ""}`); note(src, r); emitted(r); }
      return `![${alt}][${uses.get(k).label}]`;
    }
    note(src, r); emitted(r);
    return `![${alt}](${target(src, r)}${title ? ` ${title}` : ""})`;
  });
  if (defs.length) text = `${text.replace(/\s*$/, "\n")}\n${defs.join("\n")}\n`;

  // <img src> tags: each carries its own copy; a srcset is refused
  text = replaceOutside(text, protectedRanges(text), HTML_IMG, (m) => {
    const tag = m[0];
    if (/\bsrcset\s*=/i.test(tag)) { problems.push(`<img srcset> is not exportable (${tag.slice(0, 60)}…): use one src or the Markdown image syntax`); return undefined; }
    const s = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!s) return undefined;
    const src = s[1] ?? s[2] ?? s[3];
    const r = load(src);
    if (r === "remote" || r === null) return undefined;
    note(src, r); emitted(r);
    return tag.replace(s[0], `src="${target(src, r)}"`);
  });
  if (/<(?:source|picture)\b[^>]*\bsrcset\s*=/i.test(text.replace(/<!--[\s\S]*?-->/g, ""))) problems.push("a <picture>/<source srcset> is not exportable: use one Markdown image");
  if (total > maxTotalBytes) problems.push(`the copy carries ${fmtBytes(total)} of images, over the limit of ${fmtBytes(maxTotalBytes)} in all: split the document`);

  // 3. relative links to other Markdown files do not resolve in a standalone copy
  const prot = protectedRanges(text);
  const links = [...text.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+\.md(?:#[^)\s>]*)?)>?[^)]*\)/g)].filter((m) => !REMOTE.test(m[1]) && !prot.some(([a, b]) => m.index >= a && m.index < b));
  for (const m of links) problems.push(`the relative link to ${m[1]} does not resolve in a standalone copy: make it an absolute URL or remove it`);
  return { text, images, problems, bytes: Buffer.byteLength(text) };
}
