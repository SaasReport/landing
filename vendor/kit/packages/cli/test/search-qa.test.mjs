// kit site search-qa (packages/site/assets/shell.js, the global search): the pieces that need no browser (the cases derived
// from an index, the config and report schemas) and, when a Chromium is configured (KIT_CHROMIUM + KIT_PLAYWRIGHT), the whole
// gate in a real browser against the sample site and against a site whose search is broken in each way the gate exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildSite } from "@saasreport/site";
import sample from "../../../examples/site-sample/site.config.js";
import { deriveCases, searchQa } from "../src/search-qa.js";
import { bundled } from "../src/canon/index.js";
import { CHROMIUM, BROWSER_TEST_MS, loadPlaywright } from "./browser-env.mjs";
import { tempDir } from "../../core/test/support/temp.mjs";

const root = new URL("../../../examples/site-sample/", import.meta.url).pathname;
const kit = bundled();
const { formatProblems } = await import("@saasreport/core/schema");

test("deriveCases: from the site's own index, a distinctive title word, its typos, its other spellings, nothing, one character", { timeout: BROWSER_TEST_MS }, () => {
  const index = { v: 2, terms: {}, pages: [["/", "Home page", "", ""], ["/academy/", "Academy paths", "", ""], ["/directory/", "کتابخانه مالی", "", ""], ["/lab/", "Sandbox lab", "", ""]] };
  const cases = deriveCases(index);
  const ids = cases.map((c) => c.id);
  assert.ok(ids.includes("exact academy") && ids.includes("exact کتابخانه"), ids.join(" | "));
  const typo = cases.find((c) => c.typo && c.expect.url === "/academy/");
  assert.ok(typo && typo.q !== "academy" && typo.q.length >= 6, JSON.stringify(typo));
  assert.ok(cases.some((c) => c.sameAs === "academy" && c.q === "ACADEMY"), "a Latin word: another case");
  assert.ok(cases.some((c) => c.sameAs && /[يك]/.test(c.q)), "a Persian word: Arabic letter variants");
  assert.ok(cases.some((c) => c.none) && cases.some((c) => c.hint));
  assert.ok(!cases.some((c) => c.expect?.url === "/"), "the home page is not a distinctive target");
});

test("the config and the report have schemas that are bundled, accept what they describe and refuse what they do not", { timeout: BROWSER_TEST_MS }, () => {
  const cfg = kit.byName("search-qa"), rep = kit.byName("search-qa-report");
  assert.ok(cfg && rep, "registered in the schema index");
  const ok = { pages: ["/", "/terminal/"], latencyMs: 130, cases: [{ q: "sukuk", expect: { url: "/sukuk/", within: 3 }, highlight: "sukuk" }, { q: "sukuuk", typo: true, expect: { url: "/sukuk/" } }, { q: "صكوك", sameAs: "صکوک" }, { q: "zzz", none: true }, { q: "a", hint: true }] };
  assert.deepEqual(formatProblems(kit.validator.validate(ok, cfg)), []);
  for (const bad of [{ pages: ["terminal"] }, { cases: [{ expect: { url: "/x/" } }] }, { cases: [{ q: "a", expect: { url: "x" } }] }, { latencyMs: 0 }, { extra: 1 }]) assert.ok(formatProblems(kit.validator.validate(bad, cfg)).length, JSON.stringify(bad));
  const report = { schema: "kit.search-qa-report.v1", generated: "2026-10-06T00:00:00Z", outDir: "site", viewports: ["390x844"], index: { v: 2, pages: 3, sections: 2, facets: 0, synonyms: 0 }, cases: ["exact a"], latencyMs: { "390x844": { median: 40, max: 60, queries: 3 } }, ok: false, failures: [{ viewport: "390x844", kind: "typo", message: "x" }], screenshots: [] };
  assert.deepEqual(formatProblems(kit.validator.validate(report, rep)), []);
  assert.ok(formatProblems(kit.validator.validate({ ...report, failures: [{ viewport: "390x844", kind: "nope", message: "x" }] }, rep)).length);
});

const load = loadPlaywright;

test("search-qa in a real browser: the sample site's search passes at 390 and 1280 px, with a page that owns Ctrl+K kept to one dialog", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-sqa-");
  buildSite(sample, { root, outDir: out, write: true });
  const r = await searchQa({ outDir: out, playwright: await load(), chromium: CHROMIUM, shotsDir: join(out, "shots") });
  assert.deepEqual(r.failures, []);
  assert.equal(r.index.v, 2);
  for (const l of Object.values(r.latencyMs)) assert.ok(l.median < 130, JSON.stringify(r.latencyMs));
  assert.deepEqual(formatProblems(kit.validator.validate(r, kit.byName("search-qa-report"))), []);
  assert.equal(r.screenshots.length, 8, r.screenshots.join(", "));
});

test("search-qa catches a broken search: no typo tolerance, no highlight, no listbox, two dialogs on Ctrl+K, sideways scroll", { timeout: BROWSER_TEST_MS }, async (t) => {
  const out = tempDir(t, "kit-sqa-bad-");
  buildSite(sample, { root, outDir: out, write: true });
  // the search as it was: no typo retry, no marks, no roles; and a page that opens its own dialog on the same key
  let js = readFileSync(join(out, "shell.js"), "utf8");
  js = js.replace("if (fix.length) {", "if (false) {").replace(/<mark>/g, "<i>").replace(/<\/mark>/g, "</i>").replace(/\bwindow\.addEventListener\("keydown"/, 'document.addEventListener("keydown"');
  writeFileSync(join(out, "shell.js"), js);
  const html = readFileSync(join(out, "index.html"), "utf8");
  writeFileSync(join(out, "styles.css"), `${readFileSync(join(out, "styles.css"), "utf8")}\n.kshell__sbox{width:900px!important;min-width:900px}`);
  const second = `<div role="dialog" aria-label="second" hidden style="position:fixed;inset:0"></div><script>document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.key==="k")document.querySelector('[aria-label=second]').hidden=false})</script>`;
  writeFileSync(join(out, "index.html"), html.replace('role="listbox"', "").replace("</body>", `${second}</body>`));
  const r = await searchQa({ outDir: out, playwright: await load(), chromium: CHROMIUM, viewports: [[390, 844], [1280, 800]] });
  const kinds = new Set(r.failures.map((f) => f.kind));
  for (const k of ["typo", "highlight", "keyboard", "shortcut", "layout"]) assert.ok(kinds.has(k), `${k} is caught: ${[...kinds].join(", ")}`);
});

test("kit site build gives the same site from any directory: the project's own files are read next to its config", { timeout: BROWSER_TEST_MS }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync, statSync } = await import("node:fs");
  const repo = new URL("../../../", import.meta.url).pathname;
  const build = (cwd) => { const out = tempDir(t, "kit-cwd-"); execFileSync(process.execPath, [join(repo, "packages/cli/bin/kit.js"), "site", "build", "--config", join(repo, "examples/site-sample/site.config.js"), "--out", out], { cwd, encoding: "utf8" }); return out; };
  const walk = (d, r = d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), r) : [join(d, n).slice(r.length)])).sort();
  const a = build(repo), b = build(tmpdir()), c = build(join(repo, "examples/site-sample"));
  assert.deepEqual(walk(a), walk(b)); assert.deepEqual(walk(a), walk(c));
  for (const f of walk(a)) { const x = readFileSync(join(a, f)); assert.ok(x.equals(readFileSync(join(b, f))) && x.equals(readFileSync(join(c, f))), f); }
  assert.equal(JSON.parse(readFileSync(join(a, "search-index.json"), "utf8")).v, 2);
});
