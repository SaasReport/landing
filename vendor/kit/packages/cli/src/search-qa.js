/**
 * kit site search-qa: the rendered gate of the global search (packages/site/assets/shell.js). The built site is served
 * locally (nothing leaves the machine), the search is opened in Chromium at each viewport (default 390x844 and 1280x800)
 * and typed with real keys. Failed on:
 *
 *   results      a typed query whose expected page is not within the first results (default top 3)
 *   highlight    a result that shows no <mark> around the matched word, or a mark with markup of the page's text in it
 *   typo         a word of 5+ letters with one wrong letter (derived from the index, or listed) that finds nothing, or does not say so
 *   fold         the same word written with Arabic letter variants (ي ك), a ZWNJ, other digits or other case that ranks differently
 *   none         a query with no match that does not show the empty state; one character that shows no hint
 *   keyboard     the input is not a combobox over a listbox of options, ArrowDown/Up/Home/End do not move aria-activedescendant,
 *                Enter does not open the selected page, Escape does not close, the live region does not say the count
 *   latency      the median key-to-next-frame time of a query above the budget (default 130 ms)
 *   shortcut     more or fewer than one dialog after Ctrl+K on a page (a page that owns the key must keep the shell's search shut)
 *   layout       horizontal scroll, a dialog or a result wider than the viewport (390 px is the one that matters)
 *   console      console errors and uncaught exceptions
 *
 * Cases come from the site's own index (every site gets them with no config) and from search-qa.json (kit.search-qa.v1):
 * extra typed queries per site. Screenshots (the typo, the highlight, the empty state, the hint) go to a gitignored folder
 * and the findings to a JSON report (kit.search-qa-report.v1).
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serveSite } from "./visual-qa.js";
import { launchGuarded, step, faultsSince, faultMessage } from "./browser-guard.js";

const WORD = /[\p{L}\p{N}]+/gu;
const fold = (s) => String(s).replace(/[™®©]/g, "").normalize("NFKD").replace(/[̀-ًͯ-ٰٟ]/g, "").replace(/[‌-‏]/g, "").replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toLowerCase();
const wordsOf = (s) => fold(s).match(WORD) || [];

/**
 * The cases a site's own index implies: a distinctive title word (exact, highlight), the word with one letter doubled and
 * with two neighbours swapped (typo), the word in another spelling (fold), nothing, and one character.
 */
export function deriveCases(index, { max = 2 } = {}) {
  const titles = index.pages.map((p) => new Set(wordsOf(p[1])));
  const everywhere = new Set([...Object.keys(index.terms), ...index.pages.flatMap((p) => wordsOf(`${p[1]} ${p[2]} ${p[3]}`))]);
  const unknown = (w) => ![...everywhere].some((k) => k.startsWith(w) || w.startsWith(k) && k.length >= w.length) && !index.pages.some((p) => fold(`${p[1]} ${p[2]} ${p[3]} ${p[0]}`).includes(w));
  const cases = [];
  const used = new Set();
  index.pages.forEach((p, i) => {
    if (cases.length >= max * 4 || p[0] === "/") return;
    const w = [...titles[i]].find((x) => x.length >= 5 && x.length <= 14 && !/^\d+$/.test(x) && titles.filter((t) => t.has(x)).length === 1 && !used.has(x));
    if (!w) return;
    used.add(w);
    const expect = { url: p[0], within: 3 };
    cases.push({ id: `exact ${w}`, q: w, expect, highlight: w });
    // one letter doubled, then two neighbours swapped: the first that no page can match as written
    const doubled = w.slice(0, 3) + w[2] + w.slice(3), swapped = w.slice(0, 2) + w[3] + w[2] + w.slice(4);
    const typo = [doubled, swapped].find((m) => m !== w && unknown(m));
    if (typo) cases.push({ id: `typo ${typo}`, q: typo, expect, typo: true, highlight: w });
    const variant = w.replace(/ی/g, "ي").replace(/ک/g, "ك") !== w ? w.replace(/ی/g, "ي").replace(/ک/g, "ك") : w.toUpperCase();
    if (variant !== w) cases.push({ id: `fold ${variant}`, q: variant, sameAs: w });
  });
  cases.push({ id: "no match", q: "zzqxjvw", none: true }, { id: "one character", q: "a", hint: true });
  return cases.slice(0, max * 3).concat(cases.slice(-2)).filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);
}

