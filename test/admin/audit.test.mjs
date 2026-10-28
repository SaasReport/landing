// The audit log is append-only: the database refuses an update, a delete and a replace, and the code has no statement that tries one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { adminDb, hashOf, ROOT } from "./helpers.mjs";
import { audit, auditStatement } from "../../workers/admin/src/db.js";

const entry = (o = {}) => ({ actorHash: hashOf("x"), action: "updateLead", outcome: "done", targetKind: "lead", targetId: "E-1", detail: { a: 1 }, ...o });

test("an update of an audit row fails", async () => {
  const db = adminDb();
  await audit(db, entry());
  for (const sql of ["UPDATE admin_audit SET action = 'x'", "UPDATE admin_audit SET actor_hash = actor_hash WHERE seq = 1", "UPDATE OR REPLACE admin_audit SET id = 'z'"]) await assert.rejects(db.prepare(sql).run(), /append-only/, sql);
  assert.equal((await db.prepare("SELECT action FROM admin_audit").first()).action, "updateLead");
});

test("a delete of an audit row fails, whole table or one row", async () => {
  const db = adminDb();
  await audit(db, entry());
  await assert.rejects(db.prepare("DELETE FROM admin_audit").run(), /append-only/);
  await assert.rejects(db.prepare("DELETE FROM admin_audit WHERE seq = 1").run(), /append-only/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM admin_audit").first()).n, 1);
});

test("INSERT OR REPLACE over an existing row fails: SQLite's REPLACE would delete it without a DELETE trigger", async () => {
  const db = adminDb();
  await audit(db, entry());
  const row = await db.prepare("SELECT * FROM admin_audit").first();
  const replace = (over) => db.prepare("INSERT OR REPLACE INTO admin_audit (seq, id, at, actor_hash, action, outcome, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(over.seq ?? row.seq, over.id ?? row.id, row.at, row.actor_hash, "forged", "done", "lead", "E-1", "{}").run();
  await assert.rejects(replace({}), /append-only/, "same id and seq");
  await assert.rejects(replace({ id: "other-id" }), /append-only/, "same seq");
  await assert.rejects(replace({ seq: 99 }), /append-only/, "same id");
  assert.equal((await db.prepare("SELECT action FROM admin_audit").first()).action, "updateLead");
});

test("a row needs a hashed actor and a known outcome", async () => {
  const db = adminDb();
  await assert.rejects(audit(db, entry({ actorHash: "owner@example.test" })), /CHECK/);
  await assert.rejects(audit(db, entry({ outcome: "maybe" })), /CHECK/);
  await audit(db, entry({ outcome: "denied" }));
});

test("rows get increasing sequence numbers and an oversized detail is truncated rather than stored", async () => {
  const db = adminDb();
  for (let i = 0; i < 3; i++) await audit(db, entry({ targetId: `E-${i}` }));
  await audit(db, entry({ detail: { blob: "x".repeat(5000) } }));
  const rows = (await db.prepare("SELECT seq, detail_json FROM admin_audit ORDER BY seq").all()).results;
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4]);
  assert.deepEqual(JSON.parse(rows[3].detail_json), { truncated: true });
  assert.ok(auditStatement(db, entry()).sql.startsWith("INSERT INTO admin_audit"));
});

test("no statement in the Worker updates, deletes or replaces an audit row", () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(new URL("workers/admin/src", ROOT).pathname).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 5);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/(UPDATE|DELETE\s+FROM|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE|DROP\s+TABLE|TRUNCATE)[^;`"']{0,60}admin_audit/i.test(src), `${f} must not modify admin_audit`);
  }
});
