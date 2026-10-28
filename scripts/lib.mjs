import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }).sort();
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** sha256 of every vendored file except SOURCE.json, keyed by path relative to the vendor directory. */
export function fileHashes(dir) {
  return Object.fromEntries(walk(dir).filter((p) => !p.endsWith("SOURCE.json")).map((p) => [p.slice(dir.length + 1), createHash("sha256").update(readFileSync(p)).digest("hex")]));
}

/** WCAG 2.x contrast ratio of two #rrggbb colours, as an integer in hundredths (4.5 -> 450). */
export function contrastHundredths(a, b) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (h) => { const [r, g, bl] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100);
}
