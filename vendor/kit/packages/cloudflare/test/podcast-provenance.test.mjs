// The t=0 rule for podcasts (owner, 2026-10-06: "hand adding not permitted is postfacto, everything must be t=0"):
// an episode exists only because the scheduled run made it, and it carries the record that proves it.
import { migrationOrder } from "@saasreport/core/migration-order";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProvenance, provenanceProblem } from "@saasreport/core/podcast-provenance";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { provenanceMigrationSql, provenanceTriggersSql } from "@saasreport/core/podcast-provenance-sql";
import { makeKit, seed, PROV } from "./helpers.mjs";

const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };
const POLICY = { manual: false, provenance: { origins: ["cron", "cron-retry", "legacy"], legacyBefore: "2026-10-01" } };
const run = (k, iso) => k.kit.scheduled({ scheduledTime: Date.parse(`${iso}T02:00:00Z`), cron: "0 2 * * *" }, k.env, { waitUntil() {} });
const rows = async (env, sql = "SELECT slug, status, provenance_json FROM podcast_episodes ORDER BY slug") => (await env.DB.prepare(sql).all()).results;

test("every episode the cron queues carries a valid provenance record (origin cron, hashes, the cron's scheduled time)", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  const r = await run(k, "2026-10-05");
  assert.ok(r.episodes.length >= 1, JSON.stringify(r));
  const eps = await rows(k.env);
  assert.equal(eps.length, r.episodes.length);
  for (const e of eps) {
    const rec = JSON.parse(e.provenance_json);
    assert.deepEqual(checkProvenance(rec), [], e.slug);
    assert.equal(rec.origin, "cron");
    assert.equal(rec.trigger, "scheduled");
    assert.equal(rec.scheduled_at, "2026-10-05T02:00:00.000Z");
    assert.match(rec.spec_sha256, /^[0-9a-f]{64}$/);
    assert.match(rec.config_sha256, /^[0-9a-f]{64}$/);
    assert.equal(provenanceProblem(e, POLICY.provenance), null);
  }
});

test("the database refuses an episode without a provenance record, and a record cannot be removed", async () => {
  const { env } = makeKit("en");
  const insert = (prov) => env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, created_at, updated_at, provenance_json)
    VALUES ('hand-made', 'daily', 'daily', 'term', 'By hand', 'term', 'published', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', ?)`).bind(prov).run();
  await assert.rejects(insert(null), /without a valid pipeline provenance record \(t=0 rule\)/);
  await assert.rejects(insert("not json"), /t=0 rule/);
  await assert.rejects(insert(JSON.stringify({ note: "typed by hand" })), /t=0 rule/);
  await insert(PROV("daily", "x", "2026-10-05T00:00:00Z"));
  await assert.rejects(env.DB.prepare("UPDATE podcast_episodes SET provenance_json = NULL WHERE slug = 'hand-made'").run(), /t=0 rule/);
});

test("the admin generate route is closed when the project's policy says manual: false (403, no row, no workflow)", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  const r = await k.get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "2026-10-05" }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "manual_generation_disabled");
  assert.equal((await rows(k.env)).length, 0);
  assert.equal(k.env.PODCAST_WF.created.length, 0);
});

test("without a policy the admin route still works, but what it makes is origin admin, which a project's policy rejects", async () => {
  const k = makeKit("en");
  const j = await (await k.get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "2026-10-05" }) })).json();
  assert.equal(j.created, true);
  const [e] = await rows(k.env);
  const rec = JSON.parse(e.provenance_json);
  assert.deepEqual([rec.origin, rec.trigger], ["admin", "admin-api"]);
  assert.match(provenanceProblem(e, POLICY.provenance), /origin "admin" is not accepted/);
});

test("legacy origin is accepted only for episodes published before provenance.legacyBefore", () => {
  const legacy = (published_at) => ({ published_at, provenance_json: JSON.stringify({ v: 1, origin: "legacy", trigger: "migration", series: "daily", ref: null, spec_sha256: "0".repeat(64), created_at: "2026-10-01T00:00:00.000Z" }) });
  assert.equal(provenanceProblem(legacy("2026-09-30T01:54:16Z"), POLICY.provenance), null);
  assert.match(provenanceProblem(legacy("2026-10-02T02:30:00Z"), POLICY.provenance), /only for episodes published before 2026-10-01/);
  assert.match(provenanceProblem({ published_at: "2026-10-02" }, POLICY.provenance), /no provenance record/);
  assert.match(provenanceProblem({ provenance_json: "{" }, POLICY.provenance), /not JSON/);
});

