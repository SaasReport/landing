// Every operation of contracts/admin.openapi.json, failure first, with the contract as the oracle of each answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeAdmin, makeComms, seedLead, expectJson, conformsTo, newReference, hashOf, req, ORIGIN, ALLOWED, AUD, TEAM, jwksFetch, OWNER_INBOX } from "./helpers.mjs";

const HEAD = "b".repeat(40);
const mut = (method, body, extra = {}) => ({ method, body, ...extra });
const rows = async (a, sql, ...args) => (await a.env.DB.prepare(sql).bind(...args).all()).results;
const audit = (a) => rows(a, "SELECT * FROM admin_audit ORDER BY seq");

// ------------------------------------------------------------------ session, headers, routing
test("every answer carries no-store and the security headers, and none sets a cookie or a CORS header", async () => {
  const a = makeAdmin();
  for (const [p, init] of [["/api/session", {}], ["/api/nothing", {}], ["/api/leads", { method: "PUT", body: {} }], ["/workbench/", {}], ["/api/leads", { token: "bad" }]]) {
    const r = await a.call(p, init);
    assert.equal(r.headers.get("cache-control"), "no-store", p);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(r.headers.get("set-cookie"), null, "the Worker has no cookie of its own");
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
});

test("unknown route 404, wrong method 405 with Allow, OPTIONS is not answered", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/nothing")).status, 404);
  const r = await a.call("/api/leads/export", { method: "DELETE" });
  assert.equal(r.status, 405);
  assert.match(r.headers.get("allow"), /GET/);
  assert.equal((await a.call("/api/session", { method: "OPTIONS" })).status, 405);
  assert.equal((await a.call("/api/audit", { method: "PUT", body: {} })).status, 405, "the audit log has no write route at all");
  assert.equal((await a.call("/api/audit", { method: "DELETE" })).status, 405);
});

test("the interface comes from the assets only after authentication; / goes to the workbench", async () => {
  const a = makeAdmin();
  const home = await a.worker.fetch(req("/", { token: a.token() }), a.env, {});
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/workbench/");
  const page = await a.call("/workbench/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "asset /workbench/");
  assert.equal((await a.call("/workbench/", { method: "POST", body: {} })).status, 405);
});

test("getContract serves the contract the Worker is built from", async () => {
  const a = makeAdmin();
  const j = await (await a.call("/api/openapi.json")).json();
  assert.equal(j.openapi, "3.1.0");
  assert.deepEqual(Object.keys(j.components.securitySchemes), ["cfAccess"]);
});

// ------------------------------------------------------------------ leads
test("listLeads: refuses bad filters, then lists newest first with filters and a cursor", async () => {
  const a = makeAdmin();
  for (const q of ["status=maybe", "form=Bad Form", "limit=0", "limit=101", "limit=x", "q=", `q=${"x".repeat(33)}`, "cursor=@@@", "cursor=e30"]) assert.equal((await a.call(`/api/leads?${q}`)).status, 400, q);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await seedLead(a.env.ENGINE_DB, { created_at: `2026-10-0${i + 1}T10:00:00.000Z`, name: `Lead ${i}`, company: i % 2 ? "Odd Ltd" : "Even Ltd" }));
  const p1 = await expectJson(a, "listLeads", "/api/leads?limit=2", 200);
  assert.deepEqual(p1.items.map((x) => x.name), ["Lead 4", "Lead 3"]);
  assert.ok(p1.next_cursor);
  const p2 = await expectJson(a, "listLeads", `/api/leads?limit=2&cursor=${p1.next_cursor}`, 200);
  assert.deepEqual(p2.items.map((x) => x.name), ["Lead 2", "Lead 1"]);
  const p3 = await expectJson(a, "listLeads", `/api/leads?limit=2&cursor=${p2.next_cursor}`, 200);
  assert.deepEqual(p3.items.map((x) => x.name), ["Lead 0"]);
  assert.equal(p3.next_cursor, null);
  const q = await expectJson(a, "listLeads", "/api/leads?q=odd", 200);
  assert.deepEqual(q.items.map((x) => x.name), ["Lead 3", "Lead 1"]);
  assert.equal((await expectJson(a, "listLeads", "/api/leads?q=%25", 200)).items.length, 0, "a LIKE wildcard is a literal");
  assert.equal((await expectJson(a, "listLeads", "/api/leads?form=other-form", 200)).items.length, 0);
  assert.ok(!JSON.stringify(p1).includes("@"), "the list shows no address");
});

