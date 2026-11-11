import test from "node:test";
import assert from "node:assert/strict";
import { durationDecision, maxMsFor, createPodcastWorkflow, readId3, timedLines, checkDraft, articleScript, persianGate, feedbackOf } from "../src/index.js";
import { checkProvenance } from "@saasreport/core/podcast-provenance";
import { faConfig, tonePcm, b64 } from "./fixtures.mjs";

test("durationDecision: publish within the limit, review over it, no limit when unset", () => {
  assert.deepEqual(durationDecision(80_000, 80), { ok: true, totalMs: 80_000, limitMs: 80_000, reason: null });
  const over = durationDecision(151_400, 150);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "audio is 151 s, over the 150 s limit");
  assert.equal(durationDecision(10 ** 7, null).ok, true);
  assert.equal(maxMsFor(faConfig, "daily"), 80_000);
  assert.equal(maxMsFor(faConfig, "monthly"), null);
});

test("timedLines offsets line starts across chunks", () => {
  const lines = [{ text: "a" }, { text: "b" }, { text: "c" }];
  const r = timedLines(lines, [[0, 1], [2]], [{ durationMs: 1000, starts: [0, 400] }, { durationMs: 500, starts: [0] }]);
  assert.deepEqual(r.timed.map((l) => l.start_ms), [0, 400, 1000]);
  assert.equal(r.durationMs, 1500);
});

/* ---------------------------------------------------------------- fakes */
function fakeEnv(row) {
  const rows = new Map([[row.slug, { ...row }]]), objects = new Map(), sql = [];
  const DB = {
    prepare(q) {
      return {
        bind(...a) {
          return {
            async first() { sql.push(q); return rows.get(a[0]) ? { ...rows.get(a[0]) } : null; },
            async run() {
              sql.push(q);
              const r = rows.get(a.at(-1));
              if (/SET status = 'published'/.test(q)) Object.assign(r, { status: "published", audio_key: a[0], audio_bytes: a[1], duration_ms: a[2], script_json: a[3], number: r.number ?? 1, ...(/provenance_json = \?/.test(q) ? { provenance_json: a[6] } : {}) });
              else if (/SET status = \?/.test(q)) { r.status = a[0]; const cols = [...q.matchAll(/, (\w+) = \?/g)].map((m) => m[1]).filter((c) => c !== "updated_at"); cols.forEach((c, i) => { r[c] = a[2 + i]; }); }
              return { success: true };
            },
          };
        },
      };
    },
  };
  const PODCASTS = {
    async put(k, v) { objects.set(k, new Uint8Array(v)); },
    async get(k) { const v = objects.get(k); return v && { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) }; },
    async delete(k) { objects.delete(k); },
  };
  return { env: { DB, PODCASTS, GEMINI_API_KEY: "k" }, rows, objects, sql };
}
const step = { names: [], async do(name, a, b) { this.names.push(name); return (b || a)(); } };
class Base { constructor(env) { this.env = env; } }

function withGemini(ms, fn) {
  const orig = globalThis.fetch;
  const data = b64(new Uint8Array(tonePcm(8000, [[ms, true]]).buffer));
  globalThis.fetch = async (url) => {
    const response = String(url).endsWith("/interactions")
      ? { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/l16;rate=8000", data }] }] }
      : { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=8000", data } }] } }] };
    return new Response(JSON.stringify(response));
  };
  return fn().finally(() => { globalThis.fetch = orig; });
}

const row = (over = {}) => ({ slug: "term-iban", series: "daily", number: 5, kind: "term", title: "قسمت ۵", summary: "خلاصه", source_type: "term", source_ref: "iban",
  script_json: JSON.stringify([{ speaker: "host", text: "سلام" }, { speaker: "expert", text: "درود" }]), status: "queued", published_at: null, ...over });

test("workflow publishes: chunks in R2, ID3 album = show title, timed script", async () => {
  const f = fakeEnv(row());
  const WF = createPodcastWorkflow({ config: faConfig, Base });
  const r = await withGemini(1000, () => new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }));
  assert.equal(r.status, "published");
  const saved = f.rows.get("term-iban");
  assert.equal(saved.status, "published");
  assert.equal(saved.audio_key, "podcasts/term-iban.mp3");
  assert.deepEqual([...f.objects.keys()], ["podcasts/term-iban.mp3"], "temporary chunks are removed");
  const tag = readId3(f.objects.get("podcasts/term-iban.mp3"));
  assert.equal(tag.TALB, "یک دقیقه با نمونه");
  assert.equal(tag.TPE1, "نمونه مالی");
  assert.equal(tag.TRCK, "5");
  assert.equal(JSON.parse(saved.script_json)[0].start_ms, 250);
  assert.ok(f.sql.some((q) => /MAX\(p2\.number\).*WHERE p2\.series = podcast_episodes\.series/s.test(q)), "per-series numbering");
});

