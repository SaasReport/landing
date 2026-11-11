/**
 * synthesize(env, lines, {config, first, last}) → {bytes (MP3), durationMs, starts[]}
 * The provider comes from config.tts.provider (env.TTS_PROVIDER overrides per deployment).
 */
import { synthesizeGemini, perPartSpeakers, geminiModel } from "./gemini.js";
import { synthesizePiper, ttsUrl } from "./piper.js";
import { synthesizeGradio } from "./gradio.js";
import { providerName, envNames } from "../config.js";
import { chunkLines } from "../audio/chunk.js";

export const PROVIDERS = { gemini: synthesizeGemini, piper: synthesizePiper, gradio: synthesizeGradio };

export async function synthesize(env, lines, opts = {}) {
  const name = providerName(opts.config, env), fn = PROVIDERS[name];
  if (!fn) throw new Error(`unknown tts provider "${name}" (gemini, piper, gradio)`);
  return fn(env, lines, opts);
}

/** Whether the secrets the configured provider needs are present. */
export function ttsConfigured(config, env = {}) {
  const n = envNames(config), p = providerName(config, env);
  if (p === "gemini") return Boolean(env[n.geminiKey]);
  if (p === "gradio") return Boolean(ttsUrl(config, env) && env[n.hfToken]);
  return Boolean(ttsUrl(config, env) && env[n.signingKey]);
}

/** Lines per TTS request for the provider (config.tts.chunk {lines, chars} overrides). */
export function chunkLimits(config, env = {}) {
  const o = config?.tts?.chunk;
  if (o?.lines && o?.chars) return o;
  const p = providerName(config, env);
  if (p === "gradio") return { lines: 5, chars: 900 }; // GPU calls run inside a ZeroGPU window
  if (p === "gemini") return perPartSpeakers(geminiModel(config, env)) ? { lines: 10, chars: 1500 } : { lines: 40, chars: 4000 };
  return { lines: 12, chars: 2400 };
}

export const chunkFor = (config, env, lines) => { const c = chunkLimits(config, env); return chunkLines(lines, c.lines, c.chars); };

export { synthesizeGemini, geminiRequest, perPartSpeakers, geminiModel, speakerLabel, GEMINI_DEFAULT_MODEL, DEFAULT_STYLE } from "./gemini.js";
export { synthesizePiper, piperRequest, signedHeaders, ttsUrl, DEFAULT_SIGNATURE_HEADERS } from "./piper.js";
export { synthesizeGradio, gradioRequest } from "./gradio.js";
