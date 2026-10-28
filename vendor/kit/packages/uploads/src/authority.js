/**
 * Who may decide on uploads: the approval ledger (kit.approval-ledger.v1, ledger id <project>:uploads, subject = upload id), the same
 * append-only, hash-chained, signed ledger the Shariah and Persian gates use. An upload decision is ONE entry kind of it:
 *   { seq, id: <upload id>, sha256: <content sha256>, status: release | hold | unhold | delete, by, at, prev, note?, sig }       (the uploads kind's actions, core ledger.js)
 * signed over the ledger's own signedBody (ledger id, project and kind are in it, so a signature made for another ledger is worthless
 * here), appended only after checkAppend accepted it, verified here with the ledger code (canonical base64 only, prime-order keys,
 * s below L). The roster is the ledger's own (trust record approvals.uploads bootstrap, then roster-add / remove / rotate entries) and each
 * member's allowed actions are the owner-signed record's (verifyLedger refuses an entry outside them); the head is compared with the monotonic witness.
 *
 *   authority = { expect, bootstrap, loadLedger(), saveLedger(ledger, { expectedHead })?, witnessed?(id), windows?, witnessFrom?, onTamper?(problems) }       expect/bootstrap/witnessFrom: approvals.uploads of a verified trust record
 *   decision  = { ledger, seq, entry_hash }                                                      a reference to the entry; nothing signed is passed around
 *   authenticate({ authority, decision, record, action, now, ttlMs }) → human Principal | throws AuthError
 *   uploadDecisionEntry(ledger, { upload_id, sha256, action, note?, by, at }) → the unsigned entry a signer signs (signedBody) and checkAppend vets
 */
import { verifyLedger, witnessProblems, entryHash, nextEntry, kindActions, checkAppend, ledgerHead } from "@saasreport/core/ledger";
import { humanPrincipal } from "./principal.js";
import { AuthError } from "./errors.js";

export const ACTIONS = Object.freeze(["release", "delete", "hold_on", "hold_off"]);
/** The engine's action → the entry status of the uploads kind (core ledger.js kindActions("uploads")). */
const STATUS = Object.freeze({ release: "release", delete: "delete", hold_on: "hold", hold_off: "unhold" });

/** The unsigned entry for a decision (the signer adds `sig` over signedBody(ledger, entry), then checkAppend(ledger, entry, ctx) must pass before it is written). */
export function uploadDecisionEntry(ledger, { upload_id, sha256, action, note, by, at }) {
  return nextEntry(ledger, { id: upload_id, sha256, status: STATUS[action], by, at, ...(note ? { note } : {}) });
}

/** The highest ledger seq a record has used: the cursor (a record from before the cursor existed has it in its decision references). */
export const cursorOf = (record) => Math.max(record.last_ref_seq ?? 0, ...(record.decisions || []).map((d) => d.ref?.seq ?? 0));

/** The entry number a verifier problem names ("entry 7 (id): ..."), or null for a problem that is about the ledger as a whole. */
function entryOf(problem) {
  if (!problem.startsWith("entry ")) return null;
  let i = 6, n = 0;
  while (i < problem.length && problem.charCodeAt(i) >= 48 && problem.charCodeAt(i) <= 57) { n = n * 10 + problem.charCodeAt(i) - 48; i++; }
  return i > 6 ? n : null;
}

/**
 * THE writer path of the uploads ledger: every writer (the signing page, a CLI, an agent) appends through this, so an entry that would not verify
 * (not in the roster, outside the member's scope, back-dated, a non-canonical signature) is refused BEFORE it is stored, and the store's own
 * compare-and-set (saveLedger with the head it read) refuses a concurrent writer. → the reference { ledger, seq, entry_hash }.
 */
export async function appendEntry(authority, entry, { now = () => new Date() } = {}) {
  if (!authority?.loadLedger || !authority.saveLedger || !authority.expect) throw new AuthError("no_authority", "the ledger store has no append path");
  const ledger = await authority.loadLedger();
  const c = await checkAppend(ledger, entry, { expect: authority.expect, bootstrap: authority.bootstrap || [], now: now().getTime() });
  if (!c.ok) throw new AuthError("append_refused", c.problems[0]);
  await authority.saveLedger({ ...ledger, entries: [...ledger.entries, entry] }, { expectedHead: ledgerHead(ledger) });
  return { ledger: authority.expect.id, seq: entry.seq, entry_hash: entryHash(entry) };
}

