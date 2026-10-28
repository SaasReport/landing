// Test helper: owner-signed trust records. The fixture plays the owner: it adds the approval keys' fingerprints, the supersedes chain and signs with the owner's SSH key.
import { trustBody, trustNamespace, keyFingerprint, recordHash } from "../../src/trust.js";
import { sshSign } from "./ssh.mjs";

export const withFingerprints = (approvals) => Object.fromEntries(Object.entries(approvals).map(([k, v]) => [k, v && typeof v === "object" && Array.isArray(v.roster) ? { ...v, roster: v.roster.map((m) => ({ ...m, ...(m.fingerprint ? {} : { fingerprint: keyFingerprint(m.publicKey) }) })) } : v]));
/** record({ project, approvals, seq, supersedes, github, owner, at, expires, extra, key }) → a signed record. */
export function makeRecord({ project = "p", approvals, seq = 1, supersedes, github = "SaasReport/site", owner = "masoud", at = "2026-10-07T10:00:00.000Z", expires = "2099-10-07T10:00:00.000Z", extra = {}, key, namespaceProject = project }) {
  const r = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/trust-record.schema.json", v: 1, project, github, owner, seq, supersedes: supersedes !== undefined ? supersedes : seq === 1 ? null : "a".repeat(64), at, expires, approvals: withFingerprints(approvals), ...extra };
  r.signature = sshSign(key, trustBody(r), trustNamespace(namespaceProject));
  return r;
}
/** A chain of records: each supersedes the hash of the one before. */
export function chain(specs) { const out = []; for (const s of specs) out.push(makeRecord({ ...s, supersedes: out.length ? recordHash(out.at(-1)) : null })); return out; }