test("a failed render is re-queued by the next scheduled run (origin cron-retry); a published or queued episode is left alone", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  await run(k, "2026-10-05");
  const [first] = await rows(k.env, "SELECT slug FROM podcast_episodes");
  const n0 = k.env.PODCAST_WF.created.length;
  await run(k, "2026-10-05");
  assert.equal(k.env.PODCAST_WF.created.length, n0, "a queued episode is not queued again");
  await k.env.DB.prepare("UPDATE podcast_episodes SET status = 'failed', error = 'tts 429' WHERE slug = ?").bind(first.slug).run();
  const r = await run(k, "2026-10-05");
  assert.deepEqual(r.episodes, [first.slug]);
  const after = (await rows(k.env, `SELECT status, error, provenance_json FROM podcast_episodes WHERE slug = '${first.slug}'`))[0];
  assert.deepEqual([after.status, after.error], ["queued", null]);
  assert.equal(JSON.parse(after.provenance_json).origin, "cron-retry");
  await k.env.DB.prepare("UPDATE podcast_episodes SET status = 'published' WHERE slug = ?").bind(first.slug).run();
  assert.deepEqual((await run(k, "2026-10-05")).episodes, [], "published: nothing to do");
});

test("createEpisode refuses a spec that does not validate", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  const bad = { slug: "Not A Slug", kind: "term", series: "daily", title: "x", summary: "", source_type: "term", source_ref: "x", lines: [{ speaker: "ann", text: "only one line" }] };
  const { createEpisode, queueEpisode } = await import("../src/handlers/podcasts.js");
  const series = { id: "daily", kind: "term" };
  await assert.rejects(queueEpisode(k.kit.context, k.env, { series, ep: bad }), /spec invalid/);
  const good = { ...bad, slug: "term-x", title: "Title", lines: [{ speaker: "ann", text: "a" }, { speaker: "bob", text: "b" }] };
  await assert.rejects(createEpisode(k.kit.context, k.env, { series, ep: good }), /no valid pipeline provenance record/);
  assert.equal((await rows(k.env)).length, 0);
});

test("/api/podcasts exposes each episode's origin and whether its provenance is acceptable (the monitor reads it)", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  await seed(k.env, { lang: "en" });
  await run(k, "2026-10-05");
  await k.env.DB.prepare("UPDATE podcast_episodes SET status = 'published', published_at = '2026-10-05T02:00:00.000Z' WHERE provenance_json LIKE '%\"cron\"%'").run();
  const j = await (await k.get("/api/podcasts?limit=50")).json();
  const by = Object.fromEntries(j.episodes.map((e) => [e.slug, e]));
  assert.equal(by["weekly-2026-10-05"].origin, "cron");
  assert.equal(by["weekly-2026-09-26"].origin, "cron", "the seeded episode");
  assert.ok(j.episodes.every((e) => "origin" in e && "provenance_problem" in e));
  assert.equal(j.episodes.filter((e) => e.origin === "cron").every((e) => e.provenance_problem === null), true);
});

test("a day run through an admin route (runDaily origin admin) is recorded as admin, which a policy rejects", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  await k.kit.runDaily(k.env, { day: Math.floor(Date.parse("2026-10-05T00:00:00Z") / 864e5), announce: false, origin: "admin" });
  const [e] = await rows(k.env);
  assert.equal(JSON.parse(e.provenance_json).origin, "admin");
  assert.match(provenanceProblem(e, POLICY.provenance), /origin "admin" is not accepted/);
});

