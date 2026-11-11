// The early-access form in a real browser, at 390x844 and 1280x800: the built page (dist) is served with the endpoint
// (src/form-intake.js over a real SQLite database) on the same origin, as Cloudflare Pages serves them.
// Run after `npm run build`. KIT_QA_SHOTS=<dir> keeps a picture of each state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { chromium } from "playwright";
import { intake, TABLE } from "../src/form-intake.js";
import FORMS from "../src/forms.generated.js";

const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".xml": "application/xml" };
const SHOTS = process.env.KIT_QA_SHOTS;
const VIEWS = [[390, 844], [1280, 800]];
let server, base, browser, sql, env;

function d1() {
  sql = withD1Limits(new DatabaseSync(":memory:"));
  const stmt = (text, args = []) => ({ bind: (...a) => stmt(text, a), first: async () => sql.prepare(text).get(...args) ?? null, run: async () => { sql.prepare(text).run(...args); return { success: true }; } });
  return { prepare: (text) => stmt(text), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}
const rows = () => (sql.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(TABLE) ? sql.prepare(`SELECT * FROM ${TABLE}`).all() : []);

before(async () => {
  assert.ok(existsSync(join(DIST, "index.html")), "dist/index.html exists: run npm run build first");
  server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const m = url.pathname.match(/^\/api\/forms\/([^/]+)$/);
    if (m) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
      const request = new Request(url, { method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      const out = await intake(request, env, decodeURIComponent(m[1]), FORMS);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    const rel = normalize(url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
    try {
      const body = await readFile(join(DIST, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.KIT_CHROMIUM ? { executablePath: process.env.KIT_CHROMIUM } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await new Promise((r) => server.close(r)); });

async function open(w, h) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  const posts = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("request", (r) => { if (r.url().includes("/api/forms/")) posts.push(r.method()); });
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  // the first call to action a visitor can see at this width (the navigation's own is inside the drawer on a phone)
  const cta = page.locator('[data-modal="early"]:visible').first();
  await cta.click();
  const form = page.locator('form[data-form="early-access"]');
  await form.waitFor({ state: "visible" });
  return { context, page, form, problems, posts };
}
async function fill(form, over = {}) {
  const v = { name: "Ada Example", email: "ada@example.com", company: "Example Ltd", role: "Finance lead", ...over };
  for (const [k, x] of Object.entries(v)) await form.locator(`[name="${k}"]`).fill(x);
  // a visitor taps the chip (its label); the checkbox inside it is the control the chip draws
  await form.locator(".fchips__o").first().click();
  assert.equal(await form.locator('input[name="reports"]').first().isChecked(), true);
  await form.locator('input[name="consent"]').check();
}
const status = (form) => form.locator("[data-form-status]");
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

for (const [w, h] of VIEWS) {
  test(`${w}x${h}: a request is sent, stored once and confirmed in the modal, with nothing in the address`, async () => {
    env = { FORMS_DB: d1() };
    const { context, page, form, problems, posts } = await open(w, h);
    await page.waitForTimeout(700); // the modal's opening transition
    await shot(page, `form-open-${w}`);
    await fill(form);
    await form.locator('button[type="submit"]').click();
    await assert.doesNotReject(status(form).filter({ hasText: /Your reference is SR-\d{8}-[0-9A-F]{8}\./ }).waitFor({ timeout: 10000 }));
    await shot(page, `form-done-${w}`);
    assert.equal(new URL(page.url()).search, "", "no answers in the address");
    assert.deepEqual(posts, ["POST"]);
    const stored = rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].email, "ada@example.com");
    assert.ok((await status(form).innerText()).includes(stored[0].reference));
    assert.equal(await form.locator(".fgrid").isVisible(), false, "the fields give way to the confirmation");
    assert.equal(await form.locator('button[type="submit"]').isVisible(), false);
    const box = await status(form).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= w + 1, "the confirmation fits the width");
    // closed and opened again, the form is fresh
    await form.locator("[data-close]").click();
    await page.locator('[data-modal="early"]:visible').first().click();
    await form.waitFor({ state: "visible" });
    assert.equal(await form.locator(".fgrid").isVisible(), true);
    assert.equal(await status(form).innerText(), "");
    assert.equal(await form.locator('[name="email"]').inputValue(), "");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test(`${w}x${h}: with no database the visitor is told nothing was saved, and keeps the answers`, async () => {
    env = {};
    d1();
    const { context, page, form, problems } = await open(w, h);
    await fill(form);
    await form.locator('button[type="submit"]').click();
    await status(form).filter({ hasText: "Your request was not sent. Nothing was saved." }).waitFor({ timeout: 10000 });
    await shot(page, `form-failed-${w}`);
    assert.equal(await status(form).getAttribute("role"), "alert");
    const seen = await status(form).boundingBox();
    assert.ok(seen && seen.y >= 0 && seen.y + seen.height <= h + 1, `the message is on screen (y ${seen && Math.round(seen.y)}..${seen && Math.round(seen.y + seen.height)} of ${h})`);
    assert.equal(await form.locator('[name="email"]').inputValue(), "ada@example.com");
    assert.equal(await form.locator('button[type="submit"]').isEnabled(), true);
    assert.equal(await form.getAttribute("aria-busy"), null);
    assert.equal(rows().length, 0);
    assert.equal(new URL(page.url()).search, "");
    assert.deepEqual(problems.filter((p) => !/503/.test(p)), []);
    await context.close();
  });

  test(`${w}x${h}: an answer the endpoint refuses is marked and focused; an empty required answer is never sent`, async () => {
    env = { FORMS_DB: d1() };
    const { context, page, form, posts } = await open(w, h);
    await form.locator('button[type="submit"]').click();
    await page.waitForTimeout(400);
    assert.deepEqual(posts, [], "the browser holds an incomplete form");
    await fill(form, { email: "ada@example" });
    await form.locator('button[type="submit"]').click();
    await status(form).filter({ hasText: "Some answers are missing or not valid." }).waitFor({ timeout: 10000 });
    await shot(page, `form-invalid-${w}`);
    assert.equal(await form.locator('[name="email"]').getAttribute("aria-invalid"), "true");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("name")), "email");
    assert.equal(rows().length, 0);
    await form.locator('[name="email"]').fill("ada@example.com");
    await form.locator('button[type="submit"]').click();
    await status(form).filter({ hasText: /Your reference is SR-/ }).waitFor({ timeout: 10000 });
    assert.equal(rows().length, 1);
    await context.close();
  });
}
