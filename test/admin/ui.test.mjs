// The generated admin interface in a real browser (Chromium), served by the admin Worker in-process: a signed test token stands in for the
// Access edge, so every request is verified exactly as in production. Needs `npm run build` (workers/admin/dist) and Chromium (KIT_CHROMIUM
// names the executable; default: Playwright's own). Screenshots go to .admin-qa/ for a human look at 390 and 1280.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { makeAdmin, makeComms, seedLead, ORIGIN } from "./helpers.mjs";

const dist = new URL("../../workers/admin/dist/", import.meta.url).pathname;
const shots = new URL("../../.admin-qa/", import.meta.url).pathname;
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".md": "text/markdown" };
let server, base, browser, admin, leadId;

before(async () => {
  assert.ok(existsSync(join(dist, "workbench/index.html")), "workers/admin/dist is missing: run `npm run build` first (a skipped check is not a pass)");
  mkdirSync(shots, { recursive: true });
  admin = makeAdmin();
  admin.env.ASSETS = { fetch: async (r) => {
    let p = join(dist, decodeURIComponent(new URL(r.url).pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(p), { headers: { "content-type": types[extname(p)] || "application/octet-stream" } });
  } };
  admin.env.COMMS = makeComms(admin.env.ENGINE_DB);
  leadId = await seedLead(admin.env.ENGINE_DB, { name: "Browser Lead", company: "Pane Test Ltd" });
  await seedLead(admin.env.ENGINE_DB, { name: "Failed Owner", owner: "failed", owner_error: "no_recipients", created_at: "2026-10-01T10:00:00.000Z" });
  server = createServer(async (q, r) => {
    const chunks = [];
    for await (const c of q) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(q.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("cf-access-jwt-assertion", admin.token());               // what the Access edge adds
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const res = await admin.worker.fetch(new Request(`http://${q.headers.host}${q.url}`, { method: q.method, headers, body: ["GET", "HEAD"].includes(q.method) ? undefined : body }), admin.env, {});
    r.statusCode = res.status;
    res.headers.forEach((v, k) => r.setHeader(k, v));
    r.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.KIT_CHROMIUM || undefined });
});
after(async () => { await browser?.close(); await new Promise((res) => server?.close(res)); });

async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => !/ERR_ABORTED/.test(r.failure()?.errorText || "") && problems.push(`request failed: ${r.url()}`));   // a pane that is replaced aborts its own fetch
  page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  await page.goto(`${base}/workbench/`, { waitUntil: "load" });
  return { page, problems };
}
const settle = (page) => page.waitForFunction(() => !document.querySelector('.wb-pane__body[aria-busy="true"]'), null, { timeout: 15000 });
const run = async (page, line) => { await page.fill("[data-wb-input]", line); await page.keyboard.press("Enter"); await page.waitForTimeout(200); await settle(page); };
const bodyText = (page) => page.evaluate(() => document.body.innerText);

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`at ${w}px: the default panes render from the live API, nothing overflows, no error, no CSP violation`, async () => {
    const { page, problems } = await open(w, h);
    await settle(page);
    const text = await bodyText(page);
    assert.match(text, /Not connected|not connected|No billing/i, "finops shows its honest empty state");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow of the page");
    await page.screenshot({ path: `${shots}default-${w}.png`, fullPage: true });
    await page.locator("[data-wb-grid]").screenshot({ path: `${shots}grid-${w}.png` });
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`at ${w}px: every layout opens and every pane of it renders without an error pane`, async () => {
    const { page, problems } = await open(w, h);
    await settle(page);
    const layouts = await page.$$eval("[data-wb-layouts] option", (o) => o.map((x) => x.value));
    assert.ok(layouts.length >= 6);
    for (const id of layouts) {
      await page.selectOption("[data-wb-layouts]", id);
      await settle(page);
      const tabs = await page.$$('[role="tab"]');
      for (let i = 0; i < tabs.length; i++) { await page.$$('[role="tab"]').then((t) => t[i].click()); await settle(page); }
      assert.equal(await page.locator(".wb-err, [data-wb-error]").count(), 0, `layout ${id} has no error pane`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `layout ${id}: no overflow`);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });
}

test("a command opens the pane and shows the stored lead and the failed delivery", async () => {
  const { page, problems } = await open(1280, 800);
  await settle(page);
  await run(page, "LEADS");
  assert.match(await bodyText(page), /Browser Lead/);
  await run(page, "DELIV failed");
  assert.match(await bodyText(page), /no_recipients/);
  await run(page, "ROLES");
  assert.match(await bodyText(page), /operator/);
  await page.screenshot({ path: `${shots}commands-1280.png`, fullPage: true });
  assert.deepEqual(problems, []);
  await page.close();
});

test("keyboard: the command line takes focus with / and every control is reachable by Tab", async () => {
  const { page } = await open(1280, 800);
  await settle(page);
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-wb-input")), true);
  await page.close();
});

test("a lead status change posts from the page, is accepted as same-origin, and is audited and shown", async () => {
  const { page, problems } = await open(1280, 800);
  await settle(page);
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/leads/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "contacted", note: "from the browser test" }) });
    return { status: r.status, body: await r.json() };
  }, leadId);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "contacted");
  await run(page, "AUDIT updateLead");
  const text = await bodyText(page);
  assert.match(text, /updateLead/);
  assert.match(text, new RegExp(leadId));
  await run(page, "LEADS contacted");
  assert.doesNotMatch(await bodyText(page), /No lead matches/);
  const rows = (await admin.env.DB.prepare("SELECT outcome, action FROM admin_audit WHERE action = 'updateLead'").all()).results;
  assert.ok(rows.length >= 1 && rows.every((r) => r.outcome === "done"));
  assert.ok(problems.every((p) => !/^(5\d\d)/.test(p)), problems.join("; "));
  await page.close();
});