const MIG = new URL("../migrations/", import.meta.url);
const GOOD = { v: 1, origin: "cron", trigger: "scheduled", scheduled_at: "2026-10-06T02:00:00.000Z", series: "daily", ref: "riba", spec_sha256: "a".repeat(64), created_at: "2026-10-06T02:00:05.000Z" };
/** A database with the kit's migrations 0001-0007, then the provenance migration generated for `origins`. */
function dbWith(origins) {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x < "0008").sort(migrationOrder)) db.exec(readFileSync(new URL(f, MIG), "utf8"));
  db.exec(provenanceMigrationSql({ origins }));
  return db;
}
const ins = (db, prov, slug = "t") => db.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, created_at, updated_at, provenance_json)
  VALUES (?, 'daily', 'daily', 'term', 't', 'term', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z', ?)`).run(slug, prov == null ? null : typeof prov === "string" ? prov : JSON.stringify(prov));
const upd = (db, prov) => db.prepare("UPDATE podcast_episodes SET provenance_json = ? WHERE slug = 'ok'").run(typeof prov === "string" ? prov : JSON.stringify(prov));
const BAD = {
  "a cron record that carries a missed date": { ...GOOD, missed_date: "2026-10-05" },
  "a cron-retry record that carries a missed date": { ...GOOD, origin: "cron-retry", missed_date: "2026-10-05" },
  "a catchup record without its missed date": { ...GOOD, origin: "catchup" },
  "a manual record": { v: 1, origin: "manual" },
  "an incomplete cron record": { v: 1, origin: "cron" },
  "a wrong version": { ...GOOD, v: 2 },
  "version as a string": { ...GOOD, v: "1" },
  "version as a boolean": { ...GOOD, v: true },
  "an unknown origin": { ...GOOD, origin: "manual" },
  "an origin with another origin's trigger": { ...GOOD, trigger: "admin-api" },
  "a missing series": (({ series, ...r }) => r)(GOOD),
  "a missing ref": (({ ref, ...r }) => r)(GOOD),
  "a short spec hash": { ...GOOD, spec_sha256: "abc" },
  "a non-hex spec hash": { ...GOOD, spec_sha256: "z".repeat(64) },
  "a created_at that is not a timestamp": { ...GOOD, created_at: "yesterday" },
  "an unknown key": { ...GOOD, approved_by: "me" },
  "a render block with an unknown key": { ...GOOD, render: { by: "hand" } },
  "a render block with a wrong type": { ...GOOD, render: { chunks: "1" } },
  "a JSON array": [GOOD],
  "text that is not JSON": "typed by hand",
};

test("migrations: 0008 added the column and the first triggers (applied, never edited); 0011 is the generator's output for every origin the kit knows", () => {
  const all = ["cron", "cron-retry", "catchup", "admin", "legacy"];
  assert.match(readFileSync(new URL("0008_podcast_provenance.sql", MIG), "utf8"), /ADD COLUMN provenance_json/);
  // the SQL is the generator's byte for byte; its comment header is not: applied 0011 keeps the old header (a semicolon and an apostrophe in a comment, which remote D1 chokes on), the generator now writes none (kit check migrations)
  const code = (t) => t.split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.equal(code(readFileSync(new URL("0011_podcast_provenance_triggers.sql", MIG), "utf8")), code(provenanceTriggersSql({ origins: all })), "the newest triggers migration is the generator's output (0011: timestamps checked with patterns D1 accepts)");
  assert.notEqual(readFileSync(new URL("0010_podcast_provenance_triggers.sql", MIG), "utf8"), readFileSync(new URL("0011_podcast_provenance_triggers.sql", MIG), "utf8"), "0010 was applied: it stays as it was");
  assert.notEqual(readFileSync(new URL("0009_podcast_provenance_triggers.sql", MIG), "utf8"), readFileSync(new URL("0010_podcast_provenance_triggers.sql", MIG), "utf8"), "0009 was applied: it stays as it was");
  assert.throws(() => provenanceMigrationSql({ origins: ["cron", "manual"] }), /not in the provenance schema/);
  assert.throws(() => provenanceMigrationSql({}), /origins are required/);
});

test("0009 replaces the triggers of a database that already ran 0008: catchup is accepted only with its missed_date, manual still refused", () => {
  const db = new DatabaseSync(":memory:");   // not D1: the semantics of the applied 0009/0010 as SQL; D1 itself refused their 65-byte GLOB (next test)
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x < "0009").sort(migrationOrder)) db.exec(readFileSync(new URL(f, MIG), "utf8"));
  const CATCH = { ...GOOD, origin: "catchup", missed_date: "2026-10-05" };
  assert.throws(() => ins(db, CATCH, "before"), /t=0 rule/, "0008's triggers do not know catchup");
  db.exec(readFileSync(new URL("0009_podcast_provenance_triggers.sql", MIG), "utf8"));
  ins(db, CATCH, "after");
  assert.doesNotThrow(() => ins(db, { ...GOOD, missed_date: "2026-10-05" }, "0009-allowed"), "0009 still lets a cron record carry missed_date");
  db.exec(readFileSync(new URL("0010_podcast_provenance_triggers.sql", MIG), "utf8"));
  assert.throws(() => ins(db, { ...GOOD, missed_date: "2026-10-05" }, "0010-refused"), /t=0 rule/, "0010: missed_date only on a catchup record");
  assert.throws(() => ins(db, { ...CATCH, missed_date: undefined }, "nomiss"), /t=0 rule/, "catchup without missed_date");
  assert.throws(() => ins(db, { ...CATCH, missed_date: "yesterday" }, "baddate"), /t=0 rule/, "missed_date is a date");
  assert.throws(() => ins(db, { ...CATCH, trigger: "admin-api" }, "trig"), /t=0 rule/, "catchup goes with the scheduled trigger");
  assert.throws(() => ins(db, { v: 1, origin: "manual" }, "manual"), /t=0 rule/);
  ins(db, GOOD, "cron");
});

