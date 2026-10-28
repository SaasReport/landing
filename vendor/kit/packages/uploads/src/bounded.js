/**
 * The bounded body reader: the size cap is enforced WHILE the body streams in, so a body is never buffered first and
 * checked afterwards (request.text(), request.json() and request.formData() read everything, then the cap runs).
 *
 *   await readBounded(request, { maxBytes })            → { bytes, size }      throws BodyError
 *   await readBoundedText(request, { maxBytes })        → { text, size }       (UTF-8, fatal on invalid bytes)
 *   await readBoundedJson(request, { maxBytes })        → { value, size, text }
 *   bodyErrorResponse(err)                              → Response (kit.upload-error.v1)
 *
 * Rules (every one is a rejection, never a best effort):
 *   - a body needs a Content-Length (`contentLength: "required"`, the default; "optional" only for callers that read a
 *     body they know is small and sit behind a platform that has already bounded it);
 *   - Content-Length must be plain digits (no sign, no list "10, 20", no hex);
 *   - a declared length over maxBytes is refused before one byte is read (413 too_large) and the stream is cancelled;
 *   - bytes beyond the declared length, or fewer bytes than declared, are a lie (400 length_mismatch);
 *   - bytes beyond maxBytes while streaming cancel the stream (413 too_large).
 * Memory is bounded by min(maxBytes, declared length).
 */
import { concat } from "./bytes.js";
import { allDigits } from "./lex.js";

export const BODY_ERROR_STATUS = Object.freeze({ too_large: 413, length_required: 411, bad_content_length: 400, length_mismatch: 400, read_failed: 400, invalid_json: 400 });

export class BodyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BodyError";
    this.code = code;
    this.status = BODY_ERROR_STATUS[code] ?? 400;
  }
}

/** The declared Content-Length: a non-negative safe integer, null when absent. Throws bad_content_length. */
export function declaredLength(headers) {
  const raw = headers?.get ? headers.get("content-length") : null;
  if (raw == null) return null;
  if (!allDigits(raw.trim(), 15)) throw new BodyError("bad_content_length", "not a plain number");
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) throw new BodyError("bad_content_length", "not a safe integer");
  return n;
}

const cancel = (reader) => { try { reader.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } };

/**
 * Read a Request, Response or { body, headers } to bytes, within maxBytes.
 * @param {{ maxBytes: number, contentLength?: "required" | "optional" }} opts
 */
export async function readBounded(source, { maxBytes, contentLength = "required" } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("readBounded: maxBytes must be a non-negative integer");
  const declared = declaredLength(source.headers);
  const body = source.body;
  if (declared != null && declared > maxBytes) { if (body) { try { await body.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } } throw new BodyError("too_large", `declared ${declared} > ${maxBytes}`); }
  if (!body) {
    if (declared) throw new BodyError("length_mismatch", `declared ${declared}, no body`);
    return { bytes: new Uint8Array(0), size: 0 };
  }
  if (declared == null && contentLength === "required") { try { await body.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } throw new BodyError("length_required"); }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.length;
      if (declared != null && size > declared) { cancel(reader); throw new BodyError("length_mismatch", "more bytes than Content-Length"); }
      if (size > maxBytes) { cancel(reader); throw new BodyError("too_large", `more than ${maxBytes} bytes`); }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof BodyError) throw e;
    throw new BodyError("read_failed", String(e?.message || e).slice(0, 120));
  }
  if (declared != null && size !== declared) throw new BodyError("length_mismatch", `declared ${declared}, received ${size}`);
  return { bytes: concat(chunks, size), size };
}

/** readBounded, decoded as UTF-8 (invalid bytes are an error, not a replacement character). */
export async function readBoundedText(source, opts) {
  const { bytes, size } = await readBounded(source, opts);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), size, bytes }; }
  catch { throw new BodyError("read_failed", "body is not valid UTF-8"); }
}

/** readBounded, parsed as JSON (invalid_json 400). */
export async function readBoundedJson(source, opts) {
  const { text, size, bytes } = await readBoundedText(source, opts);
  try { return { value: JSON.parse(text), size, text, bytes }; } catch { throw new BodyError("invalid_json"); }
}

/** The refusal Response for a BodyError (kit.upload-error.v1). Anything else is rethrown. */
export function bodyErrorResponse(err) {
  if (!(err instanceof BodyError)) throw err;
  return new Response(JSON.stringify({ ok: false, error: err.code }), { status: err.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
