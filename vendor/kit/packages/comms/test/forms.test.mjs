// Every declared form is delivered twice, through the comms engine only: the submitter's receipt and the owner's notification
// (docs/FORMS.md, kit.forms-config.v1, kit.form-notification.v1). Root cause these tests hold shut (2026-10-13):
// each site's own handler sent the receipt and made the owner alert optional (`if (env.OPS_NOTIFY_TO)`, `.catch(() => {})`), so with
// the variable unset the owner heard of nothing and nothing recorded it: 16 receipts, 0 owner rows in the ledgers.
import { migrationOrder } from "@saasreport/core/migration-order";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { buildSpecs, checkConfig, engineRuntime, submitForm, ownerSecretProblems, deliverySummary, readDelivery } from "../src/index.js";
import { formCoverageProblems, signDrill, verifyDrill, DRILL_HEADER } from "@saasreport/core/form-deliveries";
import { createCommsEngine } from "../workers/comms-engine/engine.js";
import sample from "../examples/saasreport/comms.config.js";
import sampleAr from "../examples/saasreport-ar/comms.config.js";

const schema = (f) => JSON.parse(readFileSync(new URL(`../../core/schemas/${f}`, import.meta.url), "utf8"));
const V = createValidator([schema("forms-config.schema.json"), schema("form-notification.schema.json")]);
const NOTE = schema("form-notification.schema.json");
const valid = (value, s, at) => { const p = V.validate(value, s); assert.deepEqual(formatProblems(p), [], `${at} is not ${s.title || s.$ref}`); };
const asRecord = (r) => valid(r, NOTE, "the delivery record");
const asSubmission = (b) => valid(b, { $ref: `${NOTE.$id}#/$defs/submission` }, "the submission");
const asSummary = (b) => valid(b, { $ref: `${NOTE.$id}#/$defs/summary` }, "the summary");

/** A D1-shaped adapter over node:sqlite with every comms migration applied (the real schema, D1's limits). */
function ledger() {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort(migrationOrder)) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

const OWNER = "info@saasreport.ai";   // the project's own info@ (forms.owner.address); Email Routing forwards it to the owner
const SUBMITTER = "sara@example.com";
const specs = (config = sample) => {
  const s = buildSpecs(config);
  return { manifest: s["manifest.json"], blocks: s["blocks.json"], links: s["links.json"], providers: s["providers.json"] };
};
const engineFor = (o = {}) => createCommsEngine({ config: sample, specs: specs(), ...o });
/** A mail sender that records every message and refuses the addresses in `reject` the way send_email does. */
function mailSender(reject = []) {
  const sent = [];
  return { sent, fetch: async (url, init) => {
    const b = JSON.parse(init.body);
    if (reject.includes(b.to)) return Response.json({ ok: false, error: "send_failed", detail: "destination address is not a verified address", provider: "cf-email" }, { status: 502 });
    sent.push(b); return Response.json({ ok: true, message_id: `m${sent.length}` });
  } };
}
const submission = (o = {}) => ({
  form_id: "contact", reference: "A-TEST23XXXXXXXXXX", form_label: "Contact", submitter: { email: SUBMITTER },
  params: { name: "Sara", reference: "A-TEST23XXXXXXXXXX", submitted_at: "13 Oct 2026", fields_html: "<p>Hello &lt;team&gt;</p>", fields_text: "Message: Hello <team>" },
  ...o,
});

// ---------- the contract ----------

test("contract: both schemas compile; the submission, the record and the summary the engine produces are what they declare", async () => {
  asSubmission(submission());
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const r = await engineFor().submitCore(submission(), env);
  asRecord(r.payload.delivery);
  asRecord(await readDelivery(env.DB, "A-TEST23XXXXXXXXXX", sample.site));
  asSummary(await deliverySummary(env.DB, { now: new Date() }));
});

test("contract: a comms config declares its forms' owner; the sample config does, and its forms are every template", () => {
  valid(sample.forms, schema("forms-config.schema.json"), "sample forms");
  const m = specs().manifest;
  assert.deepEqual(m.forms.map((f) => f.form_id), sample.templates.map((t) => t.key));
  for (const f of m.forms) {
    assert.equal(f.ack_template_id, `saasreport.${f.form_id}.ack.v1`);
    assert.equal(f.owner_template_id, "saasreport.ops.lead-alert.v1");
  }
  assert.deepEqual(m.owner, { template_id: "saasreport.ops.lead-alert.v1", secret: "OPS_NOTIFY_TO", address: "info@saasreport.ai" });
});

// ---------- must fail: OPS_NOTIFY_TO missing fails at build/deploy, not at run time ----------