test("the 2026-10-07 outage: under D1's limits 0010's triggers refuse every insert, 0011's accept a full record", () => {
  const upTo = (last) => {
    const db = withD1Limits(new DatabaseSync(":memory:"));
    for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x <= last).sort(migrationOrder)) db.exec(readFileSync(new URL(f, MIG), "utf8"));
    return db;
  };
  assert.throws(() => ins(upTo("0010_podcast_provenance_triggers.sql"), GOOD, "outage"), /LIKE or GLOB pattern too complex/, "0010 on D1: no cron episode could be stored");
  ins(upTo("0011_podcast_provenance_triggers.sql"), GOOD, "fixed");
});

for (const [name, origins] of [["kit default origins", ["cron", "cron-retry", "catchup", "admin", "legacy"]], ["a project's origins (no admin)", ["cron", "cron-retry", "legacy"]]]) {
  test(`database, ${name}: a full record is stored; manual, incomplete, wrong-version and malformed records are refused on INSERT and on UPDATE`, () => {
    const db = dbWith(origins);
    ins(db, GOOD, "ok");
    ins(db, { ...GOOD, origin: "cron-retry" }, "retry");
    ins(db, { ...GOOD, origin: "legacy", trigger: "migration", note: "old" }, "legacy");
    ins(db, { ...GOOD, ref: null, config_sha256: "b".repeat(64), engine: "e", render: { provider: "gemini", model: null, voices: { a: "Kore" }, pacing: {}, chunks: 1, duration_ms: 1000, longest_pause_ms: null, rendered_at: "2026-10-06T02:01:00.000Z" } }, "full");
    for (const [what, rec] of Object.entries(BAD)) {
      assert.throws(() => ins(db, rec, "x"), /t=0 rule/, `INSERT: ${what}`);
      assert.throws(() => upd(db, rec), /t=0 rule/, `UPDATE: ${what}`);
    }
    assert.throws(() => ins(db, null, "x"), /t=0 rule/, "no record");
    assert.throws(() => db.prepare("UPDATE podcast_episodes SET provenance_json = NULL WHERE slug = 'ok'").run(), /t=0 rule/, "record removed");
    assert.equal(db.prepare("SELECT count(*) n FROM podcast_episodes").get().n, 4, "refused rows left nothing behind");
    // an update of another column does not need to re-validate, and a valid re-write passes
    db.prepare("UPDATE podcast_episodes SET status = 'published' WHERE slug = 'ok'").run();
    upd(db, { ...GOOD, render: { provider: "gemini", chunks: 2 } });
  });
}

test("a project's origins decide: admin is refused by the database when the project does not accept it", () => {
  const strict = dbWith(["cron", "cron-retry", "legacy"]);
  assert.throws(() => ins(strict, { ...GOOD, origin: "admin", trigger: "admin-api" }), /t=0 rule/);
  ins(dbWith(["cron", "cron-retry", "catchup", "admin", "legacy"]), { ...GOOD, origin: "admin", trigger: "admin-api" });
});