test("listLeads: the status filter looks across the state table, and a short page still carries its cursor", async () => {
  const a = makeAdmin();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await seedLead(a.env.ENGINE_DB, { created_at: `2026-10-0${i + 1}T10:00:00.000Z`, name: `L${i}` }));
  await a.call(`/api/leads/${ids[1]}`, mut("PATCH", { status: "won" }));
  await a.call(`/api/leads/${ids[3]}`, mut("PATCH", { status: "won" }));
  const won = await expectJson(a, "listLeads", "/api/leads?status=won", 200);
  assert.deepEqual(won.items.map((x) => x.name), ["L3", "L1"]);
  const fresh = await expectJson(a, "listLeads", "/api/leads?status=new&limit=3", 200);
  assert.deepEqual(fresh.items.map((x) => x.name), ["L5", "L4", "L2"], "a lead with no state row is new");
  assert.ok(fresh.next_cursor);
  const rest = await expectJson(a, "listLeads", `/api/leads?status=new&limit=3&cursor=${fresh.next_cursor}`, 200);
  assert.deepEqual(rest.items.map((x) => x.name), ["L0"]);
  assert.equal(rest.next_cursor, null);
});

test("listLeads answers available:false when the leads table does not exist yet", async () => {
  const a = makeAdmin();
  a.env.ENGINE_DB.raw.exec("DROP TABLE leads");
  const j = await expectJson(a, "listLeads", "/api/leads", 200);
  assert.equal(j.available, false);
  assert.equal((await a.call("/api/leads/E-AAAAAAAAAAAAAAAA")).status, 404);
});

test("getLead: bad id 400, unknown 404, found with the address, fields and state", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/leads/bad%20id")).status, 400);
  assert.equal((await a.call("/api/leads/E-NOPE")).status, 404);
  const id = await seedLead(a.env.ENGINE_DB, { email: "sara.test@example.test" });
  const j = await expectJson(a, "getLead", `/api/leads/${id}`, 200);
  assert.equal(j.email, "sara.test@example.test");
  assert.equal(j.status, "new");
  assert.equal(j.fields.role, "CFO");
});

test("updateLead: every invalid request is refused before anything is written", async () => {
  const a = makeAdmin();
  const id = await seedLead(a.env.ENGINE_DB);
  const url = `/api/leads/${id}`;
  const bad = [
    ["empty object", {}], ["unknown status", { status: "maybe" }], ["extra field", { status: "won", owner: "x" }], ["note not text", { note: 5 }], ["note over the cap", { note: "x".repeat(1001) }], ["an array", []],
  ];
  for (const [name, body] of bad) assert.equal((await a.call(url, mut("PATCH", body))).status, 400, name);
  assert.equal((await a.call(url, mut("PATCH", "{not json"))).status, 400, "malformed JSON");
  assert.equal((await a.call(url, mut("PATCH", '{"status":"won"}', { json: false, headers: { "content-type": "text/plain" } }))).status, 415, "not application/json");
  assert.equal((await a.call(url, mut("PATCH", '{"status":"won"}', { json: false }))).status, 415, "no content type");
  assert.equal((await a.call(url, mut("PATCH", { note: "x".repeat(9000) }))).status, 413, "over the body cap");
  const noLength = new Request(`${ORIGIN}${url}`, { method: "PATCH", headers: { "cf-access-jwt-assertion": a.token(), origin: ORIGIN, "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"status":"won"}')); c.close(); } }), duplex: "half" });
  assert.equal((await a.worker.fetch(noLength, a.env, {})).status, 411, "a body needs a Content-Length");
  assert.equal((await a.call("/api/leads/E-NOPE", mut("PATCH", { status: "won" }))).status, 404);
  assert.equal((await a.call("/api/leads/bad%20id", mut("PATCH", { status: "won" }))).status, 400);
  assert.equal((await rows(a, "SELECT * FROM admin_lead_state")).length, 0);
  assert.equal((await audit(a)).filter((r) => r.outcome === "done").length, 0, "a refused request is not an action");
});

test("updateLead is same-origin only: another origin, a cross-site fetch and a bare form post are refused, and audited as denied", async () => {
  const a = makeAdmin();
  const id = await seedLead(a.env.ENGINE_DB);
  const url = `/api/leads/${id}`;
  for (const opts of [{ origin: "https://evil.example.test" }, { origin: "null" }, { origin: null, headers: { "sec-fetch-site": "cross-site" } }, { origin: null, headers: { "sec-fetch-site": "same-site" } }]) {
    const r = await a.call(url, mut("PATCH", { status: "won" }, opts));
    assert.equal(r.status, 403, JSON.stringify(opts));
  }
  assert.equal((await a.call(url, mut("PATCH", "status=won", { json: false, headers: { "content-type": "application/x-www-form-urlencoded" } }))).status, 415);
  assert.equal((await rows(a, "SELECT * FROM admin_lead_state")).length, 0);
  assert.ok((await audit(a)).some((r) => r.outcome === "denied"));
  assert.equal((await a.call(url, mut("PATCH", { status: "won" }, { origin: null, headers: { "sec-fetch-site": "same-origin" } }))).status, 200, "a same-origin browser request");
  assert.equal((await a.call(url, mut("PATCH", { note: "client without browser headers" }, { origin: null }))).status, 200, "a non-browser client (still behind Access)");
});

test("updateLead sets the state and writes its audit row in one step; the note's text is not in the log", async () => {
  const a = makeAdmin();
  const id = await seedLead(a.env.ENGINE_DB);
  const j = await expectJson(a, "updateLead", `/api/leads/${id}`, 200, mut("PATCH", { status: "contacted", note: "called on Monday" }));
  assert.equal(j.status, "contacted");
  assert.equal(j.note, "called on Monday");
  const log = await audit(a);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "updateLead");
  assert.equal(log[0].outcome, "done");
  assert.equal(log[0].target_id, id);
  assert.equal(log[0].actor_hash, hashOf(ALLOWED));
  const d = JSON.parse(log[0].detail_json);
  assert.deepEqual([d.from, d.to, d.status_changed, d.note_changed, d.note_length], ["new", "contacted", true, true, 16]);
  assert.ok(!log[0].detail_json.includes("Monday"), "the note is not copied into the log");
  const list = await expectJson(a, "listLeads", "/api/leads", 200);
  assert.equal(list.items[0].status, "contacted");
  const note = await expectJson(a, "updateLead", `/api/leads/${id}`, 200, mut("PATCH", { note: "second call" }));
  assert.equal(note.status, "contacted", "a note alone keeps the status");
});

test("updateLead is idempotent: the same key replays the first answer and writes no second row; another body under the key is a 409", async () => {
  const a = makeAdmin();
  const id = await seedLead(a.env.ENGINE_DB);
  const h = { "idempotency-key": "once-1" };
  const first = await a.call(`/api/leads/${id}`, mut("PATCH", { status: "qualified" }, { headers: h }));
  assert.equal(first.status, 200);
  const again = await a.call(`/api/leads/${id}`, mut("PATCH", { status: "qualified" }, { headers: h }));
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await again.json(), await first.json());
  assert.equal((await audit(a)).length, 1);
  const other = await a.call(`/api/leads/${id}`, mut("PATCH", { status: "won" }, { headers: h }));
  assert.equal(other.status, 409);
  assert.equal((await a.call(`/api/leads/${id}`, mut("PATCH", { status: "won" }, { headers: { "idempotency-key": "bad key!" } }))).status, 400);
  assert.equal((await audit(a)).length, 1);
});

test("exportLeads: CSV with the filters, formula cells neutralised, the export audited before any row leaves", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/leads/export?status=maybe")).status, 400);
  const id = await seedLead(a.env.ENGINE_DB, { name: "=HYPERLINK(\"http://x\")", company: "Smith, \"Jr\" & Co" });
  await seedLead(a.env.ENGINE_DB, { name: "Other" });
  await a.call(`/api/leads/${id}`, mut("PATCH", { status: "won", note: "+cmd" }));
  const r = await a.call("/api/leads/export?status=won");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/csv/);
  const text = await r.text();
  const lines = text.trim().split("\r\n");
  assert.equal(lines.length, 2, "header and the one won lead");
  assert.match(lines[0], /^id,form,name,email,company,created_at,comms_status,status,note$/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://x"")"`), lines[1]);
  assert.ok(lines[1].includes(`"Smith, ""Jr"" & Co"`));
  assert.ok(lines[1].includes(",won,'+cmd"));
  const log = (await audit(a)).filter((x) => x.action === "exportLeads");
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0].detail_json).rows, 1);
  const all = await (await a.call("/api/leads/export")).text();
  assert.equal(all.trim().split("\r\n").length, 3);
});

