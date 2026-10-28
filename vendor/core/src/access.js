// Role-based access. Least privilege equals Stripe visibility: a report is available to a person only when
// their Stripe roles already let them see the data behind every metric in it. Unknown roles see nothing.
// Pure; the registries are passed in. This decides what to SHOW. The server must enforce it again (see stripe-signature.js).

/** The data classes a report needs: every input of every metric in it, mapped through the registry. */
export function reportClasses({ roles, metrics }, reportType) {
  const byId = new Map(metrics.metrics.map((m) => [m.id, m]));
  const out = new Set();
  for (const sec of reportType.sections) for (const id of sec.metrics) {
    const m = byId.get(id);
    if (!m) throw new RangeError(`report type ${reportType.id}: unknown metric ${id}`);
    for (const input of m.inputs) out.add(roles.input_class[input]);
  }
  return [...out].sort();
}

/** The union of data classes the given Stripe role ids can see (Stripe gives a user the permissions of every role). */
export function classesFor(roles, roleIds) {
  if (!Array.isArray(roleIds)) return new Set();
  const known = new Map(roles.roles.map((r) => [r.id, r]));
  const out = new Set();
  for (const id of roleIds) for (const c of known.get(id)?.sees ?? []) out.add(c);
  return out;
}

/**
 * @param {object} registries {roles, metrics, reportTypes}
 * @param {string[]|undefined} roleIds Stripe role ids of the user (undefined: unverified, no access)
 * @param {{reportTypes?: string[]}} [grant] extra report types an account administrator granted this user inside SaasReport
 * @returns {string[]} report type ids, in registry order
 */
export function allowedReportTypes({ roles, metrics, reportTypes }, roleIds, grant = {}) {
  const have = classesFor(roles, roleIds);
  const granted = new Set(Array.isArray(roleIds) ? grant.reportTypes ?? [] : []);
  return reportTypes.report_types
    .filter((r) => granted.has(r.id) || reportClasses({ roles, metrics }, r).every((c) => have.has(c)))
    .map((r) => r.id);
}
