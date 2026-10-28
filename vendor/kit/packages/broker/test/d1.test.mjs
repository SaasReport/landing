import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { d1Store, appendEvidence, verifyChain } from "../src/index.js";

/** A D1 binding on node:sqlite with the broker migration applied. */
function makeDB() {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  db.exec(readFileSync(new URL("../migrations/0001_broker.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), sqlite: db };
}

const FIELDS = { at: 1, project: "example", agent: "kit:agent:example:coder", action: "push", repo: "kit", decision: "allow", reason: "token_issued" };

test("D1: the chain appends, and the database refuses edits, deletes and forks", async () => {
  const db = makeDB();
  const store = d1Store(db);
  const a = await appendEvidence(store, FIELDS);
  const b = await appendEvidence(store, { ...FIELDS, decision: "deny", reason: "replayed" });
  assert.deepEqual([a.seq, b.seq, b.prev], [1, 2, a.hash]);
  const rows = db.sqlite.prepare("SELECT body FROM broker_evidence ORDER BY seq").all().map((r) => JSON.parse(r.body));
  assert.deepEqual(verifyChain(rows), []);
  assert.throws(() => db.sqlite.prepare("UPDATE broker_evidence SET body = body").run(), /append-only/);
  assert.throws(() => db.sqlite.prepare("DELETE FROM broker_evidence").run(), /append-only/);
  // A stale writer (expects seq 1) loses the compare-and-set instead of forking the chain.
  assert.equal(await store.append({ ...a, seq: 2 }, 1), false);
  // A record that does not link to the head is refused by the database itself.
  const bad = { ...b, seq: 3, prev: "f".repeat(64) };
  assert.throws(() => db.sqlite.prepare("INSERT INTO broker_evidence (seq, hash, body) VALUES (?, ?, ?)").run(3, "e".repeat(64), JSON.stringify({ ...bad, hash: "e".repeat(64) })), /extend the chain/);
});

test("D1: rows with missing chain fields are refused (NULL never slips through a comparison)", () => {
  const db = makeDB();
  const ins = (seq, hash, body) => db.sqlite.prepare("INSERT INTO broker_evidence (seq, hash, body) VALUES (?, ?, ?)").run(seq, hash, JSON.stringify(body));
  const h = "a".repeat(64);
  assert.throws(() => ins(1, h, { seq: 1, hash: h, decision: "allow" }), /constraint|chain/i, "no prev");
  assert.throws(() => ins(1, h, { forged: true }), /constraint|chain/i, "no fields at all");
  assert.throws(() => ins(1, h, { seq: 1, hash: h, prev: "0".repeat(64) }), /constraint/i, "no decision");
});

test("D1: a trigger refusal surfaces as evidence_failed", async () => {
  const db = makeDB();
  const store = d1Store(db);
  await assert.rejects(store.append({ seq: 1, hash: "a".repeat(64), prev: "f".repeat(64), decision: "allow" }, 0), (e) => e.reason === "evidence_failed");
});

test("D1: old nonces are pruned, recent ones kept", async () => {
  const db = makeDB();
  const store = d1Store(db);
  await store.claimNonce("a", "x".repeat(16), 1000, 100);
  await store.claimNonce("a", "y".repeat(16), 1150, 100);
  await store.claimNonce("a", "z".repeat(16), 1200, 100);
  assert.equal(await store.claimNonce("a", "y".repeat(16), 1200, 100), false, "within retention: still single-use");
  assert.deepEqual(db.sqlite.prepare("SELECT nonce FROM broker_nonce ORDER BY at").all().map((r) => r.nonce[0]), ["y", "z"], "the old one is gone");

});

test("D1: a nonce is claimed once per agent", async () => {
  const store = d1Store(makeDB());
  assert.equal(await store.claimNonce("a", "n".repeat(16), 1), true);
  assert.equal(await store.claimNonce("a", "n".repeat(16), 2), false);
  assert.equal(await store.claimNonce("b", "n".repeat(16), 2), true);
});
