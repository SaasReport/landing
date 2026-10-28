// The reference, the drill header and the lookup limit of the form-delivery ledger (docs/FORMS.md, kit.form-notification.v1).
// Review of 74113248: a 30-bit reference with an unlimited lookup, a drill header that proved only the clock and could be replayed,
// and an owner-secret name that three files each wrote on their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createValidator, formatProblems } from "../src/schema.js";
import { withD1Limits } from "../src/d1-limits.js";
import { newReference, REFERENCE_RE, REFERENCE_BITS, OWNER_SECRET_NAMES, signDrill, verifyDrill, acceptDrill, lookupAllowed, LOOKUP_LIMIT } from "../src/form-deliveries.js";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const NOTE = read("../schemas/form-notification.schema.json");
const LEDGER = readFileSync(new URL("../../comms/migrations/0003_comms_form_deliveries.sql", import.meta.url), "utf8");
const d1 = () => {
  const sql = withD1Limits(new DatabaseSync(":memory:")); sql.exec(LEDGER);
  const stmt = (q) => { let a = []; const o = { bind: (...x) => { a = x; return o; }, run: async () => { const r = sql.prepare(q).run(...a); return { meta: { changes: Number(r.changes) } }; }, first: async () => sql.prepare(q).get(...a) ?? null }; return o; };
  return { prepare: stmt };
};

test("a reference carries at least 64 bits (80), the schema pattern is the generator's, and the generator never repeats", () => {
  assert.ok(REFERENCE_BITS >= 64, `${REFERENCE_BITS} bits`);
  assert.equal(NOTE.$defs.reference.pattern, REFERENCE_RE.source, "the schema and the code have one pattern");
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const r = newReference("R"); assert.match(r, REFERENCE_RE); seen.add(r); }
  assert.equal(seen.size, 2000);
  assert.throws(() => newReference("r-"), /prefix/);
  for (const short of ["R-ABCDEF", "R-ABCDEFGH23456", "R-ABCDEFGH2345678O", "r-ABCDEFGH23456789", "ABCDEFGH23456789"]) assert.ok(!REFERENCE_RE.test(short), `${short} is not a reference`);
  // the schema refuses what the pattern refuses (a 6-character reference was 30 bits)
  const V = createValidator([NOTE]);
  assert.notDeepEqual(formatProblems(V.validate("R-ABCDEF", { $ref: `${NOTE.$id}#/$defs/reference` })), []);
  assert.deepEqual(formatProblems(V.validate(newReference("C"), { $ref: `${NOTE.$id}#/$defs/reference` })), []);
});

test("the owner secret has one name: the code, the schema enum and the canon set agree", () => {
  assert.deepEqual([...OWNER_SECRET_NAMES], read("../schemas/forms-config.schema.json").properties.owner.properties.secret.enum);
  assert.deepEqual([...OWNER_SECRET_NAMES], read("../registry/finding-classes.json").sets["owner-secret-names"]);
});

test("must fail: a drill header is bound to its form and is accepted once (a replay inside the window is refused)", async () => {
  const now = Date.parse("2026-10-13T09:00:00Z"), key = "k-for-the-test";
  const h = await signDrill(key, "event-rsvp", now);
  assert.equal(await verifyDrill(key, "event-rsvp", h, now), true);
  assert.equal(await verifyDrill(key, "contact", h, now), false, "signed for another form");
  assert.equal(await verifyDrill("other", "event-rsvp", h, now), false);
  assert.equal(await verifyDrill(key, "event-rsvp", h, now + 6 * 60_000), false, "outside the window");
  const db = d1();
  assert.equal(await acceptDrill(db, key, "event-rsvp", h, now), true);
  assert.equal(await acceptDrill(db, key, "event-rsvp", h, now + 1000), false, "the same header twice");
  assert.equal(await acceptDrill(db, key, "event-rsvp", await signDrill(key, "event-rsvp", now + 5), now + 5), true, "a fresh one is accepted");
  assert.equal(await acceptDrill(null, key, "event-rsvp", h, now), false, "no ledger accepts nothing");
  assert.equal(await acceptDrill({ prepare: () => { throw new Error("D1 down"); } }, key, "event-rsvp", await signDrill(key, "event-rsvp", now + 9), now + 9), false, "a ledger that cannot be written accepts nothing");
});

test("must fail: the lookup of references is limited per client, and the window slides", async () => {
  const db = d1(), t0 = Date.parse("2026-10-13T09:00:00Z");
  for (let i = 0; i < LOOKUP_LIMIT.max; i++) assert.equal(await lookupAllowed(db, "ip-a", new Date(t0 + i)), true);
  assert.equal(await lookupAllowed(db, "ip-a", new Date(t0 + 1000)), false, "one past the limit");
  const burst = await Promise.all(Array.from({ length: LOOKUP_LIMIT.max + 20 }, () => lookupAllowed(db, "ip-c", new Date(t0))));
  assert.equal(burst.filter(Boolean).length, LOOKUP_LIMIT.max, "a burst passes exactly the limit: count and insert are one statement");
  assert.equal(await lookupAllowed(db, "ip-b", new Date(t0 + 1000)), true, "another client is not affected");
  assert.equal(await lookupAllowed(db, "ip-a", new Date(t0 + (LOOKUP_LIMIT.windowMinutes + 1) * 60_000)), true, "after the window");
});
