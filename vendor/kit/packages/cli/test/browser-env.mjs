// The browser of the rendered gates (theme-qa, visual-qa, search-qa). A missing browser FAILS the browser tests on every machine, in CI
// or not, and there is no opt-out, no allow-entry and no environment switch that skips them: the gates never stop running silently.
//   KIT_PLAYWRIGHT / KIT_CHROMIUM name the playwright package directory and the executable; unset, the repository's own pinned
//   playwright (root devDependency) and the Chromium it installed (`npx playwright install chromium`) are used.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const own = (() => { try { const dir = dirname(require.resolve("playwright/package.json")); return { dir, exe: require("playwright").chromium.executablePath() }; } catch { return {}; /* playwright is not installed: browser stays false and loadPlaywright fails every browser test saying so */ } })();
export const PW = process.env.KIT_PLAYWRIGHT ?? own.dir;
export const CHROMIUM = process.env.KIT_CHROMIUM ?? own.exe;
export const browser = Boolean(PW && CHROMIUM && existsSync(join(PW, "package.json")) && existsSync(CHROMIUM));
export async function loadPlaywright() {
  if (!browser) throw new Error(`the browser gates need Chromium (KIT_PLAYWRIGHT=${PW || "unset"}, KIT_CHROMIUM=${CHROMIUM || "unset"}): run \`npx playwright install chromium\``);
  return (await import(pathToFileURL(require.resolve("playwright", { paths: [PW] })).href)).default;
}

// The bound of one browser test (node:test `{ timeout }`, set on every test of the three browser files and proven by browser-ci.test.mjs).
// A test that does not end inside it FAILS; a hang is never a result. The Playwright waits inside have their own, shorter bounds (src/browser-guard.js).
export const BROWSER_TEST_MS = 120000;
// The bound of the one long test (theme-qa: the kit's own theme on every page and state): about 285 s alone on a loaded machine and 325 s beside another
// run's Chromium, so the bound is four times that, not twice: it ends a hang, it must never time the machine.
export const BROWSER_SLOW_TEST_MS = 1200000;
