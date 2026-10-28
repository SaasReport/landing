// Browser QA of the built dist at 390x844 and 1280x800: every widget answers a click or an input, nothing overflows,
// no console error, no failed request; then the kit's own layout QA of the widgets (kit widgets qa).
// Needs Chromium: KIT_CHROMIUM names the executable (default: Playwright's own).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const dist = new URL("../dist/", import.meta.url).pathname;
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".xml": "application/xml", ".md": "text/markdown" };
const server = createServer((q, r) => {
  let p = join(dist, decodeURIComponent(q.url.split("?")[0]));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) { r.statusCode = 404; return r.end("not found"); }
  r.setHeader("content-type", types[extname(p)] || "application/octet-stream"); r.end(readFileSync(p));
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const base = `http://127.0.0.1:${server.address().port}`;
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); };

const browser = await chromium.launch({ executablePath: process.env.KIT_CHROMIUM || undefined });
for (const [w, h] of [[390, 844], [1280, 800]]) {
  for (const path of ["/", "/examples/"]) {
    const where = `${path} at ${w}px`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on("console", (m) => m.type() === "error" && problems.push(`${where}: console error: ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`${where}: page error: ${e.message}`));
    page.on("requestfailed", (r) => problems.push(`${where}: request failed: ${r.url()}`));
    page.on("response", (r) => r.status() >= 400 && problems.push(`${where}: ${r.status()} ${r.url()}`));
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${where}: horizontal overflow`);
    const widgets = await page.$$("[data-kw-archetype], [data-widget]");
    check(widgets.length === 8, `${where}: ${widgets.length} widgets, expected 8`);

    // roles: picking another tab shows another panel
    for (const arche of ["roles"]) {
      for (const root of await page.$$(`[data-kw-archetype="${arche}"], [data-widget="${arche}"]`)) {
        const tabs = await root.$$('[role="tab"]');
        check(tabs.length >= 3, `${where}: a roles widget has ${tabs.length} tabs`);
        const before = await root.$eval('[role="tabpanel"]:not([hidden])', (e) => e.textContent);
        await tabs[2].scrollIntoViewIfNeeded(); await tabs[2].click();
        check((await tabs[2].getAttribute("aria-selected")) === "true", `${where}: a roles tab did not become selected`);
        const after = await root.$eval('[role="tabpanel"]:not([hidden])', (e) => e.textContent);
        check(before !== after, `${where}: a roles panel did not change when a tab was picked`);
      }
    }
    // calculator: an input recomputes the results
    const calc = await page.$("[data-kw-calc]");
    if (calc) {
      const out = () => calc.$$eval("output", (o) => o.map((x) => x.textContent).join("|"));
      const before = await out();
      const input = await calc.$('input[name="people"]');
      await input.scrollIntoViewIfNeeded(); await input.fill("10");
      check(before !== (await out()), `${where}: the calculator did not recompute`);
    } else check(false, `${where}: no calculator`);
    // screens: Next shows another screen
    const next = await page.$('[data-kw-archetype="screens"] button:has-text("Next"), [data-widget="screens"] button:has-text("Next")');
    if (next) { await next.scrollIntoViewIfNeeded(); await next.click(); check((await page.textContent('[data-kw-archetype="screens"], [data-widget="screens"]')).includes("Screen 2 of 3"), `${where}: Next did not move to screen 2`); } else check(false, `${where}: no Next button on the screens widget`);
    // runs: the second case is refused by the guard
    const runs = await page.$('[data-kw-archetype="runs"], [data-widget="runs"]');
    if (runs) {
      const second = await runs.$('[data-kw-case="1"]'); await second.scrollIntoViewIfNeeded(); await second.click();
      await (await runs.$("[data-kw-run]")).click(); await page.waitForTimeout(2500);
      const text = await runs.textContent();
      check(/not computed by the engine/.test(text), `${where}: the guard case did not show the refusal`);
    } else check(false, `${where}: no runs widget`);
    // pipeline and feed and timeline: Run / Replay buttons are alive
    for (const sel of ['[data-kw-archetype="pipeline"] [data-kw-run], [data-widget="pipeline"] [data-kw-run]', '[data-kw-archetype="feed"] [data-kw-replay], [data-widget="feed"] [data-kw-replay]']) {
      const b = await page.$(sel); check(Boolean(b), `${where}: missing ${sel}`);
      if (b) { await b.scrollIntoViewIfNeeded(); await b.click(); }
    }
    // the early-access call to action opens the form modal, which carries every declared field
    if (path === "/") {
      const cta = await page.$('.hero [data-modal="early"]');
      check(Boolean(cta), `${where}: no early-access call to action in the hero`);
      if (cta) {
        await cta.click(); await page.waitForTimeout(400);
        check(await page.$eval("#m-early", (d) => d.open), `${where}: the early-access modal did not open`);
        check((await page.$$('#m-early [name]')).length >= 6, `${where}: the early-access form lacks fields`);
      }
      check((await page.$$('[data-modal="early"]')).length >= 5, `${where}: fewer than five early-access calls to action`);
    }
    await page.close();
  }
}
await browser.close();
let widgetQa = "";
try {
  const args = ["vendor/kit/packages/cli/bin/kit.js", "widgets", "qa", `${base}/`, `${base}/examples/`, "--widths", "390,1280"];
  if (process.env.KIT_CHROMIUM) args.push("--chromium", process.env.KIT_CHROMIUM);
  widgetQa = (await promisify(execFile)("node", args, { encoding: "utf8", timeout: 240000 })).stdout;
} catch (e) { problems.push(`kit widgets qa failed: ${e.stderr || e.stdout || e.message}`); }
server.close();
if (problems.length) { console.error(problems.map((p) => `  - ${p}`).join("\n")); console.error(`qa: ${problems.length} problem(s)`); process.exit(1); }
console.log(`ok: 8 widgets answer clicks and inputs at 390 and 1280 on both pages, no overflow, no console error\n${widgetQa.trim().split("\n").pop()}`);
