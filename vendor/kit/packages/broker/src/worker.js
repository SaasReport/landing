/**
 * The broker as a Worker (contracts/openapi.json):
 *
 *   GET  /broker/v1/health   ready when config validates, the key is present and the store is bound
 *   POST /broker/v1/token    kit.broker-request.v1 → a scoped installation token
 *   POST /broker/v1/merge    kit.broker-request.v1 with a review → the broker merges
 *
 * Bindings: BROKER_CONFIG (kit.broker-config.v1 as JSON), APP_PRIVATE_KEY (secret, the App's PEM), DB (D1 with
 * migrations/0001_broker.sql). Anything missing or invalid fails closed: no request is served on a bad config.
 */
import { readBoundedJson, BodyError } from "@saasreport/uploads/bounded";
import { BrokerError } from "./errors.js";
import { createBroker } from "./broker.js";
import { d1Store } from "./evidence.js";
import { checkConfig } from "./config.js";
import { validateConfig } from "./schemas.js";

export const MAX_BODY_BYTES = 8192;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const refuse = (reason, status) => json(status, { ok: false, error: reason });

/** The config from the environment, validated; a BrokerError("config_invalid") otherwise. */
export function loadConfig(env) {
  let config;
  try { config = typeof env.BROKER_CONFIG === "string" ? JSON.parse(env.BROKER_CONFIG) : env.BROKER_CONFIG; }
  catch { throw new BrokerError("config_invalid", "BROKER_CONFIG is not JSON"); }
  const problems = config ? validateConfig(config) : ["BROKER_CONFIG is missing"];
  if (problems.length) throw new BrokerError("config_invalid", problems[0]);
  checkConfig(config);
  return config;
}

/** A fetch handler; `deps` lets tests inject fetch, clock and store. */
export function createBrokerWorker(deps = {}) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      const route = { "/broker/v1/health": "GET", "/broker/v1/token": "POST", "/broker/v1/merge": "POST" }[pathname];
      if (!route) return refuse("not_found", 404);
      if (request.method !== route) return refuse("method_not_allowed", 405);
      try {
        const config = loadConfig(env);
        if (!env.APP_PRIVATE_KEY) throw new BrokerError("key_invalid", "APP_PRIVATE_KEY is not set");
        const store = deps.store || (env.DB ? d1Store(env.DB) : null);
        if (!store) throw new BrokerError("config_invalid", "DB is not bound");
        if (pathname === "/broker/v1/health") return json(200, { ok: true, project: config.project });
        const broker = createBroker({ config, privateKey: env.APP_PRIVATE_KEY, store, fetch: deps.fetch, now: deps.now, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
        const { value } = await readBoundedJson(request, { maxBytes: MAX_BODY_BYTES });
        const result = pathname === "/broker/v1/token" ? await broker.token(value) : await broker.merge(value);
        return json(200, { ok: true, ...result });
      } catch (e) {
        if (e instanceof BodyError) return refuse(e.code, e.status);
        if (e instanceof BrokerError) return refuse(e.reason, e.status);
        return refuse("upstream_failed", 502);
      }
    },
  };
}

export default createBrokerWorker();
