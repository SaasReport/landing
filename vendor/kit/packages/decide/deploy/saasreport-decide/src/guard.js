/**
 * What the saasreport-decide Worker lets through to the container. The body is read through the bounded reader (the cap is enforced
 * while it streams, before one byte reaches the container) and forwarded as bytes; a System One request is a small JSON state.
 *
 *   forwardable(request, { maxBytes }) → { request } | { response }      response: a kit.upload-error.v1 Response (413, 400)
 */
import { readBounded, BodyError, bodyErrorResponse } from "@saasreport/uploads/bounded";

export const MAX_BODY_BYTES = 256 * 1024;

export async function forwardable(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  if (request.method === "GET" || request.method === "HEAD") return { request: new Request(request, { headers }) };
  try {
    const { bytes } = await readBounded(request, { maxBytes, contentLength: "optional" });
    headers.set("content-length", String(bytes.length));
    return { request: new Request(request.url, { method: request.method, headers, body: bytes }) };
  } catch (e) {
    if (e instanceof BodyError) return { response: bodyErrorResponse(e) };
    throw e;
  }
}
