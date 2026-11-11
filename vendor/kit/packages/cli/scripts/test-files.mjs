/**
 * Which test files npm test runs, and how: the canon check, the tests that need no browser (parallel, node's default), then ONE serial
 * browser step (browser-step.mjs) for the files that import browser-env.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inModuleSet } from "../src/canon/engine.js";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const SETUP = ["--import", "./packages/calendar/test/intl-guard.setup.mjs", "--test"];


/** Every test file of the workspace (packages/<p>/test, vendor/<v>/test), as paths relative to the repository root, sorted. */
export function testFiles(root = REPO) {
  return ["packages", "vendor"].flatMap((top) => (existsSync(join(root, top)) ? readdirSync(join(root, top)).sort() : []).flatMap((p) => {
    const dir = join(root, top, p, "test");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `${top}/${p}/test/${f}`) : [];
  }));
}

const REGISTRY = "packages/core/registry/finding-classes.json";
const registryOf = (root) => JSON.parse(readFileSync(join(existsSync(join(root, REGISTRY)) ? root : REPO, REGISTRY), "utf8"));

/**
 * The modules that make a test file a browser file: the one declaration of the set, `files.importing` of the finding class
 * skipped-browser-test (the class that forbids skipping covers exactly the files this classifier runs).
 */
export function browserModules(root = REPO) {
  const cls = registryOf(root).classes.find((c) => c.id === "skipped-browser-test");
  const modules = cls?.detect?.[0]?.files?.importing;
  if (!Array.isArray(modules) || !modules.length) throw new Error("finding class skipped-browser-test declares no files.importing: the browser file set has no definition");
  return modules;
}

/**
 * The test files that start a browser: the ones that reach browser-env.mjs through imports (directly or through helpers, to a fixed point),
 * read from the parsed source by the canon engine (a comment or a string naming it is no import). The finding class browser-launch-outside-browser-env refuses a test file that reaches a browser any
 * other way, so this classification is sound. They run ONE AT A TIME, once each, in browser-step.mjs, after the others. On 2026-10-07
 * search-qa crashed its page and its target ("Page crashed", "Target crashed") and two gates hung when the three browser files ran in parallel
 * with each other and with the rest; search-qa alone passed 5 of 5. A file of the other kind runs in parallel as before.
 */
export async function browserTestFiles(root = REPO, modules = browserModules(root)) {
  const registry = registryOf(root), out = [], cache = new Map();
  const read = (p) => (existsSync(join(root, p)) && statSync(join(root, p)).isFile() ? readFileSync(join(root, p), "utf8") : null);
  for (const f of testFiles(root)) if (await inModuleSet(f, modules, registry, read, cache)) out.push(f);
  return out;
}

/** The steps of npm test after the canon check (test-run.mjs STEPS starts with it, where the enforcement check reads it): the tests that need no browser (parallel), then the browser tests (serial, browser-step.mjs). */
export async function stepsOf(root = REPO) {
  const isBrowser = new Set(await browserTestFiles(root));
  return [
    [process.execPath, [...SETUP, ...testFiles(root).filter((f) => !isBrowser.has(f))]],
    [process.execPath, ["packages/cli/scripts/browser-step.mjs"]],
  ];
}