test("the migration upgrades a database that already has episodes: they become origin legacy and stay valid", () => {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x < "0008").sort(migrationOrder)) db.exec(readFileSync(new URL(f, MIG), "utf8"));
  db.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, source_ref, created_at, updated_at) VALUES ('old', 'daily', 'daily', 'term', 't', 'term', NULL, '2026-09-30T01:53:49.815Z', '2026-09-30T01:53:49.815Z')`).run();
  db.exec(provenanceMigrationSql({ origins: ["cron", "cron-retry", "legacy"] }));
  const rec = JSON.parse(db.prepare("SELECT provenance_json p FROM podcast_episodes").get().p);
  assert.deepEqual([rec.origin, rec.trigger, rec.ref], ["legacy", "migration", null]);
  db.prepare("UPDATE podcast_episodes SET provenance_json = ? WHERE slug = 'old'").run(JSON.stringify(rec));   // the backfilled record itself passes the update trigger
});

test("multi-locale: every locale's episode records the cron event's scheduled time (not the moment the code ran)", async () => {
  const { buildKit } = await import("../src/kit.js");
  const { makeDB, makeR2, makeWF, DEPS } = await import("./helpers.mjs");
  const { bilingualConfig, bilingualContent } = await import("../../core/test/fixtures/bilingual.mjs");
  const kit = buildKit(bilingualConfig(), bilingualContent(), { now: () => new Date("2026-10-04T12:34:56Z"), deps: { ...DEPS, announcePending: null, createPodcastWorkflow: () => class {} } });
  const env = { DB: makeDB(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "k", ADMIN_TOKEN: "s", IP_SALT: "x" };
  await kit.scheduled({ scheduledTime: Date.parse("2026-10-04T02:30:00Z"), cron: "30 2 * * *" }, env, { waitUntil() {} });
  const eps = (await env.DB.prepare("SELECT slug, locale, provenance_json FROM podcast_episodes").all()).results;
  assert.ok(eps.some((e) => e.locale === "ar") && eps.some((e) => e.locale === ""), "both locales queued episodes");
  for (const e of eps) assert.equal(JSON.parse(e.provenance_json).scheduled_at, "2026-10-04T02:30:00.000Z", e.slug);
});

test("/api/podcasts audits EVERY published episode: an old unaccepted one is found though it is not the newest", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: POLICY } } });
  await seed(k.env, { lang: "en" });                                   // two accepted (cron) episodes
  await k.env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, published_at, created_at, updated_at, provenance_json)
    VALUES ('old-admin', 'weekly', 'weekly', 'topic', 'Old', 'topic', 'published', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`)
    .bind(JSON.stringify({ v: 1, origin: "admin", trigger: "admin-api", series: "weekly", ref: null, spec_sha256: "a".repeat(64), created_at: "2026-01-01T00:00:00.000Z" })).run();
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(j.episodes.length, 1);
  assert.deepEqual([j.audit.published, j.audit.unaccepted], [3, 1]);
  assert.match(j.audit.problems[0].problem, /origin "admin" is not accepted/);
  assert.equal(j.audit.problems[0].slug, "old-admin");
});

/* ------------------------------------------------------------- catch-up: sanctioned, automated, never a human endpoint */
const CATCHUP = { manual: false, provenance: { origins: ["cron", "cron-retry", "catchup", "legacy"], legacyBefore: "2026-10-01" }, catchup: { enabled: true, windowDays: 2 } };
const runAt = (k, iso) => k.kit.scheduled({ scheduledTime: Date.parse(`${iso}T02:00:00Z`), cron: "0 2 * * *" }, k.env, { waitUntil() {} });

test("catch-up: the cron fills a past day that has no episode, with origin catchup, the missed date and the cron's scheduled time", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: CATCHUP } } });
  const r = await runAt(k, "2026-10-06");                       // Tuesday: nothing due today; Monday 5 October was missed
  assert.deepEqual(r.catchup.map((x) => [x.date, x.episodes]), [["2026-10-05", ["weekly-2026-10-05"]]]);
  const [e] = (await env_rows(k, "SELECT slug, published_at, provenance_json FROM podcast_episodes"));
  const rec = JSON.parse(e.provenance_json);
  assert.deepEqual([rec.origin, rec.trigger, rec.missed_date, rec.scheduled_at], ["catchup", "scheduled", "2026-10-05", "2026-10-06T02:00:00.000Z"]);
  assert.equal(e.published_at.slice(0, 10), "2026-10-05", "the episode belongs to the day it was missed");
  assert.equal(provenanceProblem(e, CATCHUP.provenance), null);
  assert.equal(k.env.PODCAST_WF.created.length, 1);
  // idempotent: the next night finds nothing to fill
  assert.deepEqual((await runAt(k, "2026-10-07")).catchup, []);
  assert.equal(k.env.PODCAST_WF.created.length, 1);
});

test("MUST FAIL (kit app#54 P2): the public runDaily, which the admin run-daily route and run-daily.yml call, fills a missed day too, and says what it filled", async () => {
  const k = makeKit("en", { now: "2026-10-06T08:00:00Z", options: { podcasts: { policy: CATCHUP } } });
  const day = Math.floor(Date.parse("2026-10-06T00:00:00Z") / 864e5);   // Tuesday: nothing due today; Monday 5 October was missed
  const r = await k.kit.runDaily(k.env, { day, announce: false });
  assert.deepEqual(r.catchup.map((x) => [x.date, x.episodes]), [["2026-10-05", ["weekly-2026-10-05"]]], "the response states what was filled");
  const [e] = await env_rows(k, "SELECT provenance_json FROM podcast_episodes");
  assert.equal(JSON.parse(e.provenance_json).origin, "catchup");
  assert.deepEqual((await k.kit.runDaily(k.env, { day })).catchup, [], "idempotent: nothing left to fill");
  const off = makeKit("en", { now: "2026-10-06T08:00:00Z", options: { podcasts: { policy: { ...CATCHUP, catchup: { enabled: false, windowDays: 2 } } } } });
  assert.deepEqual((await off.kit.runDaily(off.env, { day })).catchup, [], "catch-up disabled by the project: filled nothing, and says so");
});

