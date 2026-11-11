/**
 * Piper-style HTTP TTS service with Ed25519-signed requests. It returns raw CBR MP3 frames and
 * reports x-duration-ms and x-line-start-ms headers.
 *   env.TTS_URL          service base URL (or config.tts.url)
 *   env.TTS_SIGNING_KEY  Ed25519 PKCS#8 private key, base64 (the service holds the public half)
 *   env.HF_TOKEN         optional bearer token (private Hugging Face Space)
 * Signature: base64url(Ed25519(`${timestamp}.${sha256hex(body)}`)); header names via tts.signatureHeaders.
 */
import { isMp3, BITRATE } from "../audio/mp3.js";
import { speak } from "../speech.js";
import { voiceFor, envNames, lang } from "../config.js";

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const DEFAULT_SIGNATURE_HEADERS = { timestamp: "x-kit-timestamp", signature: "x-kit-signature" };
export const ttsUrl = (config, env = {}) => String(env[envNames(config).url] || config?.tts?.url || "").replace(/\/$/, "");

let keyCache;
async function signingKey(src) {
  if (!keyCache || keyCache.src !== src) keyCache = { src, key: await crypto.subtle.importKey("pkcs8", b64(src), { name: "Ed25519" }, false, ["sign"]) };
  return keyCache.key;
}

/** Headers for a signed request body. */
export async function signedHeaders(env, body, config) {
  const names = envNames(config), hdr = { ...DEFAULT_SIGNATURE_HEADERS, ...(config?.tts?.signatureHeaders || {}) };
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const sig = await crypto.subtle.sign("Ed25519", await signingKey(env[names.signingKey]), new TextEncoder().encode(`${ts}.${digest}`));
  const h = { "content-type": "application/json", [hdr.timestamp]: ts, [hdr.signature]: b64url(new Uint8Array(sig)) };
  if (env[names.hfToken]) h.authorization = `Bearer ${env[names.hfToken]}`;
  return h;
}

export function piperRequest(config, lines, { first = false, last = false } = {}) {
  const locale = lang(config);
  return {
    lines: lines.map((l, i) => ({ voice: voiceFor(config, l.speaker), text: speak(l.text, locale, config?.tts?.terms), pause_ms: i === lines.length - 1 && !last ? 450 : 380 })),
    lead_ms: first ? 300 : 0, tail_ms: last ? 700 : 0,
  };
}

export async function synthesizePiper(env, lines, { config, first = false, last = false, fetch: f = globalThis.fetch } = {}) {
  const base = ttsUrl(config, env);
  if (!base) throw new Error(`piper tts: ${envNames(config).url} is not set`);
  const body = JSON.stringify(piperRequest(config, lines, { first, last }));
  const res = await f(`${base}/v1/synthesize`, { method: "POST", headers: await signedHeaders(env, body, config), body });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);   // the status is the error; the body is only detail
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isMp3(bytes)) throw new Error("tts returned something that is not MP3");
  const durationMs = Number(res.headers.get("x-duration-ms")) || Math.round((bytes.length * 8000) / BITRATE);
  const starts = (res.headers.get("x-line-start-ms") || "").split(",").filter(Boolean).map(Number);
  return { bytes, durationMs, starts };
}
