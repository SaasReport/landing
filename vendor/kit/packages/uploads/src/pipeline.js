/**
 * The upload pipeline (docs/UPLOADS.md): bounded bytes in, then
 *   filename normalised, sha256, magic-byte sniff against the form's allowlist, static triage, scan (pluggable, explicit verdict),
 *   decision, then the record (pending) FIRST, the QUARANTINE object, the released object only on allow / allow_with_limits (or
 *   needs_sandbox when the form says release_download_only), and the commit of the record to its decided stage. Every stage change
 *   is a transition of the declared lifecycle (lifecycle.json); every object key is derived from its record (keys.js); an
 *   interrupted operation is settled from the intent on its record (reconcile.js); `reconcile()` proves there are no orphans.
 *
 *   const uploads = createUploads({ config, env, scanners, records });     config: loadUploadsConfig(...)
 *   const { record, outcome } = await uploads.intake({ form, bytes, filename, contentType, subject });
 *   await uploads.release(id, { decision }); uploads.delete(id, { decision }); uploads.hold(id, true, { decision });   decision: a signed kit.upload-decision.v1
 *   await uploads.rescan(id); uploads.sweep(); uploads.migrateLegacyKeys(); uploads.reconcile(); uploads.assertConsistent();
 *
 * Fail closed: no quarantine binding means no accepted upload; a storage or record write error throws and nothing is accepted.
 */
import { sha256Hex } from "./bytes.js";
import { sniff, matchesDeclared } from "./sniff.js";
import { containerEnd } from "./triage/image.js";
import { normaliseFilename } from "./filename.js";
import { triage as runTriage } from "./triage/index.js";
import { STATEMENTS, clipText, WHY_MAX } from "./triage/collector.js";
import { runScan, NO_SCANNER } from "./scan.js";
import { decide } from "./decision.js";
import { quarantineKey, releasedKey, uploadId } from "./keys.js";
import { putOnce, readObject } from "./store.js";
import { publicOutcome } from "./public.js";
import { ConfigError } from "./config.js";
import { IntegrityError, UnknownFormError, ConflictError, AuthError, NotEligibleError } from "./errors.js";
import { assertTransition, canTransition, TransitionError, moved, tightness, completed, SWEEP_STAGES } from "./lifecycle.js";
import { SYSTEM, RETENTION } from "./principal.js";
import { authenticate } from "./authority.js";
import { bucketEvidence } from "./evidence.js";
import { SCHEMAS } from "./schemas.js";
import { createReconciler, parseKey } from "./reconcile.js";

export { IntegrityError, UnknownFormError, ConflictError, NotEligibleError };

const DAY = 86_400_000;
const iso = (d) => d.toISOString();
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const triageFailure = (e) => ({ engine: "kit-static-triage", engine_version: "1", complete: false, markers: [], statement: STATEMENTS.incomplete, verdict: "needs_sandbox", reason_code: "could_not_check", incomplete_because: [`triage error: ${clip(e?.message || e, 100)}`] });

