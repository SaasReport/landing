// kit check podcast: the t=0 gate (podcast.config.json valid, covers present and square, the cron equal to wrangler.toml,
// the provenance trigger migrated, no hand-added episode files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { podcastCheck, imageSize } from "../src/podcast-check.js";
import { migrate, provenanceFiles, sha256 } from "../src/podcast-migrations.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const CONFIG = {
  language: "en", schedule: { cron: "0 2 * * *", timezone: "Asia/Dubai", at: "06:00" }, target: { seconds: 60, minSeconds: 45, maxSeconds: 90 },
  tts: { provider: "gemini", voices: { amina: "Kore", yusuf: "Charon" }, speakers: { amina: "Amina", yusuf: "Yusuf" }, style: "A relaxed, clear conversation in English between two colleagues. Warm, natural rhythm, quick turn-taking, never like a news presenter." },
  pacing: { thresholdDb: -36, maxPauseMs: 340, turnGapMs: 200, startMs: 250, endMs: 600, normalizeDb: -20 },
  provenance: { required: true, origins: ["cron", "cron-retry", "catchup", "legacy"], legacyBefore: "2026-10-07" }, catchup: { enabled: true, windowDays: 7 }, manual: false,
  assets: { dir: "brand/podcast", covers: { daily: { file: "daily-1400.png", size: 1400, alt: "Cover of the daily show" } } },
};

function project(t, over = {}) {
  const dir = tempDir(t, "kit-podcast-");
  mkdirSync(join(dir, "brand/podcast"), { recursive: true }); mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "podcast.config.json"), JSON.stringify({ ...CONFIG, ...over }));
  writeFileSync(join(dir, "brand/podcast/daily-1400.png"), png(1400, 1400));
  writeFileSync(join(dir, "migrations/0007_comms.sql"), "-- other tables");
  writeFileSync(join(dir, "wrangler.toml"), 'name = "x"\n[triggers]\ncrons = ["0 2 * * *"]\n');
  migrate(dir, { ...CONFIG, ...over }.provenance.origins);   // 0008_podcast_provenance.sql + the ledger, as `kit podcast migrate` writes them
  return dir;
}
const problems = (dir, config) => podcastCheck(dir, { config }).problems.map((p) => `${p.file}: ${p.problem}`);

test("a complete project passes", (t) => {
  const dir = project(t);
  const r = podcastCheck(dir);
  assert.deepEqual(r.problems, []);
  assert.match(r.summary, /1 cover\(s\); cron 0 2 \* \* \*; pacing max pause 340 ms; manual generation off/);
});

test("the schema refuses manual generation, pauses over the 600 ms guard and unknown origins", (t) => {
  assert.match(problems(project(t, { manual: true })).join(), /manual: must be/);
  assert.match(problems(project(t, { pacing: { ...CONFIG.pacing, maxPauseMs: 700 } })).join(), /pacing\/maxPauseMs: must be ≤ 550/);
  assert.match(problems(project(t, { provenance: { required: true, origins: ["cron", "admin"] } })).join(), /provenance\/origins/);
  assert.match(problems(project(t, { provenance: { required: false, origins: ["cron"] } })).join(), /provenance\/required/);
});

test("the cron must be the Worker's, the covers must exist and be square at the declared size, the trigger must be migrated", (t) => {
  const dir = project(t);
  writeFileSync(join(dir, "wrangler.toml"), 'name = "x"\n[triggers]\ncrons = ["30 2 * * *"]\n');
  writeFileSync(join(dir, "brand/podcast/daily-1400.png"), png(1400, 1000));
  writeFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), "SELECT 1;");
  const p = problems(dir).join("\n");
  assert.match(p, /wrangler\.toml: .*does not contain the schedule/);
  assert.match(p, /daily-1400\.png: must be square, is 1400x1000/);
  assert.match(p, /migrations\/0008_podcast_provenance\.sql: changed since it was committed/);
  const deleted = project(t); rmSync(join(deleted, "migrations/0008_podcast_provenance.sql"));
  assert.match(problems(deleted).join(), /listed in podcast\.migrations\.lock\.json but missing/);
  const noledger = project(t); rmSync(join(noledger, "podcast.migrations.lock.json"));
  assert.match(problems(noledger).join(), /podcast\.migrations\.lock\.json is missing/);
  const gone = project(t); writeFileSync(join(gone, "podcast.config.json"), JSON.stringify({ ...CONFIG, assets: { dir: "brand/podcast", covers: { daily: { file: "nope.png", size: 1400, alt: "Cover of the daily" } } } }));
  assert.match(problems(gone).join(), /nope\.png: cover of show "daily" is missing/);
});

