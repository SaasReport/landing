import test from "node:test";
import assert from "node:assert/strict";
import { synthesize, geminiRequest, perPartSpeakers, chunkLimits, ttsConfigured, signedHeaders, piperRequest, isMp3 } from "../src/index.js";
import { faConfig, enConfig, tonePcm, wav, b64 } from "./fixtures.mjs";

const lines = [{ speaker: "host", text: "سلام! امروز ۳ نکته." }, { speaker: "expert", text: "بله، T+1 مهمه." }];

function mockGemini(calls, mime = "audio/L16;codec=pcm;rate=24000", data = b64(new Uint8Array(tonePcm(24000, [[400, true], [400, false], [400, true]]).buffer))) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = String(url).endsWith("/interactions")
      ? { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: mime, data }] }] }
      : { candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data } }] } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

test("perPartSpeakers only for 3.8 models", () => {
  assert.equal(perPartSpeakers("gemini-3.8-flash-tts"), true);
  assert.equal(perPartSpeakers("gemini-2.5-flash-preview-tts"), false);
});

test("gemini 3.8: documented Interactions API transcript, two voices, and PCM-to-MP3 pacing", async () => {
  const calls = [];
  const config = { ...faConfig, tts: { ...faConfig.tts, direction: "Two warm colleagues speaking natural Persian." } };
  const r = await synthesize({ GEMINI_API_KEY: "k" }, lines, { config, first: true, last: true, fetch: mockGemini(calls) });
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(init.headers["x-goog-api-key"], "k");
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.equal(body.input[0].type, "user_input");
  const turns = body.input[0].content;
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((p) => p.annotations[0].speaker), ["Host", "Expert"]);
  assert.deepEqual(turns.map((p) => p.annotations[0].type), ["speech_metadata", "speech_metadata"]);
  assert.equal(turns[0].annotations[0].style, config.tts.direction);
  assert.ok(!turns.some((p) => p.text.includes(config.tts.direction)), "style must not be spoken as transcript");
  assert.ok(!/\\d/.test(turns[0].text) && !/[۰-۹]/.test(turns[0].text), "numbers are spoken naturally");
  assert.deepEqual(body.response_format, { type: "audio", mime_type: "audio/l16", sample_rate: 24000 });
  assert.deepEqual(body.generation_config.speech_config, {
    speakers: [{ speaker: "Host", voice: "Sulafat" }, { speaker: "Expert", voice: "Orus" }],
  });
  assert.equal(body.contents, undefined, "the legacy generateContent schema must never be sent to Interactions");
  assert.ok(isMp3(r.bytes));
  assert.equal(r.durationMs, 250 + 400 + 340 + 400 + 600);
  assert.equal(r.starts.length, 2);
  assert.equal(r.starts[0], 250);
  assert.equal(r.pace.longestPauseMs, 340);
});

test("Gemini 3.8 HTTP 400 regression: unsupported optional conversational mode is never sent", async () => {
  let checked = 0;
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url).endsWith("/interactions"), true);
    // Upstream regression (23 Oct 2026): `speech_config.mode` causes 400
    // even with valid speakers; do not weaken failure detection or retry 400.
    if (Object.hasOwn(body.generation_config.speech_config, "mode"))
      return new Response(JSON.stringify({ error: { message: "unknown field mode" } }), { status: 400 });
    checked++;
    return mockGemini([])(url, init);
  };
  const result = await synthesize({ GEMINI_API_KEY: "k" }, lines,
    { config: faConfig, first: true, last: true, fetch: f });
  assert.equal(checked, 1);
  assert.ok(isMp3(result.bytes));
});

