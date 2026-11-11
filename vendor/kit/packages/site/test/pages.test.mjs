// Phase 2 of @saasreport/site: the template engine, the demo engines and page scripts as templates (terminal views
// chosen per project, lab missions, notify, totop), the inner pages (terminal, lab, academy, sectors, directory)
// once per locale with hreflang alternates, the sitemap per locale, and the sample's en/ar coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject, renderTemplate, createLocale, checkAssets, assetSource, TERMINAL_VIEWS, normalize } from "../src/index.js";
import { weekStartOf } from "../src/locale.js";
import { templatize } from "../tools/templatize.mjs";
import sample from "../../../examples/site-sample/site.config.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const { files, sitemap } = buildSite(sample, { root: SAMPLE });

test("templates: values, filters, lists, conditions, partials; unknown placeholders throw", () => {
  const ctx = { a: 'x"<', list: [{ n: 1, on: true }, { n: 2 }], partials: { p: "<{{.n}}>" }, L: createLocale("ar") };
  assert.equal(renderTemplate("{{a|attr}}|{{a|dq}}|{{a|tl}}", ctx), 'x&quot;&lt;|x\\"<|x"<');
  assert.equal(renderTemplate("{{#each list}}{{@n}}{{#if .on}}+{{else}}-{{/if}}{{> p}}{{#unless @last}},{{/unless}}{{/each}}", ctx), "1+<1>,2-<2>");
  assert.equal(renderTemplate("{{n|digits}} {{o|jsmap}} {{l|jslist}} {{k|jskey}} {{v|jsnum}}", { ...ctx, n: "2026", o: { a: "b" }, l: ["x", "y"], k: "a-b", v: 1250000 }), '٢٠٢٦ {"a": "b"} ["x", "y"] "a-b" 1_250_000');
  assert.throws(() => renderTemplate("{{missing}}", {}), /unknown placeholder \{\{missing\}\}/);
  assert.throws(() => renderTemplate("{{a|nope}}", ctx), /unknown filter nope/);
  assert.throws(() => renderTemplate("{{#each list}}x", ctx), /not closed/);
});

test("templatize: text in strings, template literals and markup becomes keys; the template renders back", () => {
  const src = 'const a = "سلام"; el.innerHTML = `<b title="عنوان">متن ${x} دوم</b><div style="left:${y}%;top:5%">پایان</div>`; const r = /^(بانک) /;';
  const { template, strings } = templatize(src, { prefix: "s" });
  assert.equal(Object.keys(strings).length, 6);
  assert.ok(Object.values(strings).includes("پایان"), "text after a tag split by ${…}");
  assert.ok(template.includes('style="left:${y}%;top:5%">'), "markup stays in the template");
  assert.equal(renderTemplate(template, { s: strings }), src);
});

