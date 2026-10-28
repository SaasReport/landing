#!/usr/bin/env node
/**
 * npm test: the canon check, then every package's tests, inside a temp directory of the run's own (TMPDIR, TMP, TEMP), which
 * is removed when the run ends, whatever its result. A test run never leaves temp files behind: on 2026-10-07 the runs had
 * left 7361 kit-* directories (7.2 GB) in /tmp and filled the disk mid-run.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../src/git.js";

/** Every node process of the run preloads this: no test reaches the network (it throws), so none can depend on a live URL. */
export const NO_NETWORK = fileURLToPath(new URL("./no-network.mjs", import.meta.url));

/** Run each [command, args] in order inside a fresh temp directory; stop at the first failure; always remove the directory. */
export function runInTemp(steps, { base = tmpdir(), spawn = spawnSync, env = process.env } = {}) {
  const dir = mkdtempSync(join(base, "kit-test-run-"));
  // a run started by a git hook (pre-push) must not hand the hook's repository to git in its steps
  const runEnv = { ...gitEnv(env), TMPDIR: dir, TMP: dir, TEMP: dir, NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--import ${NO_NETWORK}`, KIT_TEST_NO_NETWORK: "1" };
  try {
    for (const [cmd, args] of steps) {
      const r = spawn(cmd, args, { stdio: "inherit", env: runEnv });
      if (r.error) throw r.error;
      if (r.status !== 0) return { code: r.status ?? 1, dir };
    }
    return { code: 0, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

import { stepsOf, testFiles, browserTestFiles } from "./test-files.mjs";
export { stepsOf, testFiles, browserTestFiles };

// the canon check is spelled out first, where `kit check canon` (enforcement) reads it; the browser files are found by parsing their imports, once, when the run starts
export const STEPS = [
  [process.execPath, ["packages/cli/bin/kit.js", "check", "canon"]],
  ...(await stepsOf()),
];

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) process.exitCode = runInTemp(STEPS).code;
