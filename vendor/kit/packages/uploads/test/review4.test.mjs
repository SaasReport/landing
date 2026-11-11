// The fourth review of the upload engine (kit #112 at 8e225d9: H1-H4, M1-M6, L1-L6), each finding reproduced as a test that fails on that commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, d1Records, AuthError, NotEligibleError, MIGRATION_FILES, validateRecord, SYSTEM } from "../src/index.js";
import { parseXml } from "../src/xml.js";
import { triageSvg } from "../src/triage/svg.js";
import { cssExternal } from "../src/css.js";
import { resolveLimits } from "../src/limits.js";
import { SWEEP_STAGES, SPEC } from "../src/lifecycle.js";
import { lifecycleMermaid, VIEWS } from "../src/lifecycle-diagram.js";
import { quarantineKey } from "../src/keys.js";
import { pdf } from "./fixtures.mjs";
import { world, PDF } from "./helpers/world.mjs";
import { people } from "./helpers/people.mjs";
import { sqliteD1 } from "./helpers/sqlite-d1.mjs";
import { keys } from "../../core/test/fixtures/ledger.mjs";

const L = resolveLimits();
const enc = (s) => new TextEncoder().encode(s);

/* ---------- H1: a decision is one ledger entry, used once; no second spelling of it exists ---------- */

test("H1: a re-spelled signature (same 64 bytes, other base64) is never a second entry, and one entry is used once (a cursor, not a list)", async () => {
  const w = world();
  const a = (await w.intake(1)).record;
  const ref = await w.P.sign(a, "hold_on", "legal");
  const held = await w.uploads.hold(a.upload_id, true, { decision: ref });
  assert.equal(held.last_ref_seq, ref.seq, "the cursor");
  await assert.rejects(w.uploads.hold(a.upload_id, true, { decision: ref }), (x) => x instanceof AuthError && x.reason === "replayed", "the same entry again: not above the cursor");
  // the same entry written again with the signature's last base64 character changed: same bytes, a different spelling
  const { entryHash } = await import("@saasreport/core/ledger");
  const e = w.P.ledger.entries.at(-1);
  const respelled = { ...e, seq: e.seq + 1, prev: entryHash(e), sig: e.sig.slice(0, -2) + (e.sig.at(-2) === "A" ? "B" : "A") + "=" };
  w.P.ledger.entries.push(respelled);
  const ref2 = { ledger: ref.ledger, seq: respelled.seq, entry_hash: entryHash(respelled) };
  await assert.rejects(w.uploads.hold(a.upload_id, false, { decision: ref2 }), (x) => x instanceof AuthError && x.reason === "ledger_invalid", "it is not in the verified part of the ledger");
  assert.ok(w.P.tampered.length > 0, "and the tampering is reported (onTamper)");
  await assert.rejects(w.P.sign(a, "hold_off", "x"), (x) => x.reason === "append_refused", "the append path refuses to extend a ledger that does not verify");
});

test("H1: re-spelling the signature of an UNUSED entry in place (same bytes, other base64) is refused by the ledger, not accepted as the same entry", async () => {
  const w = world();
  const a = (await w.intake(1)).record;
  const ref = await w.P.sign(a, "hold_on", "x");
  const { entryHash } = await import("@saasreport/core/ledger");
  const e = w.P.ledger.entries.at(-1);
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const i = e.sig.length - 3, c = e.sig[i];
  const twin = e.sig.slice(0, i) + alpha[alpha.indexOf(c) ^ 1] + e.sig.slice(i + 1);
  assert.deepEqual(Buffer.from(twin, "base64"), Buffer.from(e.sig, "base64"), "the twin decodes to the same 64 bytes");
  e.sig = twin;
  await assert.rejects(w.uploads.hold(a.upload_id, true, { decision: { ...ref, entry_hash: entryHash(e) } }), (x) => x.reason === "ledger_invalid");
});

/* ---------- H2: retention and withdrawal never delete what a person holds ---------- */

