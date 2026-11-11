// Outbound webhooks on Cloudflare: subscribers from env (dormant without URL and keys), one Workflow instance per
// (event, subscriber), the Workflow step retrying retryable failures and giving up on 4xx, and the intake helper turning a
// verified upstream delivery into two layers. Fakes only: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signWebhook, webhookEvent } from "@saasreport/channels/webhooks";
import { parseKeys, wants, subscribersFrom, enqueueWebhooks, webhookWorkflowClass, intakeWebhook } from "../src/webhooks.js";

const PUBLIC = async () => ["93.184.216.34"];
const WEBHOOKS = { subscribers: [{ id: "crm", urlEnv: "HOOK_CRM_URL", keysEnv: "HOOK_CRM_KEYS", types: ["comms.*"] }, { id: "ops", urlEnv: "HOOK_OPS_URL", keysEnv: "HOOK_OPS_KEYS" }] };
const ENV = { HOOK_CRM_URL: "https://crm.example.net/hooks", HOOK_CRM_KEYS: "2026-10:new-secret,2026-07:old-secret" };

test("parseKeys, wants and subscribersFrom: keys from a secret, dormant subscribers left out", () => {
  assert.deepEqual(parseKeys("a:1,b:2"), [{ id: "a", secret: "1" }, { id: "b", secret: "2" }]);
  assert.deepEqual(parseKeys('{"a":"1"}'), [{ id: "a", secret: "1" }]);
  assert.deepEqual(parseKeys(""), []);
  assert.ok(wants({ types: ["comms.*"] }, "comms.dispatched") && !wants({ types: ["comms.*"] }, "calendar.x") && wants({}, "anything"));
  const subs = subscribersFrom(ENV, WEBHOOKS);
  assert.deepEqual(subs.map((s) => s.id), ["crm"], "ops has no URL or keys: dormant");
  assert.equal(subs[0].keys.length, 2);
  assert.throws(() => subscribersFrom({}, { subscribers: [{ id: "Bad Id" }] }), /lowercase/);
});

test("enqueueWebhooks: one instance per interested subscriber, secrets never in params, idempotent ids", async () => {
  const created = [];
  const env = { ...ENV, WEBHOOK_WF: { create: async (x) => { if (created.some((c) => c.id === x.id)) throw new Error("instance already exists"); created.push(x); } } };
  const ev = webhookEvent({ type: "comms.dispatched", source: "https://example.org", data: { dispatch_id: "d1" } });
  assert.deepEqual(await enqueueWebhooks(env, ev, { webhooks: WEBHOOKS }), { queued: 1 });
  assert.deepEqual(created[0], { id: `${ev.id}--crm`, params: { event: ev, subscriber: "crm" } });
  assert.ok(!JSON.stringify(created).includes("secret"), "no key material in Workflow params");
  assert.deepEqual(await enqueueWebhooks(env, ev, { webhooks: WEBHOOKS }), { queued: 1 }, "same event again: already queued");
  assert.deepEqual(await enqueueWebhooks(env, webhookEvent({ type: "calendar.x", source: "s" }), { webhooks: WEBHOOKS }), { queued: 0, skipped: "no_subscriber" });
  assert.deepEqual(await enqueueWebhooks(ENV, ev, { webhooks: WEBHOOKS }), { queued: 0, skipped: "no_workflow_binding" });
});

/** A fake Workflow runtime: step.do retries `limit` times, recording attempts. */
const runWorkflow = async (Cls, env, payload) => {
  const attempts = [];
  const step = { do: async (name, opts, fn) => { if (typeof opts === "function") return opts(); for (let i = 0; ; i++) { try { attempts.push(name); return await fn(); } catch (e) { if (i >= opts.retries.limit) throw e; } } } };
  const wf = new Cls(); wf.env = env;
  return { result: await wf.run({ payload }, step).catch((e) => ({ thrown: e.message })), attempts };
};
class Base {}

