/**
 * THE URL classifier of the markup triage: one definition of "this value fetches or runs something", used for href attributes, CSS url(),
 * the CSS functions that take a URL, and every presentation attribute (fill="url(...)", filter, mask, clip-path, marker-*, cursor).
 * No regular expressions. A value is read the way a URL parser reads it: ASCII control characters, tabs, newlines and spaces are removed
 * ("ht&#9;tp:" and "ht\9 tp:" are "http:"), and case is ignored.
 */
export const IMAGE_DATA = Object.freeze(["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/jpg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"]);

/** The value as a URL parser sees it: control characters and spaces gone, lower case. */
export function cleanUrl(v) {
  let out = "";
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if ((c > 32 && c < 127) || c > 159) out += v[i]; }
  return out.toLowerCase();
}
/** Does this URL stay inside the document (a fragment) or carry an inline raster image (data:image/png|jpeg|gif|webp;base64)? An empty value fetches nothing. */
export const isLocalReference = (v) => { const t = cleanUrl(v); return t === "" || t.startsWith("#") || IMAGE_DATA.some((p) => t.startsWith(p)); };
/** Anything else is external: another origin, a relative path, ftp:, an svg or html data URL. */
export const isExternalUrl = (v) => !isLocalReference(v);
export const isScriptUrl = (t) => t.startsWith("javascript:") || t.startsWith("vbscript:");