test("must fail at build: a config with forms and no owner is refused when the specs are built (npm run comms:check)", () => {
  const { forms, ...noForms } = sample;
  assert.match(checkConfig(noForms).join("\n"), /forms\.owner: required/);
  assert.throws(() => buildSpecs(noForms), /forms\.owner: required/);
  assert.match(checkConfig({ ...sample, forms: { owner: { template: "nope", secret: "OPS_NOTIFY_TO" } } }).join("\n"), /forms\.owner\.template: "nope" is not an ops key/);
  assert.match(checkConfig({ ...sample, forms: { owner: { template: "lead-alert", secret: "ops notify" } } }).join("\n"), /forms\.owner\.secret/);
  assert.match(checkConfig({ ...sample, forms: { ...sample.forms, declared: ["contact", "ghost"] } }).join("\n"), /forms\.declared: "ghost" has no acknowledgement template/);
  // every acknowledgement template is a form: a `declared` list that leaves one out is refused (review of 7cd5873)
  assert.match(checkConfig({ ...sample, forms: { ...sample.forms, declared: ["contact"] } }).join("\n"), /forms\.declared: template "sandbox-key" is not declared as a form/);
  assert.deepEqual(checkConfig({ ...sample, forms: { ...sample.forms, declared: sample.templates.map((t) => t.key) } }), []);
});

test("must fail at deploy: the comms-engine Worker without the owner's secret is refused (kit comms secrets)", () => {
  assert.deepEqual(ownerSecretProblems(sample, ["OPS_NOTIFY_TO", "OTHER"]), []);
  assert.match(ownerSecretProblems(sample, ["OTHER"]).join("\n"), /saasreport-comms-engine lacks the secret OPS_NOTIFY_TO/);
  assert.match(ownerSecretProblems(sample, []).join("\n"), /OPS_NOTIFY_TO/);
});

test("must fail at run time too (defence): an engine with no owner recipients records the owner delivery as failed and raises it", async () => {
  const events = [];
  const env = { DB: ledger(), MAIL_SENDER: mailSender() };
  const r = await engineFor({ onEvent: (type, data) => events.push([type, data]) }).submitCore(submission(), env);
  assert.equal(r.status, 200);
  assert.equal(r.payload.ok, false);
  assert.equal(r.payload.delivery.receipt.status, "sent");
  assert.equal(r.payload.delivery.owner.status, "failed");
  assert.match(r.payload.delivery.owner.error, /^owner_recipients_missing/);
  const row = await readDelivery(env.DB, "A-TEST23XXXXXXXXXX", sample.site);
  assert.equal(row.owner.status, "failed");
  assert.deepEqual(events.map(([t]) => t).filter((t) => t.startsWith("comms.form.")), ["comms.form.owner_failed"]);
  assert.equal(events.find(([t]) => t === "comms.form.owner_failed")[1].reference, "A-TEST23XXXXXXXXXX");
  assert.ok(!JSON.stringify(events).includes("@"), "no address in an event");
});

// ---------- must fail: a submit path that sends only the receipt ----------