test("kit.config.js is the file's: voices, style, pacing and the series' time cannot drift (one source per fact)", (t) => {
  const dir = project(t);
  const config = { site: { locale: "en" }, tts: { ...CONFIG.tts, voices: { amina: "Zephyr", yusuf: "Charon" }, pacing: CONFIG.pacing },
    series: [{ id: "daily", every: "day", at: "07:00", podcast: { show: "daily", maxSeconds: 30 } }], shows: { daily: {}, weekly: {} } };
  const p = problems(dir, config).join("\n");
  assert.match(p, /tts\.voices differs from podcast\.config\.json/);
  assert.match(p, /series daily runs at 07:00, the schedule says 06:00/);
  assert.match(p, /maxSeconds 30 is below the target 60/);
  assert.match(p, /no cover for the show "weekly"/);
  assert.doesNotMatch(p, /tts\.style/);
  assert.match(problems(dir, { ...config, tts: { voices: CONFIG.tts.voices, speakers: CONFIG.tts.speakers, style: CONFIG.tts.style, pacing: CONFIG.pacing } }).join(), /tts\.provider differs/, "provider is compared too (a missing one is a drift)");
  const same = problems(dir, { ...config, tts: { ...CONFIG.tts, pacing: CONFIG.pacing, model: "gemini-x" } }).join();
  assert.match(same, /tts\.model differs/, "a model only kit.config.js has is a drift");
  assert.doesNotMatch(p, /tts\.pacing/, "pacing equal");
  assert.match(problems(dir, { ...config, tts: { ...config.tts, pacing: { maxPauseMs: 500 } } }).join(), /tts\.pacing differs/);
});

test("no audio file or episode record may be committed: episodes come from the pipeline only", (t) => {
  const dir = project(t);
  mkdirSync(join(dir, "content/podcasts"), { recursive: true });
  writeFileSync(join(dir, "episodes.json"), "[]"); writeFileSync(join(dir, "content/podcasts/term-x.json"), "{}"); writeFileSync(join(dir, "public-ep.mp3"), "x");
  const p = problems(dir).join("\n");
  assert.match(p, /public-ep\.mp3: an audio file is committed/);
  assert.match(p, /episodes\.json: an episode record is committed/);
  assert.match(p, /content\/podcasts\/term-x\.json: an episode record is committed/);
});

