// C1: the rendered gates never stop running silently. A missing browser FAILS the browser tests everywhere (a developer machine, CI,
// the `npm test` that deploy:web runs), and there is no way to skip them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { tempDir } from "../../core/test/support/temp.mjs";
import { runGate } from "../src/canon/findings.js";
import { browser, loadPlaywright, CHROMIUM } from "./browser-env.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const BROWSER_TESTS = ["theme-qa.test.mjs", "visual-qa.test.mjs", "search-qa.test.mjs"];
const noBrowser = (extra = {}) => { const env = { ...process.env, ...extra, KIT_PLAYWRIGHT: "/nonexistent/playwright", KIT_CHROMIUM: "/nonexistent/chrome" }; delete env.NODE_TEST_CONTEXT; return env; };

test("no browser: each of the three browser test files FAILS, with CI set and unset, and nothing skips (there is no opt-out)", () => {
  for (const f of BROWSER_TESTS) for (const CI of ["", "true", "1"]) {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", here(f)], { env: noBrowser({ CI }), encoding: "utf8" });
    assert.notEqual(r.status, 0, `${f} (CI=${CI || "unset"}): no browser must fail\n${r.stdout.slice(-500)}`);
    assert.match(r.stdout, /the browser gates need Chromium/, `${f}: it says why`);
    assert.match(r.stdout, /# skipped 0\b/, `${f}: nothing is skipped`);
  }
});

// The skip/todo scan is the finding class "skipped-browser-test" (packages/core/registry/finding-classes.json): a contract the canon engine
// runs on canonical tree-sitter parses, proven by findings/skipped-browser-test (a real case and every written form) and run by
// `kit check canon`. Here it is run directly over the three files, and over each written form that a regex or a bare query would miss.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = [...BROWSER_TESTS.map((f) => `packages/cli/test/${f}`), "packages/cli/test/browser-env.mjs"];
const treeOf = (t, files) => { const dir = tempDir(t, "kit-skipscan-"); for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), text); } return dir; };

test("no skip or todo in the three browser test files or browser-env (the engine's skipped-browser-test class, parsed)", async () => {
  assert.deepEqual(await runGate("skipped-browser-test", ROOT, FILES), []);
  const cls = JSON.parse(readFileSync(here("../../core/registry/finding-classes.json"), "utf8")).classes.find((c) => c.id === "skipped-browser-test");
  // the class's scope is the browser file set, declared once (files.importing = the classifier's own source, packages/cli/scripts/test-files.mjs), never a list of names
  const { browserTestFiles, browserModules } = await import("../scripts/test-files.mjs");
  assert.deepEqual(cls.detect[0].files.importing, await browserModules(ROOT));
  const set = await browserTestFiles(ROOT);
  for (const f of [...FILES, "packages/cli/test/browser-bounds.test.mjs", "packages/cli/test/browser-ci.test.mjs"]) assert.ok(f === "packages/cli/test/browser-env.mjs" || set.includes(f), `${f} is in the set the class covers`);
  assert.deepEqual(await runGate("skipped-browser-test", ROOT, [...set, "packages/cli/test/browser-env.mjs"]), []);
});

