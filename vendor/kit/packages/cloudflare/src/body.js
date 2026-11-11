/**
 * Request bodies for handlers: the size cap is enforced while the body streams in (@saasreport/uploads readBounded), never after
 * request.json() / text() has buffered it. A body needs a Content-Length; a lying or oversized one is refused.
 *
 *   const { value, response } = await readJsonBody(request, { maxBytes, fallback })
 *     response: a kit.upload-error.v1 Response for too_large / length_required / bad_content_length / length_mismatch (return it);
 *     contentLength: "required" (default) refuses a body with no Content-Length (411); "optional" is for Workers reached only by Service binding, which
 *       still stops at maxBytes while the body streams.
 *     value: the parsed JSON, or `fallback` (and invalid: true) when the body is not valid JSON or cannot be read (the handler's own invalid-input path).
 */
import { readBoundedJson, bodyErrorResponse, BodyError } from "@saasreport/uploads/bounded";

export const MAX_JSON_BYTES = 64 * 1024;
const HARD = new Set(["too_large", "length_required", "bad_content_length", "length_mismatch"]);

export async function readJsonBody(request, { maxBytes = MAX_JSON_BYTES, fallback = null, contentLength = "required" } = {}) {
  try { return { value: (await readBoundedJson(request, { maxBytes, contentLength })).value, response: null, invalid: false }; }
  catch (e) {
    if (e instanceof BodyError && HARD.has(e.code)) return { value: fallback, response: bodyErrorResponse(e), invalid: true };
    if (e instanceof BodyError) return { value: fallback, response: null, invalid: true };
    throw e;
  }
}
