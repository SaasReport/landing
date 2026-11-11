// The financial-network archetypes (network, flow, split, netting, match, builder): their specs, their static HTML (complete without
// scripts), their pure layout and the rule that an archetype holds no content. The browser behaviour is in network-browser.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWidgets, checkWidgets, renderWidgetsBody, specProblems, THEME_FILE, themeTemplate, kitRegistry } from "../src/index.js";
import { validateSchema } from "../src/schema.js";
import { tempDir } from "../../core/test/support/temp.mjs";
import GEN_SCHEMA from "../schemas/widgets-generated.schema.json" with { type: "json" };
import { arrowPath, layoutNetwork, edgesOf, routeOf, hopsOf, edgeKey, sizeOf, ladderRows, ladderHeight, physical, NARROW_MAX, WIDE_REF, hubBox, HUB, measure, along } from "../assets/widgets/lib/netlayout.js";
import { parseNumber, formatNumber } from "../assets/widgets/lib/motion.js";
import { numberIn } from "../src/plugins/split.js";
import { stageFor, BUDGET } from "../src/plugins/network.js";

const FIX = fileURLToPath(new URL("./fixture-network/", import.meta.url));
const REG = { schema: "kit.vocabularies.v1", projects: [{ key: "example", terms: ["Example Library"] }, { key: "other", terms: ["Other Co"] }] };
const NOPROJ = { projects: [] };
const spec = (d) => join(d, "widgets.spec.json");
const copy = (t) => { const d = tempDir(t, "kit-net-"); cpSync(FIX, d, { recursive: true }); return d; };
const edit = (d, f) => { const s = JSON.parse(readFileSync(spec(d), "utf8")); f(s); writeFileSync(spec(d), JSON.stringify(s, null, 2)); };
const scenario = (s, id) => s.scenarios.find((x) => x.id === id);
const ARCHETYPES = ["network", "flow", "split", "netting", "match", "builder"];

test("build: the six archetypes are deterministic, schema-valid and the committed fixture is fresh", async () => {
  const a = await buildWidgets(spec(FIX)), b = await buildWidgets(spec(FIX));
  assert.equal(a.json, b.json, "same inputs, same bytes");
  assert.equal(a.json, readFileSync(join(FIX, "widgets.generated.json"), "utf8"), "test/fixture-network/widgets.generated.json is stale: rebuild it");
  assert.deepEqual(validateSchema(a.generated, GEN_SCHEMA), []);
  assert.deepEqual([...new Set(a.generated.widgets.map((w) => w.archetype))], ARCHETYPES);
  assert.equal(a.generated.widgets.length, 12, "six archetypes in two locales");
  const net = a.generated.widgets.find((w) => w.archetype === "network" && w.locale === "fa").data;
  assert.equal(net.nodes[1].label, "اعضا", "texts are the spec's, per locale");
  assert.equal(net.configurations[1].counters[1].value, "۱۸٬۴۲۰", "figures verbatim, as the project wrote them");
  assert.deepEqual(net.configurations[0].edges[0], ["hub", "members"], "default edges: every node to the hub");
  const split = a.generated.widgets.find((w) => w.archetype === "split" && w.locale === "en").data;
  assert.equal(split.allocations[0].share, 0.78, "a share is read from the digits of the value the spec wrote");
  assert.equal(numberIn("£1,234.50"), 1234.5); assert.equal(numberIn("۱٬۲۳۴"), 1234); assert.ok(Number.isNaN(numberIn("none")));
  const match = a.generated.widgets.find((w) => w.archetype === "match" && w.locale === "en").data;
  assert.equal(match.flagged, 2, "exception chips follow the stated exceptions, at most a third of the sample");
});

