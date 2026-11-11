// The page registry (src/registry.js, src/registry-markup.js): one canonical record per page, generated from a
// project's pages and taxonomy; the menu, hubs, crumbs, related links, sitemap, llms sections and search index come
// from it, and its checks fail on orphans, duplicates and mislabels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, registryMenu, checkMenu, checkRegistry, registrySitemap, registryLlms, hubMembers, shortLabel, decorateHtml, decorateSite, searchIndex, navReach, validateSchema, REGISTRY_SCHEMA } from "../src/index.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const taxonomy = {
  browse: "/browse/",
  home: { url: "/", label: "Home" },
  titleStrip: ["\\s*\\|\\s*Acme$"],
  sections: [
    { id: "platform", label: "Platform", hub: "/platform/", groups: [
      { id: "how", label: "How it works", match: { sources: ["legacy:how"], paths: ["/how/**"] } },
      { id: "concepts", label: "Concepts", hub: "/concepts/", match: { paths: ["/concepts/**"], words: ["concept"] } },
    ] },
    { id: "rules", label: "Rules", groups: [
      { id: "privacy", label: "Privacy rules", match: { within: ["/rules/*/"], words: ["privacy"] } },
      { id: "other", label: "Other rules", match: { within: ["/rules/**"] } },
    ] },
    { id: "more", label: "More", groups: [{ id: "misc", label: "Everything else", match: { within: ["/**"] } }] },
  ],
  fallback: { section: "more", group: "misc" },
  facets: [{ id: "audience", label: "Audience", values: [{ id: "dev", label: "Developers", synonyms: ["engineer"], match: { words: ["API"] } }, { id: "nobody", label: "Nobody", match: { paths: ["/nowhere/"] } }] }],
  contentType: { id: "type", label: "Content type", values: [{ id: "rule", label: "Rule", visual: "chain", match: { paths: ["/rules/*/"] } }, { id: "page", label: "Page", match: { within: ["/**"] } }] },
  synonyms: [["agent", "bot"]],
};
const pages = [
  { url: "/", title: "Acme | Acme" },
  { url: "/platform/", title: "Platform | Acme" },
  { url: "/concepts/", title: "Concepts — the model | Acme" },
  { url: "/how/decide/", title: "Decide: one API call | Acme", summary: "The API that decides.", related: ["/rules/gdpr/"] },
  { url: "/how/seal/", title: "Seal | Acme", tags: ["legacy:how"] },
  { url: "/concepts/scope/", title: "Scope | Acme" },
  { url: "/rules/gdpr/", title: "GDPR — privacy regulation | Acme" },
  { url: "/rules/sox/", title: "SOX | Acme" },
  { url: "/about/", title: "about us | Acme" },
  { url: "/admin/", title: "Admin | Acme", index: false },
];
const reg = buildRegistry({ pages, taxonomy });
const P = new Map(reg.pages.map((p) => [p.url, p]));

test("the registry is valid kit.page-registry.v1, one entry per page plus the generated hubs and facet pages", () => {
  assert.deepEqual(validateSchema(reg, REGISTRY_SCHEMA), []);
  for (const u of ["/browse/", "/browse/rules/", "/browse/rules/privacy/", "/browse/platform/how/", "/browse/audience/", "/browse/audience/dev/", "/browse/type/rule/"]) assert.ok(P.get(u)?.generated, u);
  assert.equal(P.get("/browse/audience/nobody/"), undefined, "a facet value no page has is left out");
  assert.deepEqual(checkRegistry(reg), []);
});

test("every indexable page is in exactly one group: rule strength, within areas, fallback", () => {
  assert.equal(P.get("/how/seal/").group, "how");
  assert.equal(P.get("/rules/gdpr/").group, "privacy", "words inside the area beat the area's catch-all");
  assert.equal(P.get("/rules/sox/").group, "other");
  assert.equal(P.get("/about/").group, "misc");
  assert.equal(P.get("/concepts/").kind, "group", "an existing page can be a group's hub");
  assert.equal(P.get("/admin/").group, undefined, "noindex pages are in no hub");
  assert.deepEqual(hubMembers(reg, "/browse/rules/privacy/").map((p) => p.url), ["/rules/gdpr/"]);
});

test("labels, crumbs, facets, content type, related and previous / next", () => {
  assert.equal(P.get("/").label, "Home");
  assert.equal(P.get("/how/decide/").label, "Decide");
  assert.equal(P.get("/about/").label, "About us");
  assert.equal(shortLabel("Acme — Platform · eight modules", ["^Acme\\s*—\\s*"]), "Platform");
  assert.deepEqual(P.get("/how/decide/").crumbs, ["/", "/platform/", "/browse/platform/how/", "/how/decide/"]);
  assert.deepEqual(P.get("/how/decide/").facets.audience, ["dev"]);
  assert.equal(P.get("/rules/gdpr/").contentType, "rule");
  assert.equal(P.get("/rules/gdpr/").visual, "chain");
  assert.ok(P.get("/how/decide/").related.includes("/rules/gdpr/"), "the page's own related come first");
  const how = hubMembers(reg, "/browse/platform/how/").map((p) => p.url);
  assert.equal(P.get(how[0]).next, how[1]);
  assert.equal(P.get("/browse/audience/dev/").title, "Audience: Developers");
});

