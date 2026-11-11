// The widget engine: deterministic generation from a project's spec and contracts, the guards (scenario,
// traceability, cross-project vocabulary, freshness), the static HTML and the runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWidgets, checkWidgets, specProblems, renderWidgetsBody, ARCHETYPE_NAMES, sampleOf, parseExpr, evalExpr, VOCABULARIES, foreignTerms, projectTerms, vocabularyLeaks, RUNTIME_FILE, THEME_FILE, latinDigits, localDigits } from "../src/index.js";
import { validateSchema } from "../src/schema.js";
import { tempDir } from "../../core/test/support/temp.mjs";
import NOTIFY_SCHEMA from "../../site/schema/terminal-notify.schema.json" with { type: "json" };
import GEN_SCHEMA from "../schemas/widgets-generated.schema.json" with { type: "json" };

const FIXTURE = fileURLToPath(new URL("./fixture/", import.meta.url));
const REG = { schema: "kit.vocabularies.v1", projects: [{ key: "example", terms: ["Example Library"] }, { key: "other", terms: ["Other Co", "otherco.example"] }] };
const NOPROJ = { projects: [] };
const copy = (t) => { const d = tempDir(t, "kit-widgets-"); cpSync(FIXTURE, d, { recursive: true }); return d; };
const spec = (d) => join(d, "widgets.spec.json");
const edit = (d, f) => { const s = JSON.parse(readFileSync(spec(d), "utf8")); f(s); writeFileSync(spec(d), JSON.stringify(s, null, 2)); };
async function built(d) { const r = await buildWidgets(spec(d)); writeFileSync(r.out, r.json); return r; }

test("build: one widget per archetype, scenario and locale; deterministic; schema-valid; the committed fixture is fresh", async (t) => {
  const d = copy(t);
  const a = await buildWidgets(spec(d)), b = await buildWidgets(spec(d));
  assert.equal(a.json, b.json);
  assert.equal(a.json, readFileSync(join(FIXTURE, "widgets.generated.json"), "utf8"), "test/fixture/widgets.generated.json is stale: rebuild it");
  assert.deepEqual(validateSchema(a.generated, GEN_SCHEMA), []);
  assert.equal(a.generated.widgets.length, 16);
  assert.deepEqual([...new Set(a.generated.widgets.map((w) => w.archetype))], ["feed", "chain", "timeline", "calculator", "playground", "roles", "tour", "notify"]);
  const feed = a.generated.widgets.find((w) => w.id === "borrow-feed" && w.locale === "fa");
  assert.equal(feed.data.items[1].action, "امانت", "a $ref into a content source, per locale");
  assert.equal(feed.data.items[1].outcome, "سررسید 14 روز دیگر", "an engine result, per locale");
  assert.equal(feed.data.items[1].at, "2026-10-15", "an engine date from build.asOf");
  const pg = a.generated.widgets.find((w) => w.archetype === "playground" && w.locale === "en");
  assert.deepEqual(pg.data.calls[0].body, { book: "<book>", days: 14, member: "m_7" }, "request sampled from the OpenAPI schema");
  assert.equal(pg.data.calls[1].path, "/loans/ln_42");
  assert.ok(pg.trace.includes("api#/paths/~1loans/post"));
  assert.equal(a.generated.calls.length, 2, "engine calls recorded (one per call, args and locale: memoised)");
});

test("exports: the feed projects into the terminal's notify view (its schema)", async (t) => {
  const r = await buildWidgets(join(FIXTURE, "widgets.spec.json"));
  for (const code of ["en", "fa"]) assert.deepEqual(validateSchema(r.generated.exports["terminal-notify"][code], NOTIFY_SCHEMA), []);
  const d = copy(t);
  edit(d, (s) => { s.build.exports[0].widget = "borrow-notify"; s.scenarios[0].widgets.at(-1).usage.surfaces.push({ path: "/terminal/", placement: "terminal", how: "x" }); });
  const n = await buildWidgets(spec(d));
  assert.deepEqual(validateSchema(n.generated.exports["terminal-notify"].en, NOTIFY_SCHEMA), [], "a notify widget exports too");
});

