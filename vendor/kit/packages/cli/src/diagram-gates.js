/**
 * The render gates (docs/DIAGRAMS.md, "Render gates"): what `kit diagrams render` refuses to write. A diagram delivered without
 * the brand (grey boxes, a serif fallback font) is a defect of the process, so the process fails instead of the reader noticing.
 *
 *   themeRoleProblems  the theme defines the colour roles, the accent and muted classes, a font file and a first family that is loaded
 *   decodePng          a small decoder (8-bit grey, RGB, RGBA, grey+alpha, palette; non-interlaced) → { width, height, rgba }
 *   paletteProblems    the picture's colours: the theme's background dominates, its ink is present, its accent appears where the
 *                      source uses it, and the picture is not greyscale-only while the theme has colour
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const MAX_CSS_WIDTH = 2400;   // the widest diagram (CSS px) the render accepts; wider is not readable on a phone
export const MAX_CSS_HEIGHT = 2500;   // the tallest diagram (CSS px): taller is a scroll of boxes no one reads on a phone
const ROLE_KEYS = ["fontFamily", "textColor", "background", "primaryColor", "primaryTextColor", "primaryBorderColor", "lineColor", "noteBkgColor", "noteBorderColor", "specialStateColor", "clusterBkg", "clusterBorder"];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Problems of a parsed theme: [string]. Empty when the theme defines every role the renderer needs. */
export function themeRoleProblems(theme) {
  const out = [];
  const v = theme?.initVars?.themeVariables || {};
  for (const k of ROLE_KEYS) if (!v[k]) out.push(`theme.init defines no ${k}`);
  for (const k of ROLE_KEYS.filter((k) => k !== "fontFamily")) if (v[k] && !HEX.test(v[k])) out.push(`theme.init ${k} is not a #RRGGBB colour (${v[k]})`);
  for (const c of ["accent", "muted"]) if (!theme.classDefs?.has(c)) out.push(`theme.init defines no classDef ${c}`);
  const accent = theme.classDefs?.get("accent")?.match(/fill:(#[0-9a-fA-F]{6})/);
  if (theme.classDefs?.has("accent") && !accent) out.push("theme.init classDef accent has no fill colour");
  if (!theme.fonts?.length) out.push('theme.init declares no font (a `%% font: "Family" path/to/font.ttf` line): the renderer never falls back to a default face');
  const first = String(v.fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (first && theme.fonts?.length && !theme.fonts.some((f) => f.family === first)) out.push(`theme.init fontFamily starts with "${first}" but the font files declared are ${theme.fonts.map((f) => f.family).join(", ")}`);
  return out;
}

/** The accent fill colour of a theme (#RRGGBB) or null. */
export const accentOf = (theme) => theme.classDefs?.get("accent")?.match(/fill:(#[0-9a-fA-F]{6})/)?.[1] || null;

// ---- PNG decoding ----
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** { width, height, rgba: Uint8Array } of a PNG (8 bit, non-interlaced; colour types 0, 2, 3, 4, 6), or throws. */
export function decodePng(png) {
  let p = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p), type = png.toString("latin1", p + 4, p + 8), data = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ct: data[9], il: data[12] };
    else if (type === "PLTE") plte = data; else if (type === "tRNS") trns = data; else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  if (!ihdr) throw new Error("not a PNG (no IHDR)");
  if (ihdr.depth !== 8 || ihdr.il !== 0) throw new Error(`unsupported PNG (depth ${ihdr.depth}, interlace ${ihdr.il}): the renderer writes 8-bit non-interlaced`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.ct];
  if (!ch) throw new Error(`unsupported PNG colour type ${ihdr.ct}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch, rgba = new Uint8Array(ihdr.w * ihdr.h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride), o = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[o++];
    for (let x = 0; x < stride; x++) {
      const v = raw[o++], a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      cur[x] = (v + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
    }
    for (let x = 0; x < ihdr.w; x++) {
      const i = (y * ihdr.w + x) * 4, s = x * ch;
      if (ihdr.ct === 6) { rgba[i] = cur[s]; rgba[i + 1] = cur[s + 1]; rgba[i + 2] = cur[s + 2]; rgba[i + 3] = cur[s + 3]; }
      else if (ihdr.ct === 2) { rgba[i] = cur[s]; rgba[i + 1] = cur[s + 1]; rgba[i + 2] = cur[s + 2]; rgba[i + 3] = 255; }
      else if (ihdr.ct === 0) { rgba[i] = rgba[i + 1] = rgba[i + 2] = cur[s]; rgba[i + 3] = 255; }
      else if (ihdr.ct === 4) { rgba[i] = rgba[i + 1] = rgba[i + 2] = cur[s]; rgba[i + 3] = cur[s + 1]; }
      else { const k = cur[s] * 3; rgba[i] = plte[k]; rgba[i + 1] = plte[k + 1]; rgba[i + 2] = plte[k + 2]; rgba[i + 3] = trns && cur[s] < trns.length ? trns[cur[s]] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width: ihdr.w, height: ihdr.h, rgba };
}

const near = (r, g, b, hex, tol) => {
  const n = parseInt(hex.slice(1), 16);
  return Math.abs(r - (n >> 16)) <= tol && Math.abs(g - ((n >> 8) & 255)) <= tol && Math.abs(b - (n & 255)) <= tol;
};

/** { total, bg, ink, accent, chromatic }: how many pixels are near the theme's background, ink and accent; how many are chromatic (not grey). */
export function paletteReport(png, theme) {
  const { width, height, rgba } = decodePng(png);
  const v = theme.initVars.themeVariables, accent = accentOf(theme);
  const r = { total: width * height, bg: 0, ink: 0, accent: 0, chromatic: 0 };
  for (let i = 0; i < rgba.length; i += 4) {
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
    if (near(R, G, B, v.background, 3)) r.bg++;
    if (near(R, G, B, v.textColor, 12)) r.ink++;
    if (accent && near(R, G, B, accent, 6)) r.accent++;
    if (Math.max(R, G, B) - Math.min(R, G, B) > 24) r.chromatic++;
  }
  return r;
}

/** Problems of a rendered picture against the theme and its source: [string]. */
export function paletteProblems(png, theme, source) {
  let r;
  try { r = paletteReport(png, theme); } catch (e) { return [`the picture cannot be read to check its colours: ${e.message}`]; }
  const out = [];
  const bg = theme.initVars.themeVariables.background;
  if (r.bg / r.total < 0.2) out.push(`the picture does not carry the theme's background ${bg} (${(100 * r.bg / r.total).toFixed(1)}% of its pixels): it was not rendered with docs/diagrams/theme.init`);
  if (r.ink < 50) out.push(`the picture has none of the theme's text colour ${theme.initVars.themeVariables.textColor}`);
  const accent = accentOf(theme);
  const usesAccent = source.split("\n").some((l) => !l.trim().startsWith("%%") && (/^\s*class\s+\S+\s+accent\b/.test(l) || /:::accent\b/.test(l)));   // a comment is not a node
  const kind = source.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() || "";
  if (accent && !usesAccent && /^(flowchart|graph|stateDiagram|classDiagram)\b/.test(kind)) out.push(`the picture carries none of the brand accent ${accent}: mark the diagram's key node(s) with class accent`);
  if (accent && usesAccent && r.accent < 20) out.push(`the source marks a node with the accent class but the picture has no ${accent}: the theme's classDef did not apply`);
  const themeHasColour = accent && (parseInt(accent.slice(1), 16) > 0) && Math.max(...[1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16))) - Math.min(...[1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16))) > 24;
  if (themeHasColour && usesAccent && r.chromatic < 20) out.push("the picture is greyscale-only while the theme declares colour roles");
  return out;
}

// ---- the identity footer ----

/**
 * The lines drawn inside every PNG, generated from the header only: [{ text, strong? }]. Identity first (id, project, version,
 * reviewed date, title), then the lineage in short lines; an explicit phrase when nothing is declared (the check already fails
 * empty-by-omission stubs, so an empty list here is a deliberate one).
 */
export function footerLines(h) {
  const list = (a) => a.join(", ");
  const rel = (h.relates_to || []).map((r) => `${r.id} (${r.relation})`);
  const dep = (h.depicts || []).map((d) => d.ref);
  const lin = h.lineage || {};
  const out = [
    { text: h.id, strong: true },
    { text: `${h.title}  ·  project ${h.project}  ·  v${lin.version ?? "?"}  ·  ${h.reviewed ? `reviewed ${h.reviewed}` : h.generated ? "generated" : "not reviewed"}` },
  ];
  const lineage = [];
  if ((lin.derives_from || []).length) lineage.push(`derives from: ${list(lin.derives_from)}`);
  if ((lin.supersedes || []).length) lineage.push(`supersedes: ${list(lin.supersedes)}`);
  if (rel.length) lineage.push(`relates to: ${list(rel)}`);
  if (!lineage.length) lineage.push("no lineage declared (derives from, supersedes and relates to: none)");
  out.push(...lineage.map((text) => ({ text })));
  out.push({ text: dep.length ? `depicts: ${list(dep.slice(0, 3))}${dep.length > 3 ? ` +${dep.length - 3}` : ""}` : "depicts: nothing declared" });
  return out;
}

/** sha256 of the footer text: the PNG's `kit-diagram-footer` stamp, so a footer that differs from its header fails the check. */
export function footerHash(h) {
  return createHash("sha256").update(footerLines(h).map((l) => l.text).join("\n")).digest("hex");
}
