// The plugin architecture: archetypes are plugins (kit.widgets-plugin.v1) behind a registry, so the engine core stays portable.
// Failure first: adding an archetype needs no engine edit; the registry refuses what the contract does not name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildWidgets, checkWidgets, renderWidgetsBody, specProblems, kitRegistry, createRegistry, validateManifest, composeSpecSchema, KIT_PLUGINS, ARCHETYPE_NAMES, SPEC_SCHEMA, PLUGIN_CONTRACT } from "../src/index.js";
import { tempDir } from "../../core/test/support/temp.mjs";
import { buildSite, checkProject } from "../../site/src/index.js";
import { registryFor } from "../src/index.js";
import sample from "../../../examples/site-sample/site.config.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixture/", import.meta.url));
const REG = { schema: "kit.vocabularies.v1", projects: [{ key: "example", terms: ["Example Library"] }, { key: "other", terms: ["Other Co"] }] };
const NOPROJ = { projects: [] };
const spec = (d) => join(d, "widgets.spec.json");
const t2 = (en, fa) => ({ en, fa });

const TICKER = `export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "example-ticker", version: "1.0.0",
  describes: "a ticker of labelled items the project's spec lists",
  reads: [],
  spec: { key: "ticker", schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { $ref: "#/$defs/text" }, hot: { type: "boolean" } } } } } } },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: null,
  textKeys: ["label"],
  needs: (sc) => (sc.ticker ? null : "needs \\"ticker\\""),
  derive: (sc) => ({ items: sc.ticker.items }),
  render: (w, c, f, locale, h) => "<ul class=\\"kw-ticker\\">" + w.data.items.map((i) => "<li>" + h.esc(i.label) + "</li>").join("") + "</ul>",
  check: (w) => w.data.items.filter((i) => /banned/.test(i.label)).map((i) => "the ticker says banned: " + i.label),
};
`;

/** A project that declares its own archetype plugin: no engine file is edited. */
function project(t, { plugin = TICKER, id = "example-ticker", label = t2("Alpha", "آلفا") } = {}) {
  const d = tempDir(t, "kit-widgets-plugin-");
  cpSync(FIXTURE, d, { recursive: true });
  mkdirSync(join(d, "widgets/plugins/ticker"), { recursive: true });
  writeFileSync(join(d, "widgets/plugins/ticker/plugin.mjs"), plugin);
  const s = JSON.parse(readFileSync(spec(d), "utf8"));
  const base = s.scenarios[0].widgets[0];
  s.plugins = ["./widgets/plugins/ticker"];
  s.archetypes.push(id);
  s.scenarios[0].ticker = { items: [{ label }, { label: t2("Beta", "بتا"), hot: true }] };
  s.scenarios[0].widgets.push({ archetype: id, id: "borrow-ticker", usage: { surfaces: [{ path: "/examples/", placement: "page", how: t2("Shown on the examples page.", "در صفحهٔ نمونه‌ها.") }] }, application: base.application, architecture: base.architecture, utility: base.utility });
  writeFileSync(spec(d), JSON.stringify(s, null, 2));
  return d;
}

