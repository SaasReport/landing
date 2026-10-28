// Regional strings: a British English site (site.locale en-GB) gets the kit's English words spelled the British way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translator, REGIONAL } from "../src/strings.js";
import { normalizeConfig } from "../src/config.js";
import { usSpellings } from "@saasreport/core/spelling";

test("en-GB: the kit's own English strings carry no American spelling; en-US keeps them as they are", () => {
  const cfg = (locale) => normalizeConfig({ site: { url: "https://example.org", locale } });
  const gb = translator(cfg("en-GB"));
  assert.equal(gb("form.company"), "Organisation");
  assert.deepEqual(Object.entries(gb.table).flatMap(([k, v]) => usSpellings(v).map((w) => `${k}: ${w.us}`)), []);
  assert.equal(translator(cfg("en-US"))("form.company"), "Organization");
  // the locale is canonicalised once (normalizeConfig): any spelling of the tag, with or without extensions, finds them
  for (const tag of ["en-gb", "en_GB", "EN-GB", "en-GB-u-nu-latn"]) assert.equal(translator(cfg(tag))("form.company"), "Organisation", tag);
  const x = cfg("en-gb-u-nu-latn").site;
  assert.deepEqual([x.locale, x.localeBase, x.lang, x.ogLocale], ["en-GB-u-nu-latn", "en-GB", "en", "en_GB"]);
  // a project's own strings still win over the regional ones
  assert.equal(translator({ ...cfg("en-GB"), strings: { "form.company": "Company" } })("form.company"), "Company");
  assert.ok(REGIONAL["en-GB"]);
});