export function createUploads({ config, env, scanners = {}, records, now = () => new Date(), onViolation = null, authority = null, decisionTtlMs, evidence = null } = {}) {   // authority: the approval ledger (authority.js); null: no human decision is accepted
  if (!config?.project_prefixes) throw new ConfigError(["config must come from loadUploadsConfig()"]);
  if (!records) throw new ConfigError(["records sink is required (d1Records or memoryRecords)"]);
  const quarantine = env?.[config.storage.quarantine.binding];
  const released = env?.[config.storage.released.binding];
  for (const [which, b] of [["quarantine", quarantine], ["released", released]]) if (!b || typeof b.put !== "function" || typeof b.get !== "function" || typeof b.delete !== "function") throw new ConfigError([`binding ${config.storage[which].binding} (${which} bucket) is missing from env`]);
  const names = { quarantine: config.storage.quarantine.bucket, released: config.storage.released.bucket };

  const policyOf = (form) => { const p = config.forms[form]; if (!p) throw new UnknownFormError(form); return p; };

  /** Everything the pipeline learns about bytes: sniff, triage, scan, decision. Pure of storage. */
  async function evaluate(bytes, { policy, form, filename, contentType, sha256, sn = sniff(bytes) }) {
    const sniffed = { type: sn.type, family: sn.family, matches_declared: matchesDeclared({ contentType, filename }, sn.type), ...(sn.polyglot_suspect ? { polyglot_suspect: true } : {}) };
    const scanner = policy.scanner ? scanners[policy.scanner] : NO_SCANNER;
    const first = decide({ policy, size: bytes.length, sniffed });   // size and type are decided before any analysis
    if (first.stage === "rejected") {
      return { sniffed, triage: { engine: "kit-static-triage", engine_version: "1", complete: true, markers: [], statement: STATEMENTS.incomplete }, scan: { status: "not_run", scanner: scanner?.name || "none", scanner_version: String(scanner?.version ?? "0"), signature_db_version: null, scanned_at: null, third_party_consent_ref: null }, decision: first };
    }
    let tri;
    try { tri = await runTriage(bytes, sn.type, policy.limits); } catch (e) { tri = triageFailure(e); }
    const certainBlock = tri.verdict === "block" || sniffed.polyglot_suspect || !sniffed.matches_declared;
    let scan = null, scanBlock;
    if (certainBlock) scanBlock = { status: "not_run", scanner: scanner?.name || "none", scanner_version: String(scanner?.version ?? "0"), signature_db_version: null, scanned_at: null, third_party_consent_ref: scanner?.consentRef ?? null };
    else { scan = await runScan(scanner, { bytes, sha256, size: bytes.length, sniffed, form }, { timeoutMs: policy.scan_timeout_ms ?? 30000, now }); scanBlock = scan.scan; }
    const decision = decide({ policy, size: bytes.length, sniffed, triage: tri, scan });
    return { sniffed, triage: tri, scan: scanBlock, decision };
  }

  const log = evidence ?? bucketEvidence(quarantine);   // what the system did to an upload: an append-only evidence log, never the record
  const reconciler = createReconciler({ records, quarantine, released, now, log });
  const { settle, assertDerived, keysOf, isDerived } = reconciler;
  const triageBlock = (t) => ({ engine: t.engine, engine_version: t.engine_version, complete: t.complete, markers: t.markers, statement: t.statement, ...(t.incomplete_because?.length ? { incomplete_because: t.incomplete_because.slice(0, 10).map((w) => clipText(w, WHY_MAX)) } : {}) });
  const objectMeta = (form, policy, sha256, fence) => ({ sha256, meta: { form, policy: policy.id, fence } });
  /**
   * A person's decision on the record: a REFERENCE to the ledger entry (ledger, seq, entry_hash), the signature and the note stay in the ledger. The record's
   * `decisions` keeps the newest DECISIONS_MAX (the ledger is the history) and `last_ref_seq` is the cursor that makes a replay impossible, so bookkeeping can
   * never fill the record and freeze a tightening. System actions are not decisions: they go to the evidence log.
   */
  const DECISIONS_MAX = SCHEMAS.record.properties.decisions.maxItems;
  const withDecision = (record, action, principal) => ({
    decisions: [...(record.decisions || []), { action, by: principal.id.slice(0, 120), at: principal.decided_at, ref: principal.ref }].slice(-DECISIONS_MAX),
    last_ref_seq: Math.max(record.last_ref_seq ?? 0, principal.ref.seq),
  });
  const note = (id, action, principal, text) => log.append({ upload_id: id, action, by: principal.id.slice(0, 120), at: iso(now()), note: text });
  /** A human principal from a ledger entry, for this action on this record; anything else throws AuthError. */
  const humanFor = (decision, record, action) => authenticate({ authority, decision, record, action, now, ttlMs: decisionTtlMs });
  /** Short-lived capabilities to withdraw an upload this instance just accepted: intake returns one, bound to the record's id, stage AND version (any later write makes it worthless), single use. */
  const capabilities = new Map();
  const CAPABILITY_TTL_MS = 5 * 60 * 1000;
  const pruneCapabilities = () => { const t = now().getTime(); for (const [k, v] of capabilities) if (v.expires <= t) capabilities.delete(k); };
  const newCapability = (record) => {
    pruneCapabilities();
    const token = `wd_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    capabilities.set(token, { id: record.upload_id, stage: record.stage, version: record.version, expires: now().getTime() + CAPABILITY_TTL_MS });
    return token;
  };

  /** Write the intent with a compare-and-set: the record, still in its stage, with the operation it is about to perform. Nothing else has changed yet; a lost race throws ConflictError here, before any object is touched. */
  async function begin(record, { action, to, principal }) {
    assertTransition(record.stage, to, principal, action);
    const fence = `${action}-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return records.put({ ...record, op: { action, from: record.stage, to, actor: principal.type, started_at: iso(now()), fence } });
  }
  /**
   * A write that lands AFTER the operation was rolled back (a slow worker, a retry) is cleaned up here: when the record is a tombstone, any object at its
   * derived keys that carries THIS operation's fence is ours and goes. An object with another fence is never touched.
   */
  async function dropLate(intent) {
    const cur = await records.get(intent.upload_id);
    if (!cur || cur.stage !== "deleted") return;
    const k = keysOf(cur);
    for (const [bucket, key] of [[quarantine, k.q], [released, k.r]]) {
      const head = await bucket.head(key);
      if (head && head.customMetadata?.fence === intent.op.fence) await bucket.delete(key);
    }
  }
  /** Do the effects, then commit (a compare-and-set again); on any failure settle from the intent (the same path the reconciler uses), then surface the error. */
  async function perform(intent, effects, patch) {
    try {
      await effects();
      return await records.put(completed({ ...intent, ...patch }, intent.op.to, intent.op.actor, intent.op.action));
    } catch (e) {
      try { await settle(intent); } catch { /* the intent stays on the record: reconcile() reports it as a stale operation until it is settled */ }
      try { await dropLate(intent); } catch { /* the record says what is left: reconcile() reports it */ }
      throw e;
    }
  }

  async function intake({ form, bytes, filename = null, contentType = null, subject = null, evidenceRef = null }) {
    const policy = policyOf(form);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("intake: bytes must be a Uint8Array");
    const at = now();
    const receivedSha256 = await sha256Hex(bytes);
    const norm = normaliseFilename(filename);
    // The released bytes end at the container's own end (PNG IEND, JPEG EOI, GIF trailer, WebP RIFF size): whatever follows is cut off BEFORE anything is
    // stored, hashed into the record or released, and only its length and the hash of the file as received are recorded. The scan for a glued second format
    // still reads the whole file as received (it blocks), so the strip is the guarantee and the scan is defence in depth.
    const sn = sniff(bytes);
    const end = containerEnd(bytes, sn.type);
    const received = bytes;
    if (end > 0 && end < received.length) bytes = received.slice(0, end);
    const sha256 = bytes === received ? receivedSha256 : await sha256Hex(bytes);
    const ev = await evaluate(bytes, { policy, form, filename: norm.full, contentType, sha256, sn });
    const d = ev.decision;
    const id = uploadId();
    const k = keysOf({ form, sha256, upload_id: id });
    const days = d.stage === "released" ? policy.retention_days : (policy.blocked_retention_days ?? 7);
    const record = {
      schema: "kit.upload-record.v1", upload_id: id, project: config.project, form, policy_id: policy.id, subject_ref: clip(subject, 200),
      received_at: iso(at), decided_at: iso(now()), size_bytes: bytes.length, sha256,
      ...(bytes !== received ? { trailing_stripped: { bytes: received.length - bytes.length, original_size: received.length, original_sha256: receivedSha256 } } : {}),
      declared: { content_type: clip(contentType, 200), filename: clip(filename, 300), filename_normalised: norm.name, filename_full: norm.full },
      sniffed: ev.sniffed, stage: d.stage, verdict: d.verdict, reason_code: d.reason_code, limits: d.limits,
      triage: triageBlock(ev.triage), scan: ev.scan,
      storage: { bucket: names.quarantine, key: k.q, public_read: false, stored: d.store, released_bucket: d.stage === "released" ? names.released : null, released_key: d.stage === "released" ? k.r : null },
      retention: { retain_until: iso(new Date(at.getTime() + days * DAY)), hold: false, deleted_at: null },
      ...(evidenceRef ? { evidence_ref: clip(evidenceRef, 200) } : {}),
    };
    if (!d.store) {   // refused at the edge: nothing is written but the record
      assertTransition(null, "rejected", SYSTEM.intake, "intake");
      const stored = await records.put(record);
      return { record: stored, outcome: publicOutcome(stored), withdrawToken: newCapability(stored) };
    }
    assertTransition(null, "pending", SYSTEM.intake, "intake");
    const fence = `intake-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const pending = await records.put({ ...record, stage: "pending", op: { action: "intake", from: null, to: d.stage, actor: "system", started_at: iso(now()), fence } });   // 1. the record first: from here every object has an owner
    const final = await perform(pending, async () => {
      await putOnce(quarantine, k.q, bytes, objectMeta(form, policy, sha256, fence));                       // 2. the objects
      if (d.stage === "released") await putOnce(released, k.r, bytes, objectMeta(form, policy, sha256, fence));
    }, {});                                                      // 3. the commit: completed() sets the decided stage
    return { record: final, outcome: publicOutcome(final), withdrawToken: newCapability(final) };
  }

  const need = async (id) => { const r = await records.get(id); if (!r) throw new Error(`unknown upload ${id}`); return r; };
  const settled = (record, what) => { if (record.op) throw new Error(`upload ${record.upload_id} has ${record.op.action} in flight: ${what} waits for it to be settled (reconcile)`); };

  async function loadVerified(record) {
    assertDerived(record);
    const bytes = await readObject(quarantine, record.storage.key);
    if (!bytes) throw new IntegrityError(`object ${record.storage.key} is missing from quarantine`);
    if ((await sha256Hex(bytes)) !== record.sha256) throw new IntegrityError(`object ${record.storage.key} no longer matches its sha256`);
    return bytes;
  }

  /** A person releases a quarantined or held upload (copy to the released bucket, download only), from a signed decision of a roster key. A blocked upload is not releasable. */
  async function release(id, { decision } = {}) {
    const record = await need(id);
    if (record.stage === "released") return record;
    settled(record, "release");
    if (!canTransition(record.stage, "released", { actor: "human", via: "release" })) throw new TransitionError(record.stage, "released", { actor: "human", via: "release" });   // blocked, deleted, rejected: no signature can change that
    const principal = await humanFor(decision, record, "release");
    const bytes = await loadVerified(record);
    const policy = policyOf(record.form);
    const k = keysOf(record);
    const intent = await begin(record, { action: "release", to: "released", principal });
    const at = now();
    return perform(intent, () => putOnce(released, k.r, bytes, objectMeta(record.form, policy, record.sha256, intent.op.fence)), {
      limits: ["download_only", "open_only_in_sandbox"],
      storage: { ...record.storage, released_bucket: names.released, released_key: k.r },
      retention: { ...record.retention, retain_until: iso(new Date(at.getTime() + policy.retention_days * DAY)) },
      ...withDecision(record, "release", principal),
    });
  }

  /** Re-evaluate the quarantined bytes (a new signature set, a new scanner version). A rescan can only TIGHTEN, and only on a real verdict: a looser answer, or a scan that could not run, is recorded and not applied. */
  async function rescan(id, { note: text } = {}) {
    const record = await need(id);
    if (!record.storage.stored || record.stage === "deleted" || record.stage === "rejected" || record.stage === "pending") throw new Error(`upload ${id} has no stored object`);
    settled(record, "rescan");
    const bytes = await loadVerified(record);
    const policy = policyOf(record.form);
    const ev = await evaluate(bytes, { policy, form: record.form, filename: record.declared.filename_full ?? record.declared.filename, contentType: record.declared.content_type, sha256: record.sha256 });
    const d = ev.decision;
    const target = d.stage === "rejected" ? "blocked" : d.stage;
    const principal = SYSTEM.rescan;
    const notApplied = async (why) => { await note(id, "rescan", principal, `${why} ${text || ""}`.trim()); return record; };   // nothing about the upload changed: the evidence log says what was seen, the record is not written
    if (d.verdict === "scan_failed" && record.verdict !== "scan_failed") return notApplied("the scan could not run; the stage is kept (only a real, stricter verdict changes it).");
    if (tightness(target) < tightness(record.stage)) return notApplied(`re-evaluation says ${target}; not applied: a rescan can only tighten (a person's signed release loosens).`);
    await note(id, "rescan", principal, text || `re-evaluated: ${target}`);
    const reeval = { sniffed: ev.sniffed, verdict: d.verdict, reason_code: d.reason_code, limits: d.limits, triage: triageBlock(ev.triage), scan: ev.scan, decided_at: iso(now()) };
    if (record.stage === "released" && target !== "released") {   // a released upload is withdrawn: its released object goes with the stage, under an intent
      const intent = await begin({ ...record, ...reeval }, { action: "rescan", to: target, principal });
      return perform(intent, () => released.delete(keysOf(record).r), { storage: { ...record.storage, released_bucket: null, released_key: null } });
    }
    return records.put(moved({ ...record, ...reeval }, target, principal, "rescan"));
  }

  async function hold(id, on, { decision } = {}) {
    const record = await need(id);
    settled(record, "hold");   // a hold while an operation is in flight would be reported as success and then overtaken by the settle: refused
    const principal = await humanFor(decision, record, on ? "hold_on" : "hold_off");
    assertTransition(record.stage, record.stage, principal, "hold");
    return records.put({ ...record, retention: { ...record.retention, hold: Boolean(on) }, ...withDecision(record, "hold", principal) });
  }

  async function removeAs(principal, id) {
    const record = await need(id);
    if (record.stage === "deleted") return record;
    settled(record, "delete");
    assertTransition(record.stage, "deleted", principal, "delete");
    // the sweep's eligibility is a guard on THIS transition, judged on the record being written (the compare-and-set below carries its version):
    // a hold placed after the sweep listed the page changes the version, so the delete cannot go through
    if (principal === SYSTEM.withdraw && record.retention.hold) throw new AuthError("on_hold", "an upload on hold is never withdrawn");   // judged on the record the delete's compare-and-set carries
    if (principal.type === "retention" && !(SWEEP_STAGES.includes(record.stage) && !record.retention.hold && record.retention.retain_until <= iso(now()))) throw new NotEligibleError(`upload ${id} is not due for deletion (hold or retain_until)`);
    if (!isDerived(record)) return removeLegacy(principal, record);
    const k = keysOf(record);
    const intent = await begin(record, { action: "delete", to: "deleted", principal });
    return perform(intent, async () => { await quarantine.delete(k.q); await released.delete(k.r); await log.drop(record.upload_id); }, {
      retention: { ...record.retention, deleted_at: iso(now()) },
      ...(principal.ref ? withDecision(record, "delete", principal) : {}),
    });
  }
  /** A legacy record is re-keyed first (its objects may be shared, never deleted blind), deleted, and the legacy objects go in the same delete when no live record still uses them. */
  async function removeLegacy(principal, record) {
    const legacy = { q: record.storage.key, r: record.storage.released_key };
    await migrateRecord(record.upload_id);
    const done = await removeAs(principal, record.upload_id);
    for (const [kind, key] of Object.entries(legacy)) {
      if (key && (await records.referencing(key, { excludeId: record.upload_id })) === 0) await (kind === "q" ? quarantine : released).delete(key);
    }
    return done;
  }

  /** A person deletes (a customer request, a DSAR erase), from a signed decision. */
  async function remove(id, { decision } = {}) {
    const record = await need(id);
    if (record.stage === "deleted") return record;
    return removeAs(await humanFor(decision, record, "delete"), id);
  }

  /** The engine withdraws an upload it accepted a moment ago (the other files of one refused request): a delete by the withdraw principal, through the same intent and commit. */
  async function withdraw(id, token) {
    pruneCapabilities();
    const cap = capabilities.get(token);
    capabilities.delete(token);   // single use
    if (!cap || cap.id !== id) throw new AuthError("no_capability", "withdraw needs the capability intake returned for this upload (this request, a few minutes)");
    const record = await need(id);
    if (record.stage !== cap.stage || record.version !== cap.version) throw new AuthError("no_capability", "the upload changed since intake: the capability no longer applies");
    return removeAs(SYSTEM.withdraw, id);   // a hold is refused inside removeAs, on the record the delete's compare-and-set carries
  }

  /** Re-key one legacy record (content-addressed keys from before keys were derived from records): copy, verify, commit; the legacy objects are removed by migrateLegacyKeys once no record uses them. */
  async function migrateRecord(id) {
    const record = await need(id);
    if (isDerived(record) || !record.storage.stored || record.stage === "deleted") return record;
    settled(record, "migrate");
    const bytes = await readObject(quarantine, record.storage.key);
    if (!bytes || (await sha256Hex(bytes)) !== record.sha256) throw new IntegrityError(`upload ${id}: the legacy object ${record.storage.key} is missing or does not match its sha256`);
    const policy = policyOf(record.form);
    const k = keysOf(record);
    const intent = await begin(record, { action: "migrate", to: record.stage, principal: SYSTEM.migrate });
    return perform(intent, async () => {
      await putOnce(quarantine, k.q, bytes, objectMeta(record.form, policy, record.sha256, intent.op.fence));
      if (record.storage.released_key) await putOnce(released, k.r, bytes, objectMeta(record.form, policy, record.sha256, intent.op.fence));
      const back = await readObject(quarantine, k.q);
      if (!back || (await sha256Hex(back)) !== record.sha256) throw new IntegrityError(`upload ${id}: the copy at ${k.q} does not verify`);
    }, {
      storage: { ...record.storage, key: k.q, ...(record.storage.released_key ? { released_key: k.r } : {}) },
    }).then(async (done) => { await note(id, "migrate", SYSTEM.migrate, "re-keyed from the content-addressed key"); return done; });
  }

  /** Migrate every legacy record, then remove the legacy objects no record uses any more. → { migrated, failed: [{ upload_id, error }], removed: [key] }. */
  async function migrateLegacyKeys({ pageSize = 200 } = {}) {
    const out = { migrated: 0, failed: [], removed: [] };
    for (let after = null; ;) {
      const page = await records.list({ after, limit: pageSize });
      if (!page.length) break;
      after = page.at(-1).upload_id;
      for (const r of page) {
        if (isDerived(r)) continue;
        try { await migrateRecord(r.upload_id); out.migrated++; } catch (e) { out.failed.push({ upload_id: r.upload_id, error: String(e?.message || e).slice(0, 160) }); }
      }
      if (page.length < pageSize) break;
    }
    // a legacy object may be removed only when no record points at it any more: list both buckets, and remove what no live record references
    const still = new Set();
    for (let after = null; ;) {
      const page = await records.list({ after, limit: pageSize });
      if (!page.length) break;
      after = page.at(-1).upload_id;
      for (const r of page) { if (r.stage === "deleted") continue; still.add(`q|${r.storage.key}`); if (r.storage.released_key) still.add(`r|${r.storage.released_key}`); }
      if (page.length < pageSize) break;
    }
    for (const [kind, bucket] of [["q", quarantine], ["r", released]]) {
      for (let cursor; ;) {
        const page = await bucket.list({ prefix: `${kind}/`, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) {
          const p = parseKey(o.key);
          if (p?.legacy && !still.has(`${kind}|${o.key}`)) { await bucket.delete(o.key); out.removed.push(o.key); }
        }
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }
    return out;
  }

  /**
   * The retention sweep. 1. Settle operations that never committed (pending intakes included). 2. Delete what is past retain_until, a
   * page at a time; one record failing is reported and the sweep goes on. 3. Prove the invariant over a bounded slice.
   * → { deleted, settled, failures: [{ upload_id, error }], reconcile }. A failure or a violation goes to onViolation, or, with none wired, fails the sweep AFTER everything else ran.
   */
  async function sweep({ limit = 100, reconcileLimit = 200, reconcileAfter = null, staleMs = 15 * 60 * 1000 } = {}) {
    const failures = [];
    let settledCount = 0, deleted = 0;
    const fail = (id, e) => failures.push({ upload_id: id, error: String(e?.message || e).slice(0, 160) });
    for (let after = null, n = 0; n < limit;) {
      const stale = await records.listInFlight(iso(new Date(now().getTime() - staleMs)), { limit: Math.min(50, limit - n), after });
      if (!stale.length) break;
      after = stale.at(-1).upload_id;
      for (const r of stale) { n++; try { await settle(r); settledCount++; } catch (e) { fail(r.upload_id, e); } }
    }
    for (let after = null; deleted < limit;) {
      const due = await records.listExpired(iso(now()), { limit: Math.min(50, limit - deleted), after });
      if (!due.length) break;
      after = due.at(-1).upload_id;
      for (const r of due) {
        try { await removeAs(RETENTION, r.upload_id); deleted++; }
        catch (e) { if (!(e instanceof NotEligibleError || e instanceof ConflictError)) fail(r.upload_id, e); }   // a hold (or any write) that landed since the page was listed is not a failure: the record stays, the next sweep judges it again
      }
    }
    const proof = await reconciler.reconcile({ limit: reconcileLimit, after: reconcileAfter });
    const problems = [...failures.map((f) => ({ code: "sweep_failed", detail: `${f.upload_id}: ${f.error}`, upload_id: f.upload_id })), ...proof.violations];
    if (problems.length) {
      if (onViolation) await onViolation(problems);
      else throw new IntegrityError(`upload sweep: ${problems.length} problem(s): ${problems.slice(0, 3).map((v) => `${v.code} ${v.detail}`).join("; ")}`);
    }
    return { deleted, settled: settledCount, failures, reconcile: proof };
  }

  return { intake, release, rescan, hold, delete: remove, withdraw, sweep, migrateLegacyKeys, reconcile: reconciler.reconcileAll, reconcilePage: reconciler.reconcile, assertConsistent: reconciler.assertConsistent, settle: async (id) => settle(await need(id)), policy: policyOf, names };
}