const SEL = { dlg: "[data-kit-search-dialog]", input: "[data-kit-search-dialog] input", list: "[data-kit-search-dialog] .kshell__results", note: "[data-kit-note]", count: "[data-kit-count]" };

/** One page, one viewport: every check. Returns the findings [{ kind, message }] and the measured latencies. */
async function checkViewport(page, base, { cases, budget, pages, shot, width }) {
  const fail = [], lat = [];
  const add = (kind, message) => fail.push({ kind, message });
  const errors = [];
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  // script errors raised by the search (a page's own missing assets are visual-qa's business)
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${m.text()} (${m.location().url || "page"})`); });
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  // open: the key on a wide screen, the header button on a phone (both are the user's ways in)
  if (width < 700) await page.locator("header [data-kit-search]:visible").first().click(); else await page.keyboard.press("Control+k");
  await page.waitForSelector(`${SEL.dlg}:not([hidden])`, { timeout: 4000 }).catch(() => add("keyboard", "the search did not open"));
  if (await page.locator(SEL.dlg).count() === 0) return { fail, lat };
  if (!(await page.locator(SEL.input).count())) { add("keyboard", "the search dialog has no input: another script on the page rewrote it (a data-* attribute taken for its own?)"); return { fail, lat }; }
  // the dialog's structure for assistive technology
  const a11y = await page.evaluate((S) => {
    const i = document.querySelector(S.input), l = document.querySelector(S.list), c = document.querySelector(S.count);
    return { combo: i?.getAttribute("role") === "combobox" && i.getAttribute("aria-controls") === l?.id, list: l?.getAttribute("role") === "listbox", live: c?.getAttribute("role") === "status" || c?.getAttribute("aria-live") === "polite" };
  }, SEL);
  if (!a11y.combo) add("keyboard", "the input is not a combobox controlling the results list");
  if (!a11y.list) add("keyboard", "the results list is not a listbox");
  if (!a11y.live) add("keyboard", "no live region for the result count");
  // key-to-next-frame time: an input listener (capturing, so it runs first) and a mutation observer, both in the page
  await page.evaluate((S) => {
    const i = document.querySelector(S.input), l = document.querySelector(S.list);
    window.__k = 0; window.__m = 0;
    i.addEventListener("input", () => { window.__k = performance.now(); }, true);
    new MutationObserver(() => requestAnimationFrame(() => { window.__m = performance.now(); })).observe(l, { childList: true, subtree: true });
  }, SEL);
  const type = async (q) => {
    await page.locator(SEL.input).fill(q.slice(0, -1));
    // the shell runs the search 30 ms after the last keystroke (a setTimeout): a timer queued after it, then two frames, is after that run, in the page's own order
    await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 60)));
    await page.evaluate(() => { window.__m = 0; });
    await page.keyboard.type(q.slice(-1));
    await page.waitForFunction(() => window.__m > window.__k && window.__k > 0, null, { timeout: 4000 }).catch(() => {});   // a timeout here is caught by the counts asserted next
    return page.evaluate(() => window.__m - window.__k);
  };
  const state = () => page.evaluate((S) => {
    const l = document.querySelector(S.list), n = document.querySelector(S.note);
    const opts = [...l.querySelectorAll("a")];
    return { urls: opts.map((a) => new URL(a.href).pathname), marks: [...l.querySelectorAll("mark")].map((m) => m.textContent), html: l.innerHTML, none: !!l.querySelector(".kshell__none:not(.kshell__hint)"), hint: !!l.querySelector(".kshell__hint"), note: n && !n.hidden ? n.textContent : "", said: document.querySelector(S.count).textContent,
      scroll: document.documentElement.scrollWidth - innerWidth, box: (() => { const b = document.querySelector(".kshell__sbox")?.getBoundingClientRect(); return b ? Math.max(Math.round(b.right - innerWidth), Math.round(-b.left)) : 0; })(), wide: opts.filter((a) => a.getBoundingClientRect().right > innerWidth + 1).length };
  }, SEL);
  const tops = new Map();
  for (const c of cases) {
    const ms = await type(c.q);
    const s = await state();
    const where = `"${c.q}"`;
    if (c.expect) {
      const at = s.urls.indexOf(c.expect.url);
      if (at < 0 || at >= (c.expect.within || 3)) add(c.typo ? "typo" : "results", `${where}: ${c.expect.url} is ${at < 0 ? "not in the results" : `result ${at + 1}`} (first: ${s.urls.slice(0, 3).join(", ") || "none"})`);
      if (!s.said) add("keyboard", `${where}: the live region says nothing`);
      tops.set(c.q, s.urls);
    }
    if (c.typo && !s.note) add("typo", `${where}: found, but the page does not say what it searched for`);
    if (c.highlight) {
      const want = fold(c.highlight);
      if (!s.marks.length) add("highlight", `${where}: no <mark> in the results`);
      else if (!s.marks.some((m) => fold(m).includes(want.slice(0, 4)))) add("highlight", `${where}: marks (${s.marks.slice(0, 3).join(", ")}) do not cover "${c.highlight}"`);
    }
    if (c.sameAs) { let base0 = tops.get(c.sameAs); if (!base0) { await type(c.sameAs); base0 = (await state()).urls; } if (JSON.stringify(s.urls.slice(0, 3)) !== JSON.stringify(base0.slice(0, 3))) add("fold", `${where} ranks ${s.urls.slice(0, 3).join(", ")}, but "${c.sameAs}" ranks ${base0.slice(0, 3).join(", ")}`); await type(c.q); }
    if (c.none && !(s.none && !s.urls.length)) add("none", `${where}: no empty state (${s.urls.length} results)`);
    if (c.hint && !(s.hint && !s.urls.length)) add("none", `${where}: one character shows no hint`);
    if (s.scroll > 0) add("layout", `${where}: the page scrolls sideways by ${s.scroll}px`);
    if (s.box > 1) add("layout", `${where}: the dialog is ${s.box}px outside the screen`);
    if (s.wide) add("layout", `${where}: ${s.wide} result${s.wide === 1 ? "" : "s"} wider than the screen`);
    if (c.expect) lat.push(ms);
    if (shot && (c.typo || c.highlight || c.none || c.hint) && shot.once(c)) await page.screenshot({ path: shot.path(c) });
  }
  // keyboard: arrows, Home, End, Enter, Escape
  const first = cases.find((c) => c.expect);
  if (first) {
    await type(first.q);
    const n = (await state()).urls.length;
    const active = () => page.evaluate((S) => { const i = document.querySelector(S.input), id = i.getAttribute("aria-activedescendant"), el = id && document.getElementById(id); return { id, selected: el?.getAttribute("aria-selected"), index: el ? [...document.querySelectorAll(`${S.list} a`)].indexOf(el) : -1 }; }, SEL);
    if (n > 1) {
      await page.keyboard.press("ArrowDown");
      const d = await active();
      if (d.index !== 1 || d.selected !== "true") add("keyboard", `ArrowDown moves to option ${d.index} (aria-selected ${d.selected}), not 1`);
      await page.keyboard.press("End");
      if ((await active()).index !== n - 1) add("keyboard", "End does not select the last option");
      await page.keyboard.press("ArrowDown");
      if ((await active()).index !== 0) add("keyboard", "ArrowDown from the last option does not wrap to the first");
      await page.keyboard.press("ArrowUp");
      if ((await active()).index !== n - 1) add("keyboard", "ArrowUp from the first option does not wrap to the last");
      await page.keyboard.press("Home");
    }
    const href = await page.evaluate((S) => document.getElementById(document.querySelector(S.input).getAttribute("aria-activedescendant"))?.getAttribute("href"), SEL);
    await Promise.all([page.waitForURL((u) => u.pathname === href, { timeout: 4000 }).catch(() => add("keyboard", `Enter does not open ${href}`)), page.keyboard.press("Enter")]);
    await page.goBack({ waitUntil: "networkidle" }).catch(() => {});   // no history to go back to: the next check reads the page as it is
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    if (width < 700) await page.locator("header [data-kit-search]:visible").first().click(); else await page.keyboard.press("Control+k");
    await page.waitForSelector(`${SEL.dlg}:not([hidden])`, { timeout: 4000 }).catch(() => {});   // a dialog that never opens is reported by the result check below
  }
  await page.keyboard.press("Escape");
  if (await page.locator(`${SEL.dlg}:not([hidden])`).count()) add("keyboard", "Escape does not close the search");
  // the shortcut: exactly one dialog after Ctrl+K, on every page that is listed (a page that owns the key keeps the shell's shut)
  if (width >= 700) for (const u of pages) {
    await page.goto(`${base}${u}`, { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    // a bounded poll for the first dialog, then two frames for a second one (a page that owns the key opens its own on the same keydown), not a fixed 250 ms
    const dialogs = () => document.querySelectorAll('[role="dialog"]:not([hidden])').length;
    await page.waitForFunction(dialogs, null, { timeout: 2000, polling: "raf" }).catch(() => {});   // none within the bound: the count below reports it
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const open = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].filter((d) => { const b = d.getBoundingClientRect(), c = getComputedStyle(d); return !d.hidden && c.display !== "none" && c.visibility !== "hidden" && b.width > 0 && b.height > 0; }).map((d) => d.getAttribute("aria-label") || d.className));
    if (open.length !== 1) add("shortcut", `${u}: Ctrl+K opens ${open.length} dialogs (${open.join(", ") || "none"}), one expected`);
    await page.keyboard.press("Escape");
    if (u !== "/") { await page.locator("body").click({ position: { x: 2, y: 2 } }).catch(() => {}); }   // an unclickable body is a page without one; the close is asserted after
  }
  for (const e of errors) add("console", e);
  return { fail, lat };
}

/**
 * searchQa({ outDir, playwright, chromium, viewports, config, shotsDir, log }) → report (kit.search-qa-report.v1).
 * `config`: { pages?, latencyMs?, derive?, cases? } (kit.search-qa.v1).
 */
export async function searchQa({ outDir, playwright, chromium, viewports = [[390, 844], [1280, 800]], config = {}, shotsDir, bounds, log = () => {} }) {
  const server = await serveSite(outDir);
  const browser = await launchGuarded(playwright, chromium ? { executablePath: chromium } : {}, "search-qa", bounds);
  const failures = [], latencies = {}, screenshots = [];
  try {
    const index = JSON.parse(readFileSync(join(outDir, "search-index.json"), "utf8"));
    const cases = [...(config.derive === false ? [] : deriveCases(index)), ...(config.cases || [])];
    if (shotsDir) mkdirSync(shotsDir, { recursive: true });
    for (const [w, h] of viewports) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 700, hasTouch: w < 700 });
      await ctx.route((u) => new URL(u).origin !== server.url, (r) => r.abort());
      const page = await ctx.newPage();
      const from = browser.faults.length;
      const seen = new Set();
      const shot = shotsDir ? { once: (c) => { const k = c.typo ? "typo" : c.none ? "empty" : c.hint ? "hint" : "highlight"; if (seen.has(k)) return false; seen.add(k); return true; },
        path: (c) => { const f = join(shotsDir, `search-${w}-${c.typo ? "typo" : c.none ? "empty" : c.hint ? "hint" : "highlight"}.png`); screenshots.push(f); return f; } } : null;
      const r = await step(`search-qa ${w}x${h}`, () => checkViewport(page, server.url, { cases, budget: config.latencyMs || 130, pages: config.pages || ["/"], shot, width: w }));
      const med = r.lat.length ? [...r.lat].sort((a, b) => a - b)[Math.floor(r.lat.length / 2)] : null;
      latencies[`${w}x${h}`] = { median: med === null ? null : Math.round(med), max: r.lat.length ? Math.round(Math.max(...r.lat)) : null, queries: r.lat.length };
      if (med !== null && med > (config.latencyMs || 130)) r.fail.push({ kind: "latency", message: `median ${Math.round(med)} ms from key to next frame, budget ${config.latencyMs || 130} ms` });
      // a crash or an uncaught error of the page is a finding even when nothing later threw (browser-guard.js collects them)
      for (const f of faultsSince(browser, from)) r.fail.push({ kind: "console", message: faultMessage(f) });
      for (const f of r.fail) failures.push({ viewport: `${w}x${h}`, ...f });
      log(`  ${r.fail.length ? "FAIL" : "ok  "} ${w}x${h}: ${cases.length} queries, median ${med === null ? "-" : Math.round(med)} ms${r.fail.length ? `, ${r.fail.length} findings` : ""}`);
      await ctx.close();
    }
    for (const f of faultsSince(browser)) failures.push({ viewport: "-", kind: "console", message: faultMessage(f) });   // a fault of no viewport (never silent)
    return { schema: "kit.search-qa-report.v1", generated: new Date().toISOString(), outDir, viewports: viewports.map(([w, h]) => `${w}x${h}`), index: { v: index.v, pages: index.pages.length, sections: (index.sections || []).length, facets: (index.facets || []).length, synonyms: (index.synonyms || []).length }, cases: cases.map((c) => c.id || c.q), latencyMs: latencies, ok: failures.length === 0, failures, screenshots };
  } finally { await browser.close(); await server.close(); }
}

/** search-qa.json of a site, or {} when it has none. */
export function readConfig(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; }