// ------------------------------------------------------------------ deliveries
test("listDeliveries and getDelivery: the ledger as kit.form-notification.v1; bad filters and references are refused", async () => {
  const a = makeAdmin();
  for (const q of ["state=gone", "form_id=Bad Form", "limit=0", "cursor=@@"]) assert.equal((await a.call(`/api/deliveries?${q}`)).status, 400, q);
  assert.equal((await a.call("/api/deliveries/not-a-reference")).status, 400);
  assert.equal((await a.call("/api/deliveries/E-AAAAAAAAAAAAAAAA")).status, 404);
  const ok = await seedLead(a.env.ENGINE_DB, { created_at: "2026-10-01T10:00:00.000Z" });
  const failed = await seedLead(a.env.ENGINE_DB, { created_at: "2026-10-02T10:00:00.000Z", owner: "failed", owner_error: "no_recipients" });
  const pending = await seedLead(a.env.ENGINE_DB, { created_at: new Date().toISOString(), owner: "pending", receipt: "pending" });
  const all = await expectJson(a, "listDeliveries", "/api/deliveries", 200);
  assert.equal(all.items.length, 3);
  assert.deepEqual((await expectJson(a, "listDeliveries", "/api/deliveries?state=failed", 200)).items.map((x) => x.reference), [failed]);
  assert.deepEqual((await expectJson(a, "listDeliveries", "/api/deliveries?state=pending", 200)).items.map((x) => x.reference), [pending]);
  const one = await expectJson(a, "getDelivery", `/api/deliveries/${ok}`, 200);
  assert.equal(one.owner.status, "sent");
  const p = await expectJson(a, "listDeliveries", "/api/deliveries?limit=2", 200);
  assert.ok(p.next_cursor);
  assert.equal((await expectJson(a, "listDeliveries", `/api/deliveries?limit=2&cursor=${p.next_cursor}`, 200)).items.length, 1);
});