test("the menu: one section per taxonomy section, groups link their hubs, labels are the targets' own; checkMenu catches duplicates and mislabels", () => {
  const menu = registryMenu(reg, { perGroup: 2 });
  assert.deepEqual(menu.map((s) => s.label), ["Platform", "Rules", "More", "Browse"]);
  assert.equal(menu[0].groups[1].href, "/concepts/");
  assert.deepEqual(checkMenu(menu, reg), []);
  const bad = structuredClone(menu);
  bad[0].groups[0].items.push({ label: "Seal", href: "/how/seal/" });
  bad[1].groups[0].items[0].label = "Products · Overview";
  const problems = checkMenu(bad, reg);
  assert.ok(problems.some((p) => p.startsWith("duplicate: /how/seal/")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith('mislabel: "Products · Overview"')), problems.join("\n"));
});

test("sitemap and llms sections list exactly the indexable pages", () => {
  const xml = registrySitemap(reg, { origin: "https://acme.test", lastmod: "2026-10-02" });
  assert.equal((xml.match(/<loc>/g) || []).length, reg.pages.filter((p) => p.index).length);
  assert.ok(!xml.includes("/admin/"));
  const llms = registryLlms(reg);
  assert.deepEqual(llms.map((s) => s.title), ["Platform", "Rules", "More"]);
  assert.ok(llms[0].links.some((l) => l.url === "/how/decide/"));
});

test("decorateHtml: crumbs, hub listing, facets, related, BreadcrumbList; idempotent; decorateSite + searchIndex v2 + navReach on a built site", (t) => {
  const html = (title) => `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="https://acme.test/x/"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},{"@type":"BreadcrumbList","itemListElement":[]}]}</script></head><body><main><h1>${title}</h1></main></body></html>`;
  const a = decorateHtml(html("Decide"), P.get("/how/decide/"), reg, { origin: "https://acme.test" });
  assert.match(a, /<nav class="kreg-crumbs"[\s\S]*href="\/platform\/">Platform<\/a>[\s\S]*aria-current="page">Decide</);
  assert.match(a, /class="kreg-chip" href="\/browse\/audience\/dev\/"/);
  assert.match(a, /"@type":"BreadcrumbList","itemListElement":\[\{"@type":"ListItem","position":1,"name":"Home"/);
  assert.equal((a.match(/BreadcrumbList/g) || []).length, 1);
  assert.equal(decorateHtml(a, P.get("/how/decide/"), reg, { origin: "https://acme.test" }), a);
  const hub = decorateHtml(html("How"), P.get("/browse/platform/how/"), reg, {});
  assert.match(hub, /class="kreg-hub"[\s\S]*href="\/how\/decide\/"/);

  const out = tempDir(t, "kreg-");
  for (const p of reg.pages) { const d = join(out, p.url); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "index.html"), html(p.title).replace("https://acme.test/x/", `https://acme.test${p.url}`).replace("<head>", p.index ? "<head>" : '<head><meta name="robots" content="noindex">')); }
  const r = decorateSite(out, reg, { origin: "https://acme.test" });
  assert.deepEqual(r.missing, []);
  const idx = searchIndex(out, { registry: reg });
  assert.equal(idx.v, 2);
  assert.equal(idx.pages.length, reg.pages.filter((p) => p.index).length);
  assert.equal(idx.meta.length, idx.pages.length);
  assert.deepEqual(idx.synonyms, [["agent", "bot"]]);
  assert.ok(idx.facets[0].values.some((v) => v[0] === "dev" && v[3]?.includes("engineer")));
  const { orphans } = navReach(out, { menu: registryMenu(reg), urls: reg.pages.filter((p) => p.index).map((p) => p.url), depth: 3 });
  assert.deepEqual(orphans, []);
  assert.match(readFileSync(join(out, "how/decide/index.html"), "utf8"), /data-kreg="1"/);
});

test("a clash with the page's own parent is qualified by where it sits, never \"X (X)\"", () => {
  const tx = { ...taxonomy, sections: [{ id: "learn", label: "Learn", groups: [{ id: "glossary", label: "Glossary", hub: "/glossary/", match: { paths: ["/glossary/**", "/learn/glossary/"] } }] }, ...taxonomy.sections.slice(1)] };
  const r = buildRegistry({ pages: [{ url: "/", title: "Acme" }, { url: "/glossary/", title: "Glossary | Acme" }, { url: "/learn/glossary/", title: "Glossary | Acme" }], taxonomy: { ...tx, facets: [], synonyms: [] } });
  const labels = r.pages.filter((p) => p.index).map((p) => p.label);
  assert.ok(labels.includes("Glossary (Learn)"), labels.join(", "));
  assert.ok(!labels.some((l) => /^(.+) \(\1\)$/.test(l)), labels.join(", "));
});

test("buildRegistry refuses a hub that is not a page and an invalid taxonomy", () => {
  assert.throws(() => buildRegistry({ pages, taxonomy: { ...taxonomy, sections: [{ ...taxonomy.sections[0], hub: "/nope/" }, ...taxonomy.sections.slice(1)] } }), /hub \/nope\/ is not a page/);
  assert.throws(() => buildRegistry({ pages, taxonomy: { ...taxonomy, fallback: undefined } }), /kit.taxonomy.v1/);
});

test("search terms fold case, accents, brand marks and Arabic-script variants the way the browser folds queries", async () => {
  const { searchTerms } = await import("../src/index.js");
  assert.deepEqual(searchTerms("ACME™ Évidence"), ["acme", "evidence"]);
  assert.deepEqual(searchTerms("كتاب يك ۱۲۳ پرداخت‌ها"), ["کتاب", "یک", "123", "پرداختها"]);
});
