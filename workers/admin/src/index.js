// The admin Worker (admin.saasreport.ai). Every request is verified against Cloudflare Access BEFORE anything else (the one exception is the
// kit's /api/build, which carries a commit and nothing else); then the contract's routes, or the generated interface from the assets.
import { withBuild, buildBehind } from "@saasreport/cloudflare/build";
import { config } from "./config.js";
import { createAccess } from "./access.js";
import { match } from "./routes.js";
import { fail, unavailable, originProblem, SECURITY_HEADERS } from "./http.js";
import { auditDb, audit } from "./db.js";
import { can } from "./rbac.js";

const UI = "/workbench/";

/** A Worker with its own Access key cache; `deps` is for tests (fetch and now for the key set and the probes). */
export function createWorker(deps = {}) {
  const access = createAccess({ fetch: deps.fetch, now: deps.now });

  async function denied(env, identity, action, requestId, detail) {
    const db = auditDb(env);
    if (!db || !identity?.actorHash) return;
    try { await audit(db, { actorHash: identity.actorHash, action, outcome: "denied", targetKind: "request", targetId: "-", requestId, detail }); }
    catch (e) { console.error("[admin] the refusal could not be audited", String(e?.message || e)); }
  }

  async function handle(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const auth = await access.verify(request, env);
    if (!auth.ok) {
      if (auth.status === 503) return unavailable();
      if (auth.status === 403) { await denied(env, auth, "access", requestId, { reason: auth.reason }); return fail(403, "forbidden"); }
      return fail(401, "unauthorized");
    }
    const identity = { email: auth.email, actorHash: auth.actorHash };

    if (url.pathname.startsWith("/api/")) {
      const hit = match(request.method, url.pathname);
      if (!hit) return fail(404, "not_found");
      if (hit.allow) return fail(405, "method_not_allowed", undefined, { allow: hit.allow.join(", ") });
      const role = "owner";                                    // every identity on the allowlist is an owner; the check is the same for any role
      if (!can(role, hit.route.operationId)) { await denied(env, identity, hit.route.operationId, requestId, { reason: "permission" }); return fail(403, "forbidden", "permission"); }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const problem = originProblem(request);
        if (problem) { await denied(env, identity, hit.route.operationId, requestId, { reason: problem }); return fail(403, "forbidden", problem); }
      }
      try {
        return await hit.route.handler({ request, url, env, params: hit.params, identity, requestId, fetch: deps.fetch });
      } catch (e) {
        console.error(`[admin] ${hit.route.operationId} failed`, String(e?.message || e).slice(0, 200));
        return fail(500, "internal_error");
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method_not_allowed", undefined, { allow: "GET, HEAD" });
    if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: UI, ...SECURITY_HEADERS } });
    const assets = env[config.bindings.assets];
    if (!assets || typeof assets.fetch !== "function") return unavailable();
    const res = await assets.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  return withBuild({ fetch: handle }, async (env) => ({ comms: await buildBehind(env?.[config.bindings.comms]) }));
}

export default createWorker();
