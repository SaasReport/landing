// Opens dist/ in Chromium at phone and desktop width, drives every widget, and fails on console errors, horizontal overflow, a dead click or a missing font.
// Screenshots go to the directory in argv[2] (default qa/). Needs a built dist/.
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((q, r) => { let body, p; try { p = q.url === "/" ? "/index.html" : q.url.split("?")[0]; body = readFileSync(join("dist", p)); } catch { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }); r.end(body); });
await new Promise((ok) => server.listen(0, ok));
const url = `http://127.0.0.1:${server.address().port}/`;
const outDir = process.argv[2] ?? "qa"; mkdirSync(outDir, { recursive: true });
const fails = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [name, w, h] of [["phone", 390, 844], ["desktop", 1280, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("console", (m) => m.type() === "error" && fails.push(`${name}: console error: ${m.text()}`));
  page.on("pageerror", (e) => fails.push(`${name}: page error: ${e.message}`));
  await page.goto(url); await page.waitForSelector("html[data-ready]");
  await page.screenshot({ path: join(outDir, `${name}-top.png`) });
  const first = await page.locator("#report").innerText();
  const buttons = page.locator(".who"); const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();
    const label = await buttons.nth(i).innerText();
    if ((await buttons.nth(i).getAttribute("aria-selected")) !== "true") fails.push(`${name}: ${label} did not become selected`);
    if (!(await page.locator("#report .sect").count())) fails.push(`${name}: ${label} shows no report sections`);
  }
  await buttons.nth(count - 1).click();
  if ((await page.locator("#report").innerText()) === first) fails.push(`${name}: choosing another stakeholder did not change the report`);
  await page.selectOption("#currency", { index: 1 });
  await page.locator(".role input").first().check();
  if (!(await page.locator("#access-out li").count())) fails.push(`${name}: choosing a role listed no report`);
  await page.locator(".role input").first().uncheck();
  await page.fill("#roi-people", "10"); await page.fill("#roi-hours", "2"); await page.fill("#roi-rate", "50");
  const hours = await page.locator("#r-hours").innerText();
  if (hours !== "80") fails.push(`${name}: ROI hours expected 80 (10 people x 4 reports x 2 hours), got ${hours}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) fails.push(`${name}: horizontal overflow of ${overflow}px`);
  const font = await page.evaluate(() => document.fonts.check("16px system-ui"));
  if (!font) fails.push(`${name}: system font unavailable`);
  await page.locator("#try").scrollIntoViewIfNeeded(); await page.screenshot({ path: join(outDir, `${name}-try.png`), fullPage: false });
  await page.screenshot({ path: join(outDir, `${name}-full.png`), fullPage: true });
  await page.close();
}
await browser.close(); server.close();
for (const f of fails) console.error(`  - ${f}`);
if (fails.length) { console.error(`qa: ${fails.length} problem${fails.length === 1 ? "" : "s"}`); process.exit(1); }
console.log(`ok qa: every stakeholder, currency, role and ROI input responds; no overflow or console errors (screenshots in ${outDir}/)`);