test("Gemini 3.8 fails closed if a response has no final model_output audio; earlier TTS keeps its old response adapter", async () => {
  const invalid = async () => new Response(JSON.stringify({ steps: [{ type: "tool_output", content: [{ type: "audio", data: "AAA=" }] }] }), { status: 200 });
  await assert.rejects(
    synthesize({ GEMINI_API_KEY: "k" }, lines, { config: faConfig, fetch: invalid }),
    /gemini tts 200/,
  );
  const calls = [];
  await synthesize({ GEMINI_API_KEY: "k" }, [{ speaker: "ada", text: "Hi." }, { speaker: "bob", text: "Hello." }],
    { config: enConfig, fetch: mockGemini(calls) });
  assert.match(calls[0].url, /:generateContent$/);
});
test("gemini 2.x: a single transcript with a style prompt and speaker labels", async () => {
  const calls = [];
  const pcm = tonePcm(24000, [[500, true]]);
  const r = await synthesize({ GEMINI_API_KEY: "k" }, [{ speaker: "ada", text: "Hi Bob, 3 things." }, { speaker: "bob", text: "Sure." }],
    { config: enConfig, fetch: mockGemini(calls, "audio/wav", b64(wav(pcm, 24000))) });
  const { url, body } = calls[0];
  assert.match(url, /gemini-2\.5-flash-preview-tts:generateContent$/);
  assert.equal(body.contents[0].parts.length, 1);
  const text = body.contents[0].parts[0].text;
  assert.match(text, /casual chat between two colleagues and friends, Ada \(host\) and Bob \(expert\), in everyday spoken English/);
  assert.match(text, /\n\nAda: Hi Bob, .*\nBob: Sure\.$/);
  assert.ok(!body.contents[0].parts[0].speechMetadata);
  assert.deepEqual(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.map((v) => [v.speaker, v.voiceConfig.prebuiltVoiceConfig.voiceName]), [["Ada", "Kore"], ["Bob", "Puck"]]);
  assert.equal(r.durationMs, 100 + 500 + 100, "a middle chunk joins its neighbours with the 200 ms turn gap");
});

test("gemini: a custom style and env-named secret", () => {
  const cfg = { ...enConfig, tts: { ...enConfig.tts, style: "Two friends, {hostLabel} and {expertLabel}, speak {language}." } };
  const body = geminiRequest(cfg, [{ speaker: "ada", text: "x" }]);
  assert.match(body.contents[0].parts[0].text, /^Two friends, Ada and Bob, speak English\./);
  assert.equal(ttsConfigured({ ...cfg, tts: { ...cfg.tts, env: { geminiKey: "MY_KEY" } } }, { MY_KEY: "1" }), true);
  assert.equal(ttsConfigured(cfg, {}), false);
});

test("gemini errors surface the API message", async () => {
  const f = async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
  await assert.rejects(synthesize({ GEMINI_API_KEY: "k" }, lines, { config: faConfig, fetch: f }), /gemini tts 429: .*quota/);
});

test("chunk limits per provider", () => {
  assert.deepEqual(chunkLimits(faConfig), { lines: 10, chars: 1500 });
  assert.deepEqual(chunkLimits(enConfig), { lines: 40, chars: 4000 });
  assert.deepEqual(chunkLimits({ ...faConfig, tts: { provider: "gradio" } }), { lines: 5, chars: 900 });
  assert.deepEqual(chunkLimits(faConfig, { TTS_PROVIDER: "piper" }), { lines: 12, chars: 2400 });
});

test("piper: signed request with voices from config", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pk = b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  const cfg = { ...faConfig, tts: { provider: "piper", url: "https://tts.example/" } };
  const body = JSON.stringify(piperRequest(cfg, lines, { first: true }));
  const h = await signedHeaders({ TTS_SIGNING_KEY: pk }, body, cfg);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  const sig = Buffer.from(h["x-kit-signature"].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.ok(await crypto.subtle.verify("Ed25519", kp.publicKey, sig, new TextEncoder().encode(`${h["x-kit-timestamp"]}.${digest}`)));
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.lines.map((l) => l.voice), ["amir", "ganji"]);
  assert.equal(parsed.lead_ms, 300);

  const mp3 = new Uint8Array(500); mp3[0] = 0xff; mp3[1] = 0xfb;
  let seen;
  const r = await synthesize({ TTS_SIGNING_KEY: pk }, lines, { config: cfg, fetch: async (url, init) => { seen = url; return new Response(mp3, { headers: { "x-duration-ms": "1234", "x-line-start-ms": "0,600" } }); } });
  assert.equal(seen, "https://tts.example/v1/synthesize");
  assert.equal(r.durationMs, 1234);
  assert.deepEqual(r.starts, [0, 600]);
});

/* ---------- gradio: the file URL comes from the server's reply, so it is checked like any remote input ---------- */
import { synthesizeGradio, fileUrl, MAX_AUDIO_BYTES } from "../src/providers/gradio.js";