test("retryDelivery: refused without a key, for a delivery that has gone, an unknown one, and a submission that is not stored", async () => {
  const a = makeAdmin();
  a.env.COMMS = makeComms(a.env.ENGINE_DB);
  const k = { headers: { "idempotency-key": "r1" } };
  const failed = await seedLead(a.env.ENGINE_DB, { owner: "failed", owner_error: "x" });
  assert.equal((await a.call(`/api/deliveries/${failed}/retry`, mut("POST", {}))).status, 400, "Idempotency-Key is required");
  assert.equal((await a.call("/api/deliveries/bad/retry", mut("POST", {}, k))).status, 400);
  assert.equal((await a.call("/api/deliveries/E-AAAAAAAAAAAAAAAA/retry", mut("POST", {}, k))).status, 404);
  const sent = await seedLead(a.env.ENGINE_DB);
  assert.equal((await a.call(`/api/deliveries/${sent}/retry`, mut("POST", {}, { headers: { "idempotency-key": "r2" } }))).status, 409);
  const orphan = newReference("E");
  await a.env.ENGINE_DB.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, receipt_status, owner_status) VALUES (?, 'early-access', 'https://saasreport.ai', 0, ?, 'sent', 'failed')").bind(orphan, new Date().toISOString()).run();
  const r = await a.call(`/api/deliveries/${orphan}/retry`, mut("POST", {}, { headers: { "idempotency-key": "r3" } }));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "no_stored_submission");
  assert.equal(a.env.COMMS.calls.length, 0, "the engine was not called for any of them");
  assert.equal((await a.call(`/api/deliveries/${failed}/retry`, mut("POST", {}, { origin: "https://evil.example.test", headers: { "idempotency-key": "r4" } }))).status, 403);
  assert.equal(a.env.COMMS.calls.length, 0);
});

test("retryDelivery hands the stored submission to the engine's submit under the same reference; the engine re-drives only what did not go and picks template and recipients itself", async () => {
  const a = makeAdmin();
  const comms = (a.env.COMMS = makeComms(a.env.ENGINE_DB));
  const id = await seedLead(a.env.ENGINE_DB, { owner: "failed", owner_error: "no_recipients" });
  const r = await expectJson(a, "retryDelivery", `/api/deliveries/${id}/retry`, 200, mut("POST", {}, { headers: { "idempotency-key": "retry-1" } }));
  assert.deepEqual(r.attempted, ["owner"]);
  assert.equal(r.ok, true);
  assert.equal(r.record.owner.status, "sent");
  assert.equal(comms.calls.length, 1);
  assert.match(comms.calls[0].url, /\/v1\/comms\/submit$/);
  assert.equal(comms.calls[0].body.reference, id);
  for (const forbidden of ["to", "template_id", "recipient", "recipients", "owner"]) assert.ok(!(forbidden in comms.calls[0].body), `the admin does not choose ${forbidden}`);
  assert.deepEqual(comms.sent.map((m) => m.to), [OWNER_INBOX], "one email, to the owner's address the engine holds; the receipt had already gone");
  const log = (await audit(a)).filter((x) => x.action === "retryDelivery");
  assert.deepEqual(log.map((x) => x.outcome), ["attempted", "done"], "the intent is on record before the call");
  const replay = await a.call(`/api/deliveries/${id}/retry`, mut("POST", {}, { headers: { "idempotency-key": "retry-1" } }));
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(comms.calls.length, 1, "a replay does not call the engine again");
});

test("retryDelivery re-drives both when neither went, and reports a delivery that still fails; an engine that cannot be reached is a 502, recorded as failed", async () => {
  const a = makeAdmin();
  const comms = (a.env.COMMS = makeComms(a.env.ENGINE_DB, { reject: [OWNER_INBOX] }));
  const id = await seedLead(a.env.ENGINE_DB, { receipt: "failed", owner: "failed", email: "sara.test@example.test" });
  const r = await expectJson(a, "retryDelivery", `/api/deliveries/${id}/retry`, 200, mut("POST", {}, { headers: { "idempotency-key": "retry-2" } }));
  assert.deepEqual(r.attempted, ["receipt", "owner"]);
  assert.equal(r.ok, false);
  assert.equal(r.record.receipt.status, "sent");
  assert.equal(r.record.owner.status, "failed");
  assert.ok(r.error);
  const down = makeAdmin();
  down.env.COMMS = { fetch: async () => { throw new Error("binding down"); } };
  const id2 = await seedLead(down.env.ENGINE_DB, { owner: "failed", owner_error: "x" });
  const bad = await expectJson(down, "retryDelivery", `/api/deliveries/${id2}/retry`, 502, mut("POST", {}, { headers: { "idempotency-key": "retry-3" } }));
  assert.equal(bad.ok, false);
  assert.deepEqual((await audit(down)).map((x) => x.outcome), ["attempted", "failed"]);
});