export async function authenticate({ authority, decision, record, action, now, ttlMs = 24 * 60 * 60 * 1000 }) {
  if (!authority?.loadLedger || !authority.expect) throw new AuthError("no_authority", "no approval ledger is configured, so no human decision is accepted");
  if (!decision || typeof decision !== "object" || !Number.isInteger(decision.seq) || typeof decision.ledger !== "string" || typeof decision.entry_hash !== "string") throw new AuthError("malformed", "a decision is a reference { ledger, seq, entry_hash } to a ledger entry");
  if (!ACTIONS.includes(action)) throw new AuthError("malformed", `unknown action ${action}`);
  const { expect } = authority;
  if (decision.ledger !== expect.id) throw new AuthError("wrong_ledger", `${decision.ledger} is not ${expect.id}`);
  let ledger = await authority.loadLedger();
  const opts = { expect: { id: expect.id, project: expect.project, kind: expect.kind, subject: expect.subject, ...(expect.anchor ? { anchor: expect.anchor } : {}) }, bootstrap: authority.bootstrap || [], now: now().getTime() };
  let v = await verifyLedger(ledger, opts);
  if (!v.ok) {
    // one bad entry must not block every decision: the VERIFIED PREFIX (everything before the first entry with a problem) still answers, and the tail is reported
    const bad = v.problems.map(entryOf);
    if (bad.includes(null) || !bad.length) throw new AuthError("ledger_invalid", v.problems[0]);
    const first = Math.min(...bad);
    const problems = v.problems;
    ledger = { ...ledger, entries: ledger.entries.slice(0, first - 1) };
    v = first > 1 ? await verifyLedger(ledger, opts) : { ok: false, problems };
    if (!v.ok) throw new AuthError("ledger_invalid", problems[0]);
    if (typeof authority.onTamper === "function") { try { await authority.onTamper(problems); } catch { /* an alert that fails must not decide */ } }
  }
  const seen = authority.witnessed ? await authority.witnessed(expect.id) : null;
  const required = authority.witnessFrom != null && v.head.seq >= authority.witnessFrom;
  const wp = witnessProblems(ledger, seen, { required });
  if (wp.length) throw new AuthError("witness", wp[0]);
  const entry = ledger.entries[decision.seq - 1];
  if (!entry) throw new AuthError("ledger_invalid", `seq ${decision.seq} is not in the verified part of the ledger`);
  if (entryHash(entry) !== decision.entry_hash) throw new AuthError("entry_hash_mismatch", "the entry is not the one the decision names");
  if (!kindActions("uploads").includes(entry.status)) throw new AuthError("not_a_decision", `entry ${decision.seq} is not an upload decision`);
  if (entry.status !== STATUS[action]) throw new AuthError("wrong_action", `${entry.status} is not ${STATUS[action]}`);
  if (entry.id !== record.upload_id) throw new AuthError("wrong_upload");
  if (entry.sha256 !== record.sha256) throw new AuthError("wrong_content", "the decision is for different bytes");
  const latest = v.subjects.get(record.upload_id)?.entry;
  if (!latest || latest.seq !== entry.seq) throw new AuthError("superseded", "a later ledger entry for this upload overrides this decision");
  const member = entry.by;
  if (!v.roster.some((m) => m.name === member)) throw new AuthError("not_in_roster", `${member} is no longer a member of the roster`);
  const t = now().getTime(), at = Date.parse(entry.at);
  if (!(t - at <= ttlMs)) throw new AuthError("expired");
  const win = authority.windows?.[member];
  if (win) {   // a key's validity window is judged against the SERVER clock, never against the time the signer wrote
    if (win.valid_from && t < Date.parse(win.valid_from)) throw new AuthError("key_not_yet_valid");
    if (win.valid_until && t > Date.parse(win.valid_until)) throw new AuthError("key_expired");
  }
  if (decision.seq <= cursorOf(record)) throw new AuthError("replayed", "this ledger entry is not above the record's cursor: it was used, or a later one was");
  return humanPrincipal(member, { ledger: expect.id, seq: decision.seq, entry_hash: decision.entry_hash }, entry.at);
}