test("catch-up: a gap older than the window is not filled, and the audit reports it (the monitor alerts)", async () => {
  const k = makeKit("en", { now: "2026-10-14T08:00:00Z", options: { podcasts: { policy: { ...CATCHUP, catchup: { enabled: true, windowDays: 3 } } } } });
  const r = await runAt(k, "2026-10-14");                       // 5 October is 9 days back
  assert.deepEqual(r.catchup, []);
  assert.equal((await env_rows(k, "SELECT slug FROM podcast_episodes")).length, 0);
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(j.audit.catchup.count, 0);
  assert.ok(j.audit.missing_count >= 1 && j.audit.catchup_window_days === 3);
  assert.deepEqual(j.audit.missing.find((m) => m.series === "weekly"), { day: 20731, date: "2026-10-05", series: "weekly", slug: "weekly-2026-10-05", state: "missing", existing: null });
});

test("catch-up disabled: nothing is filled; a failed past day is re-queued by the catch-up pass as cron-retry", async () => {
  const off = makeKit("en", { options: { podcasts: { policy: { ...CATCHUP, catchup: { enabled: false, windowDays: 2 } } } } });
  assert.deepEqual((await runAt(off, "2026-10-06")).catchup, []);
  const k = makeKit("en", { options: { podcasts: { policy: CATCHUP } } });
  await runAt(k, "2026-10-06");
  await k.env.DB.prepare("UPDATE podcast_episodes SET status = 'failed', error = 'tts' WHERE slug = 'weekly-2026-10-05'").run();
  await runAt(k, "2026-10-07");
  const [e] = await env_rows(k, "SELECT status, provenance_json FROM podcast_episodes");
  assert.deepEqual([e.status, JSON.parse(e.provenance_json).origin], ["queued", "cron-retry"]);
});

test("catch-up is only reachable from the scheduled run: the admin route cannot ask for it, a manual insert is still refused", async () => {
  const k = makeKit("en");                                      // no policy: the admin route exists, and says so in the record
  await k.get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "2026-10-05", origin: "catchup", missed_date: "2026-10-05" }) });
  const [e] = await env_rows(k, "SELECT provenance_json FROM podcast_episodes");
  assert.equal(JSON.parse(e.provenance_json).origin, "admin", "a body cannot choose the origin");
  const strict = makeKit("en", { options: { podcasts: { policy: CATCHUP } } });
  assert.equal((await strict.get("/api/podcasts/generate", { method: "POST", headers: auth, body: "{}" })).status, 403);
  await assert.rejects(strict.env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, created_at, updated_at, provenance_json)
    VALUES ('by-hand', 'weekly', 'weekly', 'topic', 'x', 'topic', 'published', 'n', 'n', ?)`).bind(JSON.stringify({ v: 1, origin: "manual" })).run(), /t=0 rule/);
  assert.equal(strict.kit.catchup, undefined, "the catch-up is not a public method of the kit");
});
async function env_rows(k, sql) { return (await k.env.DB.prepare(sql).all()).results; }

test("audit: a failed render older than the catch-up window is still missing (state failed) and the monitor-facing count stays above zero", async () => {
  const k = makeKit("en", { now: "2026-10-30T08:00:00Z", options: { podcasts: { policy: { ...CATCHUP, catchup: { enabled: true, windowDays: 2 } } } } });
  const sk = (slug, status) => k.env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, published_at, created_at, updated_at, provenance_json)
    VALUES (?, 'weekly', 'weekly', 'topic', 'W', 'topic', ?, '2026-10-05T02:00:00Z', 'n', 'n', ?)`).bind(slug, status, JSON.stringify({ v: 1, origin: "cron", trigger: "scheduled", series: "weekly", ref: null, spec_sha256: "a".repeat(64), created_at: "2026-10-05T02:00:00.000Z" })).run();
  await sk("weekly-2026-10-05", "failed");                       // 25 days ago, long outside the 2-day window
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  const w = j.audit.missing.find((m) => m.slug === "weekly-2026-10-05");
  assert.deepEqual([w?.state, w?.date], ["failed", "2026-10-05"]);
  assert.ok(j.audit.missing_count >= 1);
  await runAt(k, "2026-10-30");                                    // the cron's catch-up window does not reach it, so nothing heals it
  assert.equal((await env_rows(k, "SELECT status FROM podcast_episodes WHERE slug = 'weekly-2026-10-05'"))[0].status, "failed");
  // once it is published the audit is quiet about it
  await k.env.DB.prepare("UPDATE podcast_episodes SET status = 'published' WHERE slug = 'weekly-2026-10-05'").run();
  const again = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(again.audit.missing.find((m) => m.slug === "weekly-2026-10-05"), undefined);
});

