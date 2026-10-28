// The site project (docs/SITE.md): tokens, content and widgets are data files; this file only wires them to the kit.
import tokens from "./tokens.json" with { type: "json" };
import copy from "./content/copy.json" with { type: "json" };
import landing from "./content/generated/landing.en.json" with { type: "json" };
import chrome from "./content/generated/chrome.en.json" with { type: "json" };
import generated from "./content/generated/widgets.generated.json" with { type: "json" };
import sdk from "./kit.sdk.json" with { type: "json" };
import { readFileSync } from "node:fs";

const { _note, ...color } = tokens;
/** The colour tokens, for `kit check tokens` (kit.canon.json). */
export const brand = { color: color.color };

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
  content: { en: landing },
  widgets: { generated },
  out: "dist",
  styles: ["/styles.css"],
  scripts: ["/landing.js", "/totop.js"],
  sitemap: true,
  assets: { "landing.js": {}, "totop.js": {} },
  pageChrome: { strings: { en: { footer: chrome.footer } }, cta: { en: [chrome.cta] } },
  pages: [
    // The API reference, rendered by the kit from the OpenAPI contract that the SDK is generated from (one contract, one source).
    { type: "reference", path: copy.developers.referencePath, specs: sdk.targets.map((t) => ({ file: t.contract.split("/").pop(), doc: JSON.parse(readFileSync(new URL(t.contract, import.meta.url), "utf8")), raw: readFileSync(new URL(t.contract, import.meta.url), "utf8") })), source: { label: "SaasReport/landing", url: "https://github.com/SaasReport/landing" }, content: { en: copy.developers.reference } },
    { type: "widgets", path: "/examples/", generated, content: { en: { meta: { title: copy.widgets.page.title, description: copy.widgets.page.metaDescription } } } },
  ],
};