test("imageSize reads PNG and JPEG headers", () => {
  assert.deepEqual(imageSize(png(1400, 1400)), { type: "png", width: 1400, height: 1400 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x05, 0x78, 0x05, 0x78, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  assert.deepEqual(imageSize(jpg), { type: "jpeg", width: 1400, height: 1400 });
  assert.equal(imageSize(Buffer.from("GIF89a....")), null);
});

test("an en-GB project: the schema needs languageCode en-GB and spelling.variant en-GB; kit.config.js must carry the same spelling", (t) => {
  const gb = { ...CONFIG, language: "en-GB", tts: { ...CONFIG.tts, languageCode: "en-GB" }, spelling: { variant: "en-GB", exceptions: [{ phrase: "Rich Authorization Requests", reason: "the title of RFC 9396" }] } };
  assert.deepEqual(podcastCheck(project(t, gb)).problems, []);
  assert.match(problems(project(t, { ...gb, tts: { ...gb.tts, languageCode: "en-US" } })).join(), /languageCode: must be "en-GB"/);
  assert.match(problems(project(t, { ...CONFIG, language: "en-GB", tts: { ...CONFIG.tts, languageCode: "en-GB" } })).join(), /spelling: is required/);
  assert.match(problems(project(t, { ...gb, spelling: { variant: "en-US" } })).join(), /spelling\/variant: must be/);
  assert.match(problems(project(t, { ...gb, spelling: { variant: "en-GB", exceptions: [{ phrase: "canceled", reason: "x" }] } })).join(), /reason: must have at least 12/);
  const config = { site: { locale: "en" }, tts: { ...gb.tts, pacing: gb.pacing, spelling: gb.spelling }, series: [], shows: { daily: {} } };
  assert.doesNotMatch(problems(project(t, gb), config).join(), /tts\.spelling/);
  assert.match(problems(project(t, gb), { ...config, tts: { ...config.tts, spelling: undefined } }).join(), /tts\.spelling differs/, "the Worker's config cannot drift from the file");
  // the scripts the pipeline generates are clean: US words in the pack are rewritten, so the check passes; exceptions stay as written
  const content = { daily: { terms: [{ slug: "x", talk: [["host", "We organize a license fee for the center."], ["expert", "See Rich Authorization Requests."]] }] } };
  assert.deepEqual(podcastCheck(project(t, gb), { content }).problems, []);
});

test("an en-GB project's spelling.exceptions may name its one exceptions file, the list kit check spelling reads too", (t) => {
  const entry = { phrase: "completed or canceled", kind: "protocol", reason: "the ACP checkout session states, as the API spells them" };
  const gb = { ...CONFIG, language: "en-GB", tts: { ...CONFIG.tts, languageCode: "en-GB" }, spelling: { variant: "en-GB", exceptions: "spelling.exceptions.json" } };
  const dir = project(t, gb);
  writeFileSync(join(dir, "spelling.exceptions.json"), JSON.stringify({ $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/spelling-exceptions.schema.json", exceptions: [entry] }));
  const config = { site: { locale: "en-GB" }, tts: { ...gb.tts, pacing: gb.pacing, spelling: { variant: "en-GB", exceptions: [entry] } }, series: [], shows: { daily: {} } };
  assert.doesNotMatch(problems(dir, config).join(), /spelling/, "kit.config.js passes the file's entries");
  assert.match(problems(dir, { ...config, tts: { ...config.tts, spelling: gb.spelling } }).join(), /tts\.spelling differs .*with the entries of spelling\.exceptions\.json/);
  // the spoken lines keep the protocol phrase and still fail on prose
  const content = { wire: [{ slug: "acp", talk: [["n", "Sessions end completed or canceled."]] }], prose: [{ slug: "x", talk: [["n", "The order was canceled."]] }] };
  const p = podcastCheck(dir, { config, content }).problems.map((x) => `${x.file}: ${x.problem}`);
  assert.ok(!p.some((x) => x.includes("content: wire/acp")), p.join("\n"));
  const missing = project(t, gb);
  assert.match(problems(missing, config).join(), /spelling\.exceptions\.json: spelling exceptions declared but missing/);
});

test("catch-up: enabled and origins go together", (t) => {
  assert.deepEqual(podcastCheck(project(t)).problems, []);
  assert.match(problems(project(t, { catchup: { enabled: false, windowDays: 7 } })).join(), /catchup\.enabled is false but provenance\.origins lists "catchup"/);
  assert.match(problems(project(t, { provenance: { ...CONFIG.provenance, origins: ["cron", "cron-retry", "legacy"] } })).join(), /catchup\.enabled is true but provenance\.origins does not list "catchup"/);
  assert.deepEqual(problems(project(t, { catchup: { enabled: true, windowDays: 31 } })), [], "a documented outage can be repaired by scheduled catch-up for the previous month");
  assert.match(problems(project(t, { catchup: { enabled: true, windowDays: 32 } })).join(), /windowDays: must be ≤ 31/);
});

test("append-only migrations: adding the catchup origin writes a NEW numbered file, the applied one stays byte for byte, and the ledger notices any edit", (t) => {
  // a project that shipped before catch-up: origins without catchup, its first migration applied
  const before = { provenance: { ...CONFIG.provenance, origins: ["cron", "cron-retry", "legacy"] }, catchup: { enabled: false, windowDays: 7 } };
  const dir = project(t, before);
  const applied = readFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), "utf8");
  assert.deepEqual(podcastCheck(dir).problems, []);
  // the owner enables catch-up: the gate fails, because the newest migration is not what the generator makes now
  writeFileSync(join(dir, "podcast.config.json"), JSON.stringify({ ...CONFIG }));
  const p = problems(dir).join("\n");
  assert.match(p, /the newest provenance migration is not what the generator makes.*kit podcast migrate/s);
  // kit podcast migrate: a NEW file appears, nothing existing is rewritten
  const r = migrate(dir, CONFIG.provenance.origins);
  assert.equal(r.created, "0009_podcast_provenance_triggers.sql");
  assert.deepEqual(provenanceFiles(dir), ["0008_podcast_provenance.sql", "0009_podcast_provenance_triggers.sql"]);
  assert.equal(readFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), "utf8"), applied, "the applied migration is untouched");
  assert.match(readFileSync(join(dir, "migrations/0009_podcast_provenance_triggers.sql"), "utf8"), /DROP TRIGGER IF EXISTS podcast_provenance_insert;[\s\S]*'catchup'/);
  assert.deepEqual(podcastCheck(dir).problems, []);
  assert.equal(migrate(dir, CONFIG.provenance.origins).created, null, "idempotent: nothing more to write");
  // an edit of ANY recorded migration is caught, whichever file it is
  writeFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), `${applied}\n-- tweaked`);
  assert.match(problems(dir).join(), /0008_podcast_provenance\.sql: changed since it was committed/);
  writeFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), applied);
  writeFileSync(join(dir, "migrations/0009_podcast_provenance_triggers.sql"), "-- hand written");
  assert.match(problems(dir).join(), /0009_podcast_provenance_triggers\.sql: changed since it was committed/);
  // an unlisted provenance migration is refused too (only migrate adds them)
  const extra = project(t); writeFileSync(join(extra, "migrations/0010_podcast_provenance_triggers.sql"), "-- sneaked in");
  assert.match(problems(extra).join(), /0010_podcast_provenance_triggers\.sql: not in podcast\.migrations\.lock\.json/);
  // the ledger holds the real hashes
  assert.equal(JSON.parse(readFileSync(join(project(t), "podcast.migrations.lock.json"), "utf8")).files["0008_podcast_provenance.sql"].length, 64);
  assert.equal(sha256("a").length, 64);
});


