/**
 * The bounds of the rendered gates (theme-qa, visual-qa, search-qa): a browser step that does not finish is a FAILURE that names
 * the page and the step, never a hang. 2026-10-07: two gates sat 20 minutes at 0% CPU inside an npm test run, with Chromium idle.
 *   - every context gets a default action timeout and a navigation timeout, so every Playwright wait ends (the error names the call
 *     and, for a navigation, the URL);
 *   - every page records its crash and uncaught error in the run's collector (browser.faults), which each gate turns into a finding naming the page,
 *     and its console errors on stderr, with the page's URL.
 * `bounds` ({ actionMs, navigationMs }) overrides the defaults; a test passes small ones to prove a page that never settles fails.
 */
// Sized for a LOADED machine, not an idle one: other runs share the CPU and the disk (load average 11 on 4 cores was seen), and a bound that an
// idle machine never reaches but a busy one does turns contention into a failure. They only have to end a hang, never to time the page.
export const BOUNDS = { actionMs: 30000, navigationMs: 60000 };

/** The bounds with a caller's overrides; a bound that is not a positive number is an error, never "no bound". */
export function boundsOf(over = {}) {
  const b = { ...BOUNDS, ...over };
  for (const k of ["actionMs", "navigationMs"]) if (!(Number.isFinite(b[k]) && b[k] > 0)) throw new Error(`browser bound ${k} must be a positive number of milliseconds, got ${b[k]}`);
  return b;
}

/**
 * Bound a context and record what its pages do when they die. A page's crash and uncaught error go to `faults` (the run's collector,
 * `browser.faults` of launchGuarded) AND to stderr: the gate turns a non-empty collector into a finding that names the page, so a page
 * that threw and then finished still fails (faultMessage). A console error is only logged: pages' own console errors are each gate's business.
 */
export function guardContext(ctx, label, bounds = BOUNDS, faults = [], err = (s) => process.stderr.write(s)) {
  ctx.setDefaultTimeout(bounds.actionMs);
  ctx.setDefaultNavigationTimeout(bounds.navigationMs);
  ctx.on("page", (page) => {
    const at = () => page.url() || "about:blank";
    const say = (what) => err(`[browser] ${label}: ${what} (page ${at()})\n`);
    page.on("crash", () => { faults.push({ label, kind: "crash", url: at(), message: "the page crashed" }); say("PAGE CRASHED"); });
    page.on("pageerror", (e) => { const message = String(e.message || e).slice(0, 300); faults.push({ label, kind: "pageerror", url: at(), message }); say(`uncaught ${message}`); });
    page.on("console", (m) => { if (m.type() === "error") say(`console error ${m.text().slice(0, 200)}`); });
  });
  return ctx;
}

/** The finding text of one collected fault: it names the gate, the page and what happened. */
export function faultMessage(f) {
  return `${f.label}: page ${f.url} ${f.kind === "crash" ? "crashed" : "threw an uncaught error"}: ${f.message}`;
}

/** The faults collected since index `from` that no finding has been made of yet; they are marked taken, so a fault becomes one finding. */
export function faultsSince(browser, from = 0) { return browser.faults.slice(from).filter((f) => !f.taken).map((f) => { f.taken = true; return f; }); }

/** Launch Chromium whose every context is bounded and recorded; `browser.faults` is the run's collector (see guardContext). */
export async function launchGuarded(playwright, options, label, bounds) {
  const b = boundsOf(bounds);
  const browser = await playwright.chromium.launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.faults = [];
  browser.newContext = async (...a) => guardContext(await newContext(...a), label, b, browser.faults);
  return browser;
}

/** Run a step; its failure says which gate step failed (the Playwright message already names the call and the URL). */
export async function step(label, fn) {
  try { return await fn(); } catch (e) { e.message = `${label}: ${e.message}`; throw e; }
}
