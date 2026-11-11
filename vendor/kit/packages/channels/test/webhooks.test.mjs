// Signed two-layer webhooks: fixtures signed independently with node:crypto verify here; rotation, replay window, replay
// store, tampering, envelopes (relayed + normalised), backoff and one delivery against a fake receiver. Nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { signWebhook, verifyWebhook, parseSignatures, webhookEvent, twoLayerEvents, deliverWebhook, backoffDelay, retryable, webhookAdapter, WEBHOOK_SCHEMA } from "../src/index.js";

const PUBLIC = async () => ["93.184.216.34"];
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const SIGNED = fx("webhook-signed.json"), UP = fx("upstream-sync.json");

test("fixture: a delivery signed with node:crypto verifies with either rotation key, and only within the window", async () => {
  const d = { headers: SIGNED.headers, body: SIGNED.body };
  assert.deepEqual(await verifyWebhook(d, { keys: SIGNED.keys, now: SIGNED.now_ms }), { ok: true, id: SIGNED.id, timestamp: SIGNED.timestamp, keyId: "2026-10" });
  assert.equal((await verifyWebhook(d, { keys: { "2026-07": "test-secret-old" }, now: SIGNED.now_ms })).keyId, "2026-07", "a receiver still on the old key");
  assert.deepEqual(await verifyWebhook(d, { keys: { "2025-01": "x" }, now: SIGNED.now_ms }), { ok: false, reason: "unknown_key" });
  assert.deepEqual(await verifyWebhook(d, { keys: { "2026-10": "wrong" }, now: SIGNED.now_ms }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verifyWebhook(d, { keys: SIGNED.keys, now: SIGNED.now_ms + 10 * 60_000 }), { ok: false, reason: "too_old" });
  assert.deepEqual(await verifyWebhook(d, { keys: SIGNED.keys, now: SIGNED.now_ms - 10 * 60_000 }), { ok: false, reason: "too_new" });
  assert.equal((await verifyWebhook(d, { keys: SIGNED.keys, now: SIGNED.now_ms + 10 * 60_000, tolerance: 900 })).ok, true, "tolerance is configurable");
});

test("tampering: body, id or timestamp changed → bad_signature; missing or odd headers are refused", async () => {
  const o = { keys: SIGNED.keys, now: SIGNED.now_ms };
  assert.equal((await verifyWebhook({ headers: SIGNED.headers, body: SIGNED.body.replace("sent", "sEnt") }, o)).reason, "bad_signature");
  assert.equal((await verifyWebhook({ headers: { ...SIGNED.headers, "webhook-id": "evt_other" }, body: SIGNED.body }, o)).reason, "bad_signature");
  assert.equal((await verifyWebhook({ headers: { ...SIGNED.headers, "webhook-timestamp": String(SIGNED.timestamp + 1) }, body: SIGNED.body }, o)).reason, "bad_signature");
  assert.equal((await verifyWebhook({ headers: { "webhook-id": "x" }, body: "{}" }, o)).reason, "missing_headers");
  assert.equal((await verifyWebhook({ headers: { ...SIGNED.headers, "webhook-timestamp": "1e9" }, body: SIGNED.body }, o)).reason, "bad_timestamp");
  assert.equal((await verifyWebhook({ headers: { ...SIGNED.headers, "webhook-signature": "v1,2026-10,!!notbase64" }, body: SIGNED.body }, o)).reason, "bad_signature");
});

test("replay store: an id already seen is refused after the signature checks out", async () => {
  const store = new Set();
  const seen = (id) => { if (store.has(id)) return true; store.add(id); return false; };
  const o = { keys: SIGNED.keys, now: SIGNED.now_ms, seen };
  assert.equal((await verifyWebhook({ headers: new Headers(SIGNED.headers), body: SIGNED.body }, o)).ok, true, "Headers objects work too");
  assert.deepEqual(await verifyWebhook({ headers: SIGNED.headers, body: SIGNED.body }, o), { ok: false, reason: "replayed" });
});

test("signWebhook: one v1 signature per active key, the same bytes node:crypto computes", async () => {
  const h = await signWebhook({ body: SIGNED.body, id: SIGNED.id, timestamp: SIGNED.timestamp, keys: [{ id: "2026-10", secret: "test-secret-new" }, { id: "2026-07", secret: "test-secret-old" }, { id: "2026-01", secret: "retired", active: false }] });
  assert.deepEqual(h, SIGNED.headers);
  assert.deepEqual(parseSignatures(h["webhook-signature"]).map((s) => s.kid), ["2026-10", "2026-07"]);
  const raw = Buffer.from("random-bytes-secret").toString("base64");
  const h2 = await signWebhook({ body: "{}", id: "e1", timestamp: 1, keys: { k1: `whsec_${raw}` } });
  assert.equal(h2["webhook-signature"], `v1,k1,${createHmac("sha256", Buffer.from("random-bytes-secret")).update("e1.1.{}").digest("base64")}`);
  await assert.rejects(signWebhook({ body: "{}", id: "e", keys: { "bad id": "s" } }), /key id/);
  await assert.rejects(signWebhook({ body: "{}", id: "e", keys: [] }), /no active key/);
});

test("two layers: the upstream payload relayed as received, plus the normalised event pointing back at it", () => {
  const [relayed, normalised] = twoLayerEvents({ provider: UP.provider, eventType: UP.eventType, eventId: UP.eventId, payload: UP.payload, verified: UP.verified, receivedAt: UP.receivedAt },
    { source: "https://example.org", normalise: (p) => ({ type: "calendar.sync_completed", data: { account: p.account, added: p.changed.added, removed: p.changed.removed } }), now: "2026-10-01T12:00:06.000Z" });
  assert.equal(relayed.schema, WEBHOOK_SCHEMA);
  assert.equal(relayed.type, "upstream.example-calendar.sync.completed");
  assert.equal(relayed.data, null);
  assert.deepEqual(relayed.upstream, { provider: UP.provider, event_type: UP.eventType, event_id: UP.eventId, received_at: UP.receivedAt, verified: true, payload: UP.payload });
  assert.equal(normalised.type, UP.normalised.type);
  assert.deepEqual(normalised.data, UP.normalised.data);
  assert.deepEqual(normalised.upstream, { provider: UP.provider, event_type: UP.eventType, event_id: UP.eventId }, "no raw payload in the normalised layer");
  assert.equal(normalised.caused_by, relayed.id);
  assert.equal(twoLayerEvents({ provider: "p", eventType: "x", payload: {} }, { source: "s", normalise: () => null }).length, 1, "nothing to normalise: only the relay");
  assert.throws(() => webhookEvent({ type: "bad type", source: "s" }), /dotted/);
  assert.throws(() => webhookEvent({ type: "a.b" }), /source/);
});

test("backoff and retryable statuses", () => {
  assert.deepEqual([1, 2, 3, 4].map((a) => backoffDelay(a, { base: 1000 })), [1000, 2000, 4000, 8000]);
  assert.equal(backoffDelay(30, { base: 1000, cap: 60_000 }), 60_000);
  assert.equal(backoffDelay(3, { base: 1000, jitter: true, random: () => 0.5 }), 2000);
  assert.deepEqual([0, 200, 400, 404, 408, 409, 425, 429, 500, 503].map(retryable), [true, false, false, false, true, true, true, true, true, true]);
});

test("deliverWebhook: signed POST to a fake receiver; network errors and 5xx are retryable, 4xx are not; https only", async () => {
  const seen = [];
  const receiver = async (url, init) => { seen.push({ url, init }); return new Response(null, { status: seen.length === 1 ? 204 : seen.length === 2 ? 503 : 410 }); };
  const ev = webhookEvent({ type: "comms.dispatched", source: "https://example.org", data: { dispatch_id: "d1" } });
  const sub = { id: "crm", url: "https://hooks.example.net/in", keys: { "2026-10": "s1" } };
  assert.deepEqual(await deliverWebhook(ev, sub, { resolve: PUBLIC, fetch: receiver, now: 1_790_856_000_000 }), { ok: true, status: 204, retryable: false });
  const v = await verifyWebhook({ headers: seen[0].init.headers, body: seen[0].init.body }, { keys: sub.keys, now: 1_790_856_000_000 });
  assert.equal(v.ok, true, "the receiver can verify what was sent");
  assert.equal(seen[0].init.redirect, "manual");
  // the subscriber URL is a remote party's choice: internal targets are refused without a request, and not retried
  for (const url of ["https://127.0.0.1/in", "https://169.254.169.254/latest/meta-data/", "https://[::ffff:10.0.0.1]/in", "https://2130706433/in"]) { const n = seen.length; const r = await deliverWebhook(ev, { ...sub, url }, { resolve: PUBLIC, fetch: receiver }).catch((e) => ({ threw: String(e) })); assert.ok(r.threw || (r.ok === false && r.retryable === false), url); assert.equal(seen.length, n, `${url} was requested`); }
  const rebinding = await deliverWebhook(ev, sub, { resolve: async () => ["10.1.2.3"], fetch: receiver });
  assert.deepEqual([rebinding.ok, rebinding.retryable], [false, false]); assert.match(rebinding.error, /blocked_address/);
  const redirecting = await deliverWebhook(ev, sub, { resolve: PUBLIC, fetch: async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }) });
  assert.deepEqual([redirecting.ok, redirecting.status, redirecting.retryable], [false, 302, false]);
  assert.deepEqual(await deliverWebhook(ev, sub, { resolve: PUBLIC, fetch: receiver }), { ok: false, status: 503, retryable: true, error: "HTTP 503" });
  assert.deepEqual(await deliverWebhook(ev, sub, { resolve: PUBLIC, fetch: receiver }), { ok: false, status: 410, retryable: false, error: "HTTP 410" });
  const down = await deliverWebhook(ev, sub, { resolve: PUBLIC, fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.deepEqual([down.ok, down.status, down.retryable], [false, 0, true]);
  await assert.rejects(deliverWebhook(ev, { ...sub, url: "http://hooks.example.net/in" }), /https/);
});

test("webhook adapter: legacy x-kit-signature, plus the timestamped signature when a key id is set", async () => {
  const calls = [];
  const f = async (url, init) => { calls.push(init); return new Response("ok"); };
  await webhookAdapter({ url: "https://hook", secret: "s3", keyId: "k1", fetch: f }).send({ kind: "post", title: "T", idempotencyKey: "post:1" });
  const h = calls[0].headers;
  assert.match(h["x-kit-signature"], /^sha256=[0-9a-f]{64}$/);
  assert.equal(h["webhook-id"], "post:1");
  const v = await verifyWebhook({ headers: h, body: calls[0].body }, { keys: { k1: "s3" } });
  assert.equal(v.ok, true);
  await webhookAdapter({ url: "https://hook", secret: "s3", fetch: f }).send({ kind: "post", title: "T" });
  assert.ok(!("webhook-signature" in calls[1].headers), "without a key id: the legacy header only");
});

test("contract: every envelope conforms to kit.webhook-event.v1 (contracts/webhook-event.schema.json)", async () => {
  const { validate, formatProblems } = await import("@saasreport/core/schema");
  const schema = JSON.parse(readFileSync(new URL("../contracts/webhook-event.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.title, WEBHOOK_SCHEMA);
  const events = [
    webhookEvent({ type: "comms.sent", source: "https://example.org", data: { id: 1 }, subject: "lead_1" }),
    ...twoLayerEvents({ provider: UP.provider, eventType: UP.eventType, eventId: UP.eventId, payload: UP.payload, verified: UP.verified, receivedAt: UP.receivedAt },
      { source: "https://example.org", normalise: (p) => ({ type: "calendar.sync_completed", data: { ok: true } }), now: "2026-10-01T08:00:00Z" }),
    ...twoLayerEvents({ provider: "p", eventType: "x", payload: {} }, { source: "s", now: "2026-10-01T08:00:00.000Z" }),
  ];
  for (const e of events) assert.deepEqual(formatProblems(validate(e, schema)), [], e.type);
  assert.ok(formatProblems(validate({ ...events[1], data: { not: "null" } }, schema)).length, "a relayed event carries no data");
});
