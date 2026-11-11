// The network archetypes in a real browser (Chromium): they wake, they are operable by keyboard, they morph and fail over, they stay
// still under reduced motion, they pause off screen and in a hidden tab, they mirror in RTL, they keep to the work budget under
// a throttled CPU (the latency budget: bench/frame-budget.bench.mjs), and they do not overflow at phone and desktop widths. A missing browser FAILS (the repository's rule).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeWidgetsSite } from "./support/page.mjs";
import { writeStressSite } from "./support/stress.mjs";
import { serveSite } from "../../cli/src/visual-qa.js";
import { loadPlaywright, CHROMIUM, BROWSER_TEST_MS } from "../../cli/test/browser-env.mjs";
import { tempDir, fileTempDir } from "../../core/test/support/temp.mjs";

const FIX = fileURLToPath(new URL("./fixture-network/", import.meta.url));
const TMP = fileTempDir("kit-net-browser-");
let pw, browser, servers = [];
const sites = {};

before(async () => {
  pw = await loadPlaywright();
  browser = await pw.chromium.launch({ executablePath: CHROMIUM });
  for (const locale of ["en", "fa"]) {
    await writeWidgetsSite(join(TMP, locale), join(FIX, "widgets.spec.json"), { locale });
    sites[locale] = await serveSite(join(TMP, locale)); servers.push(sites[locale]);
  }
  // the worst case the budget allows: 24 nodes and 40 flows in one view
  await writeStressSite(join(TMP, "stress"), FIX, join(TMP, "stress-src"));
  sites.stress = await serveSite(join(TMP, "stress")); servers.push(sites.stress);
});
after(async () => { await browser?.close(); for (const s of servers) await s.close(); });

/** A page with its errors collected and the canvas draws counted (clearRect once per frame, arc per mark). */
async function open(site, { width = 1280, height = 900, reduced = false, locale = "en", throttle = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", deviceScaleFactor: 1, locale });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__draw = { frames: 0, arcs: 0, raf: 0, layoutShift: 0 };
    const p = CanvasRenderingContext2D.prototype, clear = p.clearRect, arc = p.arc;
    p.clearRect = function (...a) { window.__draw.frames++; return clear.apply(this, a); };
    p.arc = function (...a) { window.__draw.arcs++; return arc.apply(this, a); };
    const raf = window.requestAnimationFrame; window.requestAnimationFrame = (f) => { window.__draw.raf++; return raf(f); };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__draw.layoutShift += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch { /* no layout-shift entries here */ }
  });
  if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle }); }
  await page.goto(site.url + "/");
  await page.waitForSelector(".kw-net.is-live .kw-net__node");
  return { page, ctx, errors };
}
const draws = (page) => page.evaluate(() => ({ ...window.__draw }));
const net = (page) => page.locator('.kw[data-widget="network"] .kw-net').first();

test("they wake without errors: nodes become buttons, the live edges replace the static ones, and nothing overflows at 390, 1280, 1440 and 1920", { timeout: BROWSER_TEST_MS }, async () => {
  for (const w of [390, 1280, 1440, 1920]) {
    const { page, ctx, errors } = await open(sites.en, { width: w });
    await page.waitForTimeout(900);
    assert.deepEqual(errors, [], `${w}: no page or console errors`);
    assert.equal(await page.locator(".kw-net__node:not(button)").count(), 0, "every node is a button once awake");
    assert.equal(await page.locator(".kw-net__edges--live").count() >= 1, true);
    const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, widgets: [...document.querySelectorAll(".kw")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.dataset.widget) }));
    assert.ok(over.sw <= over.cw, `${w}: no horizontal scroll (${over.sw} > ${over.cw})`);
    assert.deepEqual(over.widgets, [], `${w}: no widget overflows`);
    await ctx.close();
  }
});

