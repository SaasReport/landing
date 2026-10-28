// A browser test never hangs: a page that does not settle is a FAILURE that names the page and the step, inside a bound
// (2026-10-07: theme-qa and visual-qa sat 20 minutes at 0% CPU in an npm test run and produced neither a pass nor a failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";
import { buildSite } from "@saasreport/site";
import sample from "../../../examples/site-sample/site.config.js";
import { searchQa } from "../src/search-qa.js";
import { visualQa, serveSite } from "../src/visual-qa.js";
import { themeQa } from "../src/theme-qa.js";
import { EventEmitter } from "node:events";
import { guardContext, faultMessage } from "../src/browser-guard.js";
import { CHROMIUM, BROWSER_TEST_MS, loadPlaywright } from "./browser-env.mjs";

const root = new URL("../../../examples/site-sample/", import.meta.url).pathname;
// a page that never reaches network idle: it asks for a new URL every 50 ms for as long as it is open
const NEVER = `<script>setInterval(function(){fetch("/never-idle?"+Math.random()).catch(function(){})},50)</script>`;
const BOUND = 2000;

test("search-qa: a page that never settles fails inside the bound, naming the page and the step", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-bound-sqa-");
  try {
    buildSite(sample, { root, outDir: out, write: true });
    writeFileSync(join(out, "index.html"), readFileSync(join(out, "index.html"), "utf8").replace("</body>", `${NEVER}</body>`));
    await assert.rejects(searchQa({ outDir: out, playwright: await loadPlaywright(), chromium: CHROMIUM, viewports: [[1280, 800]], bounds: { navigationMs: BOUND } }),
      (e) => /Timeout 2000ms exceeded/.test(e.message) && /page\.goto/.test(e.message) && /127\.0\.0\.1:\d+/.test(e.message) && /search-qa 1280x800/.test(e.message), "the failure names the step (page.goto), the page (its URL) and the viewport");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("visual-qa: a page that never settles fails inside the bound, as a finding that names the page and the step", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-bound-vqa-");
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Never</title></head><body><main><p>text</p></main>${NEVER}</body></html>`);
    const r = await visualQa({ outDir: out, playwright: await loadPlaywright(), chromium: CHROMIUM, viewports: [[390, 844]], schemes: ["light"], shots: "none", focus: false, wait: 50, bounds: { navigationMs: BOUND } });
    assert.equal(r.ok, false, "a page that never settles is not a pass");
    const f = r.failures.find((x) => x.url === "/");
    assert.ok(f, JSON.stringify(r.failures));
    assert.match(f.message, /page\.goto/); assert.match(f.message, /Timeout 2000ms exceeded/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A page's crash or uncaught error FAILS the gate, even when no later Playwright call throws: browser-guard.js collects them per run and
// every gate turns a non-empty collector into a finding that names the page.
const BOOM = `<script>setTimeout(function(){throw new Error("boom from the page")},0)</script>`;

test("guardContext collects a page's crash and uncaught error (with the page's URL) into the run's collector, and keeps console errors out of it", { timeout: BROWSER_TEST_MS }, () => {
  const ctx = Object.assign(new EventEmitter(), { setDefaultTimeout() {}, setDefaultNavigationTimeout() {} });
  const page = Object.assign(new EventEmitter(), { url: () => "http://127.0.0.1:1/p" });
  const faults = [];
  guardContext(ctx, "gate x", { actionMs: 1, navigationMs: 1 }, faults, () => {});
  ctx.emit("page", page);
  page.emit("crash");
  page.emit("pageerror", new Error("boom"));
  page.emit("console", { type: () => "error", text: () => "a console error" });
  assert.deepEqual(faults.map((f) => [f.kind, f.url, f.message]), [["crash", "http://127.0.0.1:1/p", "the page crashed"], ["pageerror", "http://127.0.0.1:1/p", "boom"]]);
  assert.match(faultMessage(faults[0]), /http:\/\/127\.0\.0\.1:1\/p.*crashed/);
});

test("search-qa: a page that throws an uncaught error and then finishes still fails, naming the page", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-fault-sqa-");
  try {
    buildSite(sample, { root, outDir: out, write: true });
    writeFileSync(join(out, "index.html"), readFileSync(join(out, "index.html"), "utf8").replace("</body>", `${BOOM}</body>`));
    const r = await searchQa({ outDir: out, playwright: await loadPlaywright(), chromium: CHROMIUM, viewports: [[1280, 800]] });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.kind === "console" && /boom from the page/.test(f.message) && /127\.0\.0\.1:\d+/.test(f.message)), JSON.stringify(r.failures));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("visual-qa: a page that throws an uncaught error and then finishes still fails, naming the page", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-fault-vqa-");
  try {
    writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Boom</title></head><body><main><p>text</p></main>${BOOM}</body></html>`);
    const r = await visualQa({ outDir: out, playwright: await loadPlaywright(), chromium: CHROMIUM, viewports: [[390, 844]], schemes: ["light"], shots: "none", focus: false, wait: 50 });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.url === "/" && f.kind === "console" && /boom from the page/.test(f.message)), JSON.stringify(r.failures));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("theme-qa: a page that throws an uncaught error and then finishes still fails, naming the page", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-fault-tqa-");
  const css = ":root{--c-bg:#FAFAF7;--c-ink:#0B0B0B}body{margin:0;background:var(--c-bg);color:var(--c-ink)}";
  try {
    writeFileSync(join(out, "t.css"), css);
    writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/t.css"></head><body><p>text</p>${BOOM}</body></html>`);
    const srv = await serveSite(out);
    try {
      const r = await themeQa({ sheets: [{ file: "t.css", text: css }], playwright: await loadPlaywright(), chromium: CHROMIUM, schemes: ["light"], viewports: [[1280, 800]], pages: [`${srv.url}/`] });
      assert.ok(r.problems.some((p) => p.kind === "console" && /boom from the page/.test(p.note) && p.where.startsWith(srv.url)), JSON.stringify(r.problems));
    } finally { await srv.close(); }
  } finally { rmSync(out, { recursive: true, force: true }); }
});
