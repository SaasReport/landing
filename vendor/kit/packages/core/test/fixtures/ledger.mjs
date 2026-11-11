// Test helpers: approver keys and signed, chained approval ledgers built the way `kit shariah approve` builds them (signed body: docs/CONCEPTS.md section 5).
import { generateKeyPairSync, sign } from "node:crypto";
import { genesisFor, nextEntry, signedBody, memberHash, verifyLedger, ledgerId, baselineHash } from "../../src/ledger.js";

export const COMMIT = "a".repeat(40);
export const PROJECT = "testproject";
export const NOW = Date.UTC(2026, 9, 8);          // verification clock: fixed, so a test never depends on the wall clock
export const keys = (name = "Dr Reviewer") => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { name, privateKey, publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64") };
};
export const rosterOf = (...ks) => ks.map((k) => ({ name: k.name, publicKey: k.publicKey }));
export const ledger = (kind = "shariah", baselineThrough = 0, project = PROJECT) => ({
  $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/approval-ledger.schema.json",
  id: ledgerId(project, kind), project, kind, subject: kind === "persian" ? "file" : "id",
  anchor: { commit: COMMIT, genesis: genesisFor(COMMIT), baselineThrough }, entries: [],
});
/** What the owner-signed record would say about this ledger: a ledger with baseline entries is given the owner's pin of exactly that set (the fixture plays the owner). */
export const expectOf = (l) => { const base = l.entries.filter((e) => e.status === "baseline"); return { id: l.id, project: l.project, kind: l.kind, subject: l.subject, ...(base.length ? { baseline: { sha256: baselineHash(base), entries: base.length }, anchor: l.anchor.commit } : {}) }; };
let clock = 0;
/** Appends a signed entry (or an unsigned baseline when `reviewer` is null). */
export function append(l, reviewer, fields) {
  const e = nextEntry(l, { at: new Date(Date.UTC(2026, 9, 7, 10, 0, clock++)).toISOString(), ...(reviewer ? { by: reviewer.name } : {}), ...fields });
  if (reviewer) e.sig = sign(null, Buffer.from(signedBody(l, e)), reviewer.privateKey).toString("base64");
  l.entries.push(e);
  return l;
}
export const ATTESTS = ["definition-accurate", "sources-read", "positions-fair", "not-a-fatwa"];
export const approve = (l, reviewer, id, sha256, extra = {}) => append(l, reviewer, { [l.subject]: id, sha256, status: "approved", attests: [...ATTESTS], statement: "I read the entry and its sources.", ...extra });
const soon = () => new Date(Date.UTC(2026, 9, 7, 10, 0, 0) + 24 * 3600 * 1000).toISOString();    // a roster proposal's signed expiry: one day after the fixture clock starts
export const addMember = (l, by, member, extra = {}) => append(l, by, { member: { name: member.name, publicKey: member.publicKey }, sha256: memberHash(member), status: "roster-add", expires: soon(), ...extra });
export const removeMember = (l, by, member, extra = {}) => append(l, by, { member: { name: member.name, publicKey: member.publicKey }, sha256: memberHash(member), status: "roster-remove", expires: soon(), ...extra });
/** The verified ledger the gate and the run time consume: `verify(l, roster)` → Promise. */
export const verify = (l, roster = [], over = {}) => verifyLedger(l, { expect: expectOf(l), bootstrap: roster, now: NOW, ...over });
