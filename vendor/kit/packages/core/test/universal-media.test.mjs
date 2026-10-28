import test from "node:test";
import assert from "node:assert/strict";
import { planMediaBundle } from "../src/media.js";
import { createUniversalMediaIntent, MEDIA_NATIVE_SCHEMA, MEDIA_AUTHORITY_REF } from "../src/universal-media.js";
import { UNIVERSAL_AUTHORITY_SHA256, universalEnvelopeProblems, assessUniversalEvidence } from "../src/universal-envelope.js";
import { validate } from "../src/schema.js";
const SHA="a".repeat(64);
const fixture=()=>planMediaBundle({
  tenant:"factory-site",project:"factory-os",content_id:"rail-risk",edition:"v1",
  title:"Rail safety terms",locale:"en-GB",
  source:{ref:"registry/topics/rail-risk",sha256:SHA,verified_at:"2026-10-25T09:00:00Z",
    citations:[{ref:"standard:rail",url:"https://example.org/rail",verified:true}]},
});
const opts={actor:"editor-01",occurredAt:"2026-10-25T10:00:00Z",correlationId:"trace-001",policyRef:"policies/media-publishing"};
test("all four media channels share one Kit native schema and one immutable lifecycle/authority",()=>{
  const plan=fixture();
  assert.deepEqual(validate(plan,MEDIA_NATIVE_SCHEMA),[]);
  const envelope=createUniversalMediaIntent(plan,opts);
  assert.equal(envelope.payload.contract_ref,"kit.media-bundle.v1");
  assert.equal(envelope.payload.schema_id,MEDIA_NATIVE_SCHEMA.$id);
  assert.equal(envelope.authority.registry_ref,MEDIA_AUTHORITY_REF);
  assert.equal(envelope.authority.root_sha256,UNIVERSAL_AUTHORITY_SHA256);
  assert.deepEqual(universalEnvelopeProblems(envelope,{nativeSchema:MEDIA_NATIVE_SCHEMA}),[]);
  for(const kind of ["podcast","infographic","blog","clip"])
    assert.ok(envelope.lifecycle.required_evidence.includes("media-"+kind));
  assert.equal(envelope.lifecycle.state,"planned-not-executed");
  assert.equal(assessUniversalEvidence(envelope,[],{nativeSchema:MEDIA_NATIVE_SCHEMA}).ok,false);
});
test("same payload, different transaction trace: same canonical media intent digest",()=>{
  const a=createUniversalMediaIntent(fixture(),opts);
  const b=createUniversalMediaIntent(fixture(),{...opts,correlationId:"retry-002",occurredAt:"2026-10-25T10:01:00Z"});
  assert.equal(a.trace.idempotency_key,b.trace.idempotency_key);
});
test("contract or evidence drift fails closed across all media modalities",()=>{
  const intent=createUniversalMediaIntent(fixture(),opts);
  const changed=structuredClone(intent);
  changed.lifecycle.required_evidence=changed.lifecycle.required_evidence.filter(x=>x!=="media-clip");
  assert.ok(universalEnvelopeProblems(changed,{nativeSchema:MEDIA_NATIVE_SCHEMA}).some(x=>x.includes("idempotency digest mismatch")));
  const bad=structuredClone(intent);
  bad.payload.data.required_kinds=["podcast"];
  assert.ok(universalEnvelopeProblems(bad,{nativeSchema:MEDIA_NATIVE_SCHEMA}).some(x=>x.includes("payload hash mismatch")));
  assert.throws(()=>createUniversalMediaIntent({...fixture(),contract:"fake.media.v1"},opts),/unsupported native payload contract/);
  assert.throws(()=>createUniversalMediaIntent(fixture(),{...opts,policyRef:""}),/policyRef/);
});
