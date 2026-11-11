#!/usr/bin/env node
/**
 * The serial browser step of npm test: every browser test file (the ones that import browser-env.mjs) runs ONCE, one after the other,
 * with the TAP reporter, and the step FAILS when a file
 *   - does not exit 0, is killed at the bound, or prints no TAP summary;
 *   - passes fewer tests than its declared floor (a file that returns early or registers fewer tests falls under it);
 *   - skips or marks todo anything.
 * The floors were a test that ran the three files a second time; theme-qa alone is about 8 minutes, and CI minutes are the constraint.
 * A new test raises its file's floor in the same change; a floor never goes down. A browser file with no floor fails the step.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SETUP, browserTestFiles } from "./test-files.mjs";

/** file → the least number of `# pass` its TAP summary may show (measured with the file alone, 2026-10-07). */
export const FLOORS = {
  "packages/cli/test/theme-qa.test.mjs": 30,
  "packages/cli/test/visual-qa.test.mjs": 12,
  "packages/cli/test/search-qa.test.mjs": 5,
  "packages/cli/test/browser-bounds.test.mjs": 6,
  "packages/cli/test/browser-ci.test.mjs": 9,
  "packages/widgets/test/network-browser.test.mjs": 9,
};

/** One file's wall-clock bound: a file that does not end inside it is killed and fails (theme-qa alone takes about 8 minutes, 8 beside another run's Chromium; this is twice the slowest file seen). */
export const FILE_MS = 1800000;

/** The problems of one file's run (empty: the file passes its floor). `run` is { code, out } of the TAP run; `floor` its declared floor. */
export function checkTap(file, run, floor) {
  const problems = [];
  const n = (k) => { const m = String(run.out).match(new RegExp(`^# ${k} (\\d+)`, "m")); return m ? Number(m[1]) : null; };
  if (!(floor > 0)) problems.push(`${file}: no declared floor (add it to FLOORS in packages/cli/scripts/browser-step.mjs)`);
  if (run.code === null || run.code === undefined) problems.push(`${file}: the run did not end (killed at ${FILE_MS} ms or could not start)`);
  else if (run.code !== 0) problems.push(`${file}: exit code ${run.code}`);
  const pass = n("pass");
  if (pass === null || n("tests") === null) { problems.push(`${file}: no TAP summary (the file did not end)`); return problems; }
  if (floor > 0 && pass < floor) problems.push(`${file}: ${pass} passed, below its declared floor of ${floor}`);
  for (const k of ["skipped", "todo", "fail", "cancelled"]) if (n(k) > 0) problems.push(`${file}: ${k} ${n(k)} (it must be 0)`);
  return problems;
}

/** Run each file once, in order; echo its TAP; check it against its floor. Returns { ok, problems }. */
export function runBrowserFiles({ files, floors = FLOORS, spawn = spawnSync, write = (s) => process.stdout.write(s), env = process.env }) {
  const problems = [];
  for (const file of files) {
    write(`# browser step: ${file}\n`);
    const r = spawn(process.execPath, [...SETUP, "--test-reporter=tap", file], { env, encoding: "utf8", timeout: FILE_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    write(out);
    problems.push(...checkTap(file, { code: r.error || r.signal ? null : r.status, out }, floors[file]));
  }
  for (const f of Object.keys(floors)) if (!files.includes(f)) problems.push(`${f}: has a floor but is not a browser test file (a stale floor)`);
  return { ok: problems.length === 0, problems };
}

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file: not run directly */ } })()) {
  const files = await browserTestFiles();
  const { ok, problems } = runBrowserFiles({ files });
  if (!ok) process.stdout.write(`\nFAIL browser step: ${problems.length} problems\n${problems.map((p) => `  - ${p}\n`).join("")}`);
  else process.stdout.write(`\nok browser step: ${files.length} files, each once, every floor met, nothing skipped\n`);
  process.exitCode = ok ? 0 : 1;
}
