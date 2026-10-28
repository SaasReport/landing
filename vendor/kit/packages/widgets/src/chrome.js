/**
 * The runtime's own interface words per locale (buttons, states, screen-reader labels): chrome, not content, kept in
 * the locale packs (src/locales/*.js). A project overrides any of them in its site page config
 * (`content.<locale>.chrome`). Everything a widget says about the project comes from widgets.generated.json.
 */
import en from "./locales/en.js";
import fa from "./locales/fa.js";
import ar from "./locales/ar.js";

export const CHROME = { en, fa, ar };

/** The interface words for a locale: the kit's packs, the registry's plugin words (a project plugin's own `chrome`), then the page's overrides. */
export const chromeFor = (code, overrides = {}, registry = null) => {
  const pack = CHROME[String(code).slice(0, 2)] || {};
  const lang = String(code).slice(0, 2);
  const plug = { a: {}, words: {} };
  for (const pl of registry?.plugins() || []) {
    const w = pl.chrome?.[lang] || pl.chrome?.en;
    if (w) { plug.a[pl.id] = w.title; Object.assign(plug.words, w.words || {}); }
  }
  return { ...CHROME.en, ...plug.words, ...pack, ...overrides, a: { ...CHROME.en.a, ...plug.a, ...(pack.a || {}), ...(overrides.a || {}) }, ch: { ...CHROME.en.ch, ...(pack.ch || {}), ...(overrides.ch || {}) }, beats: { ...CHROME.en.beats, ...(pack.beats || {}), ...(overrides.beats || {}) } };
};
export const fillIn = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
