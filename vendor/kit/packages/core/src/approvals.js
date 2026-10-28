/**
 * What the OWNER has signed about a project's approval ledgers (the trust record, trust.js): the ledger's path, kind, anchor, bootstrap roster, the one allowed
 * migration and the witness start. Nothing here is read from the project's own files or from an unsigned registry entry: a record only counts when the owner's
 * published GitHub SSH signing key verifies it. → { project, known, concepts, shariah, persian, problems }
 */
import { verifyTrustRecord, recordHash, pinProblems } from "./trust.js";

/**
 * trust = { records: [record…] }; ctx = { owner, ownerKeys, repo, now }. Takes the highest VERIFIED record: a higher-seq record that does not verify (forged, expired, unsigned, bad
 * schema) never hides a lower valid one, and the chosen record must be linked to the record just below it when that one is present (`supersedes`).
 */
export async function trustedApprovals(trust, project, ctx) {
  const set = trust?.records || [], none = (problems) => ({ project, known: false, concepts: null, shariah: null, persian: null, uploads: null, problems });
  const all = set.filter((r) => r?.project === project).sort((p, q) => q.seq - p.seq);
  const problems = [], invalidSeqs = [];
  // a record that is not even an object with a project, or a record of this project without an integer seq, cannot be attributed or ordered: it is a deleted/corrupted record in disguise
  const unreadable = set.filter((r) => !r || typeof r !== "object" || typeof r.project !== "string");
  if (unreadable.length) return none([`${unreadable.length} trust record(s) in the set have no project: the set is corrupted, so the gate fails closed`]);
  const noSeq = all.filter((r) => !Number.isInteger(r.seq) || r.seq < 1);
  if (noSeq.length) return none([`a trust record for "${project}" has no valid seq (${JSON.stringify(noSeq[0].seq)}): it cannot be ordered, so the gate fails closed instead of ignoring it`]);
  if (!all.length) { const v = await verifyTrustRecord(null, { ...ctx, project }); return { ...v.approvals, problems: v.problems }; }
  // the pin (minimum seq, verifier, witness) lives OUTSIDE the repository; a missing or malformed one means a deleted newest record could not be noticed
  const bad = pinProblems(ctx.pin); if (bad.length) return none(bad);
  for (const rec of all) {
    const v = await verifyTrustRecord(rec, { ...ctx, project });
    if (!v.ok) { problems.push(...v.problems.map((m) => `record seq ${rec.seq}: ${m}`)); invalidSeqs.push(rec.seq); continue; }
    const below = all.find((r) => r.seq === rec.seq - 1);
    if (below && below.signature && recordHash(below) !== rec.supersedes) { problems.push(`record seq ${rec.seq}: does not supersede the record at seq ${below.seq} present in the repository (the chain is broken)`); invalidSeqs.push(rec.seq); continue; }
    // a record ABOVE this one is present but does not verify: deleting or corrupting the owner's newest record must not downgrade the gate to an older, weaker one
    if (invalidSeqs.some((s) => s > rec.seq)) return { project, known: false, concepts: null, shariah: null, persian: null, uploads: null, problems: [`a higher-seq record is present but invalid, so the gate fails closed instead of falling back to seq ${rec.seq}`, ...problems] };
    return { ...v.approvals, problems: [] };
  }
  return none(problems);
}
