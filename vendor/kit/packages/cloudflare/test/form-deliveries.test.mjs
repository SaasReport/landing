// GET /api/forms/deliveries[/<reference>]: the form-delivery ledger the comms engine writes (docs/FORMS.md). The summary is what the
// monitor's form-deliveries journey reads: a failed or stale owner delivery is a 503, so the journey fails, alerts and shows on /status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { LOOKUP_LIMIT } from "@saasreport/core/form-deliveries";
import { makeKit } from "./helpers.mjs";

const NOTE = JSON.parse(readFileSync(new URL("../../core/schemas/form-notification.schema.json", import.meta.url), "utf8"));
const V = createValidator([NOTE]);
const LEDGER = readFileSync(new URL("../../comms/migrations/0003_comms_form_deliveries.sql", import.meta.url), "utf8");

function kitWithLedger(now = "2026-10-13T12:00:00Z") {
  const k = makeKit("en", { now });
  k.env.DB.sqlite.exec(LEDGER);
  const ins = k.env.DB.sqlite.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, receipt_status, owner_status, owner_error) VALUES (?, 'contact', ?, 0, ?, 'sent', ?, ?)");
  return { ...k, ins };
}

test("the summary is 200 while every owner delivery went, 503 once one failed; no address, no reference in it", async () => {
  const { get, ins, config } = kitWithLedger();
  ins.run("C-PK2223XXXXXXXXXX", config.site.url, "2026-10-13T11:00:00Z", "sent", null);
  let r = await get("/api/forms/deliveries");
  assert.equal(r.status, 200);
  let s = await r.json();
  assert.deepEqual(formatProblems(V.validate(s, { $ref: `${NOTE.$id}#/$defs/summary` })), []);
  assert.equal(s.ok, true); assert.equal(s.owner_sent, 1);
  ins.run("C-BAD2223XXXXXXXXX", config.site.url, "2026-10-13T11:30:00Z", "failed", "all_recipients_failed: destination address is not a verified address");
  r = await get("/api/forms/deliveries");
  assert.equal(r.status, 503);
  s = await r.json();
  assert.equal(s.ok, false); assert.equal(s.owner_failed, 1);
  assert.ok(!JSON.stringify(s).includes("C-BAD2223XXXXXXXXX"));
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("one record by reference, as the owner's notification links it; a bad or unknown reference is refused", async () => {
  const { get, ins, config } = kitWithLedger();
  ins.run("C-REC2223XXXXXXXXX", config.site.url, "2026-10-13T11:00:00Z", "sent", null);
  const r = await get("/api/forms/deliveries/C-REC2223XXXXXXXXX");
  assert.equal(r.status, 200);
  const rec = await r.json();
  assert.deepEqual(formatProblems(V.validate(rec, NOTE)), []);
  assert.equal(rec.owner.status, "sent");
  assert.equal(rec.ledger_url, `${config.site.url.replace(/\/$/, "")}/api/forms/deliveries/C-REC2223XXXXXXXXX`);
  assert.equal((await get("/api/forms/deliveries/C-NPNE223XXXXXXXXX")).status, 404);
  assert.equal((await get("/api/forms/deliveries/x")).status, 400);
  assert.equal((await get("/api/forms/deliveries", { method: "POST", body: "{}" })).status, 405);
});

test("no ledger table (the migration never ran) is a 503, never an empty ok", async () => {
  const { get } = makeKit("en");
  const log = console.error; console.error = () => {};
  try {
    const r = await get("/api/forms/deliveries");
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "ledger_unreadable");
  } finally { console.error = log; }
});

test("must fail: the lookup of references is limited per client (429), not for another client; the summary says when the last test ran", async () => {
  const { get, ins, config, env } = kitWithLedger();
  ins.run("C-REC2223XXXXXXXXX", config.site.url, "2026-10-13T11:00:00Z", "sent", null);
  const lookup = (ip) => get("/api/forms/deliveries/C-REC2223XXXXXXXXX", { headers: { "cf-connecting-ip": ip } });
  for (let i = 0; i < LOOKUP_LIMIT.max; i++) assert.equal((await lookup("192.0.2.1")).status, 200, `lookup ${i + 1}`);
  const limited = await lookup("192.0.2.1");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await lookup("192.0.2.2")).status, 200, "another client");
  // a probe for unknown references spends the same budget
  assert.equal((await get("/api/forms/deliveries/C-NEXT2222XXXXXXXX", { headers: { "cf-connecting-ip": "192.0.2.1" } })).status, 429);
  // the summary carries the last test row's time (the monitor drills once a day)
  let s = await (await get("/api/forms/deliveries")).json();
  assert.equal(s.last_test_at, null);
  env.DB.sqlite.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, receipt_status, owner_status) VALUES ('C-TEST2222XXXXXXXX', 'contact', ?, 1, '2026-10-13T11:45:00Z', 'sent', 'sent')").run(config.site.url);
  s = await (await get("/api/forms/deliveries")).json();
  assert.equal(s.last_test_at, "2026-10-13T11:45:00Z");
  assert.deepEqual(formatProblems(V.validate(s, { $ref: `${NOTE.$id}#/$defs/summary` })), []);
});