test("H2: a hold that lands after the sweep listed the page is honoured (eligibility is a guard on the delete itself)", async () => {
  const w = world({ verdict: "allow" });
  const a = (await w.intake(1)).record;
  w.tick(40 * 86_400_000);
  const real = w.records.listExpired.bind(w.records);
  w.records.listExpired = async (...args) => { const page = await real(...args); if (page.length) await w.uploads.hold(a.upload_id, true, await w.decide(a.upload_id, "hold_on", "legal")); return page; };   // the hold is placed after the page was read
  const out = await w.uploads.sweep();
  assert.equal(out.deleted, 0);
  assert.deepEqual(out.failures, []);
  const rec = await w.records.get(a.upload_id);
  assert.deepEqual([rec.stage, rec.retention.hold], ["released", true]);
  assert.equal(w.q.objects.has(rec.storage.key), true, "the bytes of a held upload are still there");
});

test("H2: a hold that lands between the sweep's read and its write loses nothing: the compare-and-set refuses the delete", async () => {
  const w = world({ verdict: "allow" });
  const a = (await w.intake(1)).record;
  w.tick(40 * 86_400_000);
  const real = w.records.put.bind(w.records);
  let once = true;
  w.records.put = async (r) => { if (once && r.op?.action === "delete") { once = false; const cur = await w.records.get(a.upload_id); await real({ ...cur, retention: { ...cur.retention, hold: true } }); } return real(r); };   // a hold lands exactly before the delete's intent is written
  const out = await w.uploads.sweep();
  assert.equal(out.deleted, 0);
  assert.equal((await w.records.get(a.upload_id)).retention.hold, true);
  assert.equal(w.q.objects.size, 1);
});

test("H2: withdraw needs the capability intake returned for that upload, once, and never touches a hold", async () => {
  const w = world({ verdict: "allow" });
  const { record, withdrawToken } = await w.intake(1);
  const other = await w.intake(2);
  await assert.rejects(w.uploads.withdraw(record.upload_id), (x) => x instanceof AuthError && x.reason === "no_capability", "no token, no withdrawal (the id alone is not a capability)");
  await assert.rejects(w.uploads.withdraw(record.upload_id, other.withdrawToken), (x) => x.reason === "no_capability", "another upload's token");
  assert.equal((await w.records.get(record.upload_id)).stage, "released");
  assert.equal((await w.uploads.withdraw(record.upload_id, withdrawToken)).stage, "deleted");
  await assert.rejects(w.uploads.withdraw(record.upload_id, withdrawToken), (x) => x.reason === "no_capability", "single use");
  // a held upload: a hold is a write, so the token (bound to the record's stage and version) no longer applies
  const h = await w.intake(3);
  await w.uploads.hold(h.record.upload_id, true, await w.decide(h.record.upload_id, "hold_on", "legal"));
  await assert.rejects(w.uploads.withdraw(h.record.upload_id, h.withdrawToken), (x) => x.reason === "no_capability");
  assert.equal((await w.records.get(h.record.upload_id)).stage, "released");
  assert.equal(w.q.objects.has(h.record.storage.key), true);
});

test("L-1: the hold check is made inside the delete, on the record its compare-and-set carries (a hold that lands after withdraw's own read)", async () => {
  const w = world({ verdict: "allow" });
  const { record, withdrawToken } = await w.intake(1);
  const realGet = w.records.get.bind(w.records);
  let reads = 0;
  w.records.get = async (id) => { const r = await realGet(id); if (id === record.upload_id && ++reads === 1) { const cur = await realGet(id); await w.records.put({ ...cur, retention: { ...cur.retention, hold: true } }); w.records.get = realGet; return r; } return r; };   // the hold lands right after withdraw's first read
  await assert.rejects(w.uploads.withdraw(record.upload_id, withdrawToken), (x) => x instanceof AuthError && x.reason === "on_hold");
  const rec = await realGet(record.upload_id);
  assert.deepEqual([rec.stage, rec.retention.hold], ["released", true]);
  assert.equal(w.q.objects.has(rec.storage.key), true, "the held bytes are untouched");
});

/* ---------- H3: a database that ran migration 0001 (main) gets a NEW migration; its rows are readable, deletable, sweepable ---------- */