test("check: a clean fixture passes; text typed into a generated archetype is refused as untraceable", async (t) => {
  const d = copy(t);
  assert.deepEqual((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems, []);
  const poke = {
    network: (w) => { w.data.configurations[0].flows[0].label = "Free coffee"; },
    flow: (w) => { w.data.statuses[0].label = "Free coffee"; },
    split: (w) => { w.data.allocations[0].label = "Free coffee"; },
    netting: (w) => { w.data.gross.label = "Free coffee"; },
    match: (w) => { w.data.investigation.text = "Free coffee"; },
    builder: (w) => { w.data.steps[0].title = "Free coffee"; },
  };
  for (const a of ARCHETYPES) {
    const e = copy(t);
    const gen = JSON.parse(readFileSync(join(e, "widgets.generated.json"), "utf8"));
    poke[a](gen.widgets.find((w) => w.archetype === a && w.locale === "en"));
    writeFileSync(join(e, "widgets.generated.json"), `${JSON.stringify(gen, null, 2)}\n`);
    const p = (await checkWidgets(spec(e), { registry: REG, projects: NOPROJ })).problems.join("\n");
    assert.match(p, /"Free coffee" is not traceable/, `${a}: content inside the archetype`);
    assert.match(p, /stale/, `${a}: and the file is stale`);
  }
  const x = copy(t);
  edit(x, (s) => { scenario(s, "library-network").summary.en = "Powered by Other Co."; });
  const r = await buildWidgets(spec(x)); writeFileSync(r.out, r.json);
  assert.match((await checkWidgets(spec(x), { registry: REG, projects: NOPROJ })).problems.join("\n"), /"Other Co" belongs to other/, "another project's vocabulary is still refused");
});

const refused = (_, mutate, re, what) => test(`spec must fail: ${what}`, async (t) => {
  const s = JSON.parse(readFileSync(spec(FIX), "utf8"));
  mutate(s);
  const p = specProblems(s).join("\n");
  if (re.test(p)) return;
  await assert.rejects(async () => { const d = copy(t); writeFileSync(spec(d), JSON.stringify(s)); await buildWidgets(spec(d)); }, re);
});
const net = (s) => scenario(s, "library-network").network;
refused(null, (s) => { delete net(s).nodes[1].class; }, /class/, "a node without a class");
refused(null, (s) => { net(s).nodes[1].class = "bank"; }, /class/, "a node class the schema does not name");
refused(null, (s) => { net(s).nodes[1].colour = "red"; }, /colour/, "a node with an unknown key (no colours in a spec)");
refused(null, (s) => { net(s).flowTypes[0].tone = "crimson"; }, /tone/, "a flow type tone that is not a tone");
refused(null, (s) => { net(s).configurations[0].flows[0].type = "ghost"; }, /flowTypes does not declare/, "a flow whose type is not declared");
refused(null, (s) => { net(s).configurations[0].flows[0].from = "ghost"; }, /not in the view/, "a flow between nodes that are not in the view");
refused(null, (s) => { const c = net(s).configurations[0]; c.edges = [[net(s).hub, c.flows[0].from]]; }, /has no route/, "a flow no declared edge can carry (neither direct nor through the hub)");
refused(null, (s) => { net(s).configurations[1].event.fails = "payments"; }, /not an end of flow/, "a failover that fails a node the flow does not touch");
refused(null, (s) => { net(s).configurations[1].event.reroute = "courier-a"; }, /another node of the view/, "a failover that re-routes to the failing node");
refused(null, (s) => { net(s).hub = "members"; }, /must be a node of class hub/, "a hub that is not of class hub");
refused(null, (s) => { net(s).configurations[0].nodes.push("hub"); }, /the hub is implied/, "the hub listed among a view's nodes");
refused(null, (s) => { net(s).configurations[0].nodes.push("ghost"); }, /not defined/, "a view with a node nobody defined");
refused(null, (s) => { net(s).default = "ghost"; }, /not a configuration/, "a default view that does not exist");
refused(null, (s) => { net(s).nodes.push({ ...net(s).nodes[1] }); }, /same id/, "two nodes with one id");
refused(null, (s) => { scenario(s, "fee-flow").flow.statuses[0].step = "ghost"; }, /not a step/, "a status that begins at a step that does not exist");
refused(null, (s) => { scenario(s, "grant-split").split.allocations.pop(); scenario(s, "grant-split").split.allocations.pop(); scenario(s, "grant-split").split.allocations.pop(); }, /minItems|at least 2|allocations/, "a split into one allocation");
refused(null, (s) => { scenario(s, "fee-netting").netting.participants.length = 1; }, /participants/, "netting among fewer than two participants");
refused(null, (s) => { scenario(s, "loan-match").match.sample = 99; }, /sample/, "a match sample beyond the cap");
refused(null, (s) => { scenario(s, "net-builder").builder.output[0].step = "ghost"; }, /which is not a step/, "a builder figure that counts a step that does not exist");
refused(null, (s) => { scenario(s, "net-builder").builder.steps[0].options[1].id = "m"; }, /same id/, "two options with one id in a step");
refused(null, (s) => { delete scenario(s, "net-builder").builder; }, /needs "builder"/, "a builder widget without its builder");

test("check: the performance budget is part of the contract (nodes, flows, views)", async (t) => {
  const d = copy(t);
  edit(d, (s) => {
    const n = net(s);
    for (let i = 0; i < BUDGET.nodes + 1; i++) n.nodes.push({ id: `x${i}`, label: { en: `X${i}`, fa: `ایکس${i}` }, class: "participant" });
    n.configurations[0].nodes = n.nodes.filter((x) => x.class !== "hub").map((x) => x.id);
  });
  const r = await buildWidgets(spec(d)); writeFileSync(r.out, r.json);
  assert.match((await checkWidgets(spec(d), { registry: REG, projects: NOPROJ })).problems.join("\n"), /nodes; the budget is 24/);
});

test("static HTML: every archetype makes sense with scripts off (names, roles, flows, amounts, figures, every view as text)", async () => {
  const r = await buildWidgets(spec(FIX));
  const en = renderWidgetsBody(r.generated, "en");
  // network
  for (const text of ["Example Library", "Members", "Courier A", "Late fees", "£120", "£2,400", "Fees", "Grants", "Delivery", "Loans", "Branch", "Region", "Everything", "Four thousand members borrow books."]) assert.ok(en.includes(text), `network shows "${text}" statically`);
  assert.match(en, /<details class="kw-net__all"><summary>View the network as \(3\)<\/summary>/, "every view listed as text");
  assert.match(en, /role="group" aria-label="The library network"/, "the stage is a labelled group");
  assert.match(en, /<svg class="kw-net__edges kw-net__edges--wide"[^>]* aria-hidden="true"/, "decoration is hidden from readers");
  assert.match(en, /<ul class="kw-net__flows" aria-label="Flows">/); assert.match(en, /aria-live="polite" data-kw-net-panel|data-kw-net-panel aria-live="polite"/);
  assert.match(en, /<small>Example Library to Schools<\/small>/, "the direction of the money is stated in words");
  assert.match(en, /role="tablist" aria-label="View the network as"/);
  // flow
  assert.match(en, /<ol class="kw-flow__track" style="--kw-hops:4" aria-label="Path">/); assert.match(en, /<li class="kw-flow__status" data-tone="ok" data-hop="2" data-state="done" aria-current="step">Settled/);
  assert.match(en, /<pre class="kw-code"><b>POST<\/b> \/fees/, "the request is written out");
  // split, netting, match, builder
  assert.match(en, /<li data-alloc="a"><span>Schools<\/span><b data-kw-count>£780<\/b>/);
  assert.match(en, /data-total="net"><dt>Net<\/dt><dd><span data-kw-count>£168,400<\/span>/);
  assert.match(en, /<li class="kw-match__rec" data-i="\d" data-side="ext" data-flag data-state="exception">/); assert.match(en, /data-kw-match-card role="region"[^>]*tabindex="-1"><button/, "the investigation card is in the page, not behind a script");
  assert.match(en, /<input type="checkbox" name="who--m" value="who--m" checked>/, "the builder's default selection is a real form");
  const fa = renderWidgetsBody(r.generated, "fa");
  assert.match(fa, /dir="rtl"/); assert.ok(fa.includes("اعضا") && fa.includes("پیک الف"));
});

test("RTL mirrors the picture: the start side is the right-hand side, edges and arrows are mirrored, positions are fractions", async () => {
  const r = await buildWidgets(spec(FIX));
  const data = r.generated.widgets.find((w) => w.archetype === "network" && w.locale === "en").data;
  const cfg = data.configurations[1];
  const ltr = stageFor(data, cfg, "wide", false), rtl = stageFor(data, cfg, "wide", true);
  for (const id of cfg.nodes) assert.equal(rtl.boxes[id].x, WIDE_REF.w - ltr.boxes[id].x, `${id}: mirrored x`);
  assert.ok(ltr.boxes.members.x < WIDE_REF.w / 2 && rtl.boxes.members.x > WIDE_REF.w / 2, "participants start on the start side");
  assert.ok(ltr.boxes["courier-b"].x > WIDE_REF.w / 2 && rtl.boxes["courier-b"].x < WIDE_REF.w / 2, "providers end on the end side");
  assert.equal(physical(100, 720, true), 620); assert.equal(physical(100, 720, false), 100);
  const css = readFileSync(THEME_FILE, "utf8") + themeTemplate();
  assert.match(css, /\.kw-net\[dir=rtl\],\[dir=rtl\] \.kw-net\{--dir:-1\}/); assert.doesNotMatch(css, /margin-left|margin-right|padding-left|padding-right|\bleft:|\bright:/, "logical properties only");
  assert.match(css, /translate:calc\(-50% \* var\(--dir\)\) -50%/, "node centring flips with the direction");
});

test("layout: no pill overlaps another or leaves the stage; no edge crosses a label; phone ladder fits; the CSS constants match", async () => {
  const r = await buildWidgets(spec(FIX));
  const data = r.generated.widgets.find((w) => w.archetype === "network" && w.locale === "en").data;
  for (const cfg of data.configurations) for (const mode of ["wide", "narrow"]) for (const rtl of [false, true]) {
    const { L, boxes, geom } = stageFor(data, cfg, mode, rtl);
    const ids = cfg.nodes;
    for (const id of ids) { const b = boxes[id]; assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= L.width && b.y - b.h / 2 >= 0 && b.y + b.h / 2 <= L.height, `${cfg.id}/${mode}: ${id} inside the stage`); }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = boxes[ids[i]], b = boxes[ids[j]];
      assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2, `${cfg.id}/${mode}: ${ids[i]} and ${ids[j]} do not overlap`);
    }
    if (cfg.layout !== "tiers" || mode === "narrow") for (const e of Object.values(geom)) for (const id of ids) {
      if (id === e.a || id === e.b) continue;
      const b = boxes[id];
      assert.ok(!e.pts.some((p) => Math.abs(p[0] - b.x) < b.w / 2 && Math.abs(p[1] - b.y) < b.h / 2), `${cfg.id}/${mode}: the edge ${e.a}-${e.b} does not cross the label ${id}`);
    }
  }
  // determinism and the phone ladder
  const sizes = Object.fromEntries(["a", "b", "c"].map((id) => [id, sizeOf(id)]));
  const nodes = [{ id: "a", cls: "participant" }, { id: "b", cls: "provider" }, { id: "c", cls: "infrastructure" }];
  assert.deepEqual(layoutNetwork({ nodes, sizes, mode: "narrow", width: 360 }), layoutNetwork({ nodes, sizes, mode: "narrow", width: 360 }));
  assert.equal(ladderRows(nodes, sizes, 360), 2); assert.equal(ladderHeight(2), 168 + 46 + 17 + 14);
  const css = readFileSync(join(fileURLToPath(new URL("../theme/plugins/", import.meta.url)), "network.css"), "utf8");
  assert.equal(NARROW_MAX, 520); assert.match(css, /@container kwnet \(max-width:519px\)/, "the phone breakpoint is the layout's");
  assert.match(css, new RegExp(`aspect-ratio:${WIDE_REF.w}/${WIDE_REF.h}`), "the stage's aspect is the layout's reference");
  assert.ok(Object.keys(HUB).length && hubBox(10, 10).h === HUB.h);
  // routes: through the hub when two nodes are not joined, along an edge when they are
  const { geom } = stageFor(data, data.configurations[1], "wide", false);
  assert.deepEqual(hopsOf("members", "payments", "hub", geom), ["members", "hub", "payments"]);
  assert.ok(routeOf("members", "payments", "hub", geom).length > 24);
  const m = measure(routeOf("members", "hub", "hub", geom)); assert.ok(along(m, 0.5).x > 0); assert.equal(edgeKey("b", "a"), "a|b");
  assert.deepEqual(Object.keys(edgesOf([["hub", "members"]], { hub: { x: 0, y: 0, w: 10, h: 10 }, members: { x: 100, y: 0, w: 10, h: 10 } })), ["hub|members"]);
});