// ------------------------------------------------------------------ inbound, autoreply, alerts
test("listInbound: shows what the table stores (a sender hash, never an address); a missing table is available:false", async () => {
  const a = makeAdmin();
  for (const q of ["status=gone", "limit=0", "cursor=@@"]) assert.equal((await a.call(`/api/inbound?${q}`)).status, 400, q);
  const sender = hashOf("someone@example.test");
  const ins = a.env.ENGINE_DB.prepare("INSERT INTO comms_inbound (id, received_at, sender_hash, recipient, status, forwards_json, autoreply_state, autoreply_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  await ins.bind("m1", "2026-10-02T10:00:00.000Z", sender, OWNER_INBOX, "forwarded", JSON.stringify([{ destination: "owner-1", status: "sent" }, { destination: "owner-2", status: "failed", error: "refused" }]), "sent", null).run();
  await ins.bind("m2", "2026-10-03T10:00:00.000Z", sender, OWNER_INBOX, "failed", "not json", "bogus", "x").run();
  const j = await expectJson(a, "listInbound", "/api/inbound", 200);
  assert.deepEqual(j.items.map((m) => m.id), ["m2", "m1"]);
  assert.equal(j.items[1].forwards[1].status, "failed");
  assert.equal(j.items[0].autoreply.state, "not_applicable", "an unknown state is not passed through");
  assert.deepEqual(j.items[0].forwards, []);
  assert.ok(!JSON.stringify(j).includes("someone@"), "no sender address");
  assert.equal((await expectJson(a, "listInbound", "/api/inbound?status=forwarded", 200)).items.length, 1);
  assert.equal((await expectJson(a, "listInbound", "/api/inbound?limit=1", 200)).next_cursor !== null, true);
  a.env.ENGINE_DB.raw.exec("DROP TABLE comms_inbound");
  assert.equal((await expectJson(a, "listInbound", "/api/inbound", 200)).available, false);
});

test("getAutoreplyStats: counts by state over the window, for inbound autoreplies and form receipts", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/autoreply/stats?window_hours=0")).status, 400);
  assert.equal((await a.call("/api/autoreply/stats?window_hours=721")).status, 400);
  const ins = a.env.ENGINE_DB.prepare("INSERT INTO comms_inbound (id, received_at, sender_hash, recipient, status, forwards_json, autoreply_state) VALUES (?, ?, 'h', 'r', 'received', '[]', ?)");
  const now = new Date().toISOString();
  for (const [i, s] of ["sent", "sent", "suppressed"].entries()) await ins.bind(`x${i}`, now, s).run();
  await ins.bind("old", "2020-01-01T00:00:00.000Z", "failed").run();
  await seedLead(a.env.ENGINE_DB, { receipt: "failed" });
  await seedLead(a.env.ENGINE_DB);
  const j = await expectJson(a, "getAutoreplyStats", "/api/autoreply/stats", 200);
  assert.deepEqual(j.inbound, { available: true, total: 3, by_state: { sent: 2, suppressed: 1 } });
  assert.deepEqual(j.form_receipts, { total: 2, by_status: { failed: 1, sent: 1 } });
  a.env.ENGINE_DB.raw.exec("DROP TABLE comms_inbound");
  assert.equal((await expectJson(a, "getAutoreplyStats", "/api/autoreply/stats", 200)).inbound.available, false);
});

test("listOwnerAlertFailures: failed owner notifications and failed operator dispatches, with the summary the monitor reads", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/alerts?window_hours=0")).status, 400);
  const bad = await seedLead(a.env.ENGINE_DB, { owner: "failed", owner_error: "no_recipients" });
  await seedLead(a.env.ENGINE_DB);
  await a.env.ENGINE_DB.prepare("INSERT INTO comms_dispatch (dispatch_id, template_id, channel, category, to_hashes_json, requested_at, send_status, send_error) VALUES ('d1', 'saasreport.ops.lead-alert.v1', 'email', 'operational', '[]', ?, 'failed', 'provider refused')").bind(new Date().toISOString()).run();
  const j = await expectJson(a, "listOwnerAlertFailures", "/api/alerts", 200);
  assert.deepEqual(j.failures.map((f) => f.kind).sort(), ["form_owner_notification", "ops_dispatch"]);
  assert.equal(j.failures.find((f) => f.kind === "form_owner_notification").id, bad);
  assert.equal(j.summary.ok, false);
  assert.equal(j.summary.owner_failed, 1);
});