test("H3: migration 0002 on a database that ran main's 0001: a row with no version in its JSON is read at version 1, deleted, swept and re-keyed", async () => {
  const db = sqliteD1();
  const files = (n) => readFileSync(new URL(`../migrations/${n}`, import.meta.url), "utf8");
  const names = Object.keys(MIGRATION_FILES).sort();
  assert.deepEqual(names, ["0001_upload_records.sql", "0002_upload_records_version.sql"]);
  db.exec(files(names[0]));
  // rows exactly as main wrote them: 0001 columns, record_json without a version
  const m = world({ verdict: "allow" });
  const a = (await m.intake(1)).record, b = (await m.intake(2)).record, c = (await m.intake(3)).record;
  m.tick(40 * 86_400_000);
  const insert = (r) => { const { version, ...rest } = r; db.db.prepare("INSERT INTO upload_records (upload_id, project, form, sha256, stage, verdict, bucket, key, released_bucket, released_key, retain_until, hold, received_at, record_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(rest.upload_id, rest.project, rest.form, rest.sha256, rest.stage, rest.verdict, rest.storage.bucket, rest.storage.key, rest.storage.released_bucket ?? null, rest.storage.released_key ?? null, rest.retention.retain_until, 0, rest.received_at, JSON.stringify(rest)); };
  // c is a legacy row: content-addressed keys
  const lq = `q/partner/${c.sha256}`, lr = `r/partner/${c.sha256}`;
  const cbytes = new Uint8Array(await (await m.q.get(c.storage.key)).arrayBuffer());
  await m.q.put(lq, cbytes); await m.q.delete(c.storage.key); await m.r.put(lr, cbytes); await m.r.delete(c.storage.released_key);
  for (const r of [a, b]) insert(r);
  insert({ ...c, storage: { ...c.storage, key: lq, released_key: lr } });
  db.exec(files(names[1]));
  const sink = d1Records(db);
  const got = await sink.get(a.upload_id);
  assert.equal(got.version, 1, "the version is the column's (default 1), not a missing JSON field");
  const P = people(m.now);
  const w = world({ records: sink, env: m.env, P });
  w.tick(40 * 86_400_000);
  assert.equal((await w.uploads.delete(a.upload_id, await w.decide(a.upload_id, "delete", "erasure"))).stage, "deleted");
  const migrated = await w.uploads.migrateLegacyKeys();
  assert.deepEqual(migrated.failed, [], "no re-keying failed");
  assert.equal(migrated.migrated, 1, "the one legacy row was re-keyed");
  assert.equal((await sink.get(c.upload_id)).storage.key, quarantineKey("partner", c.sha256, c.upload_id), "the legacy row is re-keyed");
  const out = await w.uploads.sweep();
  assert.deepEqual(out.failures, []);
  assert.deepEqual([(await sink.get(b.upload_id)).stage, (await sink.get(c.upload_id)).stage], ["deleted", "deleted"], "pre-0002 rows are swept");
  assert.equal(m.q.objects.size + m.r.objects.size, 0, "nothing is left behind");
  assert.equal((await w.uploads.reconcile()).ok, true);
});

test("H3: migration 0001 is main's, byte for byte (an applied migration is never edited)", async () => {
  const { createHash } = await import("node:crypto");
  const f = readFileSync(new URL("../migrations/0001_upload_records.sql", import.meta.url));
  // sha256 of packages/uploads/migrations/0001_upload_records.sql as it is on main: a change here is a new numbered file, never an edit
  assert.equal(createHash("sha256").update(f).digest("hex"), "7fcfcc3e303507246f855e25c0d341027ae8078ac5ed1fd5fa0aa5bd10015afa");
});

/* ---------- H4: one authority: the approval ledger ---------- */

test("H4: the engine has no crypto and no roster of its own: no decision/roster schema, no signing code in packages/uploads/src", () => {
  const src = ["authority.js", "principal.js", "pipeline.js", "index.js"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
  assert.ok(!/crypto\.subtle|Ed25519|importKey|canonicalDecision|signDecision|loadRoster/.test(src), "verification is the ledger's (core)");
  for (const gone of ["upload-decision", "upload-roster"]) assert.ok(!JSON.parse(readFileSync(new URL("../../core/schemas/index.json", import.meta.url), "utf8")).schemas.some((s) => s.name === gone), gone);
});

/* ---------- M1: no hold while an operation is in flight ---------- */

test("M1: a hold during an in-flight delete is refused, not reported as success and then overtaken", async () => {
  const w = world({ verdict: "allow" });
  const a = (await w.intake(1)).record;
  let release; const gate = new Promise((r) => { release = r; });
  const realDelete = w.q.delete.bind(w.q);
  w.q.delete = async (k) => { await gate; return realDelete(k); };
  const deleting = w.uploads.delete(a.upload_id, await w.decide(a.upload_id, "delete", "erasure"));
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(w.uploads.hold(a.upload_id, true, await w.decide(a.upload_id, "hold_on", "legal")), /in flight/);
  release(); await deleting;
  const rec = await w.records.get(a.upload_id);
  assert.deepEqual([rec.stage, rec.retention.hold], ["deleted", false], "the record never claimed a hold that the delete then overtook");
});

/* ---------- M3: erasing a legacy record erases its legacy bytes ---------- */

test("M3: delete of a legacy record removes the legacy object when no live record uses it, and keeps it while one does", async () => {
  const w = world({ verdict: "allow" });
  const a = (await w.intake(1)).record, b = (await w.intake(1)).record;   // the same bytes, two uploads
  const lq = `q/partner/${a.sha256}`, lr = `r/partner/${a.sha256}`;
  for (const rec of [a, b]) {
    const cur = await w.records.get(rec.upload_id);
    const bytes = new Uint8Array(await (await w.q.get(cur.storage.key)).arrayBuffer());
    await w.q.put(lq, bytes).catch(() => {}); await w.r.put(lr, bytes).catch(() => {});   // a refused late write is the expected outcome here; the listing below proves it
    await w.q.delete(cur.storage.key); await w.r.delete(cur.storage.released_key);
    await w.records.put({ ...cur, storage: { ...cur.storage, key: lq, released_key: lr } });
  }
  await w.uploads.delete(a.upload_id, await w.decide(a.upload_id, "delete", "erasure"));
  assert.equal(w.q.objects.size + w.r.objects.size, 2, "b still uses the shared legacy pair: it is kept");
  await w.uploads.delete(b.upload_id, await w.decide(b.upload_id, "delete", "erasure"));
  assert.equal(w.q.objects.size + w.r.objects.size, 0, "the last user erased: no bytes anywhere");
});

/* ---------- M4: where a comment ends is read the way a browser reads it, and a file read two ways is never allowed ---------- */

test("M4: <!-->, <!--->, --!> end a comment as an HTML parser ends it: the markup after is read, and the file is not allowed", async () => {
  for (const [label, s, marker] of [
    ["<!-->", `<svg xmlns="http://www.w3.org/2000/svg"><!--><script>alert(1)</script>--></svg>`, "script_element"],
    ["<!---->'s cousin <!--->", `<svg xmlns="http://www.w3.org/2000/svg"><!---><img src=x onerror=alert(1)>--></svg>`, "event_handler"],
    ["--!>", `<svg xmlns="http://www.w3.org/2000/svg"><!-- --!><script>alert(1)</script>--></svg>`, "script_element"],
  ]) {
    const r = await triageSvg(enc(s), L);
    assert.equal(r.verdict, "block", label);
    assert.ok(r.markers.some((m) => m.name === marker), `${label}: ${JSON.stringify(r.markers.map((m) => m.name))}`);
    assert.ok(r.markers.some((m) => m.name === "malformed_markup"), `${label}: the differential itself is reported`);
  }
  const plain = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><!-- a note --><rect/></svg>`), L);
  assert.equal(plain.verdict, "allow_with_limits");
  assert.equal(plain.markers.length, 0, "an ordinary comment is not a finding (the absent twin)");
});

/* ---------- M5: one URL classifier ---------- */

test("M5: presentation attributes and escaped CSS go through the same classifier as href", async () => {
  for (const a of ['fill="url(http://evil.example/x#a)"', 'filter="url(https://evil.example/f.svg#f)"', 'mask="url(//evil.example/m.svg#m)"', 'clip-path="url(ftp://evil.example/c)"', 'cursor="url(http://evil.example/c.cur), auto"']) {
    const r = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect ${a}/></svg>`), L);
    assert.ok(r.markers.some((m) => m.name === "external_reference"), a);
  }
  for (const s of ['a{background:url("ht\\9 tp://evil/x")}', 'a{background:url("h\\a ttps://evil/x")}', "a{background:url(ftp://evil/x)}", "a{background:url(evil.png)}", 'a{background:url("data:image/svg+xml;base64,PHN2Zz4=")}']) assert.equal(cssExternal(s), true, s);
  const viaEntity = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url('ht&#9;tp://evil.example/x#a')"/></svg>`), L);
  assert.ok(viaEntity.markers.some((m) => m.name === "external_reference"));
  for (const ok of ['fill="url(#grad)"', 'filter="url(#f)"', 'fill="red"']) {
    const r = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect ${ok}/></svg>`), L);
    assert.equal(r.markers.length, 0, `${ok} is local: the absent twin`);
  }
  assert.equal(cssExternal('a{background:url("data:image/png;base64,AAAA")}'), false);
});

/* ---------- M6: the record carries a reference, not a signature, and a tombstone no note ---------- */

test("M6: a person's decision is stored as { ledger, seq, entry_hash }; the note stays in the ledger; a tombstone has no note and no signature", async () => {
  const w = world();
  const a = (await w.intake(1)).record;
  // the probe strings must be impossible in a hash: "4711" alone appeared inside a hex entry_hash once in a thousand runs (CI, 2026-10-14)
  const note = "Maria Example passport page, legal hold ticket LH-4711";
  await w.uploads.hold(a.upload_id, true, await w.decide(a.upload_id, "hold_on", note));
  await w.uploads.hold(a.upload_id, false, await w.decide(a.upload_id, "hold_off", "released from hold"));
  await w.uploads.delete(a.upload_id, await w.decide(a.upload_id, "delete", note));
  const rec = await w.records.get(a.upload_id);
  assert.equal(rec.stage, "deleted");
  const text = JSON.stringify(rec);
  assert.ok(!text.includes("Maria") && !text.includes("LH-4711"), "no free text of a decision in a tombstone");
  for (const d of rec.decisions) if (d.by.startsWith("human:")) assert.deepEqual(Object.keys(d.ref).sort(), ["entry_hash", "ledger", "seq"]);
  assert.ok(!/"signature"|"sig"/.test(text));
  assert.deepEqual(validateRecord(rec), []);
});

/* ---------- L2 / L3: linearity is a work counter, and the budget is real ---------- */

test("L2: the tokenizer's work grows linearly with the input on every attack shape (a counter, not a clock)", () => {
  const shapes = { comments: (k) => "<!--".repeat(k), tags: (k) => "<a ".repeat(k), pis: (k) => "<?x ".repeat(k), cdata: (k) => "<![CDATA[".repeat(k), attrs: (k) => `<a ${'b="1" '.repeat(k)}/>`, nest: (k) => "<a>".repeat(k), ns: (k) => "<a xmlns:p='u'>".repeat(k), bang: (k) => "<!-- --!>".repeat(k), ents: (k) => "&amp;".repeat(k), quotes: (k) => '<a b="'.repeat(k), closers: (k) => "<a>".repeat(k) + "</a>".repeat(k) };
  for (const [name, make] of Object.entries(shapes)) {
    const small = make(4000), big = make(16000);
    const a = parseXml(small), b = parseXml(big);
    assert.ok(b.work <= 4.5 * a.work, `${name}: work ${a.work} → ${b.work} for 4x the input`);
    assert.ok(b.work <= 8 * big.length + 100_000, `${name}: under the budget`);
  }
});

test("L3: the work budget is real: a parse that exceeds it stops, says so, and the file is never allowed", async () => {
  const r = parseXml("<!--".repeat(60_000), { budgetFactor: 0 });
  assert.ok(r.problems.some((p) => /budget exhausted/.test(p)), JSON.stringify(r.problems));
  assert.ok(r.work <= 100_000 + 2 * 240_000, "it stopped, it did not run on");
});

/* ---------- L4: the gate's data file is schema-validated ---------- */

test("L4: the reviewed linear-regex list is a data file validated against its schema", async () => {
  const { validate } = await import("@saasreport/core/schema");
  const data = JSON.parse(readFileSync(new URL("./regex-linear.json", import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/regex-linear.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validate(data, schema), []);
  assert.notDeepEqual(validate({ ...data, entries: [{ file: "packages/x.js", pattern: "a+", why: "short" }] }, schema), [], "an entry without a real reason is refused");
});

/* ---------- L5: one source ---------- */

test("L5: the lifecycle diagram is generated from lifecycle.json, the sweepable stages are defined once, and no actor id is hard-coded", () => {
  const doc = readFileSync(new URL("../../../docs/UPLOADS.md", import.meta.url), "utf8");
  for (const [view, file] of [["review", "upload-lifecycle.mmd"], ["intake", "upload-lifecycle-intake.mmd"], ["disposal", "upload-lifecycle-disposal.mmd"]]) {
    // the renderer adds the theme's classDef lines (the diagram only names `class <id> accent`): compared without them
    const noDefs = (t) => t.replace(/\n\s*classDef [^\n]*/g, "");
    const mmd = noDefs(readFileSync(new URL(`../../../docs/diagrams/${file}`, import.meta.url), "utf8"));
    assert.ok(mmd.endsWith(`${lifecycleMermaid(view)}\n`), `docs/diagrams/${file} is generated (node packages/uploads/scripts/lifecycle-diagram.mjs)`);
    assert.ok(noDefs(doc).includes(lifecycleMermaid(view)), `the ${view} block in docs/UPLOADS.md is the same output`);
    assert.ok(!/rescan \(human|human rescan/.test(mmd), "no rescan by a person");
  }
  // the two views are the whole table: every (from, to, via) of lifecycle.json is in exactly one, and same-stage operations are drawn
  const drawn = new Set(VIEWS.flatMap((v) => lifecycleMermaid(v).split("\n").slice(2)).join("\n").split(/[^a-z]+/));
  for (const via of Object.keys(SPEC.operations)) assert.ok(drawn.has(via), `${via} is on a lifecycle diagram`);
  assert.ok(lifecycleMermaid("review").includes("released --> released: rescan, hold, migrate: same stage"));
  assert.deepEqual([...SWEEP_STAGES], Object.keys(SPEC.states).filter((s) => SPEC.states[s].sweepable));
  const src = ["pipeline.js", "reconcile.js", "records.js", "lifecycle.js"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
  assert.equal([...src.matchAll(/"system:[a-z]+"/g)].length, 0, "system principal ids come from principal.js only");
  assert.ok(!/'quarantined', 'held'|"quarantined", "held", "released"/.test(readFileSync(new URL("../src/records.js", import.meta.url), "utf8")), "records.js reads SWEEP_STAGES, not its own list");
  assert.ok(SYSTEM.reconciler.id.startsWith("system:"));
  assert.ok(doc.includes("q/<upload id>/<form>/<sha256>") && !doc.includes("q/<form>/<sha256>/<upload id>"), "the documented key layout is the real one");
});

/* ---------- L6: a fencing token on every object ---------- */

test("L6: every object carries the fence of the operation that wrote it, and a settle never deletes another operation's object", async () => {
  const w = world({ verdict: "allow" });
  const a = (await w.intake(1)).record;
  const q = await w.q.head(a.storage.key), r = await w.r.head(a.storage.released_key);
  assert.match(q.customMetadata.fence, /^intake-[0-9a-f]{16}$/);
  assert.equal(r.customMetadata.fence, q.customMetadata.fence);
  // an interrupted release (fence F1) whose released object was since written by another operation (fence F2): the rollback leaves it alone
  const h = world({ verdict: "needs_sandbox" });
  const b = (await h.intake(2)).record;
  const cur = await h.records.get(b.upload_id);
  const intent = await h.records.put({ ...cur, op: { action: "release", from: "held", to: "released", actor: "human", started_at: "2026-10-07T11:00:00.000Z", fence: "release-aaaaaaaaaaaaaaaa" } });
  const rk = (await import("../src/keys.js")).releasedKey("partner", b.sha256, b.upload_id);
  await h.r.put(rk, new Uint8Array(await (await h.q.get(cur.storage.key)).arrayBuffer()), { customMetadata: { fence: "release-bbbbbbbbbbbbbbbb" } });
  await h.uploads.settle(intent.upload_id);
  assert.equal(h.r.objects.has(rk), true, "an object with another operation's fence is not this settle's to delete");
  const proof = await h.uploads.reconcile();   // and it is not hidden: the reconciler sees the object the settle left and reports it
  assert.deepEqual(proof.violations.map((v) => [v.code, v.key]), [["object_unexpected", rk]]);
  assert.ok(!(await h.records.get(b.upload_id)).op, "the intent is settled");
});
