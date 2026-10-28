import en from "./locales/en.js";
import fa from "./locales/fa.js";

/** The runtime's interface words per language (a project overrides any of them); a missing language falls back to English. */
export const CHROME = { en, fa };
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] || {}, v) : v; return o; };
export const chromeFor = (code, overrides = {}) => merge(merge(CHROME.en, CHROME[String(code).slice(0, 2)] || {}), overrides);