test("the engine core names no archetype: build, check, html, chrome and the registry hold none of the kit's ids", () => {
  const ids = KIT_PLUGINS.map((p) => p.id);
  assert.ok(ids.length >= 15);
  for (const f of ["build.js", "check.js", "html.js", "chrome.js", "registry.js", "util.js", "sources.js", "qa.js", "html-kit.js", "scenario-kit.js"]) {
    const text = readFileSync(join(SRC, f), "utf8").replace(/^export const TEXT_KEYS = .*$/m, "");   // generic words that are also text keys, not archetypes
    for (const id of ids) assert.doesNotMatch(text, new RegExp(`["'\`]${id}["'\`]`), `${f} names the archetype "${id}": it belongs in src/plugins/${id}.js`);
  }
  assert.equal(readFileSync(join(ROOT, "assets/widgets.js"), "utf8").match(/\b(feed|chain|pipeline|notify|tour)\(/g), null, "the runtime core holds no archetype code");
  const schema = JSON.parse(readFileSync(join(ROOT, "schemas/widgets-spec.schema.json"), "utf8"));
  assert.equal(schema.$defs.archetype.enum, undefined, "the spec schema lists no archetype: the registry decides");
});

test("a project adds an archetype with a plugin of its own and no engine edit: build, check and render use it", async (t) => {
  const d = project(t);
  const r = await buildWidgets(spec(d));
  writeFileSync(r.out, r.json);
  const w = r.generated.widgets.find((x) => x.archetype === "example-ticker" && x.locale === "fa");
  assert.deepEqual(w.data.items.map((i) => i.label), ["آلفا", "بتا"], "its scenario key is resolved per locale by its own schema fragment");
  const html = renderWidgetsBody(r.generated, "fa", { registry: r.registry });
  assert.match(html, /data-widget="example-ticker"[\s\S]*<ul class="kw-ticker"><li>آلفا<\/li><li>بتا<\/li><\/ul>/);
  assert.deepEqual((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems, []);
  assert.throws(() => renderWidgetsBody(r.generated, "fa"), /no archetype "example-ticker"/, "without the project's registry the page cannot render a plugin it does not have");
});

test("the plugin's own check hook and schema fragment are part of kit widgets check", async (t) => {
  const d = project(t, { label: t2("banned word", "ممنوع") });
  const r = await buildWidgets(spec(d)); writeFileSync(r.out, r.json);
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /widget borrow-ticker \(en\): the ticker says banned: banned word/);
  const bad = project(t);
  const s = JSON.parse(readFileSync(spec(bad), "utf8")); s.scenarios[0].ticker.items[0].hot = "yes"; s.scenarios[0].ticker.extra = 1;
  writeFileSync(spec(bad), JSON.stringify(s));
  const p = (await checkWidgets(spec(bad), { registry: REG, projects: NOPROJ })).problems.join("\n");
  assert.match(p, /ticker\/items\/0\/hot: /); assert.match(p, /ticker\/extra: /);
  await assert.rejects(buildWidgets(spec(bad)), /ticker/);
});

test("a project plugin is subject to the same checks: its text must trace to the spec, and its id carries the project's prefix", async (t) => {
  const d = project(t);
  const r = await buildWidgets(spec(d)); writeFileSync(r.out, r.json);
  const gen = JSON.parse(readFileSync(r.out, "utf8"));
  gen.widgets.find((w) => w.id === "borrow-ticker" && w.locale === "en").data.items[0].label = "Free coffee";
  writeFileSync(r.out, `${JSON.stringify(gen, null, 2)}\n`);
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /"Free coffee" is not traceable/);
  const e = project(t, { plugin: TICKER.replace('"example-ticker"', '"ticker"'), id: "ticker" });
  await assert.rejects(buildWidgets(spec(e)), /must start with the project's prefix/);
  const m = project(t); const s = JSON.parse(readFileSync(spec(m), "utf8")); s.plugins = ["./widgets/plugins/missing"]; writeFileSync(spec(m), JSON.stringify(s));
  await assert.rejects(buildWidgets(spec(m)), /plugins: .\/widgets\/plugins\/missing does not exist/);
});

const GOOD = () => ({ ...KIT_PLUGINS[0], capabilities: { ...KIT_PLUGINS[0].capabilities } });
test("the manifest contract: the registry refuses unknown keys, duplicate ids, a contract mismatch, missing hooks and bad declarations", () => {
  assert.deepEqual(validateManifest(GOOD()), []);
  const must = (mut, re) => { const m = GOOD(); mut(m); assert.match(validateManifest(m).join("\n"), re); };
  must((m) => { m.nonsense = 1; }, /nonsense/);
  must((m) => { m.contract = PLUGIN_CONTRACT + 1; }, /plugin contract/);
  for (const h of ["needs", "derive", "render", "check"]) must((m) => { delete m[h]; }, new RegExp(`missing hook "${h}"`));
  must((m) => { m.render = "<p>"; }, /missing hook "render"/);
  must((m) => { m.extraHook = () => 1; }, /function the contract does not know/);
  must((m) => { m.id = "Feed Two"; }, /id/);
  must((m) => { m.version = "1"; }, /version/);
  must((m) => { m.capabilities = { rtl: true }; }, /reducedMotion|needsCanvas/);
  must((m) => { m.capabilities.needsCanvas = "yes"; }, /needsCanvas/);
  must((m) => { delete m.describes; }, /describes/);
  must((m) => { m.runtime = "/abs/runtime.js"; }, /relative to the plugin file/);
  must((m) => { m.spec = { key: "x" }; }, /spec has no schema fragment/);
  must((m) => { m.chrome = { fa: { title: "x" } }; }, /en/);
  assert.match(validateManifest(null).join(), /default export is an object/);
  const r = createRegistry([GOOD()]);
  assert.throws(() => r.register(GOOD()), /already registered/);
  assert.throws(() => r.register({ ...GOOD(), id: "needy", requires: ["ghost"] }), /requires "ghost"/);
  assert.throws(() => createRegistry([{ ...GOOD(), id: "a", spec: { key: "k", shared: true } }, { ...GOOD(), id: "b", spec: { key: "k", shared: true } }]), /already owned by a/);
  assert.throws(() => r.get("ghost"), /no archetype "ghost"/);
});

test("the kit's own plugins are plugins: valid manifests, runtimes that exist and parse, chrome words in every locale, and a fresh composed spec schema", async () => {
  const reg = kitRegistry();
  assert.deepEqual(reg.ids(), ARCHETYPE_NAMES);
  const en = (await import("../src/locales/en.js")).default, fa = (await import("../src/locales/fa.js")).default, ar = (await import("../src/locales/ar.js")).default;
  for (const p of reg.plugins()) {
    assert.deepEqual(validateManifest(p), [], p.id);
    assert.ok(Object.keys(en.a).includes(p.id), `${p.id}: a heading in the locale packs`);
    for (const pack of [fa, ar]) assert.ok(pack.a[p.id], `${p.id}: heading in every locale pack`);
    for (const k of p.chromeKeys || []) for (const pack of [en, fa, ar]) assert.ok(k in pack, `${p.id}: chrome key ${k} in every locale pack`);
    if (p.runtime) {
      const file = join(dirname(reg.file(p.id) || join(SRC, "plugins", `${p.id}.js`)), p.runtime);
      assert.ok(existsSync(file), `${p.id}: runtime ${p.runtime} exists`);
      const c = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(c.status, 0, `${p.id}: runtime does not parse: ${c.stderr}`);
    }
  }
  const onDisk = JSON.parse(readFileSync(join(ROOT, "schemas/widgets-spec.schema.json"), "utf8"));
  assert.deepEqual(composeSpecSchema(onDisk, reg), onDisk, "kit widgets schema: the committed spec schema is the composition of the kit's registry (run node packages/widgets/scripts/compose-schema.mjs)");
  assert.deepEqual(specProblems(JSON.parse(readFileSync(join(FIXTURE, "widgets.spec.json"), "utf8"))), []);
});

test("kit site build renders a widgets page whose project declares its own plugin: the registry reaches the page, the stylesheet and the runtime files", async (t) => {
  const d = project(t, { plugin: TICKER.replace('runtime: null,', 'runtime: "./ticker.js", styles: "./ticker.css",') });
  writeFileSync(join(d, "widgets/plugins/ticker/ticker.js"), "export default function mount() {}\n");
  writeFileSync(join(d, "widgets/plugins/ticker/ticker.css"), ".kw-ticker{color:red}\n");
  const r = await buildWidgets(spec(d));
  const registry = await registryFor(JSON.parse(readFileSync(spec(d), "utf8")), d);
  const page = (extra) => ({ type: "widgets", path: "/examples/", generated: r.generated, content: { en: { meta: { title: "Examples" } } }, ...extra });
  const without = checkProject({ ...sample, out: "out", pages: [page({})] }).join("\n");
  assert.match(without, /archetype "example-ticker", which is not registered/, "without the registry the page says what is missing, not 'no archetype'");
  const project_ = { ...sample, out: "out", pages: [page({ registry })] };
  assert.deepEqual(checkProject(project_), []);
  const { files } = buildSite(project_, { root: fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url)) });
  assert.match(files["examples/index.html"], /<ul class="kw-ticker"><li>Alpha<\/li>/);
  assert.match(files["widgets.css"], /\.kw-ticker\{color:red\}/, "the plugin's styles are in widgets.css");
  assert.equal(files["widgets/plugins/example-ticker.js"], "export default function mount() {}\n", "its runtime module is published next to widgets.js");
});

