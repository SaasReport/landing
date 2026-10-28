// The registries browser: the core registries as the build snapshot holds them (scripts/admin-snapshot.mjs reads vendor/core).
import { snapshot } from "../config.js";
import { fail, json } from "../http.js";

const NAMES = ["stakeholders", "metrics", "report-types", "findings", "commitments", "legal"];

export function listRegistries() {
  return json({ registries: NAMES.map((name) => ({ name, registry: snapshot.registries[name].registry, version: snapshot.registries[name].version, count: snapshot.registries[name].items.length })), source: snapshot.source });
}
export function getRegistry(ctx) {
  const name = ctx.params.name;
  if (!NAMES.includes(name)) return fail(404, "not_found");
  const r = snapshot.registries[name];
  return json({ name, registry: r.registry, version: r.version, count: r.items.length, items: r.items, ...(r.notes?.length ? { notes: r.notes } : {}) });
}