test("keyboard: Tab reaches the nodes, Enter opens a node's detail, Escape closes it; arrow keys move between views; roles and names are present", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx } = await open(sites.en);
  const n = net(page);
  await n.scrollIntoViewIfNeeded();
  assert.equal(await n.locator('[role="tablist"]').getAttribute("aria-label"), "View the network as");
  assert.equal(await n.locator('[data-kw-net-view][aria-selected="true"]').count(), 1);
  await n.locator('[data-kw-net-view="branch"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await n.locator('[data-kw-net-view="region"]').getAttribute("aria-selected"), "true", "ArrowRight selects the next view (LTR)");
  await page.keyboard.press("End");
  assert.equal(await n.locator('[data-kw-net-view="all"]').getAttribute("aria-selected"), "true");
  await page.keyboard.press("Home");
  await page.waitForTimeout(900);
  const node = n.locator('.kw-net__node[data-node="members"]');
  await node.focus();
  assert.equal(await node.evaluate((e) => e.tagName), "BUTTON");
  assert.match(await n.locator(".kw-net__flow.is-lit").first().textContent(), /Late fees/, "focus lights the node's flows");
  await page.keyboard.press("Enter");
  assert.equal(await node.getAttribute("aria-pressed"), "true");
  const shown = n.locator(".kw-net__d:not([hidden])");
  assert.equal(await shown.count(), 1); assert.match(await shown.textContent(), /Members[\s\S]*Borrow and pay fees[\s\S]*Loans/);
  await page.keyboard.press("Escape");
  assert.equal(await node.getAttribute("aria-pressed"), "false");
  assert.equal(await n.locator('[role="status"]').count() >= 1, true, "a polite live region announces changes");
  // the whole widget is reachable by Tab alone: count tab stops inside it
  await n.locator('[data-kw-net-view="branch"]').focus();
  const stops = new Set();
  for (let i = 0; i < 16; i++) { await page.keyboard.press("Tab"); stops.add(await page.evaluate(() => document.activeElement?.dataset?.node || document.activeElement?.className || "")); }
  assert.ok([...stops].some((s) => s === "members") && [...stops].some((s) => s === "courier-a"), `Tab visits the nodes: ${[...stops].join(", ")}`);
  await ctx.close();
});

test("morph: switching a view glides the nodes (entering ones grow in, leaving ones fade), the stage keeps its size and the page does not shift", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx, errors } = await open(sites.en);
  const n = net(page); await n.scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);
  const before = await n.locator(".kw-net__stage").boundingBox();
  const pos = async (id) => n.locator(`.kw-net__node[data-node="${id}"]`).evaluate((e) => e.style.transform);
  const members0 = await pos("members");
  await n.locator('[data-kw-net-view="region"]').click();
  await page.waitForTimeout(160);
  assert.ok(await n.locator(".kw-net__node.is-entering").count() + await n.locator(".kw-net__node").count() > 4, "new nodes exist at once");
  const mid = await pos("members");
  await page.waitForTimeout(1300);
  const members1 = await pos("members");
  assert.notEqual(members0, members1, "a persisting node moved to its place in the new view");
  assert.ok(mid !== members1 || members0 !== members1, "and it was in motion on the way");
  assert.equal(await n.locator(".kw-net__node").count(), 8, "the new view's nodes are all there");
  const after = await n.locator(".kw-net__stage").boundingBox();
  assert.equal(after.height, before.height, "no layout shift: the stage keeps its height");
  await n.locator('[data-kw-net-view="branch"]').click(); await page.waitForTimeout(1300);
  assert.equal(await n.locator(".kw-net__node").count(), 4, "leaving nodes are removed after they fade");
  const shift = (await draws(page)).layoutShift;
  assert.ok(shift < 0.02, `cumulative layout shift ${shift} stays under 0.02`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("failover: one provider's edge fades and the flow continues through another, announced to screen readers", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx } = await open(sites.en);
  const n = net(page); await n.scrollIntoViewIfNeeded();
  await n.locator('[data-kw-net-view="region"]').click(); await page.waitForTimeout(1500);
  const log = n.locator("[data-kw-net-log]");
  await n.locator("[data-kw-net-event]").click();
  await page.waitForTimeout(300);
  assert.match(await log.textContent(), /Courier A is unavailable/);
  assert.ok(await n.locator('.kw-net__node[data-node="courier-a"].is-fault').count() >= 1, "the failing provider is marked");
  await page.waitForTimeout(2600);
  assert.ok(await n.locator('.kw-net__edge.is-down').count() >= 1, "its edge faded out");
  assert.ok(await n.locator('.kw-net__node[data-node="courier-b"].is-takeover').count() === 1, "the other provider takes over");
  assert.match(await log.textContent(), /continue through Courier B/);
  assert.equal(await log.getAttribute("aria-live"), "polite");
  await ctx.close();
});