// ------------------------------------------------------------------ suppressions
test("listSuppressions: hashes only, filtered and paged; invalid filters refused", async () => {
  const a = makeAdmin();
  for (const q of ["reason=gone", "limit=0", "cursor=@@"]) assert.equal((await a.call(`/api/suppressions?${q}`)).status, 400, q);
  const ins = a.env.ENGINE_DB.prepare("INSERT INTO comms_suppression (recipient_hash, reason, scope, actor_id, created_at) VALUES (?, ?, 'global', 'a', ?)");
  await ins.bind(hashOf("one@example.test"), "hard-bounce", "2026-10-01T00:00:00.000Z").run();
  await ins.bind(hashOf("two@example.test"), "complaint", "2026-10-02T00:00:00.000Z").run();
  await ins.bind(hashOf("three@example.test"), "complaint", "2026-10-03T00:00:00.000Z").run();
  const all = await expectJson(a, "listSuppressions", "/api/suppressions", 200);
  assert.equal(all.items.length, 3);
  assert.equal((await expectJson(a, "listSuppressions", "/api/suppressions?reason=complaint", 200)).items.length, 2);
  const p = await expectJson(a, "listSuppressions", "/api/suppressions?limit=2", 200);
  assert.equal((await expectJson(a, "listSuppressions", `/api/suppressions?limit=2&cursor=${p.next_cursor}`, 200)).items.length, 1);
  assert.ok(!JSON.stringify(all).includes("@"));
});

test("addSuppression: refused for a bad body, a bad reason, both or neither of address and hash, a cross-origin call", async () => {
  const a = makeAdmin();
  a.env.COMMS = makeComms(a.env.ENGINE_DB);
  const bad = [{}, { reason: "hard-bounce" }, { reason: "nope", recipient: "x@example.test" }, { reason: "hard-bounce", recipient: "not an address" }, { reason: "hard-bounce", recipient: "x@example.test", recipient_hash: hashOf("x") }, { reason: "hard-bounce", recipient_hash: "xyz" }, { reason: "hard-bounce", recipient: "x@example.test", extra: 1 }];
  for (const body of bad) assert.equal((await a.call("/api/suppressions", mut("POST", body))).status, 400, JSON.stringify(body));
  assert.equal((await a.call("/api/suppressions", mut("POST", { reason: "complaint", recipient: "x@example.test" }, { origin: "https://evil.example.test" }))).status, 403);
  assert.equal(a.env.COMMS.calls.length, 0);
  assert.equal((await rows(a, "SELECT * FROM admin_audit WHERE outcome != 'denied'")).length, 0);
});

test("addSuppression goes through the comms engine (which hashes the address); the admin keeps the hash and never the address", async () => {
  const a = makeAdmin();
  const comms = (a.env.COMMS = makeComms(a.env.ENGINE_DB));
  const addr = "Someone.Test@Example.Test";
  const j = await expectJson(a, "addSuppression", "/api/suppressions", 200, mut("POST", { reason: "unsubscribe.marketing", recipient: addr }, { headers: { "idempotency-key": "s1" } }));
  assert.equal(j.recipient_hash, createHash("sha256").update(addr.toLowerCase()).digest("hex"));
  const stored = await a.env.ENGINE_DB.prepare("SELECT * FROM comms_suppression").all();
  assert.equal(stored.results.length, 1);
  assert.match(stored.results[0].actor_id, /^saasreport:admin:[0-9a-f]{16}$/);
  const dump = JSON.stringify([await rows(a, "SELECT * FROM admin_audit"), await rows(a, "SELECT * FROM admin_idempotency")]);
  assert.ok(!dump.toLowerCase().includes("someone.test"), "the address is in neither the audit log nor the idempotency record");
  assert.deepEqual((await audit(a)).map((x) => x.outcome), ["attempted", "done"]);
  assert.equal((await audit(a))[1].target_id, j.recipient_hash);
  const again = await a.call("/api/suppressions", mut("POST", { reason: "unsubscribe.marketing", recipient: addr }, { headers: { "idempotency-key": "s1" } }));
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(comms.calls.length, 1);
  const byHash = await expectJson(a, "addSuppression", "/api/suppressions", 200, mut("POST", { reason: "hard-bounce", recipient_hash: hashOf("other") }));
  assert.equal(byHash.recipient_hash, hashOf("other"));
});

test("addSuppression: an engine that refuses or cannot be reached is a 502 and is recorded as failed", async () => {
  const a = makeAdmin();
  a.env.COMMS = { fetch: async () => Response.json({ ok: false, error: "suppression_not_recorded" }, { status: 503 }) };
  const r = await expectJson(a, "addSuppression", "/api/suppressions", 502, mut("POST", { reason: "complaint", recipient_hash: hashOf("x") }));
  assert.equal(r.ok, false);
  assert.deepEqual((await audit(a)).map((x) => x.outcome), ["attempted", "failed"]);
});

