// The browser pass floor lives in the ONE serial browser step of npm test (scripts/browser-step.mjs): each browser test file runs once,
// with the TAP reporter, and the step fails when a file's `# pass` is below its declared floor or its skip or todo count is above 0.
// (It was a test that ran the three files a second time: theme-qa alone is about 8 minutes of CI minutes.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTap, runBrowserFiles, FLOORS } from "../scripts/browser-step.mjs";
import { browserTestFiles, stepsOf } from "../scripts/test-files.mjs";

const tap = (o = {}) => { const s = { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o }; return `TAP version 13\nok 1 - x\n1..${s.tests}\n# tests ${s.tests}\n# suites 0\n# pass ${s.pass}\n# fail ${s.fail}\n# cancelled ${s.cancelled}\n# skipped ${s.skipped}\n# todo ${s.todo}\n# duration_ms 1\n`; };

test("must-fail: a TAP stream with fewer passes than the floor, any skip, any todo, any failure, no summary or a non-zero exit fails the step", () => {
  assert.deepEqual(checkTap("a.test.mjs", { code: 0, out: tap({ tests: 4, pass: 4 }) }, 5), [`a.test.mjs: 4 passed, below its declared floor of 5`]);
  assert.match(checkTap("a.test.mjs", { code: 0, out: tap({ skipped: 1 }) }, 5).join(), /skipped 1/);
  assert.match(checkTap("a.test.mjs", { code: 0, out: tap({ todo: 2 }) }, 5).join(), /todo 2/);
  assert.match(checkTap("a.test.mjs", { code: 1, out: tap({ fail: 1, pass: 4 }) }, 5).join(), /exit code 1/);
  assert.match(checkTap("a.test.mjs", { code: 0, out: "TAP version 13\n" }, 5).join(), /no TAP summary/);
  assert.match(checkTap("a.test.mjs", { code: null, out: tap() }, 5).join(), /did not end|killed/);
  assert.match(checkTap("a.test.mjs", { code: 0, out: tap() }, undefined).join(), /no declared floor/);
});

test("must-pass: a stream at or above its floor, nothing skipped, nothing todo, exit 0", () => {
  assert.deepEqual(checkTap("a.test.mjs", { code: 0, out: tap() }, 5), []);
  assert.deepEqual(checkTap("a.test.mjs", { code: 0, out: tap({ tests: 9, pass: 9 }) }, 5), []);
});

test("runBrowserFiles runs each file once, one after the other, and returns every problem (a fixture below the floor fails the step)", () => {
  const ran = [];
  const spawn = (cmd, args) => { const f = args[args.length - 1]; ran.push(f); return { status: 0, stdout: f === "low.test.mjs" ? tap({ tests: 2, pass: 2 }) : tap(), stderr: "" }; };
  const r = runBrowserFiles({ files: ["ok.test.mjs", "low.test.mjs"], floors: { "ok.test.mjs": 5, "low.test.mjs": 5 }, spawn, write: () => {} });
  assert.deepEqual(ran, ["ok.test.mjs", "low.test.mjs"], "each file once, in order");
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /low\.test\.mjs: 2 passed, below its declared floor of 5/);
  assert.equal(runBrowserFiles({ files: ["ok.test.mjs"], floors: { "ok.test.mjs": 5 }, spawn, write: () => {} }).ok, true);
  assert.equal(ran.length, 3);
});

test("every browser test file has a declared floor, and npm test runs the browser files through this step only (no second run elsewhere)", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const browser = await browserTestFiles(root);
  for (const f of browser) assert.ok(FLOORS[f] > 0, `${f} has a floor`);
  for (const f of Object.keys(FLOORS)) assert.ok(browser.includes(f), `${f} is a browser file`);
  const steps = await stepsOf(root);
  assert.equal(steps.length, 2, "after the canon check: the parallel step, then the browser step");
  assert.deepEqual(steps[1][1], ["packages/cli/scripts/browser-step.mjs"]);
  assert.ok(!steps[0][1].some((a) => browser.includes(a)), "no browser file in the parallel step");
});