test("reduced motion: no loop, no frames, the final states are shown at once (failover done, counters final, flow finished)", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx, errors } = await open(sites.en, { reduced: true });
  const n = net(page); await n.scrollIntoViewIfNeeded();
  await n.locator('[data-kw-net-view="region"]').click(); await page.waitForTimeout(700);
  assert.ok(await n.locator('.kw-net__node[data-node="courier-b"].is-takeover').count() === 1, "the failover is shown in its final state");
  assert.ok(await n.locator(".kw-net__edge.is-down").count() >= 1);
  assert.match(await n.locator("[data-kw-net-log]").textContent(), /continue through Courier B/);
  assert.match(await n.locator('[data-counter="k2"] [data-kw-count]').textContent(), /^18,420$/, "counters show the number the spec wrote, not a count-up");
  assert.ok(await n.evaluate((e) => e.classList.contains("is-still")) && await n.locator(".kw-net__arrow").count() >= 1, "arrowheads carry the direction instead of particles");
  const flow = page.locator('.kw[data-widget="flow"]').first(); await flow.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
  assert.equal(await flow.locator('.kw-flow__hop[data-state="done"]').count(), 4); assert.equal(await flow.locator(".kw-flow__token").isHidden(), true);
  const d = await draws(page);
  await page.waitForTimeout(1000);
  const d2 = await draws(page);
  assert.equal(d2.frames, d.frames, "no frame is drawn while idle under reduced motion");
  assert.ok(d2.raf - d.raf <= 1, "and no animation frame is requested");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the loop pauses off screen and in a hidden tab, and resumes", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx } = await open(sites.en);
  const n = net(page); await n.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
  const count = async (ms) => { const a = (await draws(page)).frames; await page.waitForTimeout(ms); return (await draws(page)).frames - a; };
  assert.ok(await count(700) > 15, "drawing while visible");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500);
  assert.ok(await count(700) <= 2, "no frames while off screen");
  await net(page).scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
  assert.ok(await count(700) > 15, "it resumes when it returns");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  assert.ok(await count(600) <= 2, "no frames in a hidden tab");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(400);
  assert.ok(await count(600) > 12, "and back");
  await ctx.close();
});

test("RTL: the picture is mirrored (participants on the right, providers on the left) and the arrow keys follow the direction", { timeout: BROWSER_TEST_MS }, async () => {
  const { page, ctx, errors } = await open(sites.fa, { locale: "fa" });
  const n = net(page); await n.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".kw-net")).direction), "rtl");
  await n.locator('[data-kw-net-view="region"]').click(); await page.waitForTimeout(1500);
  const stage = await n.locator(".kw-net__stage").boundingBox();
  const cx = async (id) => { const b = await n.locator(`.kw-net__node[data-node="${id}"]`).boundingBox(); return b.x + b.width / 2 - stage.x; };
  assert.ok(await cx("members") > stage.width / 2, "participants sit on the start side: the right");
  assert.ok(await cx("courier-b") < stage.width / 2, "providers sit on the end side: the left");
  for (const id of ["members", "schools", "courier-a", "catalogue"]) { const b = await n.locator(`.kw-net__node[data-node="${id}"]`).boundingBox(); assert.ok(b.x >= stage.x - 1 && b.x + b.width <= stage.x + stage.width + 1, `${id} inside the stage`); }
  await n.locator('[data-kw-net-view="region"]').focus(); await page.keyboard.press("ArrowLeft");
  assert.equal(await n.locator('[data-kw-net-view="all"]').getAttribute("aria-selected"), "true", "ArrowLeft moves forward in RTL");
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll(".kw-net__counters dd")].map((e) => e.textContent).join("|")).then((t) => /[0-9]/.test(t)), false, "figures keep the locale's own digits (no Latin digits)");
  await ctx.close();
});

