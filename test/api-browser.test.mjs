// Browser QA of the live API wiring, in headless Chromium: the built landing is served locally; every request the page makes to
// https://api.saasreport.ai is answered in-process by the API Worker's own fetch handler (nothing leaves the machine).
//   1. the Developers section is on the landing, and its "Open a live call" link, clicked, shows the Worker's answer;
//   2. the generated SDK (dist/sdk/saasreport/index.mjs), loaded by the page like any client, calls the Worker across origins
//      (CORS, preflight included) and the page renders what came back;
//   3. the API reference page is rendered from the contract.
// What it does NOT show: a widget of the landing calling the API. The kit's widget runtime has no live source yet (see the PR).
// Needs Chromium: KIT_CHROMIUM names the executable (default: Playwright's own).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import worker from "../workers/api/src/worker.js";

const dist = new URL("../dist/", import.meta.url).pathname;
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".xml": "application/xml", ".md": "text/markdown", ".woff2": "font/woff2" };
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

const env = { BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567", RATE_LIMITER: { limit: async () => ({ success: true }) } };
const served = [];
const browser = await chromium.launch({ executablePath: process.env.KIT_CHROMIUM || undefined });
for (const [w, h] of [[390, 844], [1280, 800]]) {
  const where = `at ${w}px`;
  const context = await browser.newContext({ viewport: { width: w, height: h } });
  await context.route("https://api.saasreport.ai/**", async (route) => {
    const req = route.request();
    const res = await worker.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD", "OPTIONS"].includes(req.method()) ? undefined : req.postData() }), env, {});
    served.push(`${req.method()} ${new URL(req.url()).pathname} ${res.status}`);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${where}: page error: ${e.message}`));
  // the one expected 404 is the SDK call for an unknown registry
  page.on("console", (m) => m.type() === "error" && !m.location().url.endsWith("/v1/registries/nope") && problems.push(`${where}: console error: ${m.text()} ${m.location().url}`));

  // 1. the section and its live link
  await page.goto(`${base}/`, { waitUntil: "load" });
  const section = page.locator("#developers");
  check(await section.count() === 1, `${where}: no #developers section`);
  await section.scrollIntoViewIfNeeded();
  check((await section.locator("article").count()) === 4, `${where}: the developers section does not have its four cards`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${where}: horizontal overflow`);
  const live = page.locator("#cta-developers a", { hasText: "live call" });
  const href = await live.getAttribute("href");
  check(/^https:\/\/api\.saasreport\.ai\/v1\/registries\/stakeholders$/.test(href || ""), `${where}: the live link is ${href}`);
  await live.scrollIntoViewIfNeeded();
  await Promise.all([page.waitForURL("https://api.saasreport.ai/**"), live.click()]);
  const shown = JSON.parse(await page.evaluate(() => document.body.innerText));
  check(shown.registry === "saasreport.stakeholders" && shown.stakeholders.length > 3, `${where}: the live link did not show the stakeholders registry`);

  // 2. the generated SDK, called by a page across origins
  await page.goto(`${base}/`, { waitUntil: "load" });
  const out = await page.evaluate(async (sdkUrl) => {
    const { createClient, ApiError } = await import(sdkUrl);
    const api = createClient();                                    // the contract's own server
    const el = document.createElement("pre"); el.id = "api-out"; document.body.append(el);
    const report = await api.sample.getSampleReport({ type: "revenue-health", stakeholder: "ceo_founder" });
    const guard = await api.guard.checkNarrative({ body: { text: "Retention was 104% and 7 deals.", facts: ["104%"] } });
    let missing; try { await api.registries.getRegistry({ name: "nope" }); } catch (e) { missing = e instanceof ApiError ? e.status : String(e); }
    el.textContent = `${report.title}\n${report.sections[0].figures.map((f) => `${f.name}: ${f.display}`).join("\n")}\nguard: ${guard.decision} ${guard.unsupported.join(",")}\nunknown registry: ${missing}`;
    return { title: report.title, sample: report.sample, label: report.meta.label, decision: guard.decision, unsupported: guard.unsupported, missing, text: el.textContent };
  }, `${base}/sdk/saasreport/index.mjs`);
  check(out.sample === true && out.label === "SAMPLE" && /: /.test(out.title), `${where}: the SDK report is not labelled sample (${JSON.stringify(out)})`);
  check(out.decision === "deny" && out.unsupported.join() === "7" && out.missing === 404, `${where}: the SDK guard or error path is off (${JSON.stringify(out)})`);
  check((await page.locator("#api-out").innerText()).includes(out.title), `${where}: the page did not render the response`);

  // 3. the reference page
  await page.goto(`${base}/developers/api/api/`, { waitUntil: "load" });
  check((await page.locator(".rf-op").count()) === 8, `${where}: the reference does not list 8 operations`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${where}: reference overflows`);
  await context.close();
}
await browser.close();
server.close();
const calls = new Set(served);
for (const must of ["GET /v1/registries/stakeholders 200", "GET /v1/sample/report 200", "POST /v1/guard 200", "GET /v1/registries/nope 404"]) check(calls.has(must), `the Worker never answered ${must} (answered: ${[...calls].join("; ")})`);
if (problems.length) { console.error(problems.map((p) => `FAIL ${p}`).join("\n")); process.exit(1); }
console.log(`ok: the landing's live link and the generated SDK reached the Worker from Chromium at 390 and 1280 (${calls.size} distinct calls answered by the Worker)`);