test("a newly synced Kit engine provenance migration is locked by the canonical podcast generator, not by hand", (t) => {
  const dir = project(t);
  const upstream = new URL("../../cloudflare/migrations/0011_podcast_provenance_triggers.sql", import.meta.url);
  const trusted = join(dir, "vendor/kit/packages/cloudflare/migrations");
  mkdirSync(trusted, { recursive: true });
  copyFileSync(upstream, join(trusted, "0011_podcast_provenance_triggers.sql"));
  const copied = "0009_cloudflare_podcast_provenance_triggers.sql";
  copyFileSync(upstream, join(dir, "migrations", copied));
  const original = readFileSync(join(dir, "migrations", copied), "utf8");
  const r = migrate(dir, CONFIG.provenance.origins);
  assert.ok(r.adopted.includes(copied), "only verified Kit source bytes can be adopted");
  const lock = JSON.parse(readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8"));
  assert.equal(lock.files[copied], sha256(original), "an immutable hash records its actual bytes");
  assert.equal(readFileSync(join(dir, "migrations", copied), "utf8"), original, "no SQL edited during lock reconciliation");
  assert.ok(!problems(dir).some((p) => p.includes("not in podcast.migrations.lock.json")), problems(dir).join("\n"));
  const second = migrate(dir, CONFIG.provenance.origins);
  assert.ok(!second.adopted.length, "idempotent: no second adoption");
});

test("engine provenance lock rejects a forged Kit-looking SQL file and mutations to an already locked source", (t) => {
  const dir = project(t);
  const extra = "0009_cloudflare_podcast_provenance_triggers.sql";
  writeFileSync(join(dir, "migrations", extra), "DROP TRIGGER IF EXISTS podcast_provenance_insert;\n");
  const oldLock = readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8");
  assert.throws(() => migrate(dir, CONFIG.provenance.origins), /not byte-identical to a trusted Kit/);
  assert.equal(readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8"), oldLock,
    "failed adoption cannot mutate the ledger");
  rmSync(join(dir, "migrations", extra));
  const applied = join(dir, "migrations/0008_podcast_provenance.sql");
  writeFileSync(applied, readFileSync(applied, "utf8") + "\n-- unauthorized edit");
  assert.throws(() => migrate(dir, CONFIG.provenance.origins), /has changed; applied SQL is immutable/);
});


test("interrupt-safe canonical reconciliation locks duplicate generated trigger bytes without editing applied D1 SQL", (t) => {
  // First produce a legitimate generator-owned trigger under a different origin set.
  const old = { provenance: { ...CONFIG.provenance,
    origins: ["cron", "cron-retry", "legacy"] }, catchup: { enabled: false, windowDays: 7 } };
  const dir = project(t, old);
  writeFileSync(join(dir, "podcast.config.json"), JSON.stringify(CONFIG));
  const generated = migrate(dir, CONFIG.provenance.origins).created;
  assert.equal(generated, "0009_podcast_provenance_triggers.sql");
  const trusted = readFileSync(join(dir, "migrations", generated), "utf8");
  const duplicate = "0010_podcast_provenance_triggers.sql";
  writeFileSync(join(dir, "migrations", duplicate), trusted); // an interrupted generator copied the same committed SQL
  const r = migrate(dir, CONFIG.provenance.origins);
  assert.deepEqual(r.adopted, [duplicate]);
  assert.equal(r.created, null);
  const ledger = JSON.parse(readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8"));
  assert.equal(ledger.files[duplicate], ledger.files[generated]);
  assert.equal(ledger.files[duplicate], sha256(trusted));
  assert.equal(readFileSync(join(dir, "migrations", duplicate), "utf8"), trusted);
  assert.deepEqual(problems(dir), [], "a repaired lock and the final trigger agree with the same canonical generator");
  assert.deepEqual(migrate(dir, CONFIG.provenance.origins), { created: null, adopted: [] });
});

test("duplicate adoption refuses an untracked base ALTER TABLE or changed SQL", (t) => {
  const old = { provenance: { ...CONFIG.provenance,
    origins: ["cron", "cron-retry", "legacy"] }, catchup: { enabled: false, windowDays: 7 } };
  const dir = project(t, old);
  writeFileSync(join(dir, "podcast.config.json"), JSON.stringify(CONFIG));
  migrate(dir, CONFIG.provenance.origins);
  const lock = readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8");
  const base = "0010_podcast_provenance.sql";
  copyFileSync(join(dir, "migrations/0008_podcast_provenance.sql"), join(dir, "migrations", base));
  assert.throws(() => migrate(dir, CONFIG.provenance.origins), /refuse adoption/,
    "a base ADD COLUMN may never be replayed even if it matches a locked file");
  assert.equal(readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8"), lock);
  rmSync(join(dir, "migrations", base));
  const bad = "0010_podcast_provenance_triggers.sql";
  writeFileSync(join(dir, "migrations", bad), "-- tampered\nDROP TRIGGER IF EXISTS podcast_provenance_insert;\n");
  assert.throws(() => migrate(dir, CONFIG.provenance.origins), /refuse adoption/);
  assert.equal(readFileSync(join(dir, "podcast.migrations.lock.json"), "utf8"), lock);
});