test("workflow parks over-long episodes for review", async () => {
  const f = fakeEnv(row());
  const WF = createPodcastWorkflow({ config: faConfig, Base });
  const r = await withGemini(90_000, () => new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }));
  assert.equal(r.status, "review");
  assert.equal(f.rows.get("term-iban").status, "review");
  assert.match(f.rows.get("term-iban").error, /over the 80 s limit/);
  assert.equal(f.objects.size, 0);
});

test("workflow rebuilds a missing script from the content pack", async () => {
  const f = fakeEnv(row({ script_json: null }));
  const content = { daily: [{ slug: "iban", term: "IBAN", short: "x", talk: [["host", "چیه؟"], ["expert", "شماره حساب."]] }] };
  const WF = createPodcastWorkflow({ config: faConfig, content, Base });
  const r = await withGemini(1000, () => new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }));
  assert.equal(r.status, "published");
  assert.match(JSON.parse(f.rows.get("term-iban").script_json)[0].text, /قسمت ۵/);
});

test("checkDraft keeps only numbers the source mentions", () => {
  const src = "در سال 1404 حدود ۲۰ بانک";
  const ok = { lines: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? "expert" : "host", text: i ? "آره" : "۲۰ بانک تو 1404" })) };
  assert.ok(checkDraft(JSON.stringify(ok), src, { speakers: ["host", "expert"] }).lines);
  const bad = { lines: ok.lines.map((l, i) => (i === 3 ? { ...l, text: "۳۰ بانک" } : l)) };
  assert.match(checkDraft("```json\n" + JSON.stringify(bad) + "\n```", src).error, /line 4 mentions 30/);
  assert.match(checkDraft(JSON.stringify({ lines: ok.lines.map((l) => ({ ...l, speaker: "x" })) }), src, { speakers: ["host", "expert"] }).error, /malformed/);
  assert.equal(checkDraft("nope", src).error, "draft is not JSON");
});

test("articleScript tries models in order and wraps the draft with intro/outro", async () => {
  const good = JSON.stringify({ lines: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? "expert" : "host", text: `خط ${i % 2 ? "دو" : "یک"}` })) });
  const seen = [];
  const AI = { async run(model, input) { seen.push({ model, input }); return { response: seen.length === 1 ? "{}" : good }; } };
  const r = await articleScript({ AI }, faConfig, { title: "نوشته", summary: "خلاصه", body_md: "متن ```code``` تمام" });
  assert.equal(seen.length, 2);
  assert.equal(r.model, seen[1].model);
  assert.match(seen[0].input.messages[0].content, /«دو دقیقه نمونه»/);
  assert.match(seen[0].input.messages[1].content, /\[نمونه کد\]/);
  assert.match(r.lines[1].text, /نوشته «نوشته»/);
  assert.match(r.lines.at(-1).text, /خداحافظ/);
});

test("workflow completes the provenance record with the render facts (provider, voices, pacing, duration, longest pause)", async () => {
  const prov = { v: 1, origin: "cron", trigger: "scheduled", series: "daily", ref: "iban", spec_sha256: "a".repeat(64), created_at: "2026-10-06T02:00:00.000Z" };
  const f = fakeEnv(row({ provenance_json: JSON.stringify(prov) }));
  const WF = createPodcastWorkflow({ config: { ...faConfig, tts: { ...faConfig.tts, pacing: { maxPauseMs: 300 } } }, Base });
  await withGemini(1000, () => new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }));
  const saved = JSON.parse(f.rows.get("term-iban").provenance_json);
  assert.equal(saved.origin, "cron");
  assert.equal(saved.render.provider, "gemini");
  assert.equal(saved.render.model, "gemini-3.8-flash-tts");
  assert.deepEqual(saved.render.voices, { host: "Sulafat", expert: "Orus" });
  assert.deepEqual(saved.render.pacing, { maxPauseMs: 300 });
  assert.equal(saved.render.chunks, 1);
  assert.ok(saved.render.duration_ms > 0 && saved.render.longest_pause_ms === 0);
  assert.deepEqual(checkProvenance(saved), []);
});

