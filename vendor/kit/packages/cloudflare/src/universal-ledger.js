/** Immutable T=0 D1 ledger adapter. One canonical envelope, many append-only observations.
 * This does NOT prove live release: it persists already validated, scoped intent
 * and untrusted observations for the independent promotion controller to verify. */
import { canonicalJson } from "@saasreport/core/canonical";
import { sha256 } from "@saasreport/core/sha256";
import { universalEnvelopeProblems, assessUniversalEvidence } from "@saasreport/core/universal-envelope";
const insist = (ok, msg) => { if (!ok) throw new TypeError("universal ledger: " + msg); };
function dbContract(db) { insist(db && typeof db.prepare === "function", "D1 binding missing"); }
async function existingEnvelope(db, id) {
  return db.prepare("SELECT envelope_json FROM universal_envelopes WHERE envelope_id = ?").bind(id).first();
}
/** Idempotent insert. Never silently replace a different payload under an old ID. */
export async function storeUniversalEnvelope(db, envelope, { nativeSchema = null } = {}) {
  const problems = universalEnvelopeProblems(envelope, { nativeSchema });
  insist(problems.length === 0, "T0 envelope invalid: " + problems.join("; "));
  dbContract(db);
  const encoded = canonicalJson(envelope);
  const already = await existingEnvelope(db, envelope.id);
  if (already) {
    insist(already.envelope_json === encoded, "existing immutable envelope conflicts with incoming source");
    return { envelope_id: envelope.id, state: "already-stored-not-released", published: false };
  }
  // UNIQUE(idempotency_key) and primary key reject duplicates across namespaces.
  // The SQL admission triggers reject INSERT OR REPLACE as well as concurrent duplicate
  // inserts. A duplicate is idempotent only after reading and comparing the sealed bytes.
  let inserted = true;
  try {
    await db.prepare("INSERT INTO universal_envelopes (envelope_id, tenant, project, kind, subject, revision, authority_sha256, source_sha256, payload_sha256, idempotency_key, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(envelope.id, envelope.tenant, envelope.project, envelope.kind, envelope.subject,
        envelope.revision, envelope.authority.root_sha256, envelope.provenance.source_sha256,
        envelope.payload.sha256, envelope.trace.idempotency_key, encoded, envelope.occurred_at).run();
  } catch (error) {
    const winner = await existingEnvelope(db, envelope.id);
    if (winner?.envelope_json !== encoded) throw error;
    inserted = false;
  }
  const stored = await existingEnvelope(db, envelope.id);
  insist(stored?.envelope_json === encoded, "D1 failed post-write identity proof");
  return { envelope_id: envelope.id, state: inserted ? "stored-not-released" : "already-stored-not-released", published: false };
}
/** Append an observation only after validating its identity and required evidence kind. */
export async function appendUniversalLifecycleObservation(db, envelope, receipt, { nativeSchema = null } = {}) {
  const problems = universalEnvelopeProblems(envelope, { nativeSchema });
  insist(problems.length === 0, "T0 envelope invalid: " + problems.join("; "));
  const verdict = assessUniversalEvidence(envelope, [receipt], { nativeSchema });
  const invalid = verdict.blockers.filter((v) => v.reason !== "missing_required_evidence");
  insist(invalid.length === 0, "observation is not valid scoped evidence: " + JSON.stringify(invalid));
  dbContract(db);
  const stored = await existingEnvelope(db, envelope.id);
  insist(stored?.envelope_json === canonicalJson(envelope), "D1 source envelope absent or drifted");
  const eventBody = canonicalJson(receipt);
  const digest = sha256(eventBody);
  const eventId = envelope.trace.idempotency_key + "/" + receipt.kind + "/" + digest;
  try {
    await db.prepare("INSERT INTO universal_lifecycle_events (event_id, envelope_id, tenant, project, event_kind, event_sha256, observed_at, external_ref, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(eventId, envelope.id, envelope.tenant, envelope.project,
        receipt.kind, digest, receipt.observed_at, receipt.external_ref, eventBody).run();
  } catch (error) {
    // A concurrent writer is allowed only when it committed these exact canonical
    // bytes. The SQL insert guard deliberately rejects conflicting REPLACE writes.
    const existing = await db.prepare("SELECT event_json FROM universal_lifecycle_events WHERE event_id = ?").bind(eventId).first();
    if (existing?.event_json !== eventBody) throw error;
  }
  const saved = await db.prepare("SELECT event_json FROM universal_lifecycle_events WHERE event_id = ?").bind(eventId).first();
  insist(saved?.event_json === eventBody, "D1 event write failed");
  // This is NOT independent attestation; central deployment checks original real objects.
  return { event_id: eventId, state: "observation-recorded-unattested", deployed: false, published: false };
}