/* ------------------------------------------------------------- catch-up fixes: only the episode, private path, (series, day) */
test("catch-up renders ONLY the missed episode: an edited or unpublished past post is left untouched, nothing is announced", async () => {
  const announced = [];
  const k = makeKit("en", { options: { podcasts: { policy: CATCHUP } }, deps: { announcePending: async (...a) => { announced.push(a); return { sent: 1 }; } } });
  await k.env.DB.prepare(`INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, source, status, published_at, updated_at, channel_state)
    VALUES ('weekly-2026-10-05', 'weekly', 'article', 'Edited by the editor', 'my summary', 'my body', '[]', 'editorial', 'draft', '2026-10-05T03:00:00.000Z', '2026-10-05T09:00:00.000Z', 'skipped')`).run();
  const before = await env_rows(k, "SELECT * FROM posts ORDER BY slug");
  const r = await runAt(k, "2026-10-06");                       // 5 October is a missed podcast day inside the window
  assert.deepEqual(r.catchup.map((x) => [x.date, x.episodes, x.posts]), [["2026-10-05", ["weekly-2026-10-05"], []]], "an episode, no post written");
  assert.deepEqual(await env_rows(k, "SELECT * FROM posts ORDER BY slug"), before, "the edited, unpublished post is exactly as the editor left it");
  assert.equal(announced.length, 1, "only today's own run announces (once); the catch-up announced nothing");
});

test("runDaily is public and refuses to be asked for a catch-up record: origin catchup, missedDate and only are made by the run itself", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: CATCHUP } } });
  const day = Math.floor(Date.parse("2026-10-05T00:00:00Z") / 864e5);
  await assert.rejects(k.kit.runDaily(k.env, { day, origin: "catchup", missedDate: "2026-10-05" }), /belong to the catch-up window/);
  await assert.rejects(k.kit.runDaily(k.env, { day, missedDate: "2026-10-05" }), /belong to the catch-up window/);
  await assert.rejects(k.kit.runDaily(k.env, { day, only: new Set(["weekly-2026-10-05"]) }), /belong to the catch-up window/);
  await assert.rejects(k.kit.runDaily(k.env, { day, origin: "manual" }), /unknown origin/);
  assert.equal((await env_rows(k, "SELECT slug FROM podcast_episodes")).length, 0);
  assert.deepEqual(Object.keys(k.kit).filter((x) => /catch/i.test(x)), [], "no public catch-up method");
  // the multi-locale router refuses it too
  const { buildKit } = await import("../src/kit.js");
  const { makeDB, makeR2, makeWF, DEPS } = await import("./helpers.mjs");
  const { bilingualConfig, bilingualContent } = await import("../../core/test/fixtures/bilingual.mjs");
  const multi = buildKit(bilingualConfig(), bilingualContent(), { now: () => new Date("2026-10-06T08:00:00Z"), deps: { ...DEPS, announcePending: null, createPodcastWorkflow: () => class {} } });
  const env = { DB: makeDB(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "k", ADMIN_TOKEN: "s", IP_SALT: "x" };
  await assert.rejects(multi.runDaily(env, { day, origin: "catchup" }), /belong to the catch-up window/);
  await assert.rejects(multi.runDaily(env, { day, missedDate: "2026-10-05" }), /belong to the catch-up window/);
});