test("removeSuppression: 404 when it is not there; a dsar-erasure is permanent (409, audited as denied); otherwise it is deleted and audited", async () => {
  const a = makeAdmin();
  const h = hashOf("gone@example.test");
  const base = `/api/suppressions/${h}`;
  assert.equal((await a.call(`${base}/complaint`, mut("DELETE"))).status, 404);
  assert.equal((await a.call("/api/suppressions/xyz/complaint", mut("DELETE"))).status, 400);
  assert.equal((await a.call(`${base}/nonsense`, mut("DELETE"))).status, 400);
  assert.equal((await a.call(`${base}/complaint`, mut("DELETE", undefined, { origin: "https://evil.example.test" }))).status, 403);
  const ins = a.env.ENGINE_DB.prepare("INSERT INTO comms_suppression (recipient_hash, reason, scope, actor_id, created_at) VALUES (?, ?, 'global', 'a', ?)");
  await ins.bind(h, "dsar-erasure", new Date().toISOString()).run();
  await ins.bind(h, "complaint", new Date().toISOString()).run();
  const refused = await expectJson(a, "removeSuppression", `${base}/dsar-erasure`, 409, mut("DELETE"));
  assert.equal(refused.error, "erasure_is_permanent");
  assert.equal((await rows(a, "SELECT * FROM admin_audit WHERE outcome = 'denied' AND action = 'removeSuppression' AND detail_json LIKE '%dsar-erasure%'")).length, 1);
  const log0 = (await audit(a)).length;
  const ok = await expectJson(a, "removeSuppression", `${base}/complaint`, 200, mut("DELETE", undefined, { headers: { "idempotency-key": "del-1" } }));
  assert.equal(ok.reason, "complaint");
  const left = (await a.env.ENGINE_DB.prepare("SELECT reason FROM comms_suppression").all()).results;
  assert.deepEqual(left.map((r) => r.reason), ["dsar-erasure"]);
  assert.deepEqual((await audit(a)).slice(log0).map((x) => x.outcome), ["attempted", "done"]);
  const replay = await a.call(`${base}/complaint`, mut("DELETE", undefined, { headers: { "idempotency-key": "del-1" } }));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
});

// ------------------------------------------------------------------ registries, provisioning, overview, audit
test("registries: the index, each registry, and a 404 for a name that is not one", async () => {
  const a = makeAdmin();
  const idx = await expectJson(a, "listRegistries", "/api/registries", 200);
  assert.deepEqual(idx.registries.map((r) => r.name), ["stakeholders", "metrics", "report-types", "findings", "commitments", "legal"]);
  assert.ok(idx.registries.every((r) => r.count > 0));
  assert.equal((await a.call("/api/registries/company")).status, 404);
  for (const r of idx.registries) { const j = await expectJson(a, "getRegistry", `/api/registries/${r.name}`, 200); assert.equal(j.items.length, r.count); }
  const findings = await expectJson(a, "getRegistry", "/api/registries/findings", 200);
  assert.ok(findings.items.every((f) => f.evidence_metrics.length > 0 && f.evidence_metrics.every((m) => m.name)), "every rule shows the metrics that are its evidence, by name");
  const commitments = await expectJson(a, "getRegistry", "/api/registries/commitments", 200);
  assert.ok(commitments.items.every((c) => typeof c.status === "string"));
  const legal = await expectJson(a, "getRegistry", "/api/registries/legal", 200);
  assert.ok(legal.items.every((d) => Array.isArray(d.blockers) && d.blockers.length > 0 && d.text_checked === false), "drafts are blocked, and the view says their text was not checked");
  assert.ok(legal.notes.length);
});

test("getProvisioning: presence of names and bindings, never their values; the planned names against the naming registry", async () => {
  const a = makeAdmin({ env: { ADMIN_ALLOWED_EMAILS: `${ALLOWED}` } });
  const j = await expectJson(a, "getProvisioning", "/api/provisioning", 200);
  assert.equal(j.ready, false, "the comms service binding is not present in this test");
  const dump = JSON.stringify(j);
  for (const secret of [AUD, TEAM, ALLOWED]) assert.ok(!dump.includes(secret), "no configured value is shown");
  assert.equal(j.config.find((c) => c.name === "GITHUB_READ_TOKEN").required, false);
  assert.ok(j.planned.every((p) => p.registry_valid === false && p.problem), "admin is not in the naming registry yet");
  a.env.COMMS = makeComms(a.env.ENGINE_DB);
  assert.equal((await expectJson(a, "getProvisioning", "/api/provisioning", 200)).ready, true);
  assert.equal(j.registry.provisioning.available, false);
});