const gradioCfg = { ...faConfig, tts: { provider: "gradio", url: "https://space.example.hf.space" } };
const mp3Bytes = () => { const m = new Uint8Array(500); m[0] = 0xff; m[1] = 0xfb; return m; };
const sse = (file) => `event: complete\ndata: ${JSON.stringify([file, { duration_ms: 1000, line_start_ms: [0] }])}\n\n`;
/** A scripted Gradio server: submit, result, then whatever `fileReply` answers for the download. */
function gradio(file, fileReply = () => new Response(mp3Bytes())) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("/gradio_api/call/synthesize")) return new Response(JSON.stringify({ event_id: "e1" }));
    if (String(url).endsWith("/gradio_api/call/synthesize/e1")) return new Response(sse(file));
    return fileReply(url, init);
  };
  f.seen = seen;
  return f;
}
const env = { HF_TOKEN: "hf_secret_token" };

test("gradio: the audio is fetched from the origin the request went to, with the token, and not followed through a redirect", async () => {
  const f = gradio({ url: "https://space.example.hf.space/gradio_api/file=/tmp/a.mp3" });
  const r = await synthesizeGradio(env, lines, { config: gradioCfg, fetch: f });
  assert.equal(r.durationMs, 1000);
  const last = f.seen.at(-1);
  assert.equal(last.url, "https://space.example.hf.space/gradio_api/file=/tmp/a.mp3");
  assert.equal(last.init.headers.authorization, "Bearer hf_secret_token");
  assert.ok(f.seen.every((s) => s.init.redirect === "manual"), "every hop is requested with redirect manual");
  const byPath = gradio({ path: "/tmp/b.mp3" });
  await synthesizeGradio(env, lines, { config: gradioCfg, fetch: byPath });
  assert.equal(byPath.seen.at(-1).url, "https://space.example.hf.space/gradio_api/file=/tmp/b.mp3");
});

test("gradio: a file URL on another origin is refused before any request, so the token never leaves (internal host, metadata, look-alike, userinfo, scheme)", async () => {
  for (const url of ["https://evil.example/steal.mp3", "http://169.254.169.254/latest/meta-data/", "https://space.example.hf.space.evil.example/a.mp3", "https://space.example.hf.space@evil.example/a.mp3", "http://space.example.hf.space/a.mp3", "https://space.example.hf.space:8443/a.mp3", "//evil.example/a.mp3", "https://user:pw@space.example.hf.space/a.mp3"]) {
    const f = gradio({ url });
    await assert.rejects(synthesizeGradio(env, lines, { config: gradioCfg, fetch: f }), /tts file/, url);
    assert.equal(f.seen.length, 2, `${url}: only submit and result were requested, never the file`);
    assert.ok(!f.seen.some((s) => /evil|169\.254/.test(s.url)));
  }
  assert.throws(() => fileUrl("https://a.example", { path: "@evil.example/x" }) && fileUrl("https://a.example", { url: "https://b.example/x" }), /tts file/);
});

test("gradio: a redirect on the file download is a failure (the token is not sent on), and an oversized or endless body is cut off", async () => {
  const redirect = gradio({ path: "/a.mp3" }, () => new Response(null, { status: 302, headers: { location: "https://evil.example/a.mp3" } }));
  await assert.rejects(synthesizeGradio(env, lines, { config: gradioCfg, fetch: redirect }), /tts file 302/);
  assert.equal(redirect.seen.length, 3);
  let pulled = 0;
  const endless = gradio({ path: "/a.mp3" }, () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024)); } })));
  await assert.rejects(synthesizeGradio(env, lines, { config: gradioCfg, fetch: endless }), /tts reply too_large/);
  assert.ok(pulled <= MAX_AUDIO_BYTES / (1024 * 1024) + 2, `pulled ${pulled} MiB of an endless body`);
  const lying = gradio({ path: "/a.mp3" }, () => new Response("x", { headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } }));
  await assert.rejects(synthesizeGradio(env, lines, { config: gradioCfg, fetch: lying }), /tts reply too_large/);
  const notMp3 = gradio({ path: "/a.mp3" }, () => new Response("<html>"));
  await assert.rejects(synthesizeGradio(env, lines, { config: gradioCfg, fetch: notMp3 }), /tts file/);
});
