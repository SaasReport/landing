import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOperationalEmail } from "../src/adapters.js";

const params = {
  templateId: "saasreport.ops.developer-invite.v1",
  to: "recipient@example.org",
  idempotencyKey: "invite:123",
  params: { form_label: "registration", claim_url: "https://example.org/claim?token=secret" },
};
test("strict operational email uses approved Comms channel with single recipient and idempotency", async () => {
  const captured = [];
  const env = { COMMS: { async fetch(url, init) {
    captured.push({ url, init });
    return Response.json({ ok: true, sent: 1, dispatch_id: "dispatch_123" });
  }}};
  assert.deepEqual(await dispatchOperationalEmail(env, params),
    { status: "sent", dispatchId: "dispatch_123" });
  assert.equal(captured.length,1);
  assert.equal(new URL(captured[0].url).pathname,"/v1/comms/dispatch");
  assert.equal(captured[0].init.method,"POST");
  const sent=JSON.parse(captured[0].init.body);
  assert.deepEqual(sent.to,["recipient@example.org"]);
  assert.equal(sent.template_id,params.templateId);
  assert.equal(sent.idempotency_key,params.idempotencyKey);
  assert.deepEqual(sent.params,params.params);
});
test("permanent suppression is a typed terminal outcome, not a false sent receipt",async()=>{
  for (const value of [{ok:true,suppressed:true,sent:0},{ok:true,suppressed:1,sent:0}]) {
    const env={COMMS:{fetch:async()=>Response.json(value)}};
    assert.deepEqual(await dispatchOperationalEmail(env,params),{status:"suppressed",dispatchId:null});
  }
});
test("success without confirmed delivery must fail closed, never emit sensitive API/claim tokens",async()=>{
  for (const response of [
    () => Response.json({ok:true,sent:0}),
    () => Response.json({ok:false,sent:1}),
    () => new Response("not-json",{status:200}),
    () => new Response("bad API key: secret",{status:503}),
  ]) {
    const env={COMMS:{fetch:async()=>response()}};
    await assert.rejects(dispatchOperationalEmail(env,params),e=>
      e instanceof Error && /operational email/.test(e.message) &&
      !e.message.includes("secret") && !e.message.includes("recipient@example.org"));
  }
});
test("missing binding or recipient cannot access email dispatcher",async()=>{
  await assert.rejects(dispatchOperationalEmail({},params),/binding unavailable/);
  await assert.rejects(dispatchOperationalEmail({COMMS:{fetch:async()=>{throw Error("should not run")}}},{...params,to:""}),/recipient is invalid/);
});

test("operational dispatch rejects unbounded or malformed identity values before binding access", async () => {
  const { dispatchOperationalEmail } = await import("../src/index.js");
  const args = { to: "valid@example.com", templateId: "ops.invitation-v1", params: {}, idempotencyKey: "a" };
  for (const templateId of ["", "x".repeat(201), "bad template", "foo/bar", "کاربر"]) {
    await assert.rejects(dispatchOperationalEmail({}, { ...args, templateId }), /template is invalid/);
  }
  for (const to of ["", "a@b", "a@@b.com", "a@.com", "a@b.", "a b@d.com", "x".repeat(201) + "@d.com"]) {
    await assert.rejects(dispatchOperationalEmail({}, { ...args, to }), /recipient is invalid/);
  }
});
