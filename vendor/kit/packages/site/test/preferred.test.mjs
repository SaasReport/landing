// "Add to Google preferred sources": config-driven (project.preferredSource, schema-validated), the domain from the
// config (default: the host of project.url), words per locale with the locale's digits; the site-config schema carries
// the same schema as the package (one source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject, preferredSourceCard, preferredHref, PREFERRED_SOURCE_SCHEMA } from "../src/index.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;
const WORDS = { title: "Add {name} to Google", text: "See {domain} first, in 2 clicks.", button: "Add to Google" };

test("preferredHref and the card: the domain from the url, words filled, the locale's digits", () => {
  assert.equal(preferredHref("example.org"), "https://google.com/preferences/source?q=example.org");
  const cfg = { placements: ["footer"], strings: { en: WORDS, ar: { ...WORDS, text: "{domain} 2" } } };
  const en = preferredSourceCard(cfg, { placement: "footer", code: "en", name: "Example", url: "https://www.example.org" });
  assert.match(en, /<h2 class="kpref__title" id="kpref-footer">Add Example to Google<\/h2>/);
  assert.match(en, /See example\.org first, in 2 clicks\./);
  assert.match(en, /href="https:\/\/google\.com\/preferences\/source\?q=example\.org" target="_blank" rel="noopener"/);
  const ar = preferredSourceCard(cfg, { placement: "footer", code: "ar", name: "x", url: "https://example.org", digits: (s) => s.replace(/2/g, "٢") });
  assert.match(ar, /example\.org ٢/);
  assert.equal(preferredSourceCard(cfg, { placement: "blog", code: "en", name: "x", url: "https://example.org" }), "", "not placed there");
  assert.equal(preferredSourceCard({ ...cfg, domain: "news.example.org" }, { placement: "footer", code: "en", name: "x", url: "https://example.org" }).includes("q=news.example.org"), true);
});

test("checkProject: preferredSource is schema-validated and every locale needs its words", () => {
  assert.deepEqual(checkProject({ ...sample, preferredSource: { placements: ["footer"], strings: { en: WORDS, ar: WORDS } } }), []);
  const p = checkProject({ ...sample, preferredSource: { placements: ["sidebar"], strings: { en: WORDS }, domain: "https://example.org" } });
  assert.ok(p.some((x) => x.startsWith("preferredSource/placements/0")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("preferredSource/domain")), p.join("\n"));
  assert.ok(p.includes("preferredSource.strings.ar: missing (every locale of the site needs the card's words)"), p.join("\n"));
});

test("a built site: the card in the landing's footer and every inner page's footer, per locale", () => {
  const project = { ...sample, preferredSource: { placements: ["footer"], strings: { en: WORDS, ar: { title: "أضف {name}", text: "{domain} 2", button: "أضف" } } } };
  const { files } = buildSite(project, { root: SAMPLE, write: false });
  for (const f of ["index.html", "terminal/index.html", "lab/index.html"]) assert.match(files[f], /<aside class="kpref kpref--footer"/, f);
  assert.match(files["ar/terminal/index.html"], /example\.org ٢/, "Arabic-Indic digits on the Arabic pages");
  assert.match(files["styles.css"], /\.kpref\{display:grid/);
  assert.doesNotMatch(buildSite(sample, { root: SAMPLE, write: false }).files["index.html"], /class="kpref/, "no config, no card");
});

test("the site-config schema carries the package's preferredSource schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/site-config.schema.json", import.meta.url), "utf8"));
  const { description, ...inSchema } = schema.properties.preferredSource;
  const { $schema, ...own } = PREFERRED_SOURCE_SCHEMA;
  assert.deepEqual(inSchema, own);
});