test("counters keep the number the spec wrote: prefix, grouping, decimals, suffix and the locale's own digits", () => {
  const rt = (text, n, numerals) => { const p = parseNumber(text, numerals); return formatNumber(n ?? p.value, p, numerals); };
  for (const t of ["£420,000", "1,842", "8.4M", "99.8%", "£12,450.00 GBP", "12", "£84,220"]) assert.equal(rt(t), t, t);
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  assert.equal(parseNumber("۱۸٬۴۲۰", fa).value, 18420); assert.equal(rt("۱۸٬۴۲۰", null, fa), "۱۸٬۴۲۰");
  assert.equal(formatNumber(1234, parseNumber("£420,000"), undefined), "£1,234"); assert.equal(parseNumber("no digits"), null);
});

test("the registry knows the six, builder requires network, and each ships styles and a runtime that exist", () => {
  const reg = kitRegistry();
  for (const a of ARCHETYPES) { const p = reg.get(a); assert.ok(p.styles && p.runtime, a); assert.equal(p.capabilities.rtl, true); assert.equal(p.capabilities.reducedMotion, true); }
  assert.deepEqual(reg.get("builder").requires, ["network"]);
  assert.equal(reg.get("network").capabilities.needsCanvas, true); assert.equal(reg.get("split").capabilities.needsCanvas, false);
  const css = themeTemplate();
  for (const sel of [".kw-net__stage", ".kw-flow__track", ".kw-split__band", ".kw-netting__svg", ".kw-match__rec", ".kw-bld__form"]) assert.ok(css.includes(sel), `${sel} in the theme template`);
  assert.doesNotMatch(css.replace(/\{\{[^}]+\}\}/g, ""), /#[0-9a-f]{3,6}\b|rgba?\(|hsla?\(/i, "colours come from the tokens");
  for (const k of ["prefers-reduced-motion:reduce"]) assert.ok(css.split(k).length > 6, "every plugin stylesheet stills its motion under reduced motion");
});