test("the class refuses subscript calls, destructuring patterns, computed keys and the plain forms (each alone, in a browser test file)", async (t) => {
  const bad = ['test("x", (t) => { t["skip"](); });', 'test("x", (t) => { t[`todo`](); });', 'const { skip } = o;', 'const { skip: s } = o;', 'const { "todo": t } = o;',
    'test("x", { ["skip"]: true }, () => {});', 'test("x", { skip: true }, () => {});', 'const skip = 1; test("x", { skip }, () => {});', 'test.skip("x", () => {});', 'test.todo("x");', 'import { skip } from "./e.mjs";'];
  for (const text of bad) {
    const dir = treeOf(t, { "packages/cli/test/theme-qa.test.mjs": `import "./browser-env.mjs";\n${text}` });
    try { assert.ok((await runGate("skipped-browser-test", dir, ["packages/cli/test/theme-qa.test.mjs"])).some((x) => x.match !== "parse error"), `must be refused: ${text}`); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("there is no opt-out: no allow category, no allow-file or CI switch in browser-env", () => {
  const env = readFileSync(here("./browser-env.mjs"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/ALLOW|canon\.allow|optOut|process\.env\.CI\b/i.test(env), "browser-env reads no allow-file, no CI switch");
  assert.ok(!readFileSync(here("../../core/schemas/canon-allow.schema.json"), "utf8").includes("no-browser"));
});

// The pass floors live in the one serial browser step of npm test (scripts/browser-step.mjs, tested in browser-step.test.mjs): the files run
// ONCE there. This file spawns no browser file: a second run of theme-qa alone is about 8 minutes of CI.
test("the pass floors are wired: npm test's last step is browser-step.mjs and every browser file has a floor (static, no browser started)", async () => {
  const { stepsOf, browserTestFiles } = await import("../scripts/test-files.mjs");
  const { FLOORS } = await import("../scripts/browser-step.mjs");
  const root = here("../../../");
  const steps = await stepsOf(root);
  assert.deepEqual(steps.at(-1)[1], ["packages/cli/scripts/browser-step.mjs"]);
  for (const f of BROWSER_TESTS) assert.ok(FLOORS[`packages/cli/test/${f}`] > 0, `${f} has a floor`);
  for (const f of await browserTestFiles(root)) assert.ok(FLOORS[f] > 0, `${f} has a floor`);
});

test("probe: the configured Chromium launches and renders a page (fails when it cannot)", async () => {
  assert.ok(browser, `no Chromium (KIT_CHROMIUM=${CHROMIUM}): run \`npx playwright install chromium\``);
  const pw = await loadPlaywright();
  const b = await pw.chromium.launch({ executablePath: CHROMIUM });
  try { const p = await b.newPage(); await p.setContent("<p>ok</p>"); assert.equal(await p.textContent("p"), "ok"); } finally { await b.close(); }
});

test("the workflow (parsed as YAML) installs Chromium before npm test, exports it to the tests, and runs search-qa and visual-qa on the sample site", () => {
  const wf = YAML.parse(readFileSync(here("../../../.github/workflows/test.yml"), "utf8"));
  const steps = wf.jobs.test.steps;
  const idx = (re) => steps.findIndex((st) => re.test(String(st.run || "")));
  const install = idx(/npx playwright install --with-deps chromium/), exportsAt = idx(/KIT_PLAYWRIGHT=.*GITHUB_ENV[\s\S]*KIT_CHROMIUM=.*GITHUB_ENV/), test_ = idx(/^npm test$/), ci = idx(/^npm ci$/);
  assert.ok(ci >= 0 && ci < install, "the lockfile install comes first (playwright is a locked devDependency)");
  assert.ok(install >= 0 && install < test_, "Chromium is installed before npm test");
  assert.ok(exportsAt >= 0 && exportsAt < test_, "both variables are exported to the later steps before npm test");
  const all = steps.map((st) => String(st.run || "")).join("\n");
  assert.ok(/kit\.js site search-qa/.test(all) && /kit\.js site visual-qa/.test(all), "the CLI gates run on the sample site");
  assert.ok(!/--no-theme/.test(all), "the theme gate is not switched off");
  assert.ok(!/\bnpm (install|i)\b/.test(all), "nothing is installed outside the lockfile");
});

test("playwright is an exact root devDependency, locked, and new enough to know the canary runner image (1.56.1 has no ubuntu26.04: install --with-deps failed there)", () => {
  const pkg = JSON.parse(readFileSync(here("../../../package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(here("../../../package-lock.json"), "utf8"));
  const pin = pkg.devDependencies?.playwright;
  assert.match(String(pin), /^\d+\.\d+\.\d+$/, "an exact version, no range");
  assert.equal(lock.packages?.[""]?.devDependencies?.playwright, pin, "the lockfile root declares the same pin");
  assert.equal(lock.packages?.["node_modules/playwright"]?.version, pin, "and locks that version");
  const [maj, min] = String(pin).split(".").map(Number);
  assert.ok(maj > 1 || (maj === 1 && min >= 63), `playwright ${pin} must be >= 1.63.0, the first release verified to list ubuntu26.04 (the canary in kit.canon.json)`);
});

// A browser test never hangs: every test and hook of a browser file carries a finite node:test `timeout`, and every Playwright context is
// bounded (src/browser-guard.js). The bound of a page that never settles is proven in browser-bounds.test.mjs.
test("every test and hook of the browser files has a finite timeout; every gate launches its browser through the bounded launcher", () => {
  for (const f of [...BROWSER_TESTS, "browser-bounds.test.mjs"]) {
    const src = readFileSync(here(`./${f}`), "utf8");
    const calls = [...src.matchAll(/^(test|before|after)\(/gm)].length;
    const bounded = [...src.matchAll(/^(test|before|after)\((?:.*?)\{ timeout: (BROWSER_TEST_MS|BROWSER_SLOW_TEST_MS|\d+) \}/gm)].length;
    assert.ok(calls > 0 && bounded === calls, `${f}: ${bounded} of ${calls} tests and hooks have a timeout`);
  }
  for (const f of ["theme-qa", "visual-qa", "search-qa"]) {
    const src = readFileSync(here(`../src/${f}.js`), "utf8");
    assert.ok(!/playwright\.chromium\.launch\(/.test(src), `${f}: a browser launched without bounds`);
    assert.match(src, /launchGuarded\(playwright,/);
  }
});