test("WebhookWorkflow: retries a 503 until it lands, gives up on a 4xx at once, skips unknown subscribers", async () => {
  const ev = webhookEvent({ type: "comms.dispatched", source: "https://example.org", data: {} });
  let n = 0;
  const flaky = async () => new Response(null, { status: ++n < 3 ? 503 : 200 });
  const W = webhookWorkflowClass(Base, { webhooks: WEBHOOKS, resolve: PUBLIC, fetch: flaky, retries: { limit: 5, delay: "1 second", backoff: "exponential" } });
  const ok = await runWorkflow(W, ENV, { event: ev, subscriber: "crm" });
  assert.equal(ok.result.ok, true);
  assert.equal(ok.attempts.length, 3);
  const no = await runWorkflow(webhookWorkflowClass(Base, { webhooks: WEBHOOKS, resolve: PUBLIC, fetch: async () => new Response(null, { status: 404 }) }), ENV, { event: ev, subscriber: "crm" });
  assert.deepEqual([no.result.ok, no.result.gave_up, no.attempts.length], [false, true, 1]);
  const down = await runWorkflow(webhookWorkflowClass(Base, { webhooks: WEBHOOKS, resolve: PUBLIC, fetch: async () => new Response(null, { status: 500 }), retries: { limit: 2 } }), ENV, { event: ev, subscriber: "crm" });
  assert.match(down.result.thrown, /HTTP 500/);
  assert.equal(down.attempts.length, 3);
  assert.deepEqual((await runWorkflow(W, ENV, { event: ev, subscriber: "gone" })).result, { ok: false, skipped: "unknown_subscriber" });
});

test("intakeWebhook: a verified upstream delivery becomes [relayed, normalised]; unverified ones are refused", async () => {
  const body = JSON.stringify({ event: "sync.completed", id: "up_1", account: "acct_7" });
  const keys = { k1: "upstream-secret" };
  const headers = { "content-type": "application/json", ...(await signWebhook({ body, id: "up_1", keys })) };
  let got;
  const opts = { provider: "example-calendar", keys, eventType: (p) => p.event, eventId: (p) => p.id, source: "https://example.org",
    normalise: (p) => ({ type: "calendar.sync_completed", data: { account: p.account } }), onEvents: async (_env, evs) => { got = evs; } };
  const len = { "content-length": String(new TextEncoder().encode(body).length) };
  const r = await intakeWebhook(new Request("https://example.org/hooks/in", { method: "POST", headers: { ...headers, ...len }, body }), {}, opts);
  assert.equal(r.status, 202);
  assert.deepEqual(got.map((e) => e.type), ["upstream.example-calendar.sync.completed", "calendar.sync_completed"]);
  assert.equal(got[0].upstream.verified, true);
  assert.equal(got[1].caused_by, got[0].id);
  got = null;
  const bad = await intakeWebhook(new Request("https://example.org/hooks/in", { method: "POST", headers: { ...headers, ...len, "webhook-signature": "v1,k1,AAAA" }, body }), {}, opts);
  assert.equal(bad.status, 401);
  assert.equal(got, null, "nothing kept");
  const custom = await intakeWebhook(new Request("https://x/in", { method: "POST", headers: len, body }), {}, { ...opts, keys: undefined, verify: async () => true });
  assert.equal(custom.status, 202, "a provider's own scheme via verify()");
  assert.equal((await intakeWebhook(new Request("https://x/in"), {}, opts)).status, 405);
  const big = "x".repeat(300_000);
  assert.equal((await intakeWebhook(new Request("https://x/in", { method: "POST", headers: { "content-length": String(big.length) }, body: big }), {}, opts)).status, 413, "declared over the cap: refused before reading");
  // the cap holds while streaming, whatever the length header says; a missing or lying length is refused
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(65536)); } });
  const streamed = await intakeWebhook(new Request("https://x/in", { method: "POST", headers: { "content-length": "100" }, body: endless, duplex: "half" }), {}, opts);
  assert.equal(streamed.status, 400); assert.equal((await streamed.json()).error, "length_mismatch"); assert.ok(pulled < 10, `pulled ${pulled}`);
  const noLen = await intakeWebhook(new Request("https://x/in", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } }), duplex: "half" }), {}, opts);
  assert.equal(noLen.status, 411);
  const lying = await intakeWebhook(new Request("https://x/in", { method: "POST", headers: { "content-length": "5" }, body: "{}" }), {}, opts);
  assert.ok([400].includes(lying.status));
  assert.equal((await intakeWebhook(new Request("https://x/in", { method: "POST", headers: { "content-length": "10, 20" }, body: "{}" }), {}, opts)).status, 400);
});
