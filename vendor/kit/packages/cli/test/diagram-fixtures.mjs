// Shared by the diagram tests: a 1x1 PNG, and what `kit diagrams render` writes (lineage graph, index, stamped PNGs) without a browser.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { themeResolver, markdownFiles, mmdFiles, pngOf, sourceHash, stampPng } from "../src/diagrams.js";
import { pairRepo } from "../src/diagram-pairing.js";
import { footerHash } from "../src/diagram-gates.js";
import { crc32 } from "./crc.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { entriesWithLineage, generateIndex, generateLineage, lineageHeader, projectOf, INDEX_FILE, LINEAGE_FILE } from "../src/diagram-lineage.js";
import { readHeader } from "../src/diagram-header.js";

/** A real RGBA PNG in the theme's colours: background, ink and accent pixels (what a correct render looks like to the palette gate). */
export function themedPng(theme, { colours = true } = {}) {
  const v = theme.initVars.themeVariables, acc = (theme.classDefs.get("accent").match(/fill:(#[0-9a-fA-F]{6})/) || [])[1];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const W = 60, H = 40, raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const c = !colours ? [200, 200, 200] : y < 2 ? hex(v.textColor) : y === 2 && x < 40 ? hex(acc) : hex(v.background);
      const i = y * (W * 4 + 1) + 1 + x * 4;
      raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function png() {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
    return b;   // CRC left zero: the stamp code never verifies other chunks' CRCs
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

/** The header every fixture diagram starts from (a reviewed one); `over` replaces fields. */
export const header = (id, over = {}) => ({
  id, title: "A diagram", project: "kit", kind: "other",
  lineage: { derives_from: [], supersedes: [], version: "1" }, relates_to: [], depicts: [], reviewed: "2026-10-06", ...over,
});

/** What `kit diagrams render` leaves behind, minus the browser: lineage.mmd, the index, every .mmd's PNG stamped with hash and id. */
export function syncGenerated(root, project, kit) {
  const themes = kit ? themeResolver(root, kit) : themeResolver(root);
  const theme = themes.own.theme;
  // a source whose project has no theme gets no PNG, exactly as kit diagrams render refuses it (the check then reports the
  // missing PNG and the unknown project); it is never stamped with another organisation's theme
  const themeHash = (x) => { let t; try { t = themes.forSource(x); } catch (e) { if (/no theme|not a project/.test(e.message)) return null; throw e; } return t.hash; };
  const pr = projectOf(root, project, kit?.registry);
  const entries = entriesWithLineage(root, pr.code);
  writeFileSync(join(root, LINEAGE_FILE), generateLineage(entries.filter((e) => e.header && !e.header.generated), theme, pr.code));
  for (const f of mmdFiles(root)) {
    const src = readFileSync(join(root, f), "utf8");
    const hash = themeHash(src);
    if (hash === null) continue;
    writeFileSync(join(root, pngOf(f)), stampPng(png(), sourceHash(src), readHeader(src).header?.id, { theme: hash, footer: readHeader(src).header ? footerHash(readHeader(src).header) : undefined }));
  }
  // the Markdown pairing (image first), and the PNGs of blocks no .mmd covers
  for (const t of pairRepo(root, markdownFiles(root)).targets) {
    if (!t.own) continue;
    mkdirSync(dirname(join(root, t.png)), { recursive: true });
    const hash = themeHash(t.source);
    if (hash === null) continue;
    writeFileSync(join(root, t.png), stampPng(png(), sourceHash(t.source), t.id, { theme: hash, footer: readHeader(t.source).header ? footerHash(readHeader(t.source).header) : undefined }));
  }
  writeFileSync(join(root, INDEX_FILE), generateIndex(entriesWithLineage(root, pr.code).map((e) => (e.file === LINEAGE_FILE ? { ...e, header: lineageHeader(pr.code) } : e)), { projectName: pr.key }));
}