test("must fail: a handler that dispatches a form's receipt itself (receipt only) is refused by the engine; nothing is sent", async () => {
  const mail = mailSender();
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER };
  const engine = engineFor();
  for (const template_id of ["saasreport.contact.ack.v1", "saasreport.ops.lead-alert.v1"]) {
    const r = await engine.dispatchCore({ template_id, to: [SUBMITTER], params: submission().params, idempotency_key: "A-TEST23XXXXXXXXXX" }, env);
    assert.equal(r.status, 409, template_id);
    assert.equal(r.payload.error, "form_template_requires_submit");
  }
  const http = await engine.fetch(new Request("https://comms/v1/comms/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template_id: "saasreport.contact.ack.v1", to: [SUBMITTER], params: submission().params }) }), env);
  assert.equal(http.status, 409);
  assert.equal(mail.sent.length, 0);
});

test("a submission is delivered twice: the receipt to the submitter and the owner's notification with the contents, form id, site and ledger link", async () => {
  const mail = mailSender();
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: ` ${OWNER} ` };
  const events = [];
  const r = await engineFor({ onEvent: (t, d) => events.push([t, d]) }).submitCore(submission(), env);
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.ok, true);
  assert.deepEqual(mail.sent.map((m) => m.to), [SUBMITTER, OWNER], "exactly two deliveries: the autoreply and the owner's copy to info@");
  // the autoreply carries the project's standard signature and legal footer (one kit template, filled from the config)
  const auto = mail.sent[0];
  const blocks = specs().blocks.blocks;
  const sig = blocks.find((b) => b.kind === "signature").value.text.trim();
  const legal = blocks.find((b) => b.kind === "legal" && b.block_id.startsWith("footer.legal.")).value.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3 && !l.includes("${"));
  assert.ok(auto.text.includes(sig), "the standard signature block");
  assert.ok(legal.length && legal.every((l) => auto.text.includes(l)), "the standard legal footer block");
  assert.ok(auto.html.includes(blocks.find((b) => b.kind === "signature").value.html.slice(0, 60)), "the signature in the HTML too");
  const owner = mail.sent[1];
  assert.match(owner.text, /Message: Hello <team>/, "the submission's contents");
  assert.match(owner.text, /\bcontact\b/, "the form id");
  assert.match(owner.text, /https:\/\/saasreport\.ai\/api\/forms\/deliveries\/A-TEST23XXXXXXXXXX/, "the ledger link");
  assert.match(owner.html, /href="https:\/\/saasreport\.ai\/api\/forms\/deliveries\/A-TEST23XXXXXXXXXX"/);
  assert.match(owner.html, /saasreport\.ai/, "the site");
  assert.match(owner.html, /Hello &lt;team&gt;/);
  const rec = await readDelivery(env.DB, "A-TEST23XXXXXXXXXX", sample.site);
  assert.equal(rec.receipt.status, "sent");
  assert.equal(rec.owner.status, "sent");
  assert.match(rec.receipt.dispatch_id, /^saasreport:comms:email:/);
  assert.match(rec.owner.dispatch_id, /^saasreport:comms:email:/);
  assert.notEqual(rec.receipt.dispatch_id, rec.owner.dispatch_id);
  assert.equal(rec.ledger_url, "https://saasreport.ai/api/forms/deliveries/A-TEST23XXXXXXXXXX");
  const rows = env.DB.raw.prepare("SELECT template_id, send_status, idempotency_key FROM comms_dispatch ORDER BY requested_at, rowid").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { template_id: "saasreport.contact.ack.v1", send_status: "sent", idempotency_key: "A-TEST23XXXXXXXXXX" },
    { template_id: "saasreport.ops.lead-alert.v1", send_status: "sent", idempotency_key: "A-TEST23XXXXXXXXXX:owner" },
  ]);
  assert.deepEqual(events.map(([t]) => t).filter((t) => t.startsWith("comms.form.")), ["comms.form.delivered"]);
  // a second submit of the same reference sends nothing again: both deliveries already went
  const again = await engineFor().submitCore(submission(), env);
  assert.equal(again.payload.ok, true);
  assert.equal(mail.sent.length, 2);
});

// ---------- must fail: an owner address that is not the project's own info@ ----------

test("must fail at build: an owner address that is not the project's own info@ is refused", () => {
  for (const address of [undefined, "owner@example.org", "info@example.org", "sales@saasreport.ai", "info@saasreport.ai.evil.example"]) {
    const c = { ...sample, forms: { owner: { ...sample.forms.owner, address } } };
    if (address === undefined) delete c.forms.owner.address;
    assert.match(checkConfig(c).join("\n"), /forms\.owner\.address: must be the project's own info@saasreport\.ai/, String(address));
    assert.throws(() => buildSpecs(c), /forms\.owner\.address/);
  }
  assert.deepEqual(checkConfig({ ...sample, forms: { owner: { ...sample.forms.owner, address: "Info@SaasReport.ai" } } }), [], "case does not matter");
});

test("must fail at deploy: the deploy environment's OPS_NOTIFY_TO is not the project's own info@ (compared, never printed)", () => {
  assert.deepEqual(ownerSecretProblems(sample, ["OPS_NOTIFY_TO"], { value: OWNER }), []);
  const bad = ownerSecretProblems(sample, ["OPS_NOTIFY_TO"], { value: "someone@gmail.example" }).join("\n");
  assert.match(bad, /is not the project's own info@saasreport\.ai/);
  assert.ok(!bad.includes("someone@"), "the value is never printed");
  assert.match(ownerSecretProblems(sample, ["OPS_NOTIFY_TO"], { requireValue: true }).join("\n"), /does not hold OPS_NOTIFY_TO/);
});

test("must fail at run time: an engine secret that is not exactly the project's info@ sends the owner's copy nowhere and records the failure", async () => {
  for (const value of ["someone@example.org", `${OWNER}, someone@example.org`]) {
    const mail = mailSender();
    const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: value };
    const log = console.error; console.error = () => {};
    let r;
    try { r = await engineFor().submitCore(submission(), env); } finally { console.error = log; }
    assert.equal(r.payload.delivery.owner.status, "failed", value);
    assert.match(r.payload.delivery.owner.error, /^owner_not_project_info/);
    assert.deepEqual(mail.sent.map((m) => m.to), [SUBMITTER], "nothing goes to an address that is not info@");
  }
});

// ---------- must fail: an autoreply without the standard signature or legal footer ----------

test("must fail: a form whose autoreply lacks the standard signature or legal footer block is refused when the engine is built", () => {
  for (const drop of [/^footer\.signature\./, /^footer\.legal\./, /^header\./]) {
    const s = specs();
    const tpl = s.manifest.templates.find((t) => t.template_id === "saasreport.contact.ack.v1");
    tpl.body_blocks = tpl.body_blocks.filter((id) => !drop.test(id));
    assert.throws(() => createCommsEngine({ config: sample, specs: s }), /saasreport\.contact\.ack\.v1 has no (signature|legal footer|header) block/, String(drop));
  }
  const s = specs(); delete s.manifest.owner.address;
  assert.throws(() => createCommsEngine({ config: sample, specs: s }), /manifest\.owner\.address/);
});

// ---------- must fail: send_email rejects the owner's address ----------

test("must fail: send_email refuses the owner's address → a failed ledger row, a failed dispatch row and an alert; the summary is not ok", async () => {
  const mail = mailSender([OWNER]);
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER };
  const events = [];
  const errors = []; const log = console.error; console.error = (...a) => errors.push(a.join(" "));
  let r;
  try { r = await engineFor({ onEvent: (t, d) => events.push([t, d]) }).submitCore(submission(), env); } finally { console.error = log; }
  assert.equal(r.payload.ok, false);
  assert.equal(r.payload.delivery.receipt.status, "sent");
  assert.equal(r.payload.delivery.owner.status, "failed");
  assert.match(r.payload.delivery.owner.error, /all_recipients_failed/);
  assert.ok(!r.payload.delivery.owner.error.includes("@"), "the error names no address");
  const disp = env.DB.raw.prepare("SELECT send_status FROM comms_dispatch WHERE idempotency_key = 'A-TEST23XXXXXXXXXX:owner'").get();
  assert.equal(disp.send_status, "failed");
  assert.deepEqual(events.map(([t]) => t).filter((t) => t.startsWith("comms.form.")), ["comms.form.owner_failed"]);
  assert.ok(errors.some((e) => /owner notification failed/.test(e) && /A-TEST23XXXXXXXXXX/.test(e)), "logged loudly, by reference");
  const s = await deliverySummary(env.DB, { now: new Date() });
  assert.equal(s.ok, false);
  assert.equal(s.owner_failed, 1);
  // the retry (a re-drive of the same reference) sends only what did not go: the owner, never a second receipt
  const fixed = { ...env, MAIL_SENDER: mailSender() };
  const retry = await engineFor().submitCore(submission(), fixed);
  assert.equal(retry.payload.ok, true);
  assert.deepEqual(fixed.MAIL_SENDER.sent.map((m) => m.to), [OWNER]);
});

