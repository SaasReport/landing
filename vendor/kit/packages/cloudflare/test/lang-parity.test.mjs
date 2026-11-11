// One language per site: the static pages (@saasreport/site, the locale pack's lang) and the Worker's pages (the shell,
// normalizeConfig's site.localeBase) declare the same <html lang>, in its canonical BCP 47 form, whatever the spelling
// of the configured tag ("en-gb", "en-GB-u-nu-latn").
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeKit, seed } from "./helpers.mjs";
import { buildSite } from "../../site/src/index.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;
const htmlLang = (html) => html.match(/<html\b[^>]*\blang="([^"]+)"/)?.[1];

for (const [tag, want, lang] of [["en-GB", "en-GB", "en"], ["en-gb", "en-GB", "en"], ["en-GB-u-nu-latn", "en-GB", "en"], ["fa-IR", "fa-IR", "fa"]]) {
  test(`static and Worker pages of a site with locale "${tag}" both declare <html lang="${want}">`, async () => {
    // the Worker
    const k = makeKit(lang, { config: (c) => ({ ...c, site: { ...c.site, locale: tag } }) });
    await seed(k.env, { lang });
    const worker = htmlLang(await (await k.get("/blog/")).text());
    // the static site: the same tag as the locale's lang (and hreflang) override
    const loc = sample.locales.map((x) => (typeof x === "string" ? { code: x } : x)).find((x) => x.code === "en");
    const project = { ...sample, locales: [{ ...loc, overrides: { ...(loc.overrides || {}), lang: tag, hreflang: tag } }], content: { en: sample.content.en } };
    const { files } = buildSite(project, { root: SAMPLE, write: false });
    const stat = htmlLang(files["index.html"]);
    assert.equal(worker, want, "the Worker's shell");
    if (lang === "en") assert.equal(stat, want, "the static landing");
  });
}