test("duplicate detection is (series, day), not the name: a differently-named legacy row on a missed day gets no second episode", async () => {
  const k = makeKit("en", { options: { podcasts: { policy: CATCHUP } } });
  await k.env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, published_at, created_at, updated_at, provenance_json)
    VALUES ('the-week-of-5-october', 'weekly', 'weekly', 'topic', 'Legacy name', 'topic', 'published', '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z', ?)`)
    .bind(JSON.stringify({ v: 1, origin: "legacy", trigger: "migration", series: "weekly", ref: null, spec_sha256: "0".repeat(64), created_at: "2026-10-05T03:00:00.000Z" })).run();
  const r = await runAt(k, "2026-10-06");
  assert.deepEqual(r.catchup, [], "the day already has its weekly episode under another name");
  assert.deepEqual((await env_rows(k, "SELECT slug FROM podcast_episodes")).map((x) => x.slug), ["the-week-of-5-october"]);
  assert.equal(k.env.PODCAST_WF.created.length, 0);
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(j.audit.missing.find((m) => m.series === "weekly" && m.date === "2026-10-05"), undefined, "and the audit does not call that day missing");
});

/* ---- (series, day) uses the SITE-LOCAL day, a published row always wins, a failed row under another name is re-queued, not twinned */
const LEGACY = (slug, status, publishedAt) => ({ slug, status, publishedAt, prov: JSON.stringify({ v: 1, origin: "legacy", trigger: "migration", series: "weekly", ref: null, spec_sha256: "0".repeat(64), created_at: publishedAt }) });
const addRow = (k, r) => k.env.DB.prepare(`INSERT INTO podcast_episodes (slug, series, show, kind, title, source_type, status, published_at, created_at, updated_at, provenance_json)
  VALUES (?, 'weekly', 'weekly', 'topic', 'Old', 'topic', ?, ?, ?, ?, ?)`).bind(r.slug, r.status, r.publishedAt, r.publishedAt, r.publishedAt, r.prov).run();
const faKit = () => makeKit("fa", { now: "2026-10-04T08:00:00Z", options: { podcasts: { policy: { ...CATCHUP, catchup: { enabled: true, windowDays: 1 } } } } });
const weeklyOnly = (r) => r.catchup.flatMap((x) => x.episodes.map((slug) => [x.date, slug])).filter(([, slug]) => !slug.startsWith("daily"));   // the sample's daily series is due every day: not under test here

test("(series, day) is compared on the SITE-LOCAL day: a late-evening Tehran-time legacy row (UTC date a day earlier) gets no twin", async () => {
  const k = faKit();                                              // Tehran: Saturday 3 October is the weekly day
  await addRow(k, LEGACY("old-name-of-the-week", "published", "2026-10-02T21:00:00.000Z"));   // 00:00 on 3 October in Tehran, 2 October in UTC
  const r = await runAt(k, "2026-10-04");
  assert.deepEqual(weeklyOnly(r), [], "the local day already has its episode");
  assert.deepEqual((await env_rows(k, "SELECT slug FROM podcast_episodes WHERE series = 'weekly'")).map((x) => x.slug), ["old-name-of-the-week"]);
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(j.audit.missing.find((m) => m.series === "weekly" && m.date === "2026-10-03"), undefined);
  // and the opposite: a row at 21:00Z on the 3rd is the 4th in Tehran, so it does not cover the 3rd
  const k2 = faKit();
  await addRow(k2, LEGACY("belongs-to-the-fourth", "published", "2026-10-03T21:00:00.000Z"));
  assert.deepEqual(weeklyOnly(await runAt(k2, "2026-10-04")).map(([d]) => d), ["2026-10-03"], "that row is the next local day's, so the 3rd is still missing");
});

test("a published (series, day) row always wins: the expected name being failed does not trigger a retry or a second published episode", async () => {
  const k = faKit();
  await addRow(k, LEGACY("weekly-2026-10-03", "failed", "2026-10-03T02:30:00.000Z"));              // the expected name, failed
  await addRow(k, LEGACY("renamed-weekly-published", "published", "2026-10-03T02:35:00.000Z"));    // the same series and day, published under another name
  const r = await runAt(k, "2026-10-04");
  assert.deepEqual(weeklyOnly(r), []);
  assert.equal(k.env.PODCAST_WF.created.filter((c) => /weekly|renamed/.test(c.params.slug)).length, 0, "no retry");
  const rows = await env_rows(k, "SELECT slug, status FROM podcast_episodes WHERE series = 'weekly' ORDER BY slug");
  assert.deepEqual(rows, [{ slug: "renamed-weekly-published", status: "published" }, { slug: "weekly-2026-10-03", status: "failed" }], "no new row, the failed one is not re-queued");
  const j = await (await k.get("/api/podcasts?limit=1")).json();
  assert.equal(j.audit.missing.find((m) => m.series === "weekly" && m.date === "2026-10-03"), undefined, "the day is covered");
});

test("a failed legacy row under another name is re-queued itself (cron-retry); no twin is created next to it", async () => {
  const k = faKit();
  await addRow(k, LEGACY("old-name-failed", "failed", "2026-10-03T02:30:00.000Z"));
  const r = await runAt(k, "2026-10-04");
  assert.deepEqual(weeklyOnly(r), [["2026-10-03", "old-name-failed"]], "the existing row was re-queued");
  const rows = await env_rows(k, "SELECT slug, status, provenance_json FROM podcast_episodes WHERE series = 'weekly'");
  assert.equal(rows.length, 1, "no second row");
  assert.deepEqual([rows[0].slug, rows[0].status, JSON.parse(rows[0].provenance_json).origin], ["old-name-failed", "queued", "cron-retry"]);
  assert.equal(k.env.PODCAST_WF.created.filter((c) => /old-name-failed/.test(c.params.slug)).length, 1);
});
