import { test } from "node:test";
import assert from "node:assert/strict";
import SCHEMA from "../schemas/universal-envelope.schema.json" with { type: "json" };
import { validate } from "../src/schema.js";
import { UNIVERSAL_BOUNDARIES, universalBoundary, UNIVERSAL_AUTHORITY_SHA256, createUniversalEnvelope, universalEnvelopeProblems, assessUniversalEvidence } from "../src/universal-envelope.js";
const H = "a".repeat(64), R = "b".repeat(64), AT = "2026-10-25T10:00:00Z";
const NATIVE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:kit:tests:universal-native-media",
  title: "kit.test-native-media.v1",
  type: "object", additionalProperties: false,
  required: ["title", "links", "metadata"],
  properties: {
    title: { type: "string", minLength: 1 },
    links: { type: "array", items: { type: "string" } },
    metadata: { type: "object", required: ["z", "a"], additionalProperties: false,
      properties: { z: { type: "integer" }, a: { type: "boolean" } } },
  },
};
const seed = (override = {}) => ({
  tenant: "site-01", project: "example-project", kind: "media", subject: "term-001", revision: "v1",
  occurredAt: AT,
  authority: { registry_ref: "registry/media", contract_ref: "kit.media-bundle.v1", policy_ref: "policy/publish" },
  provenance: { source_ref: "source/verified", source_sha256: H, observed_at: AT, actor: "editor-01" },
  correlationId: "trace-001", payloadContract: "kit.media-bundle.v1", payloadSchema: NATIVE,
  payload: { title: "تست", links: ["first"], metadata: { z: 1, a: true } },
  requiredEvidence: ["source-verified", "contract-validated", "policy-evaluated", "sandbox-smoke", "production-observed"],
  ...override,
});
const receipts = (e) => e.lifecycle.required_evidence.map((kind) => ({
  kind, envelope_id: e.id, idempotency_key: e.trace.idempotency_key,
  tenant: e.tenant, project: e.project, status: "verified",
  sha256: R, external_ref: "worker-check/" + kind, observed_at: "2026-10-25T10:10:00Z",
}));
test("T=0 universal schema is the registered immutable intent, not publication", () => {
  const e = createUniversalEnvelope(seed());
  assert.deepEqual(validate(e, SCHEMA), []);
  assert.deepEqual(universalEnvelopeProblems(e, {nativeSchema:NATIVE}), []);
  assert.equal(e.authority.root_sha256, UNIVERSAL_AUTHORITY_SHA256);
  assert.match(e.payload.schema_sha256,/^[a-f0-9]{64}$/);
  assert.equal(e.id, "site-01/example-project/media/term-001/v1");
  assert.equal(e.lifecycle.state, "planned-not-executed");
  assert.equal(e.trace.idempotency_key.length, 64);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.payload.data.metadata));
  assert.equal(assessUniversalEvidence(e, [], {nativeSchema:NATIVE}).ok, false);
});
test("canonical identity and idempotency are stable across object key order and retry times", () => {
  const first = createUniversalEnvelope(seed());
  const second = createUniversalEnvelope(seed({ payload: { metadata: { a: true, z: 1 }, links: ["first"], title: "تست" },
    occurredAt: "2026-10-25T10:01:00Z", correlationId: "retry-002" }));
  assert.equal(first.trace.idempotency_key, second.trace.idempotency_key);
  assert.equal(first.payload.sha256, second.payload.sha256);
  assert.notEqual(first.trace.correlation_id, second.trace.correlation_id);
});
test("no mutable/undocumented source, fake namespace, bad policy or JSON coercion", () => {
  assert.throws(() => createUniversalEnvelope(seed({ tenant: "../other" })), /namespace segment/);
  assert.throws(() => createUniversalEnvelope(seed({ authority: { registry_ref: "registry" } })), /contract and policy/);
  assert.throws(() => createUniversalEnvelope(seed({ requiredEvidence: [] })), /requiredEvidence policy/);
  assert.throws(() => createUniversalEnvelope(seed({ requiredEvidence: ["x", "x"] })), /requiredEvidence policy/);
  assert.throws(() => createUniversalEnvelope(seed({ payload: { value: Number.NaN } })), /finite JSON/);
  assert.throws(() => createUniversalEnvelope(seed({ payload: { value: undefined } })), /must be JSON/);
  assert.throws(() => createUniversalEnvelope(seed({ provenance: { source_ref: "x", source_sha256: R,
    observed_at: "tomorrow", actor: "editor" } })), /source ref/);
});
test("hash drift, altered payload, and broken policy are detected on incoming envelopes", () => {
  const e = createUniversalEnvelope(seed()), mutable = structuredClone(e);
  mutable.payload.data.metadata.z = 2;
  assert.ok(universalEnvelopeProblems(mutable, {nativeSchema:NATIVE}).some((p) => /payload hash mismatch/.test(p)));
  const forged = structuredClone(e); forged.trace.idempotency_key = R;
  assert.ok(universalEnvelopeProblems(forged, {nativeSchema:NATIVE}).some((p) => /idempotency digest mismatch/.test(p)));
  const ns = structuredClone(e); ns.project = "another-project";
  assert.ok(universalEnvelopeProblems(ns, {nativeSchema:NATIVE}).some((p) => /canonical.*identity/.test(p)));
});
test("all receipt assertions remain NOT RELEASED; one missing or foreign evidence blocks", () => {
  const e = createUniversalEnvelope(seed()), good = assessUniversalEvidence(e, receipts(e), {nativeSchema:NATIVE});
  assert.equal(good.ok, true);
  assert.equal(good.status, "evidence-ready-for-independent-review");
  for (const flag of ["published", "released", "deployed"]) assert.equal(good[flag], false);
  const missing = assessUniversalEvidence(e, receipts(e).slice(0, 2), {nativeSchema:NATIVE});
  assert.ok(missing.blockers.some((x) => x.reason === "missing_required_evidence"));
  const forged = receipts(e); forged[0].tenant = "other";
  assert.ok(assessUniversalEvidence(e, forged, {nativeSchema:NATIVE}).blockers.some((x) => x.reason === "cross-tenant-or-identity-mismatch"));
  const fail = receipts(e); fail[1].status = "failed";
  assert.ok(assessUniversalEvidence(e, fail, {nativeSchema:NATIVE}).blockers.some((x) => x.reason === "unverified_or_invalid_observation"));
  const dup = receipts(e); dup.push(dup[0]);
  assert.ok(assessUniversalEvidence(e, dup, {nativeSchema:NATIVE}).blockers.some((x) => x.reason === "duplicate_evidence"));
});