test("must fail: an owner delivery that is suppressed (a bounce on the owner's inbox) is a failure, never a quiet skip", async () => {
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(OWNER)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  env.DB.raw.prepare("INSERT INTO comms_suppression (recipient_hash, reason, scope, actor_id, created_at) VALUES (?, 'hard-bounce', 'global', 't', '2026-10-13')").run(hash);
  const r = await engineFor().submitCore(submission(), env);
  assert.equal(r.payload.delivery.owner.status, "failed");
  assert.match(r.payload.delivery.owner.error, /^owner_suppressed/);
});

// ---------- must fail: a form that is not declared ----------

test("must fail: a form the config does not declare is refused (404 undeclared_form); nothing is sent or recorded", async () => {
  const mail = mailSender();
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER };
  const r = await engineFor().submitCore(submission({ form_id: "ghost" }), env);
  assert.equal(r.status, 404);
  assert.equal(r.payload.error, "undeclared_form");
  assert.equal(mail.sent.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM comms_form_deliveries").get().n, 0);
});

// ---------- must fail: a submission that never reaches the ledger (review of 7cd5873: the silent class this change removes) ----------

test("must fail: a site form the comms config does not declare is refused at build (kit comms check), before any visitor can post it", () => {
  assert.deepEqual(formCoverageProblems(["contact", "event-rsvp"], { ...sample, templates: [...sample.templates, { key: "event-rsvp" }] }), []);
  // the real scenario: events.rsvp on with the default rsvpForm "event-rsvp", which the sample config does not declare
  assert.match(formCoverageProblems(["event-rsvp"], sample).join("\n"), /form "event-rsvp" is posted by the site but not declared/);
  assert.match(formCoverageProblems(["contact"], { ...sample, forms: { ...sample.forms, declared: ["sandbox-key"] } }).join("\n"), /form "contact"/);
});

