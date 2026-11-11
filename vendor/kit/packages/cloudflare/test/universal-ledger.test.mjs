import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { createUniversalEnvelope } from "@saasreport/core/universal-envelope";
import { storeUniversalEnvelope, appendUniversalLifecycleObservation } from "../src/universal-ledger.js";

const SQL = readFileSync(new URL("../migrations/0013_universal_envelope_ledger.sql", import.meta.url),"utf8");
const GUARD = readFileSync(new URL("../migrations/0014_universal_envelope_contract_guard.sql", import.meta.url),"utf8");
const IMMUTABILITY = readFileSync(new URL("../migrations/0015_universal_ledger_no_replace.sql", import.meta.url),"utf8");
const H="a".repeat(64), T="2026-10-25T10:00:00Z";
const NATIVE={
 $schema:"https://json-schema.org/draft/2020-12/schema",
 $id:"urn:kit:test:universal-ledger",
 type:"object",required:["body"],additionalProperties:false,
 properties:{body:{type:"string",minLength:1}}
};
const seed=()=>createUniversalEnvelope({
 tenant:"tenant-01",project:"sample",kind:"podcast",subject:"daily-0001",revision:"v1",
 occurredAt:T,
 authority:{registry_ref:"registry/topic",contract_ref:"kit.test.episode.v1",policy_ref:"policy/episode"},
 provenance:{source_ref:"verified/episode-1",source_sha256:H,observed_at:T,actor:"reviewer-01"},
 correlationId:"run-001",payloadContract:"kit.test.episode.v1",payloadSchema:NATIVE,
 payload:{body:"Verified first episode"},
 requiredEvidence:["contract-validated","policy-evaluated","sandbox-smoke","production-observed"]
});
const d1=({applyMigration=true}={})=>{const db=withD1Limits(new DatabaseSync(":memory:"));db.exec("PRAGMA foreign_keys=ON;");if(applyMigration){db.exec(SQL);db.exec(GUARD);db.exec(IMMUTABILITY);}return{
 raw:db,prepare(statement){return{bind(...values){return{
 async run(){return db.prepare(statement).run(...values);},
 async first(){return db.prepare(statement).get(...values)??null;}
 };}}}
}};
const observe=(e)=>({
 kind:"sandbox-smoke",envelope_id:e.id,idempotency_key:e.trace.idempotency_key,
 tenant:e.tenant,project:e.project,status:"verified",sha256:"b".repeat(64),
 external_ref:"probe/sandbox-001",observed_at:"2026-10-25T10:01:00Z"
});
test("Kit-owned SQL and D1 adapter store the immutable T0 source exactly once",async()=>{
 const db=d1(), env=seed();
 const a=await storeUniversalEnvelope(db,env,{nativeSchema:NATIVE}),b=await storeUniversalEnvelope(db,env,{nativeSchema:NATIVE});
 assert.equal(a.state,"stored-not-released");assert.equal(b.state,"already-stored-not-released");
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM universal_envelopes").get().n,1);
 assert.equal(a.published,false);
 assert.throws(()=>db.raw.prepare("UPDATE universal_envelopes SET subject='different'").run(),/immutable/);
 assert.throws(()=>db.raw.prepare("DELETE FROM universal_envelopes").run(),/immutable/);
 db.raw.close();
});
test("D1 event must be on an existing identical envelope; receipts remain unattested",async()=>{
 const db=d1(),env=seed();await storeUniversalEnvelope(db,env,{nativeSchema:NATIVE});
 const receipt=observe(env);
 const a=await appendUniversalLifecycleObservation(db,env,receipt,{nativeSchema:NATIVE});
 const b=await appendUniversalLifecycleObservation(db,env,receipt,{nativeSchema:NATIVE});
 assert.equal(a.event_id,b.event_id);assert.equal(a.published,false);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM universal_lifecycle_events").get().n,1);
 assert.throws(()=>db.raw.prepare("DELETE FROM universal_lifecycle_events").run(),/append-only/);
 await assert.rejects(appendUniversalLifecycleObservation(db,env,{...receipt,tenant:"foreign"},{nativeSchema:NATIVE}),/cross-tenant|undeclared or not bound/);
 const other=seed();const forged=structuredClone(other);forged.payload.data.body="tampered";
 await assert.rejects(storeUniversalEnvelope(db,forged,{nativeSchema:NATIVE}),/T0 envelope invalid/);
 db.raw.close();
});
test("physical SQL migration refuses cross-tenant event writes even when bypassing adapter",async()=>{
 const db=d1(),env=seed();await storeUniversalEnvelope(db,env,{nativeSchema:NATIVE});
 assert.throws(()=>db.raw.prepare("INSERT INTO universal_lifecycle_events VALUES (?,?,?,?,?,?,?,?,?)")
   .run("evt-01",env.id,"other-tenant",env.project,"sandbox-smoke","b".repeat(64),T,"probe/1","{}"),
   /cross-tenant|undeclared or not bound/);
 db.raw.close();
});
test("missing D1 migration fails before storing T0 source, never returns an empty green ledger",async()=>{
 const db=d1({applyMigration:false}),env=seed();
 await assert.rejects(storeUniversalEnvelope(db,env,{nativeSchema:NATIVE}),/no such table: universal_envelopes/);
 db.raw.close();
});

