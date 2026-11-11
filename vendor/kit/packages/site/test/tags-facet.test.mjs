// The tag vocabulary as a facet of the static search index: pages name their topics in <meta name="kit:tags"> (docs/TAGS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSearchIndex, searchIndex, checkProject } from "../src/index.js";
import { compileVocabulary, searchFacet } from "../../core/src/tags.js";
import sample from "../../../examples/site-sample/site.config.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const VOCAB = compileVocabulary({
  schema: "kit.content-tags.v1", locales: ["en"], groups: [{ id: "g", label: { en: "G" } }],
  tags: [{ id: "payments", label: { en: "Payments" }, group: "g", colour: "chart1", description: { en: "Moving money" } }, { id: "legal", label: { en: "Legal" }, group: "g", colour: "chart2", description: { en: "Rules" } },
    { id: "unused", label: { en: "Unused" }, group: "g", colour: "chart3", description: { en: "No page" } }],
}, { locale: "en" });
const page = (title, tags) => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}">${tags ? `<meta name="kit:tags" content="${tags}">` : ""}</head><body><main><h1>${title}</h1><p>Text of ${title}.</p></main></body></html>`;
function site(pages) {
  const out = fileTempDir("kit-tagfacet-");
  for (const [path, html] of Object.entries(pages)) { mkdirSync(join(out, path), { recursive: true }); writeFileSync(join(out, path, "index.html"), html); }
  return out;
}

test("the index gets a `tags` facet with the tags some page names, and every page lists its own", () => {
  const out = site({ a: page("Alpha", "payments legal"), b: page("Beta", "legal"), c: page("Gamma", "") });
  const idx = searchIndex(out, { tags: searchFacet(VOCAB, "Topics") });
  assert.deepEqual(checkSearchIndex(idx), []);
  const f = idx.facets.find((x) => x.id === "tags");
  assert.equal(f.label, "Topics");
  assert.deepEqual(f.values.map((v) => v[0]), ["payments", "legal"], "a tag no page names is not a value");
  const at = (url) => idx.meta[idx.pages.findIndex((p) => p[0] === url)][2].map((pos) => f.values.find((v) => v[2] === pos)[0]);
  assert.deepEqual(at("/a/"), ["payments", "legal"]);
  assert.deepEqual(at("/b/"), ["legal"]);
  assert.deepEqual(at("/c/"), []);
});

test("must fail: a page names a tag outside the vocabulary; a project facet named tags", () => {
  const out = site({ a: page("Alpha", "payments nonsense") });
  assert.throws(() => searchIndex(out, { tags: searchFacet(VOCAB, "Topics") }), /"nonsense", which is not in the tag vocabulary/);
  const out2 = site({ a: page("Alpha", "payments") });
  assert.throws(() => searchIndex(out2, { tags: searchFacet(VOCAB, "Topics"), facets: [{ id: "tags", label: "X", values: [{ id: "v", label: "V", match: { words: ["alpha"] } }] }] }), /vocabulary owns that id/);
});

test("without a vocabulary the index is as before; the search config accepts the facet and refuses a malformed one", () => {
  const out = site({ a: page("Alpha", "payments") });
  assert.equal(searchIndex(out, {}).facets.some((f) => f.id === "tags"), false);
  assert.deepEqual(checkProject({ ...sample, search: { tags: searchFacet(VOCAB, "Topics") } }), []);
  assert.ok(checkProject({ ...sample, search: { tags: { label: "T", values: [{ id: "Bad Id", label: "x" }] } } }).length);
});