test("the sample builds every page per locale: en at its path, ar under /ar/, with alternates and a switch", () => {
  assert.deepEqual(checkProject(sample), []);
  const pages = ["terminal/", "lab/", "academy/", "sectors/", "sectors/retail/", "sectors/manufacturing/", "sectors/marketplaces/", "directory/"];
  for (const p of pages) {
    const en = files[`${p}index.html`], ar = files[`ar/${p}index.html`];
    assert.ok(en && ar, p);
    assert.match(en, /<html lang="en" dir="ltr">/, p);
    assert.match(ar, /<html lang="ar" dir="rtl">/, p);
    for (const html of [en, ar]) {
      assert.match(html, new RegExp(`<link rel="alternate" hreflang="en" href="https://example.org/${p}">`), p);
      assert.match(html, new RegExp(`<link rel="alternate" hreflang="ar" href="https://example.org/ar/${p}">`), p);
      assert.match(html, new RegExp(`<link rel="alternate" hreflang="x-default" href="https://example.org/${p}">`), p);
    }
    assert.match(en, new RegExp(`<a class="btn btn--ghost btn--sm" href="/ar/${p}" hreflang="ar" lang="ar"[^>]*>العربية</a>`), `${p}: switch to ar`);
    assert.match(ar, new RegExp(`<a class="btn btn--ghost btn--sm" href="/${p}" hreflang="en" lang="en"[^>]*>English</a>`), `${p}: switch to en`);
  }
  assert.ok(files["directory/directory.json"] && files["ar/directory/directory.json"]);
  // each page links its own locale's scripts and styles
  assert.match(files["ar/terminal/index.html"], /<script data-cfasync="false" src="\/terminal\.ar\.js\?v=[a-f0-9]{10}" defer>/);
  assert.match(files["terminal/index.html"], /<script data-cfasync="false" src="\/terminal\.js\?v=[a-f0-9]{10}" defer>/);
  assert.match(files["ar/lab/index.html"], /<link rel="stylesheet" href="\/styles\.ar\.css\?v=/);
});

test("pages keep the CSP: external scripts only (and JSON-LD), no inline handlers; no placeholders left", () => {
  for (const [f, body] of Object.entries(files)) {
    if (f.endsWith(".html")) {
      for (const [tag] of body.matchAll(/<script\b[^>]*>/g)) assert.ok(/ src="\/[\w.-]+\.js\?v=[a-f0-9]{10}"/.test(tag) || / src="\/[\w.-]+\.js"/.test(tag) || /type="application\/ld\+json"/.test(tag), `${f}: ${tag}`);
      assert.doesNotMatch(body, /\son[a-z]+\s*=/i, f);
    }
    assert.doesNotMatch(body, /\{\{[#/>]?[\w.@-]+[|}]/, `${f}: unrendered placeholder`);
  }
});

test("generated scripts parse, per locale, with the locale's strings, digits and the project's namespace", () => {
  for (const f of Object.keys(files).filter((x) => x.endsWith(".js"))) new vm.Script(files[f], { filename: f });
  const en = files["terminal.js"], ar = files["terminal.ar.js"];
  assert.doesNotMatch(en + ar, /toLocaleString|NumberFormat/);     // numbers through @saasreport/format (KitFormat)
  assert.match(en, /KitFormat\.formatNumber\(n, "en", \{ decimals: d, numerals: "latin" \}\)/);
  assert.match(ar, /KitFormat\.digits\(v, "arabic"\)/);
  assert.match(files["index.html"], /<script data-cfasync="false" src="\/format\.js\?v=[a-z0-9]+"><\/script>\n<script/);
  assert.match(en, /window\.ExampleNotify/);
  assert.match(files["lab.js"], /const STORE_KEY = "example-lab-v1";/);
  assert.match(files["notify.js"], /window\.ExampleNotify = api;/);
  // the section index is docked in the shell's header ([data-kit-sections]); nothing floats (src/shell-markup.js)
  assert.doesNotMatch(files["totop.js"], /addEventListener\("scroll"|createElement/, "nothing floats, nothing shows or hides on scroll");
  assert.match(files["shell.js"], /data-kit-sections/);
  assert.doesNotMatch(files["shell.js"], /addEventListener\("scroll"/, "the shell never toggles on scroll");
});

test("terminal views are the project's: only those views (and the engine's helpers) are in terminal.js", (t) => {
  const js = files["terminal.js"];
  const views = [...js.matchAll(/VIEWS\.(\w+) = \{/g)].map((m) => m[1]);
  assert.deepEqual(views, ["home", "payments", "sandbox"]);
  assert.match(js, /const stream = /, "the engine's stream helper");
  assert.match(js, /const ORDER = \["home", "payments", "sandbox"\];/);
  // views come in the order given, before the shell; the kit ships only the notify view
  const dir = tempDir(t, "kit-views-");
  writeFileSync(join(dir, "ledger.js"), "  VIEWS.ledger = { fa: \"{{s.ledger.1|dq}}\", group: \"x\", hint: \"y\", render(V) {}, async play() {} };\n");
  writeFileSync(join(dir, "home.js"), "  VIEWS.home = { fa: \"Mine\", group: \"x\", hint: \"y\", render(V) {}, async play() {} };\n");
  const src = assetSource("terminal.js", { views: [{ id: "home", file: "home.js" }, "notify", { id: "ledger", file: "ledger.js" }] }, dir);
  assert.ok(src.indexOf("VIEWS.notify") > src.indexOf("VIEWS.home") && src.indexOf("VIEWS.ledger") > src.indexOf("VIEWS.notify") && src.indexOf("VIEWS.ledger") < src.indexOf("SHELL"));
  assert.match(src, /VIEWS\.home = \{ fa: "Mine"/);
  assert.deepEqual(TERMINAL_VIEWS, ["notify"]);
  assert.deepEqual(checkAssets({ "terminal.js": { views: [{ id: "home", file: "home.js" }, "payments"] } }, []), ['assets.terminal.js: view "payments" is not a kit view (notify); give the project\'s views as { id, file }']);
  assert.ok(checkAssets({ "terminal.js": { views: [{ id: "home", file: "home.js" }], strings: { en: { _shell: { commands: [[["Pay", "payments", "P"]]] } } } } }, ["en"])[0].includes('opens view "payments"'));
  assert.ok(checkAssets({ "terminal.js": {} }, [])[0].includes("the kit ships no other view"));
  // no open-finance view or lab content is left in the kit's assets
  for (const f of ["payments", "treasury", "escrow", "lending", "trade", "sukuk", "networks", "workflows"]) assert.throws(() => readFileSync(new URL(`../assets/terminal/${f}.js`, import.meta.url)), f);
  assert.ok(checkAssets({ "lab.js": {} }, [])[0].includes("project's own template"));
});

test("lab missions: the page checks only the project's missions", () => {
  const js = files["lab.js"];
  assert.match(js, /hits\.push\("list"\)/);
  assert.doesNotMatch(js, /hits\.push\("replay"\)/);
  assert.match(files["lab/index.html"], /data-lab-progress>0 of 1</);
  assert.match(files["ar/lab/index.html"], /data-lab-progress>٠ من ١</);
});

test("sectors and directory generators: cards, counts, locale digits, data-q search text, JSON", async () => {
  assert.match(files["sectors/index.html"], /data-sx-count>3 sectors</);
  assert.match(files["ar/sectors/index.html"], /data-sx-count>٣ قطاعات</);
  assert.match(files["ar/sectors/retail/index.html"], /<div class="tx-stage" data-tx-view="home"><\/div>/);
  assert.match(files["directory/index.html"], /<article class="dx-card" id="north-bank" [^>]*data-q="north bank north-bank"/);
  assert.match(files["ar/directory/index.html"], /<time datetime="2026-09-30">٣٠ سبتمبر ٢٠٢٦<\/time>/);
  const json = JSON.parse(files["directory/directory.json"]);
  assert.equal(json.count, 4);
  assert.equal(json.entries[0].url, "https://example.org/directory/#sample-regulator");
  assert.equal(JSON.parse(files["ar/directory/directory.json"]).url, "https://example.org/ar/directory/");
  // public data carries data, never CSS: each category's colour is a resolved value plus the role it comes from, and the file validates against kit.directory.v1
  for (const cat of json.taxonomy.categories) { assert.match(cat.color, /^#[0-9A-Fa-f]{6}$/); assert.match(cat.colorRole, /^(accent|ok|warn|err|chart[1-6])$/); }
  assert.ok(!/var\(--/.test(files["directory/directory.json"]), "no CSS in the public directory data");
  const { validate } = await import("../../core/src/schema.js");
  const dirSchema = JSON.parse(readFileSync(new URL("../../core/schemas/directory.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validate(json, dirSchema), [], "directory.json validates against kit.directory.v1");
  assert.equal(normalize("بانك ۱۲"), "بانک 12");
});

test("sitemap: every page per locale, with its alternates", () => {
  assert.equal(sitemap.filter((u) => u.locale === "en").length, 10);
  assert.match(files["sitemap.ar.xml"], /<loc>https:\/\/example\.org\/ar\/sectors\/retail\/<\/loc>\n    <xhtml:link rel="alternate" hreflang="en" href="https:\/\/example\.org\/sectors\/retail\/"\/>/);
});

test("locale: the week start comes from the calendar profile; Hijri dates use the configured variant", () => {
  assert.equal(weekStartOf("sa"), 0);
  assert.equal(weekStartOf(null), 1);
  assert.equal(createLocale("fa").weekdays[0], "شنبه", "fa defaults to the Jalali calendar and the Iranian bank profile: Saturday");
  assert.equal(createLocale("en").weekdays[0], "Monday");
  assert.equal(createLocale("ar", {}, { calendar: { profiles: ["sa"] } }).weekdays[0], "الأحد");
  assert.equal(createLocale("en").weekdaysShort[0], "Mon", "short weekday names for narrow screens follow the week start");
  assert.equal(createLocale("en", {}, { calendar: { profiles: ["uk"] } }).weekStart, 1);
  assert.equal(createLocale("ar").hijri, "hijri-umalqura");
  assert.equal(createLocale("ar", {}, { calendar: { systems: ["gregorian", "hijri-civil"] } }).dateIntl, "ar-u-nu-arab");
  assert.match(createLocale("ar").date("2026-03-25", { calendar: "hijri" }), /^[٠-٩]+ شوال ١٤٤٧ هـ$/);
});

test("directory.json: the schema id is fixed, content cannot override it, an invalid file fails the build, the role enum is the registry", async () => {
  const { renderDirectoryJson, CATEGORY_ROLES, DIRECTORY_SCHEMA_ID } = await import("../src/index.js");
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/directory.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.taxonomy.properties.categories.items.properties.colorRole.enum, [...CATEGORY_ROLES], "the schema enum is the site generator's role registry");
  const schemaV2 = JSON.parse(readFileSync(new URL("../../core/schemas/directory-v2.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schemaV2.properties.taxonomy.properties.categories.items.properties.colorRole.enum, [...CATEGORY_ROLES], "the v2 schema enum is the same canonical role registry");
  assert.ok(schemaV2.properties.taxonomy.properties.categories.items.required.includes("colorRole"), "the v2 contract requires its portable role");
  assert.ok(!schemaV2.properties.taxonomy.properties.categories.items.properties.color, "the v2 contract must not offer resolved brand colours");
  assert.equal(schema.properties.schema.const, DIRECTORY_SCHEMA_ID);
  const args = (head) => ({
    entries: [{ id: "a", fa: "الف", category: "c", tags: [], sectors: [], site: "https://a.example", source: { title: "t", url: "https://a.example", checked: "2026-09-01" } }],
    tax: { tiers: [{ key: "t", fa: "ت" }], categories: [{ key: "c", fa: "د", tier: "t", color: "chart1" }], tags: [] }, sectors: [],
    c: { json: { head, meta: { count: 99 } } }, L: { lang: "fa", code: "fa" }, url: "https://x.example", page: { path: "/directory/", json: { schema: "evil" } },
    ctx: { pathOf: (p) => p, colorHex: { chart1: "#0072B2" } },
  });
  const doc = JSON.parse(renderDirectoryJson(args({ schema: "evil", url: "https://evil.example/" })));
  assert.equal(doc.schema, "kit.directory.v1", "head and page.json cannot replace the schema id");
  assert.equal(doc.url, "https://x.example/directory/", "nor the url");
  assert.equal(doc.count, 1, "nor the count");
  // colorRole is optional (additive within v1): a file published before it still validates, and a role that is written must be a registry role; the description and `required` agree
  const { validateSchema: validate } = await import("../src/schema.js");
  assert.ok(!schema.properties.taxonomy.properties.categories.items.required.includes("colorRole") && /optional/.test(schema.description));
  const old = JSON.parse(JSON.stringify(doc)); for (const c of old.taxonomy.categories) delete c.colorRole;
  assert.deepEqual(validate(old, schema), [], "a v1 file without colorRole is valid");
  assert.ok(doc.taxonomy.categories.every((c) => CATEGORY_ROLES.includes(c.colorRole)), "the generator always writes it");
  const bad = args({}); bad.tax.categories[0].color = "chart9"; bad.ctx.colorHex.chart9 = "#123456";
  assert.throws(() => renderDirectoryJson(bad), /does not match [^\n]*directory\.schema\.json[\s\S]*colorRole/);
});
