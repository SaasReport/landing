/** Slugs and ids. */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSlug = (s, max = 90) => typeof s === "string" && s.length <= max && SLUG_RE.test(s);
/** Latin slug from any text (non-Latin letters are dropped; returns "" when nothing is left). */
export function slugify(text, max = 60) {
  const s = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}
export const ids = { slugify, isSlug, SLUG_RE };