test("must fail: every submitForm failure the engine never recorded is written to the ledger by the client, with recorded:false only when that fails too", async () => {
  const site = "https://saasreport.ai";
  const cases = [
    ["comms_binding_missing", {}],
    ["comms_binding_error", { COMMS: { fetch: async () => { throw new Error("down"); } } }],
    ["comms_unreadable_502", { COMMS: { fetch: async () => new Response("<html>", { status: 502 }) } }],
    ["undeclared_form", { COMMS: { fetch: async () => Response.json({ ok: false, error: "undeclared_form" }, { status: 404 }) } }],
    ["invalid_submission:form_id", { COMMS: { fetch: async () => Response.json({ ok: false, error: "invalid_submission", field: "form_id" }, { status: 400 }) } }],
    ["ledger_not_recorded", { COMMS: { fetch: async () => Response.json({ ok: false, error: "ledger_not_recorded" }, { status: 503 }) } }],
  ];
  const log = console.error; console.error = () => {};
  try {
    for (const [error, bind] of cases) {
      const DB = ledger();
      const out = await submitForm({ DB, ...bind }, submission({ reference: "A-FAJL223XXXXXXXXX" }), { site });
      assert.deepEqual(out, { ok: false, recorded: true, receipt: "failed", owner: "failed", error }, error);
      const rec = await readDelivery(DB, "A-FAJL223XXXXXXXXX", site);
      assert.equal(rec.owner.status, "failed"); assert.equal(rec.owner.error, error); assert.equal(rec.form_id, "contact");
      const s = await deliverySummary(DB, { now: new Date() });
      assert.equal(s.ok, false, `${error}: the monitor goes red`); assert.equal(s.owner_failed, 1);
    }
    // no DB, or a DB that refuses the write: recorded is false, so the handler never answers ok
    const none = await submitForm({}, submission(), { site });
    assert.equal(none.recorded, false);
    const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); } }) }) };
    assert.equal((await submitForm({ DB: broken }, submission(), { site })).recorded, false);
    // the engine's own record is never overwritten by the client's failed row (ON CONFLICT DO NOTHING)
    const DB = ledger();
    const env = { DB, MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
    const engine = engineFor();
    const live = { DB, COMMS: { fetch: async (url, init) => engine.fetch(new Request(url, init), env) } };
    const ok = await submitForm(live, submission(), { site });
    assert.deepEqual([ok.ok, ok.recorded, ok.owner], [true, true, "sent"]);
    await submitForm({ DB, COMMS: { fetch: async () => new Response("x", { status: 500 }) } }, submission(), { site });
    assert.equal((await readDelivery(DB, "A-TEST23XXXXXXXXXX", site)).owner.status, "sent");
  } finally { console.error = log; }
});

test("a throw inside one delivery is that delivery's failure and never skips the other", async () => {
  const DB = ledger();
  // the receipt path throws (a D1 error on its dispatch row), the owner copy still goes
  let calls = 0;
  const flaky = { prepare: (sql) => { const st = DB.prepare(sql); if (/INSERT INTO comms_dispatch/.test(sql) && ++calls === 1) return { bind: () => ({ run: async () => { throw new Error("D1 hiccup"); }, first: async () => null, all: async () => ({ results: [] }) }) }; return st; } };
  const mail = mailSender();
  const log = console.error; console.error = () => {};
  let r;
  try { r = await engineFor().submitCore(submission(), { DB: flaky, MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER }); } finally { console.error = log; }
  assert.equal(r.payload.delivery.receipt.status, "failed");
  assert.equal(r.payload.delivery.owner.status, "sent");
  assert.deepEqual(mail.sent.map((m) => m.to), [OWNER]);
});

test("the drill flag: a signed header within five minutes verifies, anything else does not", async () => {
  const key = "k".repeat(32);
  const now = Date.parse("2026-10-13T12:00:00Z");
  const h = await signDrill(key, "contact", now);
  assert.match(h, /^[0-9]+\.[0-9a-f]{64}$/);
  assert.equal(await verifyDrill(key, "contact", h, now + 60_000), true);
  assert.equal(await verifyDrill(key, "event-rsvp", h, now), false, "signed for another form");
  assert.equal(await verifyDrill(key, "contact", h, now + 6 * 60_000), false, "expired");
  assert.equal(await verifyDrill("other", "contact", h, now), false, "another key");
  assert.equal(await verifyDrill(key, "contact", h.slice(0, -1) + (h.endsWith("0") ? "1" : "0"), now), false, "tampered");
  assert.equal(await verifyDrill(undefined, "contact", h, now), false, "no key: never a drill");
  assert.equal(await verifyDrill(key, "contact", "", now), false);
  assert.equal(DRILL_HEADER, "x-kit-form-drill");
});

