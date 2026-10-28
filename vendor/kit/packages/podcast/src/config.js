import { formatNumber } from "@saasreport/format";
/** Small readers over the normalized kit config (defineConfig output); tolerant of partial configs. */

/** "fa-IR" → "fa". */
export const lang = (config) => String(config?.site?.locale || "en").toLowerCase().split(/[-_]/)[0];

/** Host keys in config order (the first is the host, the second the expert by convention). */
export const hostKeys = (config) => Object.keys(config?.hosts || {});

/** Map a content speaker key ("host" / "expert" or a config.hosts key) to a config.hosts key. */
export function speakerKey(config, key) {
  const keys = hostKeys(config);
  if (!keys.length || keys.includes(key)) return key;
  if (key === "host" || key === "h" || key === 0) return keys[0];
  if (key === "expert" || key === "e" || key === 1) return keys[1] ?? keys[0];
  throw new Error(`unknown speaker "${key}" (hosts: ${keys.join(", ")})`);
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
/**
 * Voice for a speaker: config.tts.voices[key] (provider-specific), else config.hosts[key].voice.
 * Per-locale voices: tts.voices = { en: { host: "Kore", … }, ar: { host: "Despina", … } } (keyed by locale code or language),
 * and hosts[key].voice = { en: "…", ar: "…" }; a multi-locale config resolves them per locale before they get here.
 */
export function voiceFor(config, key) {
  const loc = config?.site?.localeKey, l = lang(config);
  const perLocale = (v) => (isObj(v) ? v[loc] ?? v[l] ?? v[config?.site?.locale] : v);
  const voices = config?.tts?.voices;
  const table = isObj(voices) && (isObj(voices[loc]) || isObj(voices[l])) ? voices[loc] ?? voices[l] : voices;
  return perLocale(table?.[key]) ?? perLocale(config?.hosts?.[key]?.voice) ?? key;
}

/** Env variable names for secrets and vars (overridable via config.tts.env). */
export const envNames = (config) => ({
  geminiKey: "GEMINI_API_KEY", signingKey: "TTS_SIGNING_KEY", hfToken: "HF_TOKEN", url: "TTS_URL",
  provider: "TTS_PROVIDER", model: "GEMINI_TTS_MODEL", ...(config?.tts?.env || {}),
});

/** Provider name: config.tts.provider, overridable per deployment by env.TTS_PROVIDER. */
export const providerName = (config, env = {}) => env[envNames(config).provider] || config?.tts?.provider || "gemini";

export const seriesById = (config, id) => (config?.series || []).find((s) => s.id === id) || null;

/** Show of a series (config.shows[series.podcast.show]) with its id. */
export function showFor(config, series) {
  const id = series?.podcast?.show ?? series?.id;
  const show = config?.shows?.[id];
  return show ? { id, ...show } : { id, title: config?.site?.name || id };
}

/** Longest a series' episodes may run, in ms (null: no limit). */
export function maxMsFor(config, series) {
  const s = typeof series === "string" ? seriesById(config, series) : series;
  const sec = s?.podcast?.maxSeconds ?? config?.shows?.[s?.podcast?.show]?.maxSeconds;
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

/**
 * Publish-or-review decision for a rendered episode.
 * @returns {{ok: boolean, totalMs: number, limitMs: number|null, reason: string|null}}
 */
export function durationDecision(totalMs, maxSeconds) {
  const limitMs = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds * 1000 : null;
  if (limitMs == null || totalMs <= limitMs) return { ok: true, totalMs, limitMs, reason: null };
  return { ok: false, totalMs, limitMs, reason: `audio is ${Math.round(totalMs / 1000)} s, over the ${limitMs / 1000} s limit` };
}

/** Format a number with the locale's digits (no grouping): @saasreport/format (CONSTITUTION.md §7). */
export const num = (config, n) => formatNumber(n, config?.site?.locale || "en", { grouping: false });

/** Replace {placeholders}; unknown ones are left as they are. */
export const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
