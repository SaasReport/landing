/**
 * Google Gemini TTS: one multi-speaker request per chunk; the PCM reply is padded and MP3-encoded here.
 *   3.8 models ("perPartSpeakers") take one part per line with speechMetadata.speaker;
 *   earlier TTS models take one transcript ("Speaker: text" lines) preceded by a style direction.
 * Config: tts.model, tts.voices {hostKey: voiceName}, tts.speakers {hostKey: label}, tts.style, tts.language,
 *   tts.temperature, tts.languageCode (speechConfig), tts.pacing (audio/pace.js: pauses capped, silence trimmed, levels matched).
 * Gemini TTS takes no SSML: the style direction (tts.style) steers rhythm, punctuation steers pauses (speech.js), and
 * tidyPcm() enforces the result on the audio.
 * Secret: env.GEMINI_API_KEY (name via tts.env.geminiKey).
 */
import { pcmFromInline } from "../audio/pcm.js";
import { encodeMp3 } from "../audio/mp3.js";
import { estimateStarts } from "../audio/starts.js";
import { tidyPcm, pacingOf } from "../audio/pace.js";
import { speak } from "../speech.js";
import { hostKeys, voiceFor, envNames, lang, fill } from "../config.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const perPartSpeakers = (model) => /^gemini-3\.8/.test(String(model || ""));

const LANGUAGES = { fa: "Persian", en: "English", ar: "Arabic", de: "German", fr: "French", es: "Spanish", tr: "Turkish" };
export const DEFAULT_STYLE = "This is a relaxed, casual chat between two colleagues and friends, {hostLabel} ({hostRole}) and {expertLabel} ({expertRole}), in everyday spoken {language}. Speak naturally and conversationally, like real people talking: warm, relaxed, fluid and connected, natural rhythm and intonation, quick natural turn-taking, small reactions. Never sound like a news presenter or like reading word by word.";

export const geminiModel = (config, env = {}) => env[envNames(config).model] || config?.tts?.model || GEMINI_DEFAULT_MODEL;

/** Transcript label of a speaker: tts.speakers[key], else the key capitalized (Latin labels are safest). */
export const speakerLabel = (config, key) => config?.tts?.speakers?.[key] ?? String(key).charAt(0).toUpperCase() + String(key).slice(1);

/**
 * Model-family transport adapter. Gemini 3.8 TTS requires the Interactions API
 * (/v1beta/interactions), speech_metadata annotations and a response_format.
 * Legacy 2.x / 3.1 TTS use generateContent. Both return the same PCM contract.
 * Never mix the schemas: that silently broke production podcast synthesis.
 */
export function geminiRequest(config, lines, { model = geminiModel(config), locale = lang(config) } = {}) {
  const keys = [...new Set([...hostKeys(config), ...lines.map((l) => l.speaker)])].slice(0, 2);
  const text = (l) => speak(l.text, locale, config?.tts?.terms);
  if (perPartSpeakers(model)) {
    // 3.8 reads all text verbatim: directions must be metadata, never prefixed
    // to the transcript (which would make the narrator speak them aloud).
    const style = String(config?.tts?.direction || config?.tts?.style || "").trim().slice(0, 600);
    return {
      model,
      input: [{
        type: "user_input",
        content: lines.map((l) => ({
          type: "text",
          text: text(l),
          annotations: [{
            type: "speech_metadata",
            speaker: speakerLabel(config, l.speaker),
            ...(style ? { style } : {}),
          }],
        })),
      }],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      generation_config: {
        speech_config: {
          // No `mode`: Gemini 3.8's official JS/Python Interactions examples
          // configure multi-speaker turns with `speakers` alone. The optional
          // REST `mode:"conversational"` started returning HTTP 400 on 23 Oct
          // 2026; the typed `speech_metadata` still carries speaker/style.
          speakers: keys.map((k) => ({ speaker: speakerLabel(config, k), voice: voiceFor(config, k) })),
        },
      },
    };
  }
  const [h, e] = keys;
  const style = fill(config?.tts?.style ?? DEFAULT_STYLE, {
    hostLabel: speakerLabel(config, h), expertLabel: speakerLabel(config, e),
    hostRole: config?.hosts?.[h]?.role ?? "host", expertRole: config?.hosts?.[e]?.role ?? "expert",
    language: config?.tts?.language ?? LANGUAGES[locale] ?? locale,
  });
  const contents = [{ parts: [{ text: `${style}\n\n${lines.map((l) => `${speakerLabel(config, l.speaker)}: ${text(l)}`).join("\n")}` }] }];
  const t = config?.tts;
  return {
    contents,
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(Number.isFinite(t?.temperature) ? { temperature: t.temperature } : {}),
      speechConfig: { ...(t?.languageCode ? { languageCode: t.languageCode } : {}), multiSpeakerVoiceConfig: { speakerVoiceConfigs: keys.map((k) => ({ speaker: speakerLabel(config, k), voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(config, k) } } })) } },
    },
  };
}

/** Pull the final audio block from the REST Interactions response, not the SDK-only output_audio convenience property. */
export function interactionAudio(reply) {
  const steps = Array.isArray(reply?.steps) ? reply.steps : [];
  for (const step of [...steps].reverse()) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of [...step.content].reverse()) {
      if (block?.type === "audio" && typeof block.data === "string" && block.data.length) {
        return { mime: block.mime_type || "audio/l16;rate=24000", data: block.data };
      }
    }
  }
  return null;
}

export async function synthesizeGemini(env, lines, { config, first = false, last = false, fetch: f = globalThis.fetch } = {}) {
  const model = geminiModel(config, env);
  const key = env[envNames(config).geminiKey];
  if (!key) throw new Error(`gemini tts: ${envNames(config).geminiKey} is not set`);
  const interactions = perPartSpeakers(model);
  const endpoint = interactions ? GEMINI_INTERACTIONS_ENDPOINT : `${GEMINI_ENDPOINT}/${model}:generateContent`;
  const res = await f(endpoint, {
    method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(geminiRequest(config, lines, { model })),
  });
  const responseText = await res.text();
  let out;
  try { out = JSON.parse(responseText); } catch { out = { body: responseText.slice(0, 300) }; }
  const audio = interactions
    ? interactionAudio(out)
    : (() => {
      const part = out.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      return part ? { mime: part.inlineData.mimeType, data: part.inlineData.data } : null;
    })();
  if (!res.ok || !audio) throw new Error(`gemini tts ${res.status}: ${JSON.stringify(out.error || out).slice(0, 300)}`);
  const { pcm: voice, rate } = pcmFromInline(audio.mime, audio.data);
  const pace = pacingOf(config);
  const { pcm, stats } = tidyPcm(voice, rate, { ...pace, first, last });
  const lead = first ? pace.startMs : 0;
  return {
    bytes: encodeMp3(pcm, rate, config?.tts?.kbps ?? 64),
    durationMs: Math.round((pcm.length / rate) * 1000),
    starts: estimateStarts(pcm, rate, lines, lead),
    pace: stats,
  };
}
