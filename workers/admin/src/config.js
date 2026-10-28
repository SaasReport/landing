// The admin Worker's configuration by NAME (admin.config.json, kit-checked against admin-config.schema.json) and the build-time snapshot
// (generated/snapshot.json, scripts/admin-snapshot.mjs). Nothing here is a value of a secret: only the names the Worker reads.
import config from "../admin.config.json" with { type: "json" };
import snapshot from "../generated/snapshot.json" with { type: "json" };

export { config, snapshot };

/** A configured secret or variable as text, or "" when it is absent or not text. */
export const text = (env, name) => (typeof env?.[name] === "string" ? env[name].trim() : "");

const isBinding = (b, method) => Boolean(b) && typeof b[method] === "function";
/** The three bindings every request needs (the audit database, the engine database, the assets); the comms binding is needed by the mutations that call the engine. */
export const hasDb = (env, name) => isBinding(env?.[name], "prepare");
export const hasService = (env, name) => isBinding(env?.[name], "fetch");