test("D1 ledger refuses an absent or divergent native schema regardless of recorded receipts",async()=>{
  const db=d1(),env=seed();
  await assert.rejects(storeUniversalEnvelope(db,env),/native payload schema unresolved/);
  const counterfeit={...NATIVE,$id:"urn:kit:another"};
  await assert.rejects(storeUniversalEnvelope(db,env,{nativeSchema:counterfeit}),/native payload schema unresolved/);
  db.raw.close();
});

test("physical SQL refuses INSERT OR REPLACE even without recursive triggers, preserving immutable history", async () => {
  const db = d1(), envelope = seed();
  db.raw.exec("PRAGMA recursive_triggers=OFF;");
  await storeUniversalEnvelope(db, envelope, { nativeSchema: NATIVE });
  const before = db.raw.prepare("SELECT * FROM universal_envelopes WHERE envelope_id=?").get(envelope.id);
  const columns = Object.keys(before);
  const insert = "INSERT OR REPLACE INTO universal_envelopes (" + columns.join(",") +
    ") VALUES (" + columns.map(() => "?").join(",") + ")";
  assert.throws(() => db.raw.prepare(insert).run(...columns.map((k) =>
    k === "created_at" ? "2099-01-01T00:00:00Z" : before[k])), /immutable duplicate/);
  assert.deepEqual(db.raw.prepare("SELECT * FROM universal_envelopes WHERE envelope_id=?").get(envelope.id), before);
  const receipt = observe(envelope);
  await appendUniversalLifecycleObservation(db, envelope, receipt, { nativeSchema: NATIVE });
  const original = db.raw.prepare("SELECT * FROM universal_lifecycle_events").get();
  const eventColumns = Object.keys(original);
  const eventInsert = "INSERT OR REPLACE INTO universal_lifecycle_events (" + eventColumns.join(",") +
    ") VALUES (" + eventColumns.map(() => "?").join(",") + ")";
  assert.throws(() => db.raw.prepare(eventInsert).run(...eventColumns.map((k) =>
    k === "external_ref" ? "forged/replacement" : original[k])), /immutable duplicate/);
  assert.deepEqual(db.raw.prepare("SELECT * FROM universal_lifecycle_events").get(), original);
  // Repeated canonical writes remain idempotent even though the storage trigger
  // refuses duplicates before SQLite's ON CONFLICT policy can silence them.
  assert.equal((await storeUniversalEnvelope(db, envelope, { nativeSchema: NATIVE })).state,
    "already-stored-not-released");
  assert.equal((await appendUniversalLifecycleObservation(db, envelope, receipt, { nativeSchema: NATIVE })).event_id,
    original.event_id);
  db.raw.close();
});