test("check: clean fixture passes; stale, untraceable and hand-edited output fails", async (t) => {
  const d = copy(t);
  assert.deepEqual((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems, []);
  edit(d, (s) => { s.scenarios[0].steps[0].action.en = "Asks for a novel"; });
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /stale/);
  await built(d);
  const gen = JSON.parse(readFileSync(join(d, "widgets.generated.json"), "utf8"));
  gen.widgets[0].data.items[0].outcome = "Free coffee for every member";
  writeFileSync(join(d, "widgets.generated.json"), `${JSON.stringify(gen, null, 2)}\n`);
  const p = (await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n");
  assert.match(p, /"Free coffee for every member" is not traceable/);
  assert.match(p, /stale/);
  const tw = copy(t);
  edit(tw, (s) => { s.scenarios[0].steps[0].action.en = "Approved by {approver}"; });
  await built(tw);
  assert.match((await checkWidgets(spec(tw), { registry: REG, projects: NOPROJ })).problems.join("\n"), /unresolved placeholder \{approver\}/);
});

test("qa: the gap probe and the measuring loop are exported for kit widgets qa", async () => {
  const m = await import("../src/index.js");
  assert.equal(typeof m.gapProbe, "function");
  assert.equal(typeof m.measureGaps, "function");
});

test("check: a widget without a project scenario fails", async (t) => {
  const d = copy(t); await built(d);
  const gen = JSON.parse(readFileSync(join(d, "widgets.generated.json"), "utf8"));
  gen.widgets.push({ ...gen.widgets[0], id: "stray", scenario: "payments-demo" });
  writeFileSync(join(d, "widgets.generated.json"), `${JSON.stringify(gen, null, 2)}\n`);
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /widget stray \(en\): no scenario "payments-demo"/);
});

