/**
 * The broker's evidence: one hash-chained record per authenticated allow and deny (kit.broker-evidence.v1). The store
 * appends with compare-and-set on the sequence, so two concurrent writers cannot fork the chain, and claims nonces
 * once. Records never carry a token or key.
 */
import { canonicalJson } from "@saasreport/core/concepts";
import { sha256 } from "@saasreport/core/sha256";
import { BrokerError } from "./errors.js";
import { validateEvidence } from "./schemas.js";

export const GENESIS = "0".repeat(64);

export const recordHash = ({ hash, ...rest }) => sha256(canonicalJson(rest));

/** Problems with a chain of records, oldest first: [] when every record is valid, linked and contiguous. */
export function verifyChain(records) {
  const problems = [];
  let prev = GENESIS;
  records.forEach((r, i) => {
    for (const p of validateEvidence(r)) problems.push(`#${i + 1}: ${p}`);
    if (r.seq !== i + 1) problems.push(`#${i + 1}: seq ${r.seq} is not ${i + 1}`);
    if (r.prev !== prev) problems.push(`#${i + 1}: prev does not link to the record before it`);
    if (recordHash(r) !== r.hash) problems.push(`#${i + 1}: hash does not match the record`);
    prev = r.hash;
  });
  return problems;
}

/** Append one record to the chain through the store (retrying a lost compare-and-set race a few times). */
export async function appendEvidence(store, fields) {
  for (let attempt = 0; attempt < 12; attempt++) {
    // Jittered backoff after a lost compare-and-set, so concurrent writers spread out instead of colliding again.
    if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 10 * 2 ** Math.min(attempt, 6)));
    const head = await store.head();
    const record = { ...fields, seq: (head?.seq || 0) + 1, prev: head?.hash || GENESIS };
    record.hash = recordHash(record);
    const problems = validateEvidence(record);
    if (problems.length) throw new BrokerError("evidence_failed", problems[0]);
    if (await store.append(record, head?.seq || 0)) return record;
  }
  throw new BrokerError("evidence_failed", "the chain kept moving");
}

/** An in-memory store with the same contract as the D1 store (tests, local runs). */
export function memoryStore() {
  const records = [];
  const nonces = new Set();
  return {
    records,
    async head() { return records.at(-1) || null; },
    async append(record, expectedSeq) {
      if ((records.at(-1)?.seq || 0) !== expectedSeq) return false;
      records.push(record);
      return true;
    },
    async claimNonce(agent, nonce) {
      const key = `${agent} ${nonce}`;
      if (nonces.has(key)) return false;
      nonces.add(key);
      return true;
    },
  };
}

/** A database failure (a trigger refusing a row included) is an evidence failure, never an upstream one. */
async function guard(run) {
  try { return await run(); } catch (e) { throw new BrokerError("evidence_failed", String(e?.message || e).slice(0, 120)); }
}

/** The D1 store: tables from migrations/0001_broker.sql. INSERT … SELECT … WHERE makes the append a compare-and-set. */
export function d1Store(db) {
  return {
    async head() {
      const row = await guard(() => db.prepare("SELECT body FROM broker_evidence ORDER BY seq DESC LIMIT 1").first());
      return row ? JSON.parse(row.body) : null;
    },
    async append(record, expectedSeq) {
      const r = await guard(() => db
        .prepare("INSERT INTO broker_evidence (seq, hash, body) SELECT ?1, ?2, ?3 WHERE (SELECT COALESCE(MAX(seq), 0) FROM broker_evidence) = ?4")
        .bind(record.seq, record.hash, canonicalJson(record), expectedSeq)
        .run());
      const changes = r?.meta?.changes;
      if (!Number.isInteger(changes)) throw new BrokerError("evidence_failed", "the database did not report a change count");
      return changes === 1;
    },
    async claimNonce(agent, nonce, at, keepSeconds) {
      // Nonces older than any request or review that could still be accepted are dropped (the table stays bounded).
      if (Number.isInteger(keepSeconds)) await guard(() => db.prepare("DELETE FROM broker_nonce WHERE at < ?1").bind(at - keepSeconds).run());
      const r = await guard(() => db.prepare("INSERT OR IGNORE INTO broker_nonce (agent, nonce, at) VALUES (?1, ?2, ?3)").bind(agent, nonce, at).run());
      const changes = r?.meta?.changes;
      if (!Number.isInteger(changes)) throw new BrokerError("evidence_failed", "the database did not report a change count");
      return changes === 1;
    },
  };
}
