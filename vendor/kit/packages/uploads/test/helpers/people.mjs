// The people who decide on uploads, for tests: an approval ledger (kit.approval-ledger.v1, `<project>:uploads`, subject = upload id) the way
// `kit` builds one, with one approver key, and the `authority` the engine takes. A decision is an entry signed over signedBody and referenced by { ledger, seq, entry_hash }.
import { sign as edSign } from "node:crypto";
import { keys, ledger as newLedger, expectOf } from "../../../core/test/fixtures/ledger.mjs";
import { signedBody, entryHash, nextEntry, ledgerHead } from "@saasreport/core/ledger";
import { appendEntry } from "../../src/authority.js";
const STATUS = { release: "release", delete: "delete", hold_on: "hold", hold_off: "unhold" };

/** → { authority, ledger, sign(record, action, note?, over?) → ref, approver, add(over) } where entries are dated by `now()` (over.decided_at overrides, over.by names another signer). */
export function people(now = () => new Date(), { name = "Dr Reviewer", actions = null, windows = null, witnessFrom = null } = {}) {
  const approver = keys(name);
  const ledger = newLedger("uploads");
  const signers = new Map([[name, approver]]);
  let witnessedHead = null;
  const tampered = [];
  const authority = {
    expect: expectOf(ledger),
    bootstrap: [{ name, publicKey: approver.publicKey, ...(actions ? { actions } : {}) }],
    loadLedger: async () => structuredClone(ledger),
    saveLedger: async (next, { expectedHead }) => { const h = ledgerHead(ledger); if (h.seq !== expectedHead.seq || h.hash !== expectedHead.hash) throw new Error("ledger head moved: refused"); ledger.entries = next.entries; },   // the store's compare-and-set write
    onTamper: async (problems) => { tampered.push(...problems); },
    witnessed: async () => witnessedHead,
    ...(windows ? { windows } : {}),
    ...(witnessFrom != null ? { witnessFrom } : {}),
  };
  /** Append a signed decision entry and return the reference to it. `over` overrides entry fields; `over.signer` is a keys() object that signs it. */
  let chain = Promise.resolve();   // one writer at a time, as the ledger's file is
  const sign = (record, action, note, over = {}) => { const run = chain.then(() => signNow(record, action, note, over)); chain = run.catch(() => {});   /* the caller sees the rejection on `run`; the chain only needs to go on */ return run; };
  const signNow = async (record, action, note, over = {}) => {
    const { signer = approver, decided_at, force = false, ...fields } = over;
    const e = nextEntry(ledger, { id: record.upload_id, sha256: record.sha256, status: STATUS[action], by: signer.name, at: decided_at ?? now().toISOString(), ...(note ? { note } : {}), ...fields });
    e.sig = edSign(null, Buffer.from(signedBody(ledger, e)), signer.privateKey).toString("base64");
    if (force) { ledger.entries.push(e); return { ledger: ledger.id, seq: e.seq, entry_hash: entryHash(e) }; }   // a writer that bypasses the append path: a tampered ledger
    return appendEntry(authority, e, { now });   // the one writer path: checkAppend before the store, then the store's compare-and-set
  };
  return { authority, ledger, sign, approver, tampered, witness: () => { witnessedHead = { seq: ledger.entries.length, hash: ledger.entries.length ? entryHash(ledger.entries.at(-1)) : ledger.anchor.genesis }; } };
}

/** The uploads calls with their signed decision made for you: s.release(id, note), s.del(id, note), s.holdOn(id), s.holdOff(id). */
export function decide(uploads, records, sign) {
  const rec = (id) => records.get(id);
  const signed = async (id, action, note) => sign((await rec(id)) ?? { upload_id: id, sha256: "0".repeat(64) }, action, note);
  return {
    release: async (id, note = "reviewed") => uploads.release(id, { decision: await signed(id, "release", note) }),
    del: async (id, note = "erasure request") => uploads.delete(id, { decision: await signed(id, "delete", note) }),
    hold: async (id, on, note) => uploads.hold(id, on, { decision: await signed(id, on ? "hold_on" : "hold_off", note) }),
  };
}