test("getOverview: each Worker's /api/build, served commits against main's head when the read secret is set, delivery and lead counts", async () => {
  const state = { keys: [] };
  const calls = [];
  const a0 = makeAdmin();
  state.keys = [a0.key];
  const jwks = jwksFetch(state);
  const fetchFn = async (url, init) => {
    calls.push([String(url), init?.headers]);
    if (String(url) === "https://api.saasreport.ai/api/build") return Response.json({ commit: HEAD, services: {} });
    if (String(url) === "https://api.github.com/repos/SaasReport/landing/commits/main") return Response.json({ sha: HEAD });
    return jwks(url, init);
  };
  const a = makeAdmin({ key: a0.key, fetch: fetchFn, env: { BUILD_COMMIT: "c".repeat(40) } });
  a.env.COMMS = { fetch: async () => Response.json({ commit: HEAD, services: {} }) };
  await seedLead(a.env.ENGINE_DB);
  const noHead = await expectJson(a, "getOverview", "/api/overview", 200);
  assert.deepEqual(noHead.main_head, { available: false, reason: "not_configured" });
  assert.ok(noHead.workers.every((w) => w.matches_main === null), "without main's head nothing is compared");
  assert.ok(!calls.some(([u]) => u.includes("github")), "GitHub is not asked without the read secret");
  a.env.GITHUB_READ_TOKEN = "read-token-for-tests";
  const j = await expectJson(a, "getOverview", "/api/overview", 200);
  assert.deepEqual(j.main_head, { available: true, commit: HEAD });
  const by = Object.fromEntries(j.workers.map((w) => [w.id, w]));
  assert.equal(by.admin.matches_main, false, "this Worker was built from another commit");
  assert.equal(by["comms-engine"].matches_main, true);
  assert.equal(by.api.matches_main, true);
  assert.equal(j.leads.total, 1);
  assert.equal(j.leads.by_status.new, 1);
  assert.equal(j.deliveries.submissions, 1);
  const gh = calls.find(([u]) => u.includes("github"));
  assert.match(String(gh[1].authorization), /^Bearer /);
  assert.ok(!JSON.stringify(j).includes("read-token-for-tests"));
});

test("getOverview: an unreachable Worker is reported as unreachable, never as matching", async () => {
  const a = makeAdmin();
  a.env.COMMS = { fetch: async () => { throw new Error("down"); } };
  const j = await expectJson(a, "getOverview", "/api/overview", 200);
  const comms = j.workers.find((w) => w.id === "comms-engine");
  assert.equal(comms.reachable, false);
  assert.equal(comms.commit, "unreachable");
  const api = j.workers.find((w) => w.id === "api");
  assert.equal(api.reachable, false);
  assert.equal(j.deliveries.submissions, 0);
});

test("listAudit: newest first, filtered by action and target, paged; bad filters refused", async () => {
  const a = makeAdmin();
  for (const q of ["action=a-b", "limit=0", "cursor=@@", `target_id=${"x".repeat(201)}`]) assert.equal((await a.call(`/api/audit?${q}`)).status, 400, q);
  const ids = [await seedLead(a.env.ENGINE_DB), await seedLead(a.env.ENGINE_DB)];
  for (const id of ids) await a.call(`/api/leads/${id}`, mut("PATCH", { status: "contacted" }));
  await a.call(`/api/leads/${ids[0]}`, mut("PATCH", { status: "won" }));
  const all = await expectJson(a, "listAudit", "/api/audit", 200);
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.items.map((x) => x.seq), [3, 2, 1]);
  assert.equal((await expectJson(a, "listAudit", `/api/audit?target_id=${ids[0]}`, 200)).items.length, 2);
  assert.equal((await expectJson(a, "listAudit", "/api/audit?action=exportLeads", 200)).items.length, 0);
  const p = await expectJson(a, "listAudit", "/api/audit?limit=2", 200);
  assert.deepEqual((await expectJson(a, "listAudit", `/api/audit?limit=2&cursor=${p.next_cursor}`, 200)).items.map((x) => x.seq), [1]);
  assert.ok(all.items.every((x) => x.actor_hash === hashOf(ALLOWED)));
  assert.ok(!JSON.stringify(all).includes("@"));
});

test("a Worker with a missing binding refuses with 503 and no detail instead of throwing", async () => {
  // which routes need which database: the audit database (DB), the engine's (ENGINE_DB), or both
  const needs = { "/api/leads": ["DB", "ENGINE_DB"], "/api/deliveries": ["ENGINE_DB"], "/api/suppressions": ["ENGINE_DB"], "/api/inbound": ["ENGINE_DB"], "/api/alerts": ["ENGINE_DB"], "/api/audit": ["DB"] };
  for (const missing of ["DB", "ENGINE_DB"]) {
    const a = makeAdmin({ env: { [missing]: undefined } });
    for (const [p, uses] of Object.entries(needs)) {
      const r = await a.call(p);
      if (uses.includes(missing)) { assert.equal(r.status, 503, `${missing} ${p}`); assert.deepEqual(await r.json(), { ok: false, error: "unavailable" }); }
      else assert.equal(r.status, 200, `${missing} ${p}`);
    }
  }
  const noComms = makeAdmin();
  const id = await seedLead(noComms.env.ENGINE_DB, { owner: "failed" });
  assert.equal((await noComms.call(`/api/deliveries/${id}/retry`, mut("POST", {}, { headers: { "idempotency-key": "k" } }))).status, 503);
  assert.equal((await noComms.call("/api/suppressions", mut("POST", { reason: "complaint", recipient_hash: hashOf("x") }))).status, 503);
});

test("a handler that throws answers 500 internal_error without its message", async () => {
  const a = makeAdmin();
  a.env.ENGINE_DB = { prepare() { throw new Error("secret-ish detail: table internals"); } };
  const r = await a.call("/api/leads");
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: "internal_error" });
});
