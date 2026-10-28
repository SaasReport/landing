// The provisioning view: what this Worker has and lacks (NAMES and presence, never a value), the planned resource names against the naming
// registry, and the kit's provisioning registry and release records when the repository holds them (the snapshot).
import { config, snapshot, text, hasDb, hasService } from "../config.js";
import { json } from "../http.js";

const present = {
  secret: (env, name) => text(env, name) !== "",
  var: (env, name) => text(env, name) !== "",
};

/** Missing required configuration and bindings, for the overview and the provisioning view. */
export function readiness(env) {
  const s = config.secrets, b = config.bindings;
  const cfg = [
    { name: s.teamDomain, kind: "secret", required: true }, { name: s.aud, kind: "secret", required: true }, { name: s.allowlist, kind: "secret", required: true },
    { name: s.githubRead, kind: "secret", required: false }, { name: config.buildCommit, kind: "var", required: false },
  ].map((c) => ({ ...c, present: present[c.kind](env, c.name) }));
  const bindings = [
    { name: b.audit, kind: "d1", required: true, present: hasDb(env, b.audit) }, { name: b.engineDb, kind: "d1", required: true, present: hasDb(env, b.engineDb) },
    { name: b.comms, kind: "service", required: true, present: hasService(env, b.comms) }, { name: b.assets, kind: "assets", required: true, present: hasService(env, b.assets) },
  ];
  const missing = [...cfg, ...bindings].filter((x) => x.required && !x.present).map((x) => x.name);
  return { cfg, bindings, missing, ready: missing.length === 0 };
}

export function getProvisioning(ctx) {
  const r = readiness(ctx.env);
  return json({ ready: r.ready, config: r.cfg, bindings: r.bindings, planned: snapshot.planned, naming: snapshot.naming, registry: { provisioning: snapshot.provisioning, release: snapshot.release } });
}
