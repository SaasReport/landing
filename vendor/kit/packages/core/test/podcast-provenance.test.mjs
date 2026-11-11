// The episode spec, the provenance record and the helpers of the t=0 rule (src/podcast-provenance.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEpisodeSpec, checkProvenance, buildProvenance, withRender, legacyProvenance, provenanceProblem, canonicalJson, sha256Hex, PROVENANCE_ORIGINS } from "../src/podcast-provenance.js";

const spec = { slug: "term-riba", kind: "term", series: "daily", show: "daily", number: 1, title: "Islamic Finance in a Minute, episode 1: Riba", summary: "An increase over principal.",
  lines: [{ speaker: "amina", text: "Hi!" }, { speaker: "yusuf", text: "Hello." }], source_type: "term", source_ref: "riba", maxSeconds: 110, estimatedMs: 60_000 };

test("episode spec: what episodeFromItem builds validates; hand-typed junk does not", () => {
  assert.deepEqual(checkEpisodeSpec(spec), []);
  assert.deepEqual(checkEpisodeSpec({ ...spec, slug: "ar/term-riba" }), [], "a non-default locale's stored slug");
  assert.deepEqual(checkEpisodeSpec({ ...spec, lines: null, kind: "article", source_type: "post", series: null }), [], "article episodes are scripted by the workflow later");
  assert.match(checkEpisodeSpec({ ...spec, slug: "Term Riba" }).join(), /slug: must match/);
  assert.match(checkEpisodeSpec({ ...spec, lines: [{ speaker: "a", text: "x" }] }).join(), /lines/);
  assert.match(checkEpisodeSpec({ ...spec, lines: [{ speaker: "a", text: "" }, { speaker: "b", text: "x" }] }).join(), /text/);
  assert.match(checkEpisodeSpec({ slug: "x" }).join(), /is required/);
});

test("buildProvenance: origin, trigger, scheduled time, stable spec hash, config hash; valid against the schema", async () => {
  const at = Date.parse("2026-10-06T02:00:00Z");
  const a = await buildProvenance({ ep: spec, series: "daily", scheduledAt: at, config: { tts: { voices: { a: "Kore" } } }, now: "2026-10-06T02:00:05.000Z" });
  assert.deepEqual(checkProvenance(a), []);
  assert.deepEqual([a.v, a.origin, a.trigger, a.scheduled_at, a.series, a.ref], [1, "cron", "scheduled", "2026-10-06T02:00:00.000Z", "daily", "riba"]);
  const b = await buildProvenance({ ep: { ...spec, estimatedMs: 1 }, series: "daily", scheduledAt: at, now: "2026-10-07T00:00:00.000Z" });
  assert.equal(b.spec_sha256, a.spec_sha256, "the hash covers the spoken content (slug, title, summary, lines, ref), not bookkeeping");
  const c = await buildProvenance({ ep: { ...spec, lines: [...spec.lines, { speaker: "amina", text: "More" }] }, series: "daily", scheduledAt: at });
  assert.notEqual(c.spec_sha256, a.spec_sha256);
  const admin = await buildProvenance({ ep: spec, series: "daily", origin: "admin" });
  assert.deepEqual([admin.origin, admin.trigger, admin.scheduled_at], ["admin", "admin-api", undefined]);
  await assert.rejects(buildProvenance({ ep: spec, series: "daily", origin: "by-hand" }), /provenance record invalid/);
});

test("withRender adds the render facts and the result still validates", async () => {
  const r = withRender(await buildProvenance({ ep: spec, series: "daily" }), { provider: "gemini", model: "m", voices: { amina: "Kore" }, chunks: 1, duration_ms: 59_000, longest_pause_ms: 340, rendered_at: "2026-10-06T02:01:00.000Z" });
  assert.deepEqual(checkProvenance(r), []);
  assert.equal(r.render.longest_pause_ms, 340);
  assert.match(checkProvenance({ ...r, render: { ...r.render, longest_pause_ms: -1 } }).join(), /longest_pause_ms/);
});

test("provenanceProblem: the monitor's and the tests' verdict on a stored row", async () => {
  const policy = { origins: ["cron", "cron-retry", "legacy"], legacyBefore: "2026-10-07" };
  const ok = JSON.stringify(await buildProvenance({ ep: spec, series: "daily" }));
  assert.equal(provenanceProblem({ provenance_json: ok }, policy), null);
  assert.match(provenanceProblem({}, policy), /no provenance record/);
  assert.match(provenanceProblem({ provenance_json: "{nope" }, policy), /not JSON/);
  assert.match(provenanceProblem({ provenance_json: JSON.stringify({ v: 1, origin: "cron" }) }, policy), /invalid/);
  assert.match(provenanceProblem({ provenance_json: JSON.stringify(await buildProvenance({ ep: spec, series: "daily", origin: "admin" })) }, policy), /origin "admin" is not accepted/);
  assert.equal(provenanceProblem({ published_at: "2026-10-06T00:00:00Z", provenance_json: JSON.stringify(legacyProvenance()) }, policy), null);
  assert.match(provenanceProblem({ published_at: "2026-10-07T00:00:00Z", provenance_json: JSON.stringify(legacyProvenance()) }, policy), /only for episodes published before 2026-10-07/);
});

