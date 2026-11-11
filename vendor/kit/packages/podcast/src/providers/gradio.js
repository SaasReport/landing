/**
 * Gradio app (e.g. a Hugging Face ZeroGPU Space) via the queue API: submit, read the SSE result,
 * then download the MP3 it produced. The app's `synthesize` endpoint takes one JSON string
 * {lines: [{voice, text}], pause_ms} and returns [file, meta-json {duration_ms, line_start_ms}].
 *   env.TTS_URL (or config.tts.url), env.HF_TOKEN (pays the ZeroGPU quota)
 */
import { readBounded, readBoundedText, readBoundedJson, BodyError } from "@saasreport/uploads/bounded";
import { isMp3 } from "../audio/mp3.js";
import { speak } from "../speech.js";
import { voiceFor, envNames, lang } from "../config.js";
import { ttsUrl } from "./piper.js";

export function gradioRequest(config, lines) {
  const locale = lang(config);
  return { lines: lines.map((l) => ({ voice: voiceFor(config, l.speaker), text: speak(l.text, locale, config?.tts?.terms) })), pause_ms: 380 };
}

/** Bounds on what the TTS server may send back: the audio it produced, its queue answers. */
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * The URL of the produced file. The server's reply names it, so it is not operator configuration: it must be on the origin the
 * request went to (the Hugging Face token travels with it), whatever the reply says.
 */
export function fileUrl(base, file) {
  const origin = new URL(base).origin;
  let url;
  try { url = new URL(file?.url || `${base}/gradio_api/file=${file?.path}`, `${base}/`); } catch { throw new Error("tts file: the server returned an unusable file reference"); }
  if (url.origin !== origin || url.username || url.password) throw new Error(`tts file: the server pointed at ${url.origin}, not ${origin}`);
  return url.href;
}

const bounded = async (promise, read) => {
  try { return await read(await promise); } catch (e) { if (e instanceof BodyError) throw new Error(`tts reply ${e.code}`); throw e; }
};

export async function synthesizeGradio(env, lines, { config, fetch: f = globalThis.fetch } = {}) {
  const base = ttsUrl(config, env), names = envNames(config);
  if (!base) throw new Error(`gradio tts: ${names.url} is not set`);
  const endpoint = config?.tts?.endpoint ?? "synthesize";
  const auth = env[names.hfToken] ? { authorization: `Bearer ${env[names.hfToken]}` } : {};
  const payload = JSON.stringify(gradioRequest(config, lines));
  // redirect "manual": a 3xx is a failure here, never followed with the token
  const sub = await f(`${base}/gradio_api/call/${endpoint}`, { method: "POST", redirect: "manual", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ data: [payload] }) });
  if (!sub.ok) throw new Error(`tts submit ${sub.status}: ${(await sub.text().catch(() => "")).slice(0, 200)}`);   // the status is the error; the body is only detail
  const { event_id } = (await bounded(sub, (r) => readBoundedJson(r, { maxBytes: MAX_REPLY_BYTES, contentLength: "optional" }))).value;
  const eventRes = await f(`${base}/gradio_api/call/${endpoint}/${encodeURIComponent(event_id)}`, { headers: auth, redirect: "manual" });
  if (!eventRes.ok) throw new Error(`tts result ${eventRes.status}`);
  const sse = (await bounded(eventRes, (r) => readBoundedText(r, { maxBytes: MAX_AUDIO_BYTES, contentLength: "optional" }))).text;
  const events = [...sse.matchAll(/event: (\w+)\ndata: (.*)/g)];
  const done = events.find(([, e]) => e === "complete");
  if (!done) throw new Error(`tts failed: ${(events.find(([, e]) => e === "error")?.[2] || sse).slice(0, 300)}`);
  const [file, meta] = JSON.parse(done[2]);
  const res = await f(fileUrl(base, file), { headers: auth, redirect: "manual" });
  if (!res.ok) throw new Error(`tts file ${res.status}`);
  const { bytes } = await bounded(res, (r) => readBounded(r, { maxBytes: MAX_AUDIO_BYTES, contentLength: "optional" }));
  if (!isMp3(bytes)) throw new Error(`tts file ${res.status}`);
  const m = typeof meta === "string" ? JSON.parse(meta) : meta || {};
  return { bytes, durationMs: m.duration_ms, starts: m.line_start_ms || [] };
}
