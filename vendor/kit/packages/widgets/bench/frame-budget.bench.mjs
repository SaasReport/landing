// The network archetype's latency budget: on the stress view (24 nodes, 40 flows) with the CPU throttled four times, the median
// frame stays within 60 fps and p95 within 30 fps. Host time decides a latency, so this runs only on a dedicated runner:
//   KIT_DEDICATED_RUNNER=1 node --test packages/widgets/bench/frame-budget.bench.mjs
// npm test asserts the work counters instead (test/network-browser.test.mjs, "work budget").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeStressSite } from "../test/support/stress.mjs";
import { serveSite } from "../../cli/src/visual-qa.js";
import { loadPlaywright, CHROMIUM, BROWSER_TEST_MS } from "../../cli/test/browser-env.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const dedicated = Boolean(process.env.KIT_DEDICATED_RUNNER);
const FIX = fileURLToPath(new URL("../test/fixture-network/", import.meta.url));
const TMP = fileTempDir("kit-net-bench-");
let browser, site;

before(async () => {
  if (!dedicated) return;
  await writeStressSite(join(TMP, "stress"), FIX, join(TMP, "stress-src"));
  site = await serveSite(join(TMP, "stress"));
  browser = await (await loadPlaywright()).chromium.launch({ executablePath: CHROMIUM });
});
after(async () => { await browser?.close(); await site?.close(); });

test("frame budget: the stress view holds a 60 fps median and a 30 fps p95 on a CPU throttled four times", { skip: !process.env.KIT_DEDICATED_RUNNER && "a latency budget needs the dedicated runner (KIT_DEDICATED_RUNNER=1)", timeout: BROWSER_TEST_MS }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(site.url + "/");
  await page.waitForSelector(".kw-net.is-live .kw-net__node");
  await page.locator(".kw-net").first().scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);
  const m = await page.evaluate(() => new Promise((done) => {
    const dts = []; let last = performance.now(); const end = last + 4000;
    const tick = (now) => { dts.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { dts.sort((a, b) => a - b); const at = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))]; done({ n: dts.length, p50: at(0.5), p95: at(0.95) }); } };
    requestAnimationFrame(tick);
  }));
  console.log(`# frame budget (CPU x4, 24 nodes, 40 flows): ${m.n} frames, p50 ${m.p50.toFixed(1)} ms, p95 ${m.p95.toFixed(1)} ms`);
  assert.ok(m.p50 <= 17.5, `median frame ${m.p50} ms stays within 60 fps`);
  assert.ok(m.p95 <= 34, `p95 frame ${m.p95} ms never drops below 30 fps`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