test("work budget: the worst view the budget allows (24 nodes, 40 flows) draws once per frame, caps its particles, and keeps drawing on a CPU throttled four times", { timeout: BROWSER_TEST_MS }, async () => {
  // Counters, not clocks: a loaded runner decides a latency, never a count. The latency budget is bench/frame-budget.bench.mjs, on the dedicated runner only.
  const { page, ctx, errors } = await open(sites.stress, { throttle: 4 });
  const n = net(page); await n.scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);
  const m = await page.evaluate(() => new Promise((done) => {
    let ticks = 0; window.__draw.arcs = 0; const f0 = window.__draw.frames;
    const tick = () => { ticks++; if (ticks < 240) requestAnimationFrame(tick); else done({ ticks, drawn: window.__draw.frames - f0, arcs: window.__draw.arcs }); };
    requestAnimationFrame(tick);
  }));
  const perFrame = m.arcs / Math.max(1, m.drawn);
  assert.ok(m.drawn <= m.ticks + 2, `${m.drawn} canvas clears for ${m.ticks} frames: at most one draw per frame`);
  assert.ok(m.drawn >= m.ticks * 0.5, `${m.drawn} draws in ${m.ticks} frames: the loop keeps up under a throttled CPU`);
  assert.ok(perFrame <= 72 * 6 + 40, `${perFrame} arcs per frame: particles are capped at 72 (head, halo, four trail marks each)`);
  assert.ok(perFrame >= 100, "and the stress view really is drawing its flows");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("visual QA: every archetype, LTR and RTL, phone and desktop: nothing overflows, no label overlaps another, screenshots are taken", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = join(TMP, "shots"); mkdirSync(out, { recursive: true });
  for (const locale of ["en", "fa"]) for (const w of [390, 1280]) {
    const { page, ctx, errors } = await open(sites[locale], { width: w, locale });
    await page.waitForTimeout(600);
    for (const a of ["network", "flow", "split", "netting", "match", "builder"]) {
      const el = page.locator(`.kw[data-widget="${a}"]`).first();
      await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(a === "network" ? 1600 : 3200);
      const r = await el.evaluate((e) => ({ over: e.scrollWidth - e.clientWidth, box: e.getBoundingClientRect().width }));
      assert.ok(r.over <= 1, `${a} ${locale} ${w}: no horizontal overflow (${r.over}px)`);
      const file = join(out, `${a}-${locale}-${w}.png`);
      await el.screenshot({ path: file });
      assert.ok(statSync(file).size > 4000, `${a} ${locale} ${w}: a real screenshot`);
      if (a === "network") {
        const boxes = await el.locator(".kw-net__node").evaluateAll((es) => es.map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.node, b.x, b.y, b.width, b.height]; }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const [, ax, ay, aw, ah] = boxes[i], [, bx, by, bw, bh] = boxes[j];
          assert.ok(ax + aw <= bx + 0.5 || bx + bw <= ax + 0.5 || ay + ah <= by + 0.5 || by + bh <= ay + 0.5, `network ${locale} ${w}: ${boxes[i][0]} and ${boxes[j][0]} overlap`);
        }
      }
    }
    assert.deepEqual(errors, [], `${locale} ${w}: no errors`);
    await ctx.close();
  }
});