test("a site with two widgets pages ships the union of their plugins; the same plugin id from two different sources is a validation error", async (t) => {
  const mk = async (name, css, key = "ticker") => {
    const d = project(t, { plugin: TICKER.replace('runtime: null,', 'runtime: "./ticker.js", styles: "./ticker.css",').replace(/example-ticker/g, name).replace(/key: "ticker"/, `key: "${key}"`).replace(/sc\.ticker/g, `sc.${key}`).replace(/needs \\"ticker\\"/, `needs \\"${key}\\"`), id: name });
    const sp = JSON.parse(readFileSync(spec(d), "utf8")); sp.scenarios[0][key] = sp.scenarios[0].ticker; if (key !== "ticker") delete sp.scenarios[0].ticker; writeFileSync(spec(d), JSON.stringify(sp, null, 2));
    writeFileSync(join(d, "widgets/plugins/ticker/ticker.js"), `export default function mount() { /* ${name} */ }\n`);
    writeFileSync(join(d, "widgets/plugins/ticker/ticker.css"), `.kw-${name}{color:${css}}\n`);
    const r = await buildWidgets(spec(d));
    return { r, d, registry: await registryFor(JSON.parse(readFileSync(spec(d), "utf8")), d) };
  };
  const a = await mk("example-alpha", "red"), b = await mk("example-beta", "blue", "tickerb");
  const root = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
  const page = (x, path) => ({ type: "widgets", path, generated: (() => { const g = structuredClone(x.r.generated); for (const k of Object.keys(g.page || {})) g.page[k].path = path; return g; })(), registry: x.registry, content: { en: { meta: { title: path } } } });
  const project_ = { ...sample, out: "out", pages: [page(a, "/examples/"), page(b, "/more/")] };
  assert.deepEqual(checkProject(project_), []);
  const { files } = buildSite(project_, { root });
  assert.match(files["widgets.css"], /\.kw-example-alpha\{color:red\}/); assert.match(files["widgets.css"], /\.kw-example-beta\{color:blue\}/, "the second page's plugin styles ship too");
  assert.ok(files["widgets/plugins/example-alpha.js"] && files["widgets/plugins/example-beta.js"], "both runtime modules are published");
  const bad = checkProject({ ...sample, out: "out", pages: [{ ...page(a, "/examples/"), registry: { not: "a registry" } }, page(b, "/more/")] }).join("\n");
  const duck = checkProject({ ...sample, out: "out", pages: [{ ...page(a, "/examples/"), registry: { entries: () => [] } }] }).join("\n");
  assert.match(duck, /registry must be the widgets Registry/, "an object that only has entries() is not a registry");
  assert.match(bad, /registry must be the widgets Registry/, "a malformed registry is a message, not a crash");
  // the same id from another source
  const c = await mk("example-alpha", "green", "tickerc");
  const clash = checkProject({ ...sample, out: "out", pages: [page(a, "/examples/"), page(c, "/more/")] }).join("\n");
  assert.match(clash, /plugin "example-alpha" comes from .* on one widgets page and from .* on another/);
});
