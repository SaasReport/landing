/**
 * Zero orphans by construction, and a proof that it holds.
 *
 * By construction: every object key is derived from its record (q|r / upload id / form / sha256), the record is written FIRST (stage
 * pending, or an `op` on a settled record), then the objects, then the commit, and every record write is a compare-and-set on the
 * record's version. An object therefore never exists without a record that names it, an interrupted operation leaves its intent on the
 * record where `settle` finishes it (intake, release and migrate roll BACK; rescan and delete roll FORWARD), and a writer holding a
 * stale read cannot revive or overwrite anything (a deleted tombstone is final). There is no best-effort delete: rollback is a transition.
 *
 * The proof: `reconcile` checks that every stored object has exactly one live record that expects it and every live record has the
 * objects its stage requires. It is a merge join of two id-ordered streams (records by upload id, objects by key, id first), read a page
 * at a time: each page costs one records query and one list per bucket, so a Worker can run a slice (`limit`) per invocation and carry
 * the cursor (`next`) to the next one; with no limit it reads everything (tests, a CLI).
 */
import { SPEC, completed } from "./lifecycle.js";
import { SYSTEM } from "./principal.js";
import { quarantineKey, releasedKey, isUploadId } from "./keys.js";
import { IntegrityError, ConflictError } from "./errors.js";

const iso = (d) => d.toISOString();
const STALE_MS = 15 * 60 * 1000;

/** { kind: "q" | "r", id, form, sha256 } for a derived key, or null. A legacy content-addressed key (q|r / form / sha256) is { legacy: true, … }. */
export function parseKey(key) {
  const parts = String(key).split("/");
  if (parts.length === 4 && (parts[0] === "q" || parts[0] === "r") && isUploadId(parts[1])) return { kind: parts[0], id: parts[1], form: parts[2], sha256: parts[3] };
  if (parts.length === 3 && (parts[0] === "q" || parts[0] === "r") && parts[2].length === 64) return { kind: parts[0], legacy: true, form: parts[1], sha256: parts[2] };
  return null;
}