test("check: another project's vocabulary or a forbidden word fails, in the spec and in the output", async (t) => {
  const d = copy(t);
  edit(d, (s) => { s.scenarios[0].summary.en = "Powered by Other Co."; });
  await built(d);
  const p = (await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n");
  assert.match(p, /widgets\.spec\.json: "Other Co" belongs to other/);
  assert.match(p, /widgets\.generated\.json: "Other Co" belongs to other/);
  const e = copy(t);
  edit(e, (s) => { s.scenarios[0].steps[1].detail = "No overdue fine applies"; });
  await built(e);
  assert.match((await checkWidgets(spec(e), { registry: REG, projects: NOPROJ })).problems.join("\n"), /"overdue fine" belongs to forbidden by this spec/);
  const f = copy(t);
  edit(f, (s) => { s.project.key = "unregistered"; });
  await built(f);
  assert.match((await checkWidgets(spec(f), { registry: REG, projects: NOPROJ })).problems.join("\n"), /in neither the project registry/);
});

test("spec problems: unknown ids, archetypes the project did not choose, archetypes without data", async (t) => {
  const s = JSON.parse(readFileSync(join(FIXTURE, "widgets.spec.json"), "utf8"));
  const bad = structuredClone(s);
  bad.scenarios[0].steps[0].actor = "ghost"; bad.scenarios[0].widgets.push({ ...bad.scenarios[0].widgets[1], archetype: "comparison" }); bad.scenarios[0].useCase = "nope";
  const p = specProblems(bad).join("\n");
  assert.match(p, /unknown actor "ghost"/); assert.match(p, /archetype "comparison" is not one of this project's archetypes/); assert.match(p, /unknown use case "nope"/);
  const d = copy(t);
  edit(d, (x) => { x.archetypes.push("comparison"); x.scenarios[0].widgets.push({ ...x.scenarios[0].widgets[1], archetype: "comparison" }); });
  await assert.rejects(buildWidgets(spec(d)), /comparison widget needs "compare"/);
  assert.match(specProblems({}).join("\n"), /scenarios: is required|missing "scenarios"/);
  const noUse = structuredClone(s); delete noUse.scenarios[0].widgets[1].utility; noUse.scenarios[0].widgets[2].usage.surfaces[0].path = "/elsewhere/";
  const q = specProblems(noUse).join("\n");
  assert.match(q, /widgets\/1(\/utility: is required|: missing "utility")/);
  const e = copy(t);
  edit(e, (x) => { x.scenarios[0].widgets[0].usage.surfaces.pop(); x.scenarios[0].widgets[1].architecture.diagram = "docs/diagrams/missing.png"; x.scenarios[0].widgets[2].usage.surfaces[0].path = "/elsewhere/"; });
  const r = (await checkWidgets(spec(e), { registry: REG, projects: NOPROJ })).problems.join("\n");
  assert.match(r, /exported to the terminal, so usage must list it/);
  assert.match(r, /architecture\.diagram docs\/diagrams\/missing\.png does not exist/);
  assert.match(r, /usage on page \/elsewhere\/, but build\.page\.path is \/examples\//);
});

test("archetypes are pure: the engine's source holds no project vocabulary and no demo content", () => {
  assert.ok(ARCHETYPE_NAMES.length >= 15, "the kit ships at least its original fifteen archetypes");
  const terms = [...projectTerms()].flatMap(([owner, set]) => [...set].map((term) => ({ term, owner })));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (["test", "registry"].includes(f) ? [] : files(join(dir, f))) : [join(dir, f)]));
  for (const f of files(root)) {
    const leaks = vocabularyLeaks([readFileSync(f, "utf8").replace(/@saasreport\/|SaasReport\/kit|saasreport-kit/g, "")], terms);   // the kit's own scope and repository are not a project's vocabulary
    assert.deepEqual(leaks.map((l) => l.term), [], f);
  }
  assert.deepEqual(foreignTerms("saasreport").filter((t) => t.owner === "saasreport"), []);
  assert.ok(foreignTerms("nope").some((t) => t.term === "SaasReport"), "registry names come from packages/core/registry/projects.json");
});

test("helpers: schema samples, calculator expressions", () => {
  assert.deepEqual(sampleOf({ type: "object", properties: { a: { type: "string", format: "date" }, b: { enum: ["x", "y"] }, c: { type: "array", items: { type: "integer", minimum: 3 } } } }, { asOf: "2026-10-01" }), { a: "2026-10-01", b: "x", c: [3] });
  assert.equal(evalExpr(parseExpr("round(amount * (1 + rate / 100), 0) + max(fee, 2)", new Set(["amount", "rate", "fee"])), { amount: 100, rate: 10, fee: 1 }), 112);
  assert.throws(() => parseExpr("amount * secret", new Set(["amount"])), /unknown name "secret"/);
  assert.throws(() => parseExpr("alert(1)", new Set()), /unknown name "alert"/);
});

test("html + runtime: RTL page, honesty badges, archetype markup; the runtime parses and the theme uses tokens only", async () => {
  const r = await buildWidgets(join(FIXTURE, "widgets.spec.json"));
  const fa = renderWidgetsBody(r.generated, "fa");
  assert.match(fa, /<div class="kw-page" dir="rtl" lang="fa">/);
  assert.match(fa, /data-honesty="sample">نمونه</);
  assert.match(fa, /<time datetime="2026-10-15">/);
  assert.match(fa, /data-decision="allow">مجاز</);
  assert.match(fa, /<output data-expr="days \* 3" data-decimals="0">۴۲<\/output>/, "computed at build, Persian digits");
  assert.match(fa, /<details class="kw-about">/); assert.match(fa, /https:\/\/github\.com\/example\/library\/blob\/main\/docs\/diagrams\/lending\.png/);
  assert.match(fa, /چه می‌آموزید:<\/b> مسیر امانت از میز تا یادآوری\./);
  for (const a of ["feed", "chain", "timeline", "calculator", "playground", "roles"]) assert.match(fa, new RegExp(`data-widget="${a}"`));
  const en = renderWidgetsBody(r.generated, "en");
  assert.match(en, /dir="ltr"/); assert.match(en, /15 October 2026/);
  new Function(readFileSync(RUNTIME_FILE, "utf8"));
  const css = readFileSync(THEME_FILE, "utf8");
  assert.doesNotMatch(css.replace(/\{\{[^}]+\}\}/g, ""), /#[0-9a-f]{3,6}\b/i, "colours come from tokens");
  assert.doesNotMatch(css, /margin-left|margin-right|padding-left|padding-right|\bleft:|\bright:/, "logical properties only (RTL and LTR)");
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test("check: API payloads are contract samples (freshness-checked), their keys are not read as copy", async (t) => {
  const d = copy(t);
  const api = JSON.parse(readFileSync(join(d, "openapi.json"), "utf8"));
  api.components.schemas.Loan.properties.title = { type: "string" };
  writeFileSync(join(d, "openapi.json"), JSON.stringify(api));
  await built(d);
  assert.deepEqual((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems, []);
});

test("sources: a YAML contract is read with the project's own yaml package; without it, a clear error", async (t) => {
  const d = copy(t);
  writeFileSync(join(d, "openapi.yaml"), readFileSync(join(d, "openapi.json"), "utf8"));   // JSON is valid YAML
  edit(d, (s) => { s.sources.api.path = "openapi.yaml"; });
  await assert.rejects(buildWidgets(spec(d)), /needs the "yaml" package/);
  mkdirSync(join(d, "node_modules/yaml"), { recursive: true });
  writeFileSync(join(d, "node_modules/yaml/package.json"), JSON.stringify({ name: "yaml", main: "index.js" }));
  writeFileSync(join(d, "node_modules/yaml/index.js"), "module.exports = { parse: (t) => JSON.parse(t) };");
  const r = await buildWidgets(spec(d));
  assert.ok(r.generated.widgets.find((w) => w.archetype === "playground").trace.includes("api#/paths/~1loans/post"));
});

test("fa: every rendered number is Persian (outside code); check enforces it", async (t) => {
  const r = await buildWidgets(join(FIXTURE, "widgets.spec.json"));
  const fa = renderWidgetsBody(r.generated, "fa");
  assert.deepEqual(latinDigits(fa), []);
  assert.match(fa, /۲۰۲۶|۱۴۰۵/); assert.match(fa, /<code dir="ltr">loan\.requested<\/code>/);
  assert.match(fa, /<pre dir="ltr" class="kw-code"><b>POST<\/b> \/loans/, "code keeps Latin");
  assert.equal(localDigits("<p>3 روز، T+1</p><code>v1</code>", "arabext"), "<p>۳ روز، T+1</p><code>v1</code>");
  assert.notDeepEqual(latinDigits(renderWidgetsBody(r.generated, "en")), []);
  const d = copy(t);
  edit(d, (s) => { s.locales[1].digits = "latn"; });
  await built(d);
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /locales\.fa: digits must be arabext/);
});

test("tour: tasks of steps with callouts pinned to screen regions, deep links, progress, finish card as the only CTA; needs checked", async (t) => {
  const r = await buildWidgets(join(FIXTURE, "widgets.spec.json"));
  const tg = r.generated.widgets.find((w) => w.archetype === "tour" && w.locale === "en");
  assert.equal(tg.data.tasks[0].steps[1].anchor, "due"); assert.equal(tg.data.tasks[0].steps[1].beat, "seal");
  const en = renderWidgetsBody(r.generated, "en");
  assert.match(en, /href="\?task=borrow&amp;step=1#w-borrow-tour-en" data-kw-task="borrow"/);
  assert.match(en, /data-kw-status aria-live="polite"/);
  assert.match(en, /<div data-anchor="1"><dt>Due<\/dt>/);
  assert.match(en, /<span class="kw-chip" data-anchor="1">Queue<\/span>/);
  assert.equal((en.match(/<a class="kw-btn" href=/g) || []).length, 1, "one call to action: the finish card");
  assert.doesNotMatch(en, /<form[^>]*data-kw-tour|<input type="email"/, "no lead form");
  const fa = renderWidgetsBody(r.generated, "fa");
  assert.deepEqual(latinDigits(fa), []);
  const css = readFileSync(THEME_FILE, "utf8");
  assert.match(css, /@media \(max-width:639px\)\{\s*\.kw-tour\{grid-template-columns:1fr\}/, "vertical stepper below 640px");
  const d = copy(t);
  edit(d, (s) => { s.scenarios[0].tour.callouts[0].anchor = "nowhere"; });
  await assert.rejects(buildWidgets(spec(d)), /anchor "nowhere" is not a region of screen "desk"/);
  const e = copy(t);
  edit(e, (s) => { s.scenarios[0].tour.tasks[0].steps.push("ghost"); });
  await assert.rejects(buildWidgets(spec(e)), /task step "ghost" is not a step/);
});

test("notify: devices, scenes, actions; the initiator's approve is refused; no built-in content", async (t) => {
  const r = await buildWidgets(join(FIXTURE, "widgets.spec.json"));
  const n = r.generated.widgets.find((w) => w.archetype === "notify" && w.locale === "en");
  assert.deepEqual(n.data.devices.map((d) => d.kind), ["phone", "console"]);
  const lend = n.data.items.find((i) => i.id === "lend");
  assert.equal(lend.actions[0].blocked, true, "approve by the initiator");
  assert.equal(lend.actions[1].blocked, false);
  const en = renderWidgetsBody(r.generated, "en");
  assert.match(en, /<figure class="kw-dev kw-dev--phone" id="[^"]+-dev-phone" data-kw-dev="phone" role="tabpanel"/);
  assert.match(en, /class="kw-dev__lock"[\s\S]*data-kw-clock/, "a lock screen with a clock");
  assert.match(en, /role="tablist"[\s\S]*data-kw-devtab="phone"[\s\S]*data-kw-badge/, "a device switcher with badges");
  assert.match(en, /class="kw-nc__stage has-phone"/);
  assert.match(en, /data-blocked="1" data-tone="err">Member tries to self-approve/, "the initiator's button reads as an attempt");
  assert.match(en, /data-kw-scene="seal"/); assert.match(en, /data-kw-scene="checklist"/);
  assert.match(en, /data-kind="approve" data-done="[^"]*" data-result="Refused: the initiator cannot approve their own request\." data-blocked="1"/);
  assert.match(en, /data-kw-play aria-pressed="false"/);
  assert.deepEqual(latinDigits(renderWidgetsBody(r.generated, "fa")).filter((x) => !/9f2c41aa/.test(x)), []);
  const css = readFileSync(THEME_FILE, "utf8");
  assert.match(css, /@media \(max-width:639px\)\{[^}]*\.kw\.is-live \.kw-nc__tabs\{display:flex\}/, "one device at a time below 640px");
  const d = copy(t);
  edit(d, (s) => { s.scenarios[0].devices.push({ ...s.scenarios[0].devices[1], id: "idle" }); });
  await assert.rejects(buildWidgets(spec(d)), /device "idle" receives no notification/, "no empty device");
  assert.doesNotMatch(css, /\.kw-dev(--phone)?\{[^}]*(min-height|[^-]height):/, "devices size to their content");
  assert.match(css, /\.kw\.is-live \.kw-dev:not\(:has\(\.kw-nc__n:not\(\.is-hidden\)\)\) \.kw-dev__stack\{display:none\}/, "an empty device is a slim header until its first notification");
  assert.match(en, /<div class="kw-nc__side"><div class="kw-nc__col">/, "side devices in balanced columns");
});


test("runtime manifest is authoritative: static timeline never fetches a missing plugin, interactive widgets still enhance", async () => {
  const generated = (await buildWidgets(join(FIXTURE, "widgets.spec.json"))).generated;
  const html = renderWidgetsBody(generated, "en");
  assert.match(html, /data-widget="timeline"[^>]*data-kw-runtime="static"/, "static manifest is recorded in markup");
  assert.match(html, /data-widget="feed"[^>]*data-reset-label=/, "interactive archetype remains present");
  assert.doesNotMatch(html, /data-widget="feed"[^>]*data-kw-runtime="static"/, "interactive archetype is not marked static");
  const runtime = readFileSync(RUNTIME_FILE, "utf8");
  assert.match(runtime, /w\.dataset\.kwRuntime === "static"/, "client loader honours the same manifest contract");
});