test("a submission that cannot be recorded sends nothing (zero silent failure); a malformed one is refused", async () => {
  const mail = mailSender();
  const broken = { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => { throw new Error("D1 down"); }, all: async () => ({ results: [] }) }) }) };
  const log = console.error; console.error = () => {};
  try {
    const r = await engineFor().submitCore(submission(), { DB: broken, MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER });
    assert.equal(r.status, 503);
    assert.equal(r.payload.error, "ledger_not_recorded");
  } finally { console.error = log; }
  assert.equal(mail.sent.length, 0);
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER };
  const long = `a@${".".repeat(50_000)}`;
  for (const bad of [{ reference: "x" }, { submitter: { email: "nope" } }, { submitter: { email: "a@b@example.org" } }, { submitter: { email: "a b@example.org" } },
    { submitter: { email: "a@example" } }, { submitter: { email: "a@example.c" } }, { submitter: { email: "@example.org" } }, { submitter: { email: long } },
    { params: null }, { form_id: "Bad Id" }, { form_id: "-x" }, { extra: 1 }]) {
    const r = await engineFor().submitCore(submission(bad), env);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.payload.error, "invalid_submission");
  }
  assert.equal(mail.sent.length, 0);
  // the address check is one linear scan (submissions are attacker input; no regex reads them, the regex gate proves it): the
  // backtracking shape of the old pattern (a long local part, a domain of dots) is refused like any other malformed address
  const r = await engineFor().submitCore(submission({ submitter: { email: `${"a".repeat(240)}@${"a.".repeat(6)}` } }), env);
  assert.equal(r.payload.field, "submitter.email");
});

test("a test submission (a drill, or the owner's live proof) is marked TEST in both subjects and its receipt goes to the owner, never to the form's address", async () => {
  const mail = mailSender();
  const env = { DB: ledger(), MAIL_SENDER: mail, OPS_NOTIFY_TO: OWNER };
  const r = await engineFor().submitCore(submission({ test: true, submitter: { email: "anyone@example.net" } }), env);
  assert.equal(r.payload.ok, true);
  assert.deepEqual(mail.sent.map((m) => m.to), [OWNER, OWNER]);
  for (const m of mail.sent) assert.match(m.subject, /^\[TEST\] /);
  assert.equal((await readDelivery(env.DB, "A-TEST23XXXXXXXXXX", sample.site)).test, true);
});

test("a concurrent submit of the same reference never downgrades a delivery that went: in flight stays pending, sent stays sent", async () => {
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const engine = engineFor();
  // the other submit holds both dispatch keys (sending), then this one runs: it must not record failures
  env.DB.raw.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at) VALUES ('A-TEST23XXXXXXXXXX', 'contact', ?, 0, '2026-10-13T00:00:00Z')").run(sample.site);
  const hold = env.DB.raw.prepare("INSERT INTO comms_dispatch (dispatch_id, template_id, channel, category, to_hashes_json, requested_at, idempotency_key, send_status) VALUES (?, ?, 'email', 'transactional', '[]', '2026-10-13', ?, 'sending')");
  hold.run("d-r", "saasreport.contact.ack.v1", "A-TEST23XXXXXXXXXX"); hold.run("d-o", "saasreport.ops.lead-alert.v1", "A-TEST23XXXXXXXXXX:owner");
  const r = await engine.submitCore(submission(), env);
  assert.equal(r.payload.delivery.receipt.status, "pending");
  assert.equal(r.payload.delivery.owner.status, "pending");
  // the other submit finished and recorded both as sent; a late writer with stale failures cannot undo it
  env.DB.raw.prepare("UPDATE comms_form_deliveries SET receipt_status = 'sent', owner_status = 'sent' WHERE reference = 'A-TEST23XXXXXXXXXX'").run();
  env.DB.raw.prepare("UPDATE comms_dispatch SET send_status = 'sent'").run();
  const again = await engine.submitCore(submission(), env);
  assert.equal(again.payload.ok, true);
  assert.equal((await readDelivery(env.DB, "A-TEST23XXXXXXXXXX", sample.site)).owner.status, "sent");
  assert.equal(env.MAIL_SENDER.sent.length, 0);
});

// ---------- the summary the monitor reads ----------

test("the summary counts failed and stale owner deliveries over the window; old ones and fresh pending ones do not count", async () => {
  const db = ledger();
  const ins = db.raw.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, receipt_status, owner_status) VALUES (?, 'contact', 'https://x.example', 0, ?, ?, ?)");
  const now = new Date("2026-10-13T12:00:00Z");
  ins.run("R-OLD1", "2026-10-10T12:00:00Z", "sent", "failed");     // outside 24h
  ins.run("R-OK01", "2026-10-13T11:00:00Z", "sent", "sent");
  ins.run("R-PEN1", "2026-10-13T11:58:00Z", "sent", "pending");    // fresh
  ins.run("R-PEN2", "2026-10-13T11:00:00Z", "sent", "pending");    // stale
  ins.run("R-FAI1", "2026-10-13T10:00:00Z", "failed", "failed");
  const s = await deliverySummary(db, { now, windowHours: 24, pendingAfterMin: 15 });
  asSummary(s);
  assert.deepEqual({ ok: s.ok, submissions: s.submissions, owner_sent: s.owner_sent, owner_failed: s.owner_failed, owner_pending_stale: s.owner_pending_stale, receipt_failed: s.receipt_failed, last: s.last_owner_failure_at },
    { ok: false, submissions: 4, owner_sent: 1, owner_failed: 1, owner_pending_stale: 1, receipt_failed: 1, last: "2026-10-13T10:00:00Z" });
  const clean = ledger();
  assert.equal((await deliverySummary(clean, { now })).ok, true);
});

