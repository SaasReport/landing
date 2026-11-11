/**
 * Multi-locale sites. One kit config can publish in several languages:
 *
 *   site: { locales: ["en", "ar"], name: { en: "Acme", ar: "أكمي" }, … }
 *
 * The first locale is the default and is served at `/`; every other locale is served at `/<locale>/`.
 * A **localized value** is a plain object whose keys are all locale codes ({ en: …, ar: … }); anywhere in the config
 * (site, hosts, tts.voices, shows, strings, series[].source, …) or in the content it resolves to the value of the locale
 * being built, falling back to the default locale's value. `series[].locales: ["en"]` limits a series to some locales.
 *
 * Content comes in either form (both can be mixed):
 *   keyed per locale   { en: { weekly: [...], daily: {...} }, ar: { weekly: [...], daily: {...} } }   (canonical)
 *   localized fields   { weekly: [{ date, title: { en, ar }, talk: { en: [...], ar: [...] }, … }] }
 * A pack keyed per locale has no fallback: a locale without its own pack publishes nothing.
 *
 * Every locale is, from there on, an ordinary single-locale config (defineConfig), so the planner, the contracts,
 * the podcast builder and the Worker run per locale unchanged. Such a config carries, in `site`:
 *   locales, defaultLocale, root (the origin URL), base ("" or "/ar") and url = root + base.
 * A config without `site.locales` (or with one locale) is a single-locale site and none of this applies.
 */

const isPlain = (v) => v != null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Is `v` a localized value ({ en: …, ar: … }: a plain object whose keys are all locale codes)? */
export function isLocalized(v, locales) {
  if (!isPlain(v) || !locales?.length) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => locales.includes(k));
}

/**
 * Resolve every localized value inside `value` for `locale` (deep; functions and class instances are kept as they are).
 * A missing locale falls back to `fallback` (the default locale).
 */
export function localize(value, locale, locales, fallback = locales?.[0]) {
  if (isLocalized(value, locales)) {
    const v = value[locale] !== undefined ? value[locale] : value[fallback];
    return localize(v, locale, locales, fallback);
  }
  if (Array.isArray(value)) return value.map((x) => localize(x, locale, locales, fallback));
  if (isPlain(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = localize(v, locale, locales, fallback);
    return out;
  }
  return value;
}

/** URL prefix of a locale: "" for the default, "/ar" for "ar", "/en-gb" for "en-GB". */
export const localeBase = (locale, defaultLocale) => (locale === defaultLocale ? "" : `/${String(locale).toLowerCase()}`);

/** The locales of a raw config ([] for a single-locale site). */
export function rawLocales(cfg) {
  const l = cfg?.site?.locales;
  return Array.isArray(l) && l.length > 1 ? l : [];
}

/**
 * The raw single-locale config of one locale (before defineConfig): localized values resolved, `series[].locales`
 * applied, and site.{locale, locales, defaultLocale, root, base, url} set.
 */
export function rawForLocale(cfg, locale) {
  const locales = rawLocales(cfg), def = locales[0];
  const tagIn = cfg.site?.locale;
  const { locales: _drop, ...siteIn } = cfg.site || {};
  const c = localize({ ...cfg, site: siteIn }, locale, locales, def);
  const root = typeof c.site?.url === "string" ? c.site.url.replace(/\/+$/, "") : c.site?.url;
  const base = localeBase(locale, def);
  // site.locale: a localized value ({ en: "en-US", ar: "ar-SA" }), the default locale's tag, or the locale code itself.
  const tag = isLocalized(tagIn, locales) ? c.site.locale : locale === def && typeof tagIn === "string" ? tagIn : locale;
  c.site = { ...c.site, locale: tag, localeKey: locale, url: typeof root === "string" ? `${root}${base}` : root, root, base, locales: [...locales], defaultLocale: def };
  if (Array.isArray(c.series)) c.series = c.series.filter((s) => !Array.isArray(s?.locales) || s.locales.includes(locale)).map((s) => {
    if (!isPlain(s) || !("locales" in s)) return s;
    const { locales: _l, ...rest } = s;
    return rest;
  });
  return c;
}

/** The locales of a normalized config ([] for a single-locale site). */
export const localesOf = (config) => (Array.isArray(config?.site?.locales) && config.site.locales.length > 1 ? config.site.locales : []);
/** Does the config publish in more than one language? */
export const isMultiLocale = (config) => localesOf(config).length > 1;
/** The default locale of a config (its site.locale for a single-locale site). */
export const defaultLocaleOf = (config) => (isMultiLocale(config) ? config.site.defaultLocale : config?.site?.locale);

/** Is this the root of a multi-locale config (defineConfig's result, holding every locale), not one locale's config? */
export const isLocaleRoot = (config) => Boolean(config?.__locales);

/** The normalized single-locale config of `locale` (the config itself for a single-locale site, or when it already is that locale's). */
export function configFor(config, locale) {
  if (!isMultiLocale(config)) return config;
  const map = config.__locales;
  if (map?.[locale]) return map[locale];
  if (config.site.localeKey === locale) return config;
  throw new Error(`unknown locale ${JSON.stringify(locale)} (site.locales: ${localesOf(config).join(", ")})`);
}

/** Is a content object keyed per locale ({ en: pack, ar: pack })? */
export const isKeyedByLocale = (config, content) => isMultiLocale(config) && isLocalized(content, localesOf(config));

const packs = new WeakMap();
/** The content pack of one locale (default: the config's own locale; the pack itself for a single-locale site). Cached per pack. */
export function contentFor(config, content, locale = config?.site?.localeKey) {
  if (!isMultiLocale(config)) return content;
  const locales = localesOf(config), def = config.site.defaultLocale;
  const key = content && typeof content === "object" ? content : null;
  const hit = key && packs.get(key)?.get(locale);
  if (hit) return hit;
  const pack = isLocalized(content, locales) ? content[locale] || {} : content || {};
  const out = localize(pack, locale, locales, def);
  if (key) { if (!packs.has(key)) packs.set(key, new Map()); packs.get(key).set(locale, out); packs.set(out, new Map([[locale, out]])); }
  return out;
}

/** A site path in a locale: localePath(config, "ar", "/blog/") → "/ar/blog/". */
export const localePath = (config, locale, path = "/") => `${isMultiLocale(config) ? localeBase(locale, config.site.defaultLocale) : ""}${path}`;

/** Per-locale entries [{ locale, config, content, base }] (one entry, locale = site.locale, for a single-locale site). */
export function eachLocale(config, content) {
  if (!isMultiLocale(config)) return [{ locale: config.site.locale, config, content, base: "" }];
  return localesOf(config).map((l) => ({ locale: l, config: configFor(config, l), content: contentFor(config, content, l), base: localeBase(l, config.site.defaultLocale) }));
}

export const locales = { isLocalized, localize, localeBase, localesOf, isMultiLocale, isLocaleRoot, defaultLocaleOf, configFor, contentFor, isKeyedByLocale, localePath, eachLocale };