test("canonical JSON hashing is key-order independent; schema origins are the documented five", async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  assert.equal(await sha256Hex({ a: 1, b: 2 }), await sha256Hex({ b: 2, a: 1 }));
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.deepEqual([...PROVENANCE_ORIGINS], ["cron", "cron-retry", "catchup", "admin", "legacy"]);
});

test("podcast-config schema: only Gemini's documented languageCodes, only providers that can pace", async () => {
  const { readFileSync } = await import("node:fs");
  const { validate, formatProblems } = await import("../src/schema.js");
  const schema = JSON.parse(readFileSync(new URL("../schemas/podcast-config.schema.json", import.meta.url), "utf8"));
  const base = { language: "en", schedule: { cron: "0 2 * * *", timezone: "UTC", at: "06:00" }, target: { seconds: 60, minSeconds: 45, maxSeconds: 90 },
    tts: { provider: "gemini", voices: { a: "Kore", b: "Charon" }, speakers: { a: "Aa", b: "Bb" }, style: "x".repeat(90) },
    pacing: { thresholdDb: -36, maxPauseMs: 340, turnGapMs: 200, startMs: 250, endMs: 600, normalizeDb: -20 },
    provenance: { required: true, origins: ["cron"] }, catchup: { enabled: false, windowDays: 7 }, manual: false, assets: { dir: "public/brand", covers: { daily: { file: "c.png", size: 1400, alt: "cover" } } } };
  const check = (tts) => formatProblems(validate({ ...base, tts: { ...base.tts, ...tts } }, schema));
  assert.deepEqual(check({ languageCode: "en-US" }), []);
  assert.deepEqual(check({}), [], "omitted: allowed (Persian omits it)");
  assert.match(check({ languageCode: "fa-IR" }).join(), /languageCode: must be one of/);
  assert.deepEqual(check({ languageCode: "en-GB" }), [], "en-GB: accepted by the API, the British accent");
  assert.match(check({ languageCode: "en-AU" }).join(), /languageCode: must be one of/);
  assert.match(check({ provider: "piper" }).join(), /provider: must be one of/);
  assert.match(check({ provider: "gradio" }).join(), /provider: must be one of/);
});

test("britishSpelling: American spellings become British (case kept), licence as a noun, exceptions untouched, idempotent", async () => {
  const { britishSpelling, usSpellings } = await import("../src/spelling.js");
  assert.equal(britishSpelling("We organize the program. Organization matters; ORGANIZE it. The center analyzes color."), "We organise the program. Organisation matters; ORGANISE it. The centre analyses colour.");
  assert.equal(britishSpelling("A software license costs more; you may license it. The licenses differ. Add a LICENSE file."), "A software licence costs more; you may license it. The licences differ. Add a LICENCE file.");
  const ex = [{ phrase: "Rich Authorization Requests", reason: "RFC 9396" }, { phrase: "completed or canceled", reason: "API status" }, { phrase: "LICENSE file", reason: "file name" }];
  assert.equal(britishSpelling("Rich Authorization Requests cover authorization; sessions end completed or canceled. Add a LICENSE file.", { exceptions: ex }), "Rich Authorization Requests cover authorisation; sessions end completed or canceled. Add a LICENSE file.");
  const once = britishSpelling("Judgment of the traveler's labeled catalog, fulfillment and installments.");
  assert.equal(once, "Judgement of the traveller's labelled catalogue, fulfilment and instalments.");
  assert.equal(britishSpelling(once), once);
  assert.deepEqual(usSpellings(once), []);
});

test("the schema's origin rules are enforced by checkProvenance: x-required-by-origin, x-allowed-only-by-origin, x-trigger-by-origin (each fails when its rule is broken)", async () => {
  const cron = await buildProvenance({ ep: spec, series: "daily", scheduledAt: Date.parse("2026-10-06T02:00:00Z") });
  assert.deepEqual(checkProvenance(cron), []);
  const catchup = { ...cron, origin: "catchup", missed_date: "2026-10-05" };
  assert.deepEqual(checkProvenance(catchup), []);
  const { missed_date, ...without } = catchup;
  assert.match(checkProvenance(without).join(), /\/missed_date: is required for origin "catchup"/, "x-required-by-origin");
  assert.match(checkProvenance({ ...cron, missed_date: "2026-10-05" }).join(), /\/missed_date: only origin catchup may carry it/, "x-allowed-only-by-origin");
  assert.match(checkProvenance({ ...cron, trigger: "admin-api" }).join(), /\/trigger: origin "cron" goes with trigger "scheduled"/, "x-trigger-by-origin");
});
