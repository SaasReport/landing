// The site project (docs/SITE.md): tokens, pages and content are data files; this file only wires them to the kit.
import { renderWidget, chromeFor } from "@saasreport/widgets";
import tokens from "./tokens.json" with { type: "json" };
import copy from "./content/copy.json" with { type: "json" };
import pages from "./content/generated/pages.en.json" with { type: "json" };
import chrome from "./content/generated/chrome.en.json" with { type: "json" };
import generated from "./content/generated/widgets.generated.json" with { type: "json" };

const { _note, ...color } = tokens;
/** The colour tokens, for `kit check tokens` (kit.canon.json). */
export const brand = { color: color.color };
const locale = generated.locales[0];
const widget = (b) => {
  const w = generated.widgets.find((x) => x.id === b.id && x.locale === locale.code);
  if (!w) throw new Error(`no widget "${b.id}" in widgets.generated.json`);
  return renderWidget(w, { locale, labels: generated.labels?.[locale.code], chrome: chromeFor(locale.code, b.chrome || {}), level: 4, embed: true });
};

export default {
  name: "SaasReport",
  url: "https://saasreport.ai",
  locales: [{ code: "en", path: "/" }],
  timeZone: "UTC",
  namespace: { global: "SaasReport", key: "saasreport" },
  tokens: {
    ...color,
    logo: { nav: { src: "/brand/logo.svg", width: 198, height: 45 }, footer: { src: "/brand/logo.svg", width: 198, height: 45 }, icon: { src: "/brand/icon.svg", width: 45, height: 45 } },
    icons: [{ rel: "icon", href: "/brand/icon.svg", type: "image/svg+xml" }],
    manifest: null,
  },
  landing: false,
  content: { en: {} },
  out: "dist",
  sitemap: true,
  assets: { "totop.js": {} },
  pageChrome: { strings: { en: { footer: chrome.footer } }, cta: { en: [chrome.cta] } },
  pages: [
    { type: "content", path: "/", pages: { en: pages }, renderers: { widget }, content: { en: {} } },
    { type: "widgets", path: "/examples/", generated, content: { en: { meta: { title: copy.widgets.page.title, description: copy.widgets.page.metaDescription } } } },
  ],
};
