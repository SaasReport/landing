/**
 * Canonical credential identity projection for a governed release.
 * Single owner: release.json + the monitor-required names derived by secretPlan.
 * This contains NO values, key hashes, guessed secrets, or Cloudflare success claims.
 * A matching binding name does not prove shared secret material; the shipper must
 * attest binding origin/epoch before treating distributed state as one identity.
 */
const GENERATED = new Set(["ADMIN_TOKEN", "DEVELOPER_KEY_PEPPER", "IP_SALT", "MONITOR_TOKEN"]);
const ID = /^[A-Z][A-Z0-9_]*$/;
const workspaceKey = (x) => x.wrangler + "\u0000" + (x.env || "");
const bindingKey = (x) => x.name + "\u0000" + workspaceKey(x);

export function credentialAuthority(doc, plan, workers) {
  if (!doc || !/^[a-z][a-z0-9-]*$/.test(doc.project || "")) throw new Error("credential authority: invalid project");
  if (!Array.isArray(plan) || !Array.isArray(workers)) throw new Error("credential authority: missing T0 Worker/secret plan");
  const environment = doc.environment || "production";
  const workerByPath = new Map();
  for (const worker of workers) {
    const key = workspaceKey(worker);
    if (workerByPath.has(key)) throw new Error("credential authority: duplicate Worker configuration " + worker.wrangler);
    if (!worker.name || !worker.wrangler) throw new Error("credential authority: Worker has no runtime identity");
    workerByPath.set(key, worker.name);
  }
  const generated = new Set();
  for (const name of doc.generated_secrets || []) {
    if (!GENERATED.has(name) || generated.has(name))
      throw new Error("credential authority: undeclared or duplicate daemon identity " + name);
    generated.add(name);
  }
  const optional = new Set(), required = new Set(), bindings = new Set();
  for (const [entries, target] of [[doc.secrets || [], required], [doc.optional_secrets || [], optional]]) {
    for (const p of entries) {
      if (!ID.test(p.name || "") || !p.wrangler || !workerByPath.has(workspaceKey(p)))
        throw new Error("credential authority: undeployed or malformed Worker binding " + (p.name || "(missing)"));
      if (bindings.has(bindingKey(p)))
        throw new Error("credential authority: duplicate or conflicting physical secret binding " + p.name);
      bindings.add(bindingKey(p));
      target.add(p.name);
    }
  }
  for (const name of optional) {
    if (required.has(name) || generated.has(name))
      throw new Error("credential authority: " + name + " has multiple lifecycle owners");
  }
  const ownerNames = new Set(["OPS_NOTIFY_TO", doc.owner?.secret, ...(doc.owner?.targets || []).map(x => x.name)]);
  const groups = new Map();
  const observedBindings = new Set();
  for (const entry of plan) {
    const key = bindingKey(entry);
    if (!ID.test(entry.name || "") || !workerByPath.has(workspaceKey(entry)))
      throw new Error("credential authority: planned secret has no declared Worker " + (entry.name || "(missing)"));
    if (!generated.has(entry.name) && !required.has(entry.name) && !optional.has(entry.name) && !entry.monitorDerived)
      throw new Error("credential authority: undeclared runtime identity " + entry.name);
    if (ownerNames.has(entry.name))
      throw new Error("credential authority: owner address is not a runtime secret: " + entry.name);
    if (observedBindings.has(key))
      throw new Error("credential authority: repeated runtime binding: " + entry.name);
    observedBindings.add(key);
    const classification = generated.has(entry.name) ? "daemon" : optional.has(entry.name) ? "optional-provider" : "provider";
    if (Boolean(entry.optional) !== (classification === "optional-provider"))
      throw new Error("credential authority: optional/required binding drift: " + entry.name);
    if (!groups.has(entry.name)) groups.set(entry.name, { name: entry.name, id: "urn:saasreport:credential:" + doc.project + ":" + environment + ":" + entry.name,
      principal: classification === "daemon" ? "release-daemon" : "external-provider", lifecycle: classification,
      scope: { project: doc.project, environment }, consumers: [] });
    groups.get(entry.name).consumers.push({ worker: workerByPath.get(workspaceKey(entry)), wrangler: entry.wrangler, env: entry.env || "", binding: entry.name });
  }
  for (const name of [...generated, ...required, ...optional])
    if (!groups.has(name)) throw new Error("credential authority: orphan credential has no deployed consumer: " + name);
  for (const p of [...doc.secrets || [], ...doc.optional_secrets || []])
    if (!observedBindings.has(bindingKey(p)))
      throw new Error("credential authority: declared binding is absent from release secret plan: " + p.name);
  // Shared identity is ONE name and lifecycle across ALL declared consumers;
  // remote existence alone cannot prove equal values or epoch.
  return Object.freeze([...groups.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(g =>
    Object.freeze({ ...g, consumers: Object.freeze(g.consumers.sort((a,b) => a.worker.localeCompare(b.worker)).map(x => Object.freeze(x))) })));
}
