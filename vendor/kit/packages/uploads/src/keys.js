/**
 * Object keys: q|r / upload id / form / sha256. The id comes first so objects list in the same order as records (a reconciler can merge-join
 * them page by page); the form and the sha256 stay for operators and integrity checks. An upload owns its objects: two uploads of the same bytes are two objects,
 * so deleting one (a customer request, retention, a rescan that withdraws a release) can never remove what another upload points
 * at, and there is no window between "is anything still pointing at this" and "delete it" for a concurrent intake to fall into.
 * The sha256 stays in the key for operators and integrity checks, the filename (user input) is never part of a key, and the id
 * is 128 random bits, so a released key is not guessable.
 */
import { isHex } from "./lex.js";
/** upl_ and 32 lower-case hex digits. */
export function isUploadId(id) {
  const s = String(id);
  if (s.length !== 36 || !s.startsWith("upl_")) return false;
  for (let i = 4; i < 36; i++) { const c = s.charCodeAt(i); if (!isHex(c) || (c >= 65 && c <= 70)) return false; }
  return true;
}
const keyOf = (prefix, form, sha256, id) => {
  if (!isUploadId(id)) throw new TypeError("object keys need the upload id (upl_ and 32 hex digits)");
  return `${prefix}/${id}/${form}/${sha256}`;
};
export const quarantineKey = (form, sha256, id) => keyOf("q", form, sha256, id);
export const releasedKey = (form, sha256, id) => keyOf("r", form, sha256, id);

export function uploadId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `upl_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