test("a provider that cannot pace (piper) fails the episode when pacing is configured: no unpaced audio, no silent null", async () => {
  const f = fakeEnv(row({ provenance_json: JSON.stringify({ v: 1, origin: "cron", trigger: "scheduled", series: "daily", ref: "iban", spec_sha256: "a".repeat(64), created_at: "2026-10-06T02:00:00.000Z" }) }));
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  f.env.TTS_URL = "https://tts.example"; f.env.TTS_SIGNING_KEY = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64");
  const cfg = { ...faConfig, tts: { ...faConfig.tts, provider: "piper", pacing: { maxPauseMs: 300 } } };
  const WF = createPodcastWorkflow({ config: cfg, Base });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(Uint8Array.from({ length: 2000 }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xfb : 0)), { status: 200, headers: { "content-type": "audio/mpeg" } });
  try { await assert.rejects(new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }), /cannot apply pacing/); } finally { globalThis.fetch = orig; }
  assert.equal(f.rows.get("term-iban").status, "failed");
});

/* ------------------------------------------------- the Persian gate before TTS (docs/PERSIAN.md) */
test("Persian gate: a script with a Persian error is not voiced; the episode fails with the findings", async () => {
  const bad = JSON.stringify([{ speaker: "host", text: "سلام" }, { speaker: "expert", text: "مثلاً قسط ماشین، چک، یا سپرده." }]);
  const f = fakeEnv(row({ script_json: bad }));
  const WF = createPodcastWorkflow({ config: faConfig, Base });
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error("TTS must not be called"); };
  try { await assert.rejects(new WF(f.env).run({ payload: { slug: "term-iban" } }, { ...step, names: [] }), /^Error: persian: 1 findings before TTS/); }
  finally { globalThis.fetch = orig; }
  assert.equal(calls, 0);
  const saved = f.rows.get("term-iban");
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /line 2: fa-comma-before-conj «، » → « »/);
  assert.equal(feedbackOf(saved.error).split("\n")[0].startsWith("line 2: fa-comma-before-conj"), true);
});

test("Persian gate: articleScript sends a failing draft back once with its findings, and feeds back a previous run's", async () => {
  const draft = (t) => JSON.stringify({ lines: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? "expert" : "host", text: i === 3 ? t : (i % 2 ? "آره" : "خب") })) });
  const seen = [];
  const AI = { async run(model, input) { seen.push(input.messages); return { response: seen.length === 1 ? draft("پرداخت، رد، و ارجاع") : draft("پرداخت، رد و ارجاع") }; } };
  const gate = persianGate(faConfig);
  const r = await articleScript({ AI }, faConfig, { title: "نوشته", summary: "خلاصه", body_md: "متن" }, { check: gate, feedback: "line 9: fa-passive-tavassot «توسط» → …" });
  assert.ok(r.lines, r.error);
  assert.equal(seen.length, 2);
  assert.match(seen[0][1].content, /ایراد نگارشی فارسی[\s\S]*fa-passive-tavassot/);
  assert.equal(seen[1].at(-2).role, "assistant");
  assert.match(seen[1].at(-1).content, /fa-comma-before-conj/);
  assert.equal(persianGate({ site: { locale: "en" } }), null);
});

test("articleScript never lets a Persian draft through unchecked: with no check given it runs the project's own Persian gate (wo-0009)", async () => {
  const draft = JSON.stringify({ lines: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? "expert" : "host", text: i === 3 ? "پرداخت، رد، و ارجاع" : (i % 2 ? "آره" : "خب") })) });
  const AI = { async run() { return { response: draft }; } };
  const r = await articleScript({ AI }, faConfig, { title: "نوشته", summary: "خلاصه", body_md: "متن" }, { repairs: 0 });
  assert.equal(r.lines, undefined, "the draft with a Persian finding was accepted without a check");
  assert.match(r.error, /fa-comma-before-conj/);
});