// ---------- the client a site's handler uses ----------

const SITE = "https://saasreport.ai";

test("submitForm: the one call a site's form handler makes; it posts the submission to the engine and reports both deliveries", async () => {
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const engine = engineFor();
  const calls = [];
  const site = { COMMS: { fetch: async (url, init) => { calls.push(String(url)); return engine.fetch(new Request(url, init), env); } } };
  const out = await submitForm(site, submission(), { site: SITE });
  assert.deepEqual(calls, ["https://comms/v1/comms/submit"]);
  assert.equal(out.ok, true);
  assert.equal(out.receipt, "sent");
  assert.equal(out.owner, "sent");
  // no binding, a refused or unreadable answer: reported as failed for both, never as sent
  assert.deepEqual(await submitForm({}, submission(), { site: SITE }), { ok: false, recorded: false, receipt: "failed", owner: "failed", error: "comms_binding_missing" });
  const down = { COMMS: { fetch: async () => new Response("<html>", { status: 502 }) } };
  const log = console.error; console.error = () => {};
  try { assert.equal((await submitForm(down, submission(), { site: SITE })).owner, "failed"); } finally { console.error = log; }
});

test("must fail: a legacy-shaped reference is refused loudly (reference_invalid), never dropped: nothing posted, nothing recorded", async () => {
  const posted = [];
  const env = { DB: ledger(), COMMS: { fetch: async (u, i) => { posted.push(i.body); return Response.json({ ok: true }); } } };
  const log = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
  try {
    for (const reference of ["R-ABCDEF", "R-K7M2QX", "c-ABCDEFGH23456789", "", undefined, 5]) {
      assert.deepEqual(await submitForm(env, submission({ reference }), { site: SITE }), { ok: false, recorded: false, receipt: "failed", owner: "failed", error: "reference_invalid" }, String(reference));
    }
  } finally { console.error = log; }
  assert.equal(logged.length, 6, "each refusal is logged");
  assert.deepEqual(posted, []);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM comms_form_deliveries").get().n, 0);
});

test("must fail: submitForm without a site is refused before anything is posted or recorded (the row needs its site)", async () => {
  const posted = [];
  const env = { DB: ledger(), COMMS: { fetch: async (u, i) => { posted.push(i.body); return Response.json({ ok: true }); } } };
  const log = console.error; console.error = () => {};
  try {
    for (const opts of [undefined, {}, { site: "" }, { site: "http://x.example" }, { site: 5 }]) {
      assert.deepEqual(await submitForm(env, submission(), opts), { ok: false, recorded: false, receipt: "failed", owner: "failed", error: "site_required" }, JSON.stringify(opts));
    }
  } finally { console.error = log; }
  assert.deepEqual(posted, [], "nothing was posted");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM comms_form_deliveries").get().n, 0, "nothing was recorded");
});