test("embed: a visual shown as part of a site's own story says nothing about what it is made with (no build notes, no lead, no data-widget)", async () => {
  const { renderWidget } = await import("../src/index.js");
  const r = await buildWidgets(spec(FIX));
  const locale = r.generated.locales.find((l) => l.code === "en");
  for (const w of r.generated.widgets.filter((x) => x.locale === "en")) {
    const html = renderWidget(w, { locale, labels: r.generated.labels.en, registry: r.registry, embed: true });
    assert.doesNotMatch(html, /widget/i, `${w.archetype}: the word never appears in an embedded visual`);
    assert.doesNotMatch(html, /kw-about|kw__lead|How this/, `${w.archetype}: no build notes or lead`);
    assert.match(html, new RegExp(`data-kw-archetype="${w.archetype}"`));
    assert.match(renderWidget(w, { locale, labels: r.generated.labels.en, registry: r.registry }), new RegExp(`data-widget="${w.archetype}"`), "the default keeps its attribute");
  }
  const runtime = readFileSync(fileURLToPath(new URL("../assets/widgets.js", import.meta.url)), "utf8");
  assert.match(runtime, /data-kw-archetype/); assert.match(runtime, /kwBase/, "the module folder is named by data-kw-base, so a site may publish it under any path");
});

test("netting: the ratio reads localized digits (fa and en derive the same ratio from the same amounts)", async () => {
  const a = await buildWidgets(spec(FIX));
  const r = (loc) => a.generated.widgets.find((w) => w.archetype === "netting" && w.locale === loc).data.ratio;
  assert.ok(r("fa") > 0 && r("fa") < 1 && r("fa") !== 0.5, "the fallback ratio is only for amounts that cannot be read");
  assert.ok(Math.abs(r("fa") - r("en")) < 0.01, `fa ${r("fa")} vs en ${r("en")}`);
});

test("arrowheads: a reverse flow points from 'to' to 'from' (static HTML and reduced-motion painting)", async () => {
  const m = measure([[0, 0], [100, 0]]);
  assert.notEqual(arrowPath(m, 0.62, 6, true), arrowPath(m));
  assert.match(arrowPath(m), /^M68 0/, "forward: the tip is ahead of the point"); assert.match(arrowPath(m, 0.62, 6, true), /^M56 0/, "reverse: the tip is behind it");
  assert.match(readFileSync(new URL("../assets/widgets/plugins/network.js", import.meta.url), "utf8"), /direction === "reverse" \? s\.angle \+ Math\.PI/, "paintStatic turns the arrow for a reverse flow");
});
