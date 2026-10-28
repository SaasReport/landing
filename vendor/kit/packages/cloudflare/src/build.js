/**
 * GET /api/build on every Worker a kit project deploys (contract: kit.build.v1, packages/core/schemas/build.schema.json; docs/RELEASE.md).
 * The production workflow deploys each Worker with `--var BUILD_COMMIT:<sha>` (`kit release ship`), so the commit is part of the Worker's
 * version; this answers it, with the builds of the Workers behind the service bindings under role keys (never an internal name: the
 * answer is public). `kit release verify` reads it with no credential right after the deploy and the drift workflow every day.
 *
 *   export default withBuild(worker)                                      // a Worker with no service behind it
 *   export default withBuild(worker, async (env) => ({ messages: await buildBehind(env.COMMS) }))
 *
 * Generalised from Federated-Banking/core src/kit/build.js (the reference that has served main's HEAD since 2026-10-09).
 */

const SHA = /^[0-9a-f]{40}$/;
export const BUILD_PATH = "/api/build";
/** The marker for a Worker behind a binding that did not answer: never null, which means "deployed without a commit" (a drift).
 *  The verify step reads it as unreadable, so a drift workflow never redeploys on it. */
export const UNREACHABLE = "unreachable";

/** This Worker's commit: the 40-hex commit, or null when the version carries none (a shell deploy, a local run). */
export const commitOf = (env = {}) => (SHA.test(String(env.BUILD_COMMIT ?? "")) ? env.BUILD_COMMIT : null);

/** The build the Worker behind a service binding answers, or { commit: UNREACHABLE, services: {} } when it answers none. */
export async function buildBehind(binding, { timeoutMs = 5000 } = {}) {
  if (!binding || typeof binding.fetch !== "function") return { commit: UNREACHABLE, services: {} };
  try {
    const r = await binding.fetch(new Request(`https://binding${BUILD_PATH}`, { signal: AbortSignal.timeout(timeoutMs) }));
    const b = r.ok ? await r.json() : null;
    if (b && typeof b === "object" && "commit" in b) return { commit: b.commit, services: b.services && typeof b.services === "object" ? b.services : {} };
  } catch (e) { console.error("[kit] build: the Worker behind a service binding did not answer", String(e?.message || e)); }
  return { commit: UNREACHABLE, services: {} };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** The kit.build.v1 Response for this Worker (GET only; anything else 405). */
export async function buildResponse(request, env, services = async () => ({})) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { ...JSON_HEADERS, allow: "GET" } });
  return new Response(JSON.stringify({ commit: commitOf(env), services: await services(env) }), { headers: JSON_HEADERS });
}

/**
 * Wraps a Worker (an object with fetch, and any other handlers: scheduled, queue, Durable Object exports stay on the module) so GET
 * /api/build answers kit.build.v1 and every other request goes to the Worker unchanged.
 */
export const withBuild = (worker, services = async () => ({})) => ({
  ...worker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== BUILD_PATH) return worker.fetch(request, env, ctx);
    return buildResponse(request, env, services);
  },
});
