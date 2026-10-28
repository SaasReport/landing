/**
 * uploads.config.json → a validated, frozen configuration. The project must be in the project registry, both buckets carry that
 * project's own prefix (the naming constitution: a prefix of the project registry, never a legacy one), the two buckets differ, and every
 * form's policy is valid and names a scanner the project actually wired. Binding names and bucket names come from the file.
 */
import { validateConfig } from "./schemas.js";
import { resolveLimits } from "./limits.js";

export class ConfigError extends Error { constructor(problems) { super(`uploads config: ${problems.join("; ")}`); this.name = "ConfigError"; this.problems = problems; } }

/** @param raw the parsed uploads.config.json  @param {{ registry: { projects, legacy? }, scanners?: object }} ctx */
export function loadUploadsConfig(raw, { registry, scanners = {} } = {}) {
  const problems = validateConfig(raw);
  if (problems.length) throw new ConfigError(problems);
  const project = (registry?.projects || []).find((p) => p.key === raw.project);
  if (!project) throw new ConfigError([`project "${raw.project}" is not in the project registry`]);
  const prefixes = [project.prefix, project.short].filter(Boolean);
  const legacy = (registry.legacy || []).map((l) => l.prefix);
  const out = [];
  for (const which of ["quarantine", "released"]) {
    const name = raw.storage[which].bucket;
    if (legacy.some((l) => name.startsWith(l))) out.push(`${which} bucket ${name} uses a legacy prefix`);
    else if (!prefixes.some((p) => name.startsWith(p))) out.push(`${which} bucket ${name} must start with ${prefixes.join(" or ")} (the project's own prefix)`);
  }
  if (raw.storage.quarantine.bucket === raw.storage.released.bucket) out.push("quarantine and released must be different buckets");
  if (raw.storage.quarantine.binding === raw.storage.released.binding) out.push("quarantine and released must use different bindings");
  const ids = new Set();
  for (const [form, policy] of Object.entries(raw.forms)) {
    if (ids.has(policy.id)) out.push(`policy id ${policy.id} is used by two forms`);
    ids.add(policy.id);
    if (policy.scanner && !scanners[policy.scanner]) out.push(`form ${form}: scanner "${policy.scanner}" is not wired (createUploads({ scanners }))`);
    try { resolveLimits(policy.limits); } catch (e) { out.push(`form ${form}: ${e.message}`); }
    const names = policy.file_fields.map((f) => f.name);
    if (new Set(names).size !== names.length) out.push(`form ${form}: file field names must be unique`);
  }
  if (out.length) throw new ConfigError(out);
  return Object.freeze({ ...raw, project_prefixes: prefixes });
}