test("all layers: 47 canonical boundary types include every surface, SDK, API, customer, agent, rail, daemon and media kind", () => {
  const kinds = new Set(UNIVERSAL_BOUNDARIES.map((b) => b.kind));
  assert.equal(kinds.size, 47);
  for (const kind of ["surface","widget","app","environment","customer","product","sdk","api",
    "routine","daemon","rail","engine","agent","workflow","database","event","media",
    "podcast","infographic","blog","clip","deployment","migration","tenant","policy"]) {
    assert.equal(universalBoundary(kind).kind,kind);
  }
  assert.throws(() => universalBoundary("unregistered"),/unregistered T0/);
});
test("T0 boundary evidence is mandatory even for custom declared tracks; duplicate levels fail", () => {
  assert.throws(() => createUniversalEnvelope(seed({ requiredEvidence: ["sandbox-smoke"] })),
    /boundary evidence gate missing/);
  assert.throws(() => createUniversalEnvelope(seed({ kind: "not-registered" })),
    /unregistered T0/);
  const reduced=structuredClone(createUniversalEnvelope(seed()));
  reduced.lifecycle.required_evidence = ["sandbox-smoke"];
  assert.ok(universalEnvelopeProblems(reduced, {nativeSchema:NATIVE}).some((p) => /boundary evidence gate missing/.test(p)));
  const optional=seed({ requiredEvidence: [...seed().requiredEvidence, "consent-approved"] });
  const original=createUniversalEnvelope(optional);
  const tampered=structuredClone(original);
  tampered.lifecycle.required_evidence=tampered.lifecycle.required_evidence.filter(x=>x!=="consent-approved");
  assert.ok(universalEnvelopeProblems(tampered, {nativeSchema:NATIVE}).some((p) => /idempotency digest mismatch/.test(p)), "any removal of an additional T0 policy requirement invalidates immutable identity");
  assert.equal(assessUniversalEvidence(tampered, receipts(tampered), {nativeSchema:NATIVE}).ok, false);
});

test("native payload contract is mandatory at T0; no permissive postfacto wrapper", () => {
  assert.throws(() => createUniversalEnvelope(seed({payloadSchema:null})), /native payloadSchema/);
  assert.throws(() => createUniversalEnvelope(seed({payload:{title:"incomplete"}})), /native payload contract rejected/);
  const e = createUniversalEnvelope(seed());
  assert.equal(e.payload.schema_id,NATIVE.$id);
});

test("one authority digest rejects divergent registries and unverified native payload schemas at read time", () => {
  const env = createUniversalEnvelope(seed());
  const mutated = structuredClone(env);
  mutated.authority.root_sha256 = R;
  assert.ok(universalEnvelopeProblems(mutated, {nativeSchema:NATIVE}).some(p=>p.includes("authority root SHA mismatch")));
  assert.equal(assessUniversalEvidence(env, receipts(env)).ok, false, "no native schema proof is a blocker even if receipts claim verified");
  const wrong = {...NATIVE, $id:"urn:bogus:copy"};
  assert.ok(universalEnvelopeProblems(env, {nativeSchema:wrong}).some(p=>p.includes("native payload schema unresolved")));
  const sameIdAltered = structuredClone(NATIVE);
  sameIdAltered.properties.title.minLength = 200;
  assert.ok(universalEnvelopeProblems(env,{nativeSchema:sameIdAltered}).some(p=>p.includes("native schema content digest mismatch")),
    "a schema with the SAME id but divergent content cannot be accepted");
  const changed = structuredClone(env);
  changed.payload.data.links = [2];
  assert.ok(universalEnvelopeProblems(changed, {nativeSchema:NATIVE}).some(p=>p.includes("native payload")));
});

test("T0 native payload contract and governing authority cannot be different contracts", () => {
  const env = createUniversalEnvelope(seed());
  const modified = structuredClone(env);
  modified.authority.contract_ref = "kit.unrelated.v1";
  assert.ok(universalEnvelopeProblems(modified,{nativeSchema:NATIVE}).some(p=>p.includes("authority and native payload contract mismatch")));
});