test("the engine's answers to POST /v1/comms/submit conform to kit.form-notification.v1 $defs.submitAnswer, recorded:false included; a secret name the kit does not know is refused", async () => {
  const answer = (x) => V.validate(x, { $ref: `${NOTE.$id}#/$defs/submitAnswer` });
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const engine = engineFor();
  const ok = await engine.submitCore(submission(), env);
  assert.deepEqual(formatProblems(answer(ok.payload)), []);
  assert.equal(ok.payload.outcome_recorded, undefined, "outcome_recorded appears only when false");
  const refused = await engine.submitCore(submission({ form_id: "ghost" }), env);
  assert.deepEqual(formatProblems(answer(refused.payload)), []);
  // the final write fails: the answer says outcome_recorded:false (the row exists, so the submission is recorded), and the schema allows exactly that
  const noWrite = { DB: { raw: env.DB.raw, prepare: (q) => (/^UPDATE comms_form_deliveries/.test(q) ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : env.DB.prepare(q)) }, MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const log = console.error; console.error = () => {};
  try {
    const late = await engine.submitCore(submission({ reference: "A-LATE2222XXXXXXXX" }), noWrite);
    assert.equal(late.payload.outcome_recorded, false); assert.equal(late.payload.recorded, undefined);
    assert.deepEqual(formatProblems(answer(late.payload)), []);
  } finally { console.error = log; }
  assert.notDeepEqual(formatProblems(answer({ ok: true, outcome_recorded: true })), [], "outcome_recorded: true is not an answer the engine gives");
  assert.match(checkConfig({ ...sample, forms: { ...sample.forms, owner: { ...sample.forms.owner, secret: "SOME_OTHER_NAME" } } }).join("\n"), /forms\.owner\.secret.*OPS_NOTIFY_TO/);
});

test("must fail: a submission in a declared language gets that language's autoreply, and no variant is reachable by plain dispatch", async () => {
  const sp = specs(sampleAr);
  const form = sp.manifest.forms[0];
  assert.deepEqual(Object.keys(form.ack_templates), ["en", "ar"]);
  assert.match(form.ack_templates.ar, /\.ack\.ar\.v1$/);
  for (const f of sp.manifest.forms) valid(f, { $ref: `${NOTE.$id}#/$defs/manifestForm` }, `manifest form ${f.form_id}`);
  const engine = createCommsEngine({ config: sampleAr, specs: sp });
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: sampleAr.forms.owner.address };
  const params = Object.fromEntries(sp.manifest.templates.find((t) => t.template_id === form.ack_templates.ar).required_params.map((k) => [k, "x"]));
  const used = async (reference, locale) => {
    const sub = { form_id: form.form_id, reference, submitter: { email: SUBMITTER }, params: { ...params, reference }, ...(locale ? { locale } : {}) };
    asSubmission(sub);
    const r = await engine.submitCore(sub, env);
    assert.equal(r.payload.ok, true, JSON.stringify(r.payload));
    return env.DB.raw.prepare("SELECT template_id FROM comms_dispatch WHERE idempotency_key = ?").get(reference).template_id;
  };
  assert.equal(await used("I-ARAB2222XXXXXXXX", "ar"), form.ack_templates.ar, "an ar submission gets the Arabic autoreply");
  assert.equal(await used("I-ARSA2222XXXXXXXX", "ar-SA"), form.ack_templates.ar, "a regional tag picks its language");
  assert.equal(await used("I-ENGL2222XXXXXXXX", "en-GB"), form.ack_templates.en);
  assert.equal(await used("I-NEXT2222XXXXXXXX"), form.ack_template_id, "no locale: the primary one");
  assert.equal(await used("I-GERM2222XXXXXXXX", "de"), form.ack_template_id, "an undeclared language: the primary one");
  const bad = await engine.submitCore({ form_id: form.form_id, reference: "I-BADL2222XXXXXXXX", submitter: { email: SUBMITTER }, params, locale: "not a locale" }, env);
  assert.deepEqual([bad.status, bad.payload.field], [400, "locale"]);
  // every variant is submit-only: the Arabic autoreply cannot be sent by a plain dispatch
  for (const id of [form.ack_templates.ar, form.ack_templates.en]) {
    const r = await engine.dispatchCore({ template_id: id, to: [SUBMITTER], params }, env);
    assert.deepEqual([r.status, r.payload.error], [409, "form_template_requires_submit"], id);
  }
});

test("must fail: a failed final status write after delivery is a recorded submission (outcome_recorded:false), never a reason to submit again; no row is the only 503", async () => {
  const noWrite = { DB: (() => { const d = ledger(); return { raw: d.raw, prepare: (q) => (/^UPDATE comms_form_deliveries/.test(q) ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : d.prepare(q)) }; })(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  const engine = engineFor();
  const live = { DB: noWrite.DB, COMMS: { fetch: async (url, init) => engine.fetch(new Request(url, init), noWrite) } };
  const log = console.error; console.error = () => {};
  try {
    const out = await submitForm(live, submission(), { site: SITE });
    assert.deepEqual([out.ok, out.recorded, out.outcome_recorded, out.receipt, out.owner], [true, true, false, "sent", "sent"]);
    assert.equal(noWrite.MAIL_SENDER.sent.length, 2, "both emails went once");
    assert.equal(noWrite.DB.raw.prepare("SELECT COUNT(*) AS n FROM comms_form_deliveries").get().n, 1, "one row, no duplicate");
    const none = await submitForm({ COMMS: { fetch: async () => new Response("x", { status: 500 }) } }, submission(), { site: SITE });
    assert.equal(none.recorded, false, "no ledger row anywhere: the only unrecorded case");
  } finally { console.error = log; }
});

test("engine runtime and manifest agree: the owner secret name reaches the engine from the config, not from the site", () => {
  assert.equal(engineRuntime(sample).ownerSecret, "OPS_NOTIFY_TO");
});

test("a locale is read by a linear scan with the schema's shape: 2-3 letters then 1-8 character subtags", async () => {
  const engine = engineFor();
  const env = { DB: ledger(), MAIL_SENDER: mailSender(), OPS_NOTIFY_TO: OWNER };
  for (const [locale, ok] of [["en", true], ["ar-SA", true], ["zh-Hant-TW", true], ["e", false], ["english", false], ["en-", false], ["en--GB", false], ["en-toolongsub", false], ["en_GB", false], ["x".repeat(40), false], [5, false]]) {
    const r = await engine.submitCore(submission({ locale }), { ...env, DB: ledger() });
    assert.equal(r.status === 400 && r.payload.field === "locale", !ok, String(locale));
  }
});
