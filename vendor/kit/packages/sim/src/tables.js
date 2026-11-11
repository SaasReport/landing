/**
 * Reference tables of the standards as data (kit.sim-factor-table.v1) and the jurisdiction profile that selects and, within
 * the standard's own bounds, adjusts them (kit.sim-profile.v1). A table row is {id, value, unit, ref, min?, max?}; unit "bp"
 * is basis points (10000 = 100%), "count" a count, "currency-major" an amount in whole currency units. A profile override is
 * accepted only when the row carries a bound (min and/or max: the standard's floor or cap, e.g. the 10% floor of less stable
 * retail run-off, the 3% option for stable deposits) and the new value lies inside it; otherwise it is refused, so a
 * profile can tighten or use a stated national option but never silently loosen the standard. No code changes are needed
 * to add a profile.
 */
import { SimError } from "./errors.js";
import { validateFactorTable, validateProfile } from "./schemas.js";

export const BASELINE = "baseline";

export function buildTables(profileId, { tables, profiles }) {
  const profile = Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined;
  if (!profile) throw new SimError("unknown-profile", `no profile "${profileId}" (known: ${Object.keys(profiles).join(", ")})`, "profile");
  const pp = validateProfile(profile);
  if (pp.length) throw new SimError("bad-profile", `profile "${profileId}" is off its schema: ${pp.join("; ")}`, "profile");
  if (profile.id !== profileId) throw new SimError("bad-profile", `profile registered as "${profileId}" has id "${profile.id}"; the id must equal its key`, "profile");
  if (profile.extends !== null && profile.extends !== BASELINE) throw new SimError("bad-profile", `profile "${profileId}" extends "${profile.extends}": only the ${BASELINE} tables exist to extend`, "profile");
  const out = {};
  for (const [tid, t] of Object.entries(tables)) {
    const tp = validateFactorTable(t);
    if (tp.length) throw new SimError("bad-table", `table "${tid}" is off its schema: ${tp.join("; ")}`, tid);
    if (t.id !== tid) throw new SimError("bad-table", `table key "${tid}" differs from its id "${t.id}"`, tid);
    if (t.profile !== BASELINE) throw new SimError("bad-table", `table "${tid}" belongs to profile "${t.profile}": the tables are the ${BASELINE} standard and a profile only overrides rows of them`, tid);
    const rows = Object.create(null);
    for (const f of t.factors) {
      if (Object.hasOwn(rows, f.id)) throw new SimError("bad-table", `table "${tid}" repeats factor "${f.id}"`, tid);
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new SimError("bad-table", `${tid}/${f.id}: min ${f.min} above max ${f.max}`, tid);
      if ((f.min !== undefined && f.value < f.min) || (f.max !== undefined && f.value > f.max)) throw new SimError("bad-table", `${tid}/${f.id}: value ${f.value} is outside its own bounds [${f.min ?? "-"}, ${f.max ?? "-"}]`, tid);
      rows[f.id] = { value: f.value, unit: f.unit, ref: f.ref, min: f.min, max: f.max };
    }
    out[tid] = { id: tid, version: t.version, currency: t.currency, standard: t.standard, rows };
  }
  const applied = [], seen = new Set();
  for (const o of profile.overrides) {
    const key = `${o.table}/${o.factor}`;
    if (seen.has(key)) throw new SimError("bad-profile", `profile "${profileId}" overrides ${key} twice`, "profile");
    seen.add(key);
    const t = Object.hasOwn(out, o.table) ? out[o.table] : undefined, row = t && Object.hasOwn(t.rows, o.factor) ? t.rows[o.factor] : undefined;
    if (!row) throw new SimError("unknown-factor", `profile "${profileId}" overrides ${o.table}/${o.factor}, which is not in the tables`, "profile");
    if (row.min === undefined && row.max === undefined) throw new SimError("override-refused", `${o.table}/${o.factor} has no national option in the standard (${row.ref}); a profile cannot change it`, "profile");
    if ((row.min !== undefined && o.value < row.min) || (row.max !== undefined && o.value > row.max)) throw new SimError("override-out-of-range", `${o.table}/${o.factor} = ${o.value} is outside the standard's bounds [${row.min ?? "-"}, ${row.max ?? "-"}] (${row.ref})`, "profile");
    applied.push({ table: o.table, factor: o.factor, from: row.value, to: o.value, ref: o.ref, reason: o.reason });
    row.value = o.value;
  }
  const get = (tid, fid) => {
    const r = Object.hasOwn(out, tid) && Object.hasOwn(out[tid].rows, fid) ? out[tid].rows[fid] : undefined;
    if (!r) throw new SimError("unknown-factor", `no factor ${tid}/${fid}`, `${tid}/${fid}`);
    return r;
  };
  return { profile: profileId, tables: out, get, value: (tid, fid) => get(tid, fid).value, applied, has: (tid, fid) => Object.hasOwn(out, tid) && Object.hasOwn(out[tid].rows, fid) };
}