export function createReconciler({ records, quarantine, released, now, log = null }) {
  const keysOf = (r) => ({ q: quarantineKey(r.form, r.sha256, r.upload_id), r: releasedKey(r.form, r.sha256, r.upload_id) });
  const isDerived = (r) => { const k = keysOf(r); return (!r.storage.stored || r.storage.key === k.q) && (!r.storage.released_key || r.storage.released_key === k.r); };

  /** A record whose stored keys are not the ones its id derives: refused for any object change. `migrate` re-keys it. */
  function assertDerived(r) {
    if (!isDerived(r)) throw new IntegrityError(`upload ${r.upload_id} has legacy keys (${r.storage.key}): migrate it before any object is changed`);
  }

  /**
   * Finish or undo an interrupted operation from the intent on the record. The one code path for runtime failures and for the
   * reconciler. It re-reads the record: if the record is no longer the one the caller saw (another writer moved it, or it is settled
   * or deleted), there is nothing to settle and nothing is written.
   */
  /** Roll back an object this operation wrote: an object carrying another operation's fence belongs to that operation and stays. */
  const dropMine = async (bucket, key, fence) => {
    const head = await bucket.head(key);
    if (head && head.customMetadata?.fence && fence && head.customMetadata.fence !== fence) return;
    await bucket.delete(key);
  };
  async function settle(seen) {
    const record = await records.get(seen.upload_id);
    if (!record || !record.op || record.version !== seen.version) return record;
    const op = record.op;
    const k = keysOf(record);
    const at = iso(now());
    const decision = async (action, text) => { if (log) await log.append({ upload_id: record.upload_id, action, by: SYSTEM.reconciler.id, at, note: text }); };   // what the reconciler did is evidence, not a decision on the record
    let next;
    if (op.action === "intake") {   // roll back: the intake never committed
      await dropMine(quarantine, k.q, op.fence); await dropMine(released, k.r, op.fence);
      next = completed({ ...record, retention: { ...record.retention, deleted_at: at } }, "deleted", "system", "rollback");
    } else if (op.action === "release") {   // roll back: the release never committed; the record returns to where it was
      await dropMine(released, k.r, op.fence);
      const { op: _gone, ...rest } = record;
      next = rest; await decision("release", "interrupted release rolled back");
    } else if (op.action === "rescan") {   // roll forward: the record already holds the tighter evaluation
      await released.delete(k.r);
      next = completed({ ...record, storage: { ...record.storage, released_bucket: null, released_key: null } }, op.to, op.actor, "rescan");
    } else if (op.action === "delete") {    // roll forward
      await quarantine.delete(k.q); await released.delete(k.r);
      next = completed({ ...record, retention: { ...record.retention, deleted_at: record.retention.deleted_at || at } }, "deleted", op.actor, "delete");
    } else if (op.action === "migrate") {   // roll back: the derived copies are removed, the record keeps its legacy keys
      await dropMine(quarantine, k.q, op.fence); await dropMine(released, k.r, op.fence);
      const { op: _gone, ...rest } = record;
      next = rest; await decision("migrate", "interrupted migration rolled back");
    } else throw new IntegrityError(`upload ${record.upload_id}: unknown operation ${op.action}`);
    return records.put(next);
  }

  /** Objects with this prefix after `startAfter`, listing no further than the first object whose id is past `hi` (null: to the end). */
  async function listPage(bucket, prefix, startAfter, hi) {
    if (typeof bucket.list !== "function") throw new IntegrityError("reconcile needs buckets that can list (R2 list)");
    const out = [];
    let cursor;
    for (;;) {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : startAfter ? { startAfter } : {}) });
      out.push(...page.objects);
      const last = page.objects.length ? parseKey(page.objects.at(-1).key) : null;
      if (!page.truncated || (hi !== null && last && !last.legacy && last.id > hi)) return out;
      cursor = page.cursor;
    }
  }

  /**
   * Check the invariant over one page of records and the objects whose id falls in the same range.
   * → { ok, violations, checked, next: { after } | null, done }. `limit`: records per page (default: all). `repair`: settle stale operations first.
   */
  async function reconcile({ repair = false, staleMs = STALE_MS, limit = Infinity, after = null } = {}) {
    const page = [];
    for (let cur = after; page.length < limit;) {
      const want = Math.min(500, limit - page.length);
      const batch = await records.list({ after: cur, limit: want });
      page.push(...batch);
      if (batch.length < want) break;
      cur = batch.at(-1).upload_id;
    }
    const more = Number.isFinite(limit) && page.length >= limit && page.length > 0;
    const lo = after ?? "", hi = more ? page.at(-1).upload_id : null;   // this page covers ids in (lo, hi], or (lo, ∞) on the last page
    const violations = [];
    const flag = (code, detail, extra = {}) => violations.push({ code, detail, ...extra });
    const nowMs = Date.parse(iso(now()));
    const byId = new Map();
    for (let r of page) {
      if (repair && r.op && nowMs - Date.parse(r.op.started_at) > staleMs) r = (await settle(r)) ?? r;
      byId.set(r.upload_id, r);
    }
    const inRange = (o) => { const p = parseKey(o.key); return p && !p.legacy ? p.id > lo && (hi === null || p.id <= hi) : false; };
    const ranges = { q: [], r: [] };
    for (const [kind, bucket] of [["q", quarantine], ["r", released]]) {
      const listed = await listPage(bucket, `${kind}/`, lo ? `${kind}/${lo}` : undefined, hi);
      for (const o of listed) {
        const p = parseKey(o.key);
        if (!p) { flag("object_without_record", `${o.key} is not a derived key`, { key: o.key }); continue; }
        if (p.legacy) { if (!hi || after === null) flag("legacy_key", `${o.key} is a content-addressed object from before keys were derived from records: migrate`, { key: o.key }); continue; }
        if (inRange(o)) ranges[kind].push(o);
      }
    }
    const have = { q: new Map(ranges.q.map((o) => [o.key, o])), r: new Map(ranges.r.map((o) => [o.key, o])) };
    for (const kind of ["q", "r"]) {
      for (const o of ranges[kind]) {
        const p = parseKey(o.key);
        const rec = byId.get(p.id);
        if (!rec) { flag("object_without_record", `${o.key}: no record ${p.id}`, { key: o.key }); continue; }
        if (rec.form !== p.form || rec.sha256 !== p.sha256) { flag("key_mismatch", `${o.key} does not match its record`, { upload_id: p.id, key: o.key }); continue; }
        if (rec.op) continue;   // in flight: either side of the write is fine until it is stale
        const want = SPEC.states[rec.stage][kind === "q" ? "quarantine_object" : "released_object"];
        if (want === "absent") flag("object_unexpected", `${o.key} exists but a ${rec.stage} upload has no ${kind === "q" ? "quarantine" : "released"} object`, { upload_id: p.id, key: o.key });
        if (o.size !== rec.size_bytes) flag("object_size_mismatch", `${o.key}: ${o.size} bytes, the record says ${rec.size_bytes}`, { upload_id: p.id, key: o.key });
      }
    }
    for (const rec of byId.values()) {
      const k = keysOf(rec);
      if (rec.op) {
        if (nowMs - Date.parse(rec.op.started_at) > staleMs) flag("stale_operation", `${rec.op.action} to ${rec.op.to} started ${rec.op.started_at} and never committed`, { upload_id: rec.upload_id });
        continue;
      }
      if (!isDerived(rec)) { flag("key_mismatch", `record key ${rec.storage.key} is not derived (${k.q})`, { upload_id: rec.upload_id, key: rec.storage.key }); continue; }
      const st = SPEC.states[rec.stage];
      if (st.quarantine_object === "present" && !have.q.has(k.q)) flag("object_missing", `${rec.stage} upload has no quarantine object ${k.q}`, { upload_id: rec.upload_id, key: k.q });
      if (st.released_object === "present" && !have.r.has(k.r)) flag("object_missing", `${rec.stage} upload has no released object ${k.r}`, { upload_id: rec.upload_id, key: k.r });
    }
    return { ok: violations.length === 0, violations, checked: { records: byId.size, objects: ranges.q.length + ranges.r.length }, next: more ? { after: hi } : null, done: !more };
  }

  /** Every page, until done (no limit needed per page: `pageSize` bounds each). */
  async function reconcileAll({ pageSize = 500, ...opts } = {}) {
    const all = { ok: true, violations: [], checked: { records: 0, objects: 0 }, next: null, done: true };
    for (let after = null; ;) {
      const r = await reconcile({ ...opts, limit: pageSize, after });
      all.violations.push(...r.violations); all.checked.records += r.checked.records; all.checked.objects += r.checked.objects;
      if (r.done) break;
      after = r.next.after;
    }
    all.ok = all.violations.length === 0;
    return all;
  }

  async function assertConsistent(opts) {
    const r = await reconcileAll(opts);
    if (!r.ok) throw new IntegrityError(`upload invariant violated (${r.violations.length}): ${r.violations.slice(0, 3).map((v) => `${v.code} ${v.detail}`).join("; ")}`);
    return r;
  }

  return { settle, reconcile, reconcileAll, assertConsistent, assertDerived, isDerived, keysOf };
}
