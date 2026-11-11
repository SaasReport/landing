// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/shared/http.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance: TypeScript to JavaScript; every OpenAPI method (GET, PUT, POST, DELETE,
// OPTIONS, HEAD, PATCH, TRACE) instead of five; the verb comes from the contract, so upstream's guess of a verb from a
// CLI method name (getHttpMethod: "list" → GET, "create" → POST …) is not ported.

/** @typedef {"GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE"} HttpMethod */

/** The operations of an OpenAPI 3.1 path item, in the specification's order (§4.8.9). */
export const HTTP_METHODS = /** @type {const} */ (["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * Safe methods do not modify resources (RFC 9110 §9.2.1).
 * @param {string} method
 */
export function isSafeMethod(method) {
  return ["GET", "HEAD", "OPTIONS", "TRACE"].includes(method.toUpperCase());
}

/**
 * Idempotent methods (RFC 9110 §9.2.2).
 * @param {string} method
 */
export function isIdempotentMethod(method) {
  return isSafeMethod(method) || ["PUT", "DELETE"].includes(method.toUpperCase());
}

/**
 * Methods that typically carry a request body. A contract may still declare a body on any method but HEAD and TRACE,
 * whose requests never have content (RFC 9110 §9.3.2, §9.3.8).
 * @param {string} method
 */
export function methodHasBody(method) {
  return ["POST", "PUT", "PATCH"].includes(method.toUpperCase());
}

/**
 * Methods whose response never has content (HEAD, RFC 9110 §9.3.2).
 * @param {string} method
 */
export function responseHasNoContent(method) {
  return method.toUpperCase() === "HEAD";
}

/**
 * Mutating methods (anything not safe): POST, PUT, PATCH, DELETE.
 * @param {string} method
 */
export function isMutatingMethod(method) {
  return !isSafeMethod(method);
}

/**
 * Destructive methods: DELETE.
 * @param {string} method
 */
export function isDestructiveMethod(method) {
  return method.toUpperCase() === "DELETE";
}
