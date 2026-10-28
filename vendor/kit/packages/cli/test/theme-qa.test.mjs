// The rendered theme gate: the browser measures what renders, for every state and tone, so no cascade a parser would
// have to approximate can hide a failing pair (there is no static pass). Needs Chromium: without one it FAILS (browser-env.mjs), everywhere.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { themeQa, worstOverGlyphPixels, worstOverVisibleGlyphPixels } from "../src/theme-qa.js";
import postcss from "postcss";
import { selectorLines } from "../src/theme-qa.js";
import { themeEntries, kitEntries, kitTemplateOf } from "../src/theme-entries.js";
import { serveSite } from "../src/visual-qa.js";
import { CHROMIUM, BROWSER_TEST_MS, BROWSER_SLOW_TEST_MS, loadPlaywright } from "./browser-env.mjs";

const TMP = fileTempDir("kit-theme-");
let playwright;
before(async () => { playwright = await loadPlaywright(); }, { timeout: BROWSER_TEST_MS });


test("T0 real glyph-pixel fallback: black active chip passes, white-on-white and masked glyphs never green", { timeout: BROWSER_TEST_MS }, () => {
  const image = (colours) => ({ w: 3, h: 3, px(x, y) { return colours[y][x]; } });
  const black = [11, 11, 11], white = [255, 255, 255], gray = [120, 120, 120];
  const hidden = image(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => black)));
  const shown = image([[black, black, black], [black, white, black], [black, black, black]]);
  const rects = [[0, 0, 3, 3]], clip = { x: 0, y: 0 };
  const healthy = worstOverVisibleGlyphPixels(hidden, shown, clip, rects, [...white, 1]);
  assert.ok(healthy && healthy.ratio >= 4.5, "actual visible white glyph on dark chip is admissible");
  const whiteBg = image(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => white)));
  assert.equal(worstOverVisibleGlyphPixels(whiteBg, whiteBg, clip, rects, [...white, 1]), null,
    "white-on-white remains a failure, never a waiver");
  assert.equal(worstOverVisibleGlyphPixels(hidden, hidden, clip, rects, [...white, 1]), null,
    "hidden or occluded glyph has no admissible pixels");
  const offColour = image([[black, black, black], [black, gray, black], [black, black, black]]);
  assert.equal(worstOverVisibleGlyphPixels(hidden, offColour, clip, rects, [255, 0, 0, 1]), null,
    "unrelated repaint must not count as text");
  assert.equal(worstOverVisibleGlyphPixels(hidden, { ...shown, w: 4 }, clip, rects, [...white, 1]), null,
    "mismatched screenshot geometry denies proof");
});

// the colour roles of a project, the way the theme declares them
const ROOT = `:root{--c-bg:#FAFAF7;--c-surface:#FFFFFF;--c-ink:#0B0B0B;--c-on-ink:#FFFFFF;--c-accent:#FF5A00;--c-on-accent:#0B0B0B;--c-muted:#6B6B6B;--c-on-muted:#FFFFFF;--c-ok:#127436;--c-on-ok:#FFFFFF;--c-warn:#A24A08;--c-on-warn:#FFFFFF;--c-err:#B91C1C;--c-on-err:#FFFFFF;--c-chart-1:#0072B2;--c-on-chart-1:#FFFFFF;--c-chart-2:#DD6611;--c-on-chart-2:#111111;--c-line:#E6E4DE}
body{margin:0;background:var(--c-bg);color:var(--c-ink);font:16px/1.5 sans-serif}`;
const run = (css, o = {}) => themeQa({ sheets: [{ file: "t.css", text: ROOT + "\n" + css }], playwright, chromium: CHROMIUM, schemes: ["light"], viewports: [[1280, 800]], ...o });
const sels = (r) => r.problems.map((p) => `${p.selector} [${p.state}${p.tone ? " tone:" + p.tone : ""}]`);

test("must-fail: an enabled state behind :not(:disabled), a hover and a focus state", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await run(".btn{color:var(--c-ink);background:var(--c-surface)}\n.btn:not(:disabled):hover{background:var(--c-accent);color:var(--c-on-ink)}\n.link:focus-visible{color:var(--c-accent);background:var(--c-surface)}");
  assert.ok(sels(r).some((s) => s.startsWith(".btn:not(:disabled):hover [:hover]")), sels(r).join("\n"));
  assert.ok(sels(r).some((s) => s.startsWith(".link:focus-visible [:focus-visible]")), sels(r).join("\n"));
});

test("must-fail: colour inherited from an ancestor, and a background on a container with a descendant that sets the text colour", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await run(".nt{color:var(--c-on-ink)}\n.nt b{background:var(--c-accent);color:inherit;display:block}\n.b{background:var(--c-accent)}\n.b span{color:var(--c-on-ink)}");
  assert.ok(sels(r).some((s) => s.startsWith(".nt b ")), `inherited colour: ${sels(r).join("\n")}`);
  assert.ok(sels(r).some((s) => s.startsWith(".b span ")), `descendant colour on the container's background: ${sels(r).join("\n")}`);
});

test("must-fail: --c set without its --on-c falls back to a colour that does not read; a tone that is muted or ink is tried too", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await run(".ntf--brand{--c:var(--c-accent)}\n.ntf{background:var(--c,var(--c-surface));color:var(--on-c,var(--c-on-ink))}\n.chip{background:var(--c,var(--c-ink));color:var(--on-c,var(--c-on-ink))}");
  assert.ok(sels(r).some((s) => s.startsWith(".ntf--brand ")), `--c without --on-c: ${sels(r).join("\n")}`);
  assert.ok(!sels(r).some((s) => /^\.chip .*tone:(muted|ink)/.test(s)), "muted and ink are tried and read with their on-roles");
  const bad = await run(".chip{background:var(--c,var(--c-ink));color:var(--c-on-ink)}");
  assert.ok(sels(bad).some((s) => /^\.chip .*tone:chart2/.test(s)), `a fixed white on chart-2: ${sels(bad).join("\n")}`);
  assert.ok(!sels(bad).some((s) => /^\.chip .*tone:muted/.test(s)), "white on muted reads");
});

test("colour syntax is not a blind spot: named colours, hsl, oklch, currentColor, color-mix, nested CSS and gradients are what the browser computes", { timeout: BROWSER_TEST_MS }, async () => {
  const css = `.a{background:yellow;color:white}
.b{background:hsl(30 100% 50%);color:oklch(0.99 0 0)}
.c{color:currentColor;background:color-mix(in srgb,#FF5A00 90%,white)}
.nest{background:var(--c-accent);& .in{color:var(--c-on-ink)}}
.grad{background:linear-gradient(90deg,#FFE066,#FFFFFF);color:#FFFFFF}`;
  const r = await run(css);
  const names = sels(r).map((s) => s.split(" ")[0]);
  for (const k of [".a", ".b", ".nest", ".grad"]) assert.ok(names.includes(k) || sels(r).some((s) => s.startsWith(k + " ")), `${k}: ${sels(r).join("\n")}`);
});

test("must-pass: roles that read, the derived on-roles, large text at 3:1, and no built-in waiver for a disabled control", { timeout: BROWSER_TEST_MS }, async () => {
  const ok = await run(".a{background:var(--c-accent);color:var(--c-on-accent)}\n.big{background:var(--c-accent);color:var(--c-on-ink);font-size:28px;font-weight:700}\n.chip{background:var(--c,var(--c-ink));color:var(--on-c,var(--c-on-ink))}");
  assert.deepEqual(sels(ok), [], sels(ok).join("\n"));
  const disabled = await run("button.d:disabled{background:var(--c-accent);color:var(--c-on-ink)}");
  assert.ok(sels(disabled).length, "a disabled control is measured like any other pair");
  const allowed = await run("button.d:disabled{background:var(--c-accent);color:var(--c-on-ink)}", { allow: [{ file: "t.css", category: "contrast", match: "button.d:disabled", context: "base", reason: "An inactive control is exempt from WCAG 1.4.3." }] });
  assert.deepEqual(sels(allowed), [], "one declared instance excuses it");
  const stale = await run(".d{background:var(--c-accent);color:var(--c-on-accent)}", { allow: [{ file: "t.css", category: "contrast", match: ".d", context: "base", reason: "Nothing fails here, so this entry is stale." }] });
  assert.equal(stale.stale.length, 1);
});

test("a declared surface (on) measures the selector where it is used: light text on the ink surface reads, on the page it does not", { timeout: BROWSER_TEST_MS }, async () => {
  const css = ".log .k{color:var(--c-on-ink)}";
  assert.ok(sels(await run(css)).length, "undeclared: measured on the page background, fails");
  const r = await run(css, { allow: [{ file: "t.css", category: "contrast", match: ".log .k", context: "base", on: "ink", reason: "The log panel is a dark surface." }] });
  assert.deepEqual(sels(r), [], "declared on ink: measured there and reads");
});

test("theme harness inherits the canonical component token root instead of fabricating neutral-page contrast", { timeout: BROWSER_TEST_MS }, async () => {
  const css = `.kw{--kw-ink:var(--c-ink);--kw-on-ink:var(--c-on-ink)}
.kw-dev--phone{background:var(--kw-ink);color:var(--kw-on-ink)}
.kw-dev--phone .kw-dev__bar{color:var(--kw-on-ink)}`;
  const good = await run(css);
  assert.ok(!sels(good).some((s) => s.startsWith(".kw-dev--phone .kw-dev__bar ")),
    "the dark phone's white text is measured against its actual black component background");
  const bad = await run(css + "\n.kw-dev--phone .kw-dev__bar{background:var(--kw-on-ink);color:var(--kw-on-ink)}");
  assert.ok(sels(bad).some((s) => s.startsWith(".kw-dev--phone .kw-dev__bar ")),
    "same foreground and background inside the correctly scoped component MUST fail");
});

test("real pages: a selector is measured on the element and in the context the page really has", { timeout: BROWSER_TEST_MS }, async () => {
  const root = join(TMP, "site"); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/t.css"></head><body><section class="dark"><a class="lnk" href="#x">Link on dark</a><button class="btn">Go</button></section></body></html>`);
  const css = ROOT + "\n.dark{background:var(--c-ink)}\n.lnk{color:var(--c-ink)}\n.btn{color:var(--c-on-ink);background:var(--c-ink)}\n.btn:hover{background:var(--c-surface)}";
  writeFileSync(join(root, "t.css"), css);
  const srv = await serveSite(root);
  try {
    const r = await themeQa({ sheets: [{ file: "t.css", text: css }], playwright, chromium: CHROMIUM, schemes: ["light"], viewports: [[1280, 800]], pages: [`${srv.url}/`] });
    assert.ok(r.problems.some((p) => p.selector === ".lnk" && p.where === "page"), "ink link on the page's ink section fails in its real context: " + JSON.stringify(r.problems));
    assert.ok(r.problems.some((p) => p.selector === ".btn:hover" && p.state === ":hover"), "the hover state is forced on the real button");
  } finally { await srv.close(); }
});

test("the kit's own theme, built into the sample site, reads in every selector, state and tone on its real pages (the declared entries are reviewed and none is stale)", { timeout: BROWSER_SLOW_TEST_MS }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { sitePages } = await import("../src/visual-qa.js");
  const out = join(TMP, "sample-out");
  execFileSync(process.execPath, [fileURLToPath(new URL("../bin/kit.js", import.meta.url)), "site", "build", "--out", out], { cwd: fileURLToPath(new URL("../../../examples/site-sample", import.meta.url)), stdio: "pipe", env: { ...process.env } });
  const sheets = readdirSync(out).filter((f) => f.endsWith(".css") && !f.includes(".ar.")).map((f) => ({ file: f, text: readFileSync(join(out, f), "utf8") }));
  const bySig = new Map();
  for (const p of sitePages(out)) if (!p.redirect && !p.file.startsWith("ar/") && !bySig.has(p.signature)) bySig.set(p.signature, p.url);
  const srv = await serveSite(out);
  try {
    const r = await themeQa({ sheets, playwright, chromium: CHROMIUM, pages: [...bySig.values()].map((u) => srv.url + u), allow: themeEntries(sheets), schemes: ["light", "dark"], viewports: [[1280, 800]] });
    assert.deepEqual(r.problems.map((p) => `${p.file}:${p.line} ${p.selector} [${p.state}${p.tone ? " tone:" + p.tone : ""}] ${p.fg} on ${p.bg} ${p.ratio}`), []);
    assert.deepEqual(r.stale.map((e) => `${e.match} (${e.context})`), [], "every declared entry is used");
    assert.ok(r.placed > 800, `the whole theme was measured (${r.placed} selectors)`);
  } finally { await srv.close(); }
});

test("partner step counter uses canonical ink/on-ink pair rather than washed accent", { timeout: BROWSER_TEST_MS }, () => {
  const css = readFileSync(new URL("../../site/theme/pages.css", import.meta.url), "utf8");
  const rule = css.split("\n").find((line) => line.startsWith(".psteps li::before{"));
  assert.ok(rule, "step marker rule must exist");
  assert.ok(rule.includes("background:var(--black);color:{{color.onInk}};"), "must render a contrast-safe ink pair");
  assert.ok(!rule.includes("background:var(--orange)"), "never render low-contrast pale accent markers");
});

test("the kit theme's contrast entries are valid canon-allow entries, each with a reason and a state, and none is a wildcard", { timeout: BROWSER_TEST_MS }, async () => {
  const { validate } = await import("../../core/src/schema.js");
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/canon-allow.schema.json", import.meta.url), "utf8"));
  const entries = kitEntries();
  assert.ok(entries.length > 20);
  assert.deepEqual(validate({ $schema: "x", entries }, schema), []);
  for (const e of entries) { assert.equal(e.category, "contrast"); assert.ok(!/[*?]/.test(e.match), e.match); assert.ok(e.reason.length >= 40, `${e.match}: a real reason`); }
});

// ---- review of #115: every probe is a test that failed before the fix ----------------------------------------------------------
let SITES = 0;
/** A one-page site (html body, css after the roles) served locally, and themeQa on its page. */
async function onPage(html, css, o = {}) {
  const dir = join(TMP, `p${++SITES}`); mkdirSync(dir, { recursive: true });
  const text = ROOT + "\n" + css;
  writeFileSync(join(dir, "t.css"), text);
  writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/t.css"></head><body>${html}</body></html>`);
  const srv = await serveSite(dir);
  try { return await themeQa({ sheets: [{ file: "t.css", text }], playwright, chromium: CHROMIUM, pages: [`${srv.url}/`], schemes: ["light"], viewports: [[1280, 800]], ...o }); } finally { await srv.close(); }
}
const has = (r, sel) => r.problems.some((p) => p.selector === sel);
const why = (r) => JSON.stringify(r.problems.map((p) => `${p.selector} [${p.state}] ${p.scheme} ${p.fg}/${p.bg}`));

test("H1: text is decided from the DOM, not from the tag: a span, a div, an i with a background rule and inherited text are measured", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage(`<p>x <span class="pill">Ink on ink</span></p><div class="box">Ink on an ink box</div><p><i class="ico">Italic</i></p>`, ".pill{background:var(--c-ink)}\n.box{background:var(--c-ink)}\n.ico{background:var(--c-ink)}");
  for (const k of [".pill", ".box", ".ico"]) assert.ok(has(r, k), `${k}: ${why(r)}`);
  const synthetic = await run(".pill{background:var(--c-ink)}\n.dot{background:var(--c-ink);width:8px;height:8px;display:inline-block}");
  assert.ok(sels(synthetic).some((s) => s.startsWith(".pill ")), "a span rule no page shows is measured with the text it would carry, on the page background");
});

test("H2: aria-hidden text that is painted is measured (the markup does not make low contrast acceptable)", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage(`<p class="ends" aria-hidden="true">Upstream Downstream</p>`, ".ends{color:#EEEEEE;background:#FFFFFF}");
  assert.ok(has(r, ".ends"), why(r));
});

test("H3: text painted by a clipped gradient (background-clip:text, transparent fill) is measured: the gradient against what is behind it", { timeout: BROWSER_TEST_MS }, async () => {
  const bad = await onPage(`<h2 class="g">Gradient title</h2>`, ".g{background:linear-gradient(90deg,#FFFFFF,#FAFAF7);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:var(--c-ink)}");
  assert.ok(has(bad, ".g"), "a pale gradient on a pale page fails: " + why(bad));
  const good = await onPage(`<h2 class="g">Gradient title</h2>`, ".g{background:linear-gradient(90deg,#0B0B0B,#1D3557);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:var(--c-ink)}");
  assert.ok(!has(good, ".g"), "a dark gradient on a pale page reads: " + why(good));
});

test("H4: the background is what is painted (pixels with the text hidden): a ::before panel, a positioned overlay sibling and an ancestor ::after are in it", { timeout: BROWSER_TEST_MS }, async () => {
  const before_ = await onPage(`<p class="card">Ink on a ::before ink panel</p>`, ".card{position:relative;z-index:0;color:var(--c-ink);padding:20px}.card::before{content:'';position:absolute;inset:0;background:var(--c-ink);z-index:-1}");
  assert.ok(has(before_, ".card"), "::before panel: " + why(before_));
  const overlay = await onPage(`<div class="hero"><div class="hero__shade"></div><p class="hero__t">Title over shade</p></div>`, ".hero{position:relative}.hero__shade{position:absolute;inset:0;background:var(--c-ink)}.hero__t{position:relative;color:var(--c-ink)}");
  assert.ok(has(overlay, ".hero__t"), "overlay sibling: " + why(overlay));
  const clean = await onPage(`<p class="card">Ink on a pale ::before panel</p>`, ".card{position:relative;z-index:0;color:var(--c-ink);padding:20px}.card::before{content:'';position:absolute;inset:0;background:var(--c-surface);z-index:-1}");
  assert.ok(!has(clean, ".card"), "a pale panel reads: " + why(clean));
});

test("H5: the dark pass applies the hook the CSS reacts to ([data-theme=dark], .dark): a pair that fails only there is found; a hook that changes nothing fails", { timeout: BROWSER_TEST_MS }, async () => {
  const css = ".t{color:var(--c-ink);background:var(--c-surface)}\n:root[data-theme=dark]{--c-surface:#111111}";
  const r = await onPage(`<p class="t">Dark-themed text</p>`, css, { schemes: ["light", "dark"] });
  assert.ok(r.problems.some((p) => p.selector === ".t" && p.scheme === "dark"), "the attribute is set in the dark pass: " + why(r));
  assert.ok(!r.problems.some((p) => p.selector === ".t" && p.scheme === "light"));
  const cls = await onPage(`<p class="t">Dark-themed text</p>`, ".t{color:var(--c-ink);background:var(--c-surface)}\nhtml.dark{--c-surface:#111111}", { schemes: ["light", "dark"] });
  assert.ok(cls.problems.some((p) => p.selector === ".t" && p.scheme === "dark"), "the class is set in the dark pass: " + why(cls));
  const idle = await onPage(`<p class="t">x</p>`, ".t{color:var(--c-ink);background:var(--c-surface)}\n[data-theme=dark] .zz{font-weight:700}", { schemes: ["light", "dark"] });
  assert.ok(idle.problems.some((p) => /dark hook not exercised/.test(p.note || p.state || "")), "a hook that changes no colour is reported: " + why(idle));
});

test("H6: a selector skipped on a page (display:none there) is not counted as measured: it is retried in the neutral page with display forced on", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage(`<div class="nav">Menu<div class="dd"><a href="#">Hidden link</a></div></div>`, ".nav{padding:4px}.nav .dd{display:none;color:var(--c-ink);background:var(--c-ink)}");
  assert.ok(has(r, ".nav .dd"), "the hidden dropdown is measured shown: " + why(r));
});

test("M2: :is() and :where() arguments are built (each branch); a media rule's breakpoints are measured; :visited is reported, not silently measured", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage(`<p class="chip">Chip</p><p>x</p>`, ".chip{color:var(--c-ink);background:var(--c-surface)}.chip:is(.hot){background:var(--c-ink)}\n:where(.dark) .t2{color:var(--c-ink)}.dark{background:var(--c-ink)}");
  assert.ok(has(r, ".chip:is(.hot)"), "the :is branch: " + why(r));
  assert.ok(has(r, ":where(.dark) .t2"), "the :where context: " + why(r));
  const bp = await run("@media (max-width:600px){.m{color:#EEEEEE;background:#FFFFFF}}\n@media (min-width:1100px){.w{color:#EEEEEE;background:#FFFFFF}}", { viewports: [[1280, 800], [390, 844]] });
  assert.ok(bp.problems.some((p) => p.selector === ".m" && p.viewports.some((v) => /^(600|390)x/.test(v))), "the max-width breakpoint: " + why(bp));
  assert.ok(sels(bp).some((s) => s.startsWith(".w ")), "the min-width rule is measured where it applies");
  const bps = await run("@media (max-width:600px){.m{color:#EEEEEE;background:#FFFFFF}}", { viewports: [[1280, 800]] });
  assert.ok(bps.problems.some((p) => p.selector === ".m"), "with one viewport asked, the breakpoint of the media rule is derived and measured: " + why(bps));
  const v = await run("a.v:visited{color:#EEEEEE;background:#FFFFFF}");
  assert.ok(v.problems.some((p) => p.selector === "a.v:visited" && /not measured/.test(p.state)), ":visited cannot be measured, so it fails unless allowed: " + why(v));
});

test("M1: a selector that cannot be built or measured fails unless an allow entry covers it; the entry is stale when it covers nothing", { timeout: BROWSER_TEST_MS }, async () => {
  const css = "input.x:user-valid{color:#EEEEEE;background:#FFFFFF}\nli.y:nth-child(2 of .z){color:#EEEEEE;background:#FFFFFF}";
  const r = await run(css);
  for (const m of ["input.x:user-valid", "li.y:nth-child(2 of .z)"]) assert.ok(r.problems.some((p) => p.selector === m && p.state === "not measured"), `${m}: ${why(r)}`);
  const allowed = await run(css, { allow: [{ file: "t.css", category: "contrast", match: "input.x:user-valid", context: "not measured", reason: "A user interaction state the browser cannot be put in from a script; its colours are the same as the base rule, which is measured." }] });
  assert.ok(!allowed.problems.some((p) => p.selector === "input.x:user-valid") && allowed.problems.some((p) => p.selector === "li.y:nth-child(2 of .z)"));
  const stale = await run(".d{background:var(--c-accent);color:var(--c-on-accent)}", { allow: [{ file: "t.css", category: "contrast", match: "input.gone:user-valid", context: "not measured", reason: "This selector does not exist in the sheet, so the entry is stale and must fail." }] });
  assert.equal(stale.stale.length, 1);
});

test("allow entries match exactly: the context is the whole state label, the file is the sheet's path, and an entry for another sheet excuses nothing", { timeout: BROWSER_TEST_MS }, async () => {
  const css = ".btn:hover{background:var(--c-accent);color:var(--c-on-ink)}";
  const entry = { category: "contrast", match: ".btn:hover", reason: "A reviewed exception used to test the exact match of an allow entry in the rendered gate." };
  const excused = await run(css, { allow: [{ ...entry, file: "t.css", context: ":hover" }] });
  assert.ok(!has(excused, ".btn:hover"), "file t.css, context :hover: " + why(excused));
  for (const wrong of [{ file: "t.css", context: "hover" }, { file: "t.css", context: ":hov" }, { file: "other.css", context: ":hover" }, { file: "dir/t.css", context: ":hover" }]) {
    const r = await run(css, { allow: [{ ...entry, ...wrong }] });
    assert.ok(has(r, ".btn:hover"), `${JSON.stringify(wrong)} excuses nothing: ${why(r)}`);
  }
});

test("Low: every selector of a case is placed (not skipped, not unbuilt), so a test cannot pass without measuring; the colour syntax of .c (currentColor, color-mix) is measured", { timeout: BROWSER_TEST_MS }, async () => {
  const css = ".a{background:yellow;color:white}\n.b{background:hsl(30 100% 50%);color:oklch(0.99 0 0)}\n.c{color:currentColor;background:color-mix(in srgb,#0B0B0B 90%,white)}\n.nest{background:var(--c-accent);& .in{color:var(--c-on-ink)}}";
  const r = await run(css);
  for (const k of [".a", ".b", ".c", ".nest", ".nest .in"]) assert.ok(r.placedSelectors.includes(k), `${k} was placed: ${r.placedSelectors.join(" | ")}`);
  for (const k of [".a", ".b", ".c", ".nest .in"]) assert.ok(has(r, k), `${k}: ${why(r)}`);
  assert.deepEqual(r.unbuilt, []);
});

test("the starting background of an element with no background of its own is the page's canvas, never white (and the ancestors' walk agrees with the pixels)", { timeout: BROWSER_TEST_MS }, async () => {
  const css = "html{background:#0B0B0B}\nbody{background:transparent}\n.k{color:#0B0B0B}";
  const r = await onPage(`<p class="k">Ink on the dark canvas</p>`, css);
  assert.ok(has(r, ".k"), "ink text on a dark canvas fails: " + why(r));
});

test("H7: the kit's reviewed entries excuse only the kit's own sheets, matched by exact path: a project's sheet that shares a name with a kit sheet gets none of them", { timeout: BROWSER_TEST_MS }, async () => {
  const { readTheme } = await import("@saasreport/site");
  const kit = { file: "out/styles.css", text: readTheme("styles.css") + "/* a built sheet carries more */" };
  const foreign = { file: "styles.css", text: ".btn[aria-disabled=\"true\"]{background:#FFFFFF;color:#EEEEEE}" };
  assert.equal(kitTemplateOf(kit.text), "styles.css");
  assert.equal(kitTemplateOf(foreign.text), "", "a foreign sheet is not a kit template, whatever its name");
  const given = themeEntries([kit, foreign]);
  assert.ok(given.length > 0 && given.every((e) => e.file === "out/styles.css"), "the kit's entries are handed to the kit sheet's own path only");
  assert.deepEqual(themeEntries([foreign]), [], "nothing for the foreign sheet");
  // the kit's own sheet in another directory: still its entries, at its path
  assert.ok(themeEntries([{ file: "ar/styles.ar.css", text: kit.text }]).every((e) => e.file === "ar/styles.ar.css"));
});

test("the kit entries are read through the @saasreport/site export and a broken file is an error, never an empty list", { timeout: BROWSER_TEST_MS }, async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/theme-entries.js", import.meta.url), "utf8");
  assert.ok(/require\.resolve\("@saasreport\/site\/theme\/contrast\.json"\)/.test(src), "resolved through the package export");
  assert.ok(!/catch\s*\{\s*return \[\]/.test(src), "no swallowed parse error");
});

test("H7: kit.canon.json validates the kit theme's contrast entries against the canon-allow schema (a malformed entry fails kit check canon)", { timeout: BROWSER_TEST_MS }, async () => {
  const { readFileSync } = await import("node:fs");
  const cfg = JSON.parse(readFileSync(new URL("../../../kit.canon.json", import.meta.url), "utf8"));
  assert.ok(cfg.schemas.some((r) => r.schema === "canon-allow" && (r.files || []).includes("packages/site/theme/contrast.json")), "contrast.json is under a schema rule");
  assert.ok(cfg.tokens.sources.includes("packages/core/src/colour.js"), "the colour derivation is a token source");
});

test("T0 ARIA-current pill: painted text/background are measured after DOM state settles; genuine bad pill fails", { timeout: BROWSER_TEST_MS }, async () => {
  const markup = '<nav><a class="chip2" aria-current="false">Payments</a><a class="chip2" aria-current="true">Credit</a></nav>';
  const positive = '.chip2{display:inline-block;padding:8px 14px;background:#FFFFFF;color:#555555}.chip2[aria-current="true"]{background:#0B0B0B;color:#FFFFFF}';
  const healthy = await onPage(markup, positive);
  assert.ok(!has(healthy, '.chip2[aria-current="true"]'), 'black active pill with white glyphs must pass: ' + why(healthy));
  // A globally disabled rAF makes Chromium's own page rendering and CDP
  // screenshot scheduler stall, so do not damage the browser to test host-
  // side settled-paint logic. Both real painted positive and negative controls
  // below still execute and reject an actual white-on-white element.
  assert.match(readFileSync(new URL("../src/theme-qa.js", import.meta.url), "utf8"),
    /await page\.waitForTimeout\(70\)/, "settled-paint wait must be host-driven");
  const negative = await onPage(markup, '.chip2{display:inline-block;padding:8px 14px;background:#FFFFFF;color:#555555}.chip2[aria-current="true"]{background:#FFFFFF;color:#FFFFFF}');
  assert.ok(has(negative, '.chip2[aria-current="true"]'), 'actual white-on-white active pill must stay RED: ' + why(negative));
});

test("T0 scrolled active category chips: page-height viewport glyph proof, including a descendant counter, rejects real white-on-white", { timeout: BROWSER_TEST_MS }, async () => {
  const markup = `<main style="height:2300px">Scrolled content</main><nav class="chips2" aria-label="Categories"><a class="chip2" href="#payments">پرداخت و شبکه پرداخت <small>۲۷</small></a><a class="chip2" href="#credit">اعتبار و حساب <small>۲۷</small></a></nav><footer style="height:1300px"></footer>`;
  const base = `.chips2{display:flex;flex-wrap:wrap;gap:6px;background:#FFFFFF}
  .chip2{display:inline-block;padding:6px 14px;border:1.5px solid #DDDDDD;border-radius:99px;font:700 14px sans-serif;color:#666666}
  .chip2[aria-current="true"]{background:#0B0B0B;border-color:#0B0B0B;color:#FFFFFF}`;
  const good = await onPage(markup, base, { viewports: [[1280,800]] });
  assert.ok(!has(good, '.chip2[aria-current="true"]'), "scrolled dark pill must render verifiable light glyphs: " + why(good));
  const badCss = base.replace('background:#0B0B0B;border-color:#0B0B0B;color:#FFFFFF', 'background:#FFFFFF;border-color:#DDDDDD;color:#FFFFFF');
  const bad = await onPage(markup, badCss, { viewports: [[1280,800]] });
  assert.ok(has(bad, '.chip2[aria-current="true"]'), "viewport fallback MUST NOT waive actual white-on-white ink: " + why(bad));
  const src = readFileSync(new URL("../src/theme-qa.js", import.meta.url), "utf8");
  assert.match(src, /window\.__qa\.viewportItem\(i\)/, "viewport recheck must get scroll-adjusted glyph rectangles from the same browser");
  assert.match(src, /shootViewport\(cdp\)/, "viewport capture must have no CDP clip because clipped coordinates are document-relative even when captureBeyondViewport is false");
});

test("T0 scrolled overlay: document-space screenshot samples are transformed to viewport-space hit testing (fail-closed)", { timeout: BROWSER_TEST_MS }, async () => {
  const html = `<main style="height:1000px"></main><div class="pane"><div class="shade"></div><p class="ink">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</p></div><footer style="height:1500px"></footer>`;
  const css = `.pane{position:relative;background:#FFFFFF;padding:16px}.ink{margin:0;color:#0B0B0B;display:block;font-size:20px}.shade{position:absolute;z-index:3;left:20%;top:0;bottom:0;width:15%;background:#0B0B0B;pointer-events:none}`;
  const r = await onPage(html, css, { viewports: [[1280,800]] });
  assert.ok(has(r, ".ink"), "a real overlay may never be excused by unoccluded glyphs: " + why(r));
  assert.ok(r.notes.some((n) => n.includes("glyph-probe .ink") && n.includes("covered=true")), "the overlay hit test must use viewport coords after scroll: " + r.notes.join("\\n"));
});

test("re-review H1/M2: every overlay a plain-ancestor shortcut could miss is found, because the background is always read from pixels: a child panel inside the text element, an overlay narrower than the sample points, an ancestor ::after painting by outline, a pseudo-element with a gradient of its own", { timeout: BROWSER_TEST_MS }, async () => {
  const cases = {
    pseudoGradient: [`<p class="tag">Tag</p>`, `.tag::before{content:"New";background-image:linear-gradient(#0B0B0B,#0B0B0B);color:#333333;padding:4px}`, ".tag::before"],
    childPanel: [`<div class="btn">Read me<i class="shade"></i></div>`, `.btn{position:relative;color:#222222;padding:10px}.btn .shade{position:absolute;inset:0;background:#0B0B0B;z-index:1;pointer-events:none}`, ".btn"],
    narrowOverlay: [`<div class="w"><span class="bar"></span><p class="t">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnop</p></div>`, `.w{position:relative}.t{color:#0B0B0B;margin:0;display:inline-block}.bar{position:absolute;left:22%;width:12%;top:0;bottom:0;background:#0B0B0B;z-index:2}`, ".t"],
    outlinePanel: [`<p class="card">Ink text here</p>`, `.card{position:relative;color:#0B0B0B;padding:20px}.card::after{content:"";position:absolute;inset:0;outline:200px solid #0B0B0B;outline-offset:-200px}`, ".card"],
    pseudoPass: [`<p class="tag">Tag</p>`, `.tag::before{content:"New";background-image:linear-gradient(#0B0B0B,#222222);color:#FFFFFF;padding:4px}`, null],
  };
  for (const [k, [html, css, sel]] of Object.entries(cases)) {
    const r = await onPage(html, css);
    if (sel) assert.ok(has(r, sel), `${k}: ${why(r)}`); else assert.deepEqual(r.problems, [], `${k}: a gradient pseudo-element that reads passes: ${why(r)}`);
  }
});

test("a state a tag cannot have is not silently skipped: :disabled on an <a class=btn> is built on an element that can be disabled, and fails there", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage(`<a class="btn" href="#x">Link button</a>`, ".btn{color:var(--c-ink);background:var(--c-surface)}\n.btn:disabled{color:#CCCCCC;background:#FFFFFF}");
  assert.ok(has(r, ".btn:disabled"), why(r));
});

test("selectorLines: positions come from postcss, nested rules are reported both as written and resolved, keyframe steps are not selectors", { timeout: BROWSER_TEST_MS }, () => {
  // written out by hand from the fixture below: line numbers are the line each selector starts on
  const css = `/* .gone { color: red } */
.a, .b:hover { color: red }
.p {
  .q { color: red }
  &:hover { color: blue }
}
@media (prefers-color-scheme: dark) {
  .c::before { content: "{ .not { } "; }
}
@keyframes k { from { color: red } to { color: blue } }

.d
{ color: red }`;
  assert.deepEqual(selectorLines(css), [
    { selector: ".a, .b:hover", line: 2 }, { selector: ".p", line: 3 }, { selector: ".q", line: 4 }, { selector: ".p .q", line: 4 },
    { selector: "&:hover", line: 5 }, { selector: ".p:hover", line: 5 }, { selector: ".c::before", line: 8 }, { selector: ".d", line: 12 },
  ]);
  assert.throws(() => selectorLines(".a{color:red", "broken.css"), /broken\.css/, "an unreadable sheet is an error, never skipped");
});

test("selectorLines on the kit's own theme: every top-level rule's line is the line of its selector in the source, and postcss's rule count is matched", { timeout: BROWSER_TEST_MS }, async () => {
  const dir = fileURLToPath(new URL("../../site/theme/", import.meta.url));
  let checked = 0;
  const { renderCss, resolveTokens, createLocale } = await import("@saasreport/site");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".css"))) {
    const text = renderCss(readFileSync(join(dir, f), "utf8"), { file: f, tokens: resolveTokens({}), locale: createLocale("en"), name: "T" }), lines = text.split("\n");
    const got = selectorLines(text, f);
    const expected = []; postcss.parse(text).walkRules((r) => { if (!(r.parent?.type === "atrule" && /keyframes$/i.test(r.parent.name))) expected.push(r); });
    assert.ok(got.length >= expected.length, `${f}: a reported selector per rule`);
    for (const r of expected) {
      const first = r.selector.replace(/\s+/g, " ").trim();
      assert.ok(got.some((g) => g.selector === first && g.line === r.source.start.line), `${f}:${r.source.start.line} ${first}`);
      assert.ok(lines[r.source.start.line - 1].includes(r.selectors[0].split(/\s+/)[0]), `${f}:${r.source.start.line}: the selector is written on that line`);
      checked++;
    }
  }
  assert.ok(checked > 100, `checked ${checked} rules of the real theme`);
});

// ---- review of #115 (round 3): an error inside the browser program is a finding, never a match. The browser is made to reject a selector
// (Element.prototype.matches throws for it); the gate must say "not measured: <error>" and never judge the pair as if the selector matched.
const rejecting = (pw, text, when = "true") => {
  const script = `(() => { const m = Element.prototype.matches; Element.prototype.matches = function (s) { if (String(s).includes(${JSON.stringify(text)}) && (${when})) throw new SyntaxError("boom: " + s); return m.call(this, s); }; })()`;
  return { chromium: { launch: async (o) => {
    const b = await pw.chromium.launch(o), nc = b.newContext.bind(b);
    b.newContext = async (...a) => {
      const c = await nc(...a), np = c.newPage.bind(c);
      await c.addInitScript(script);   // documents the page navigates to
      c.newPage = async () => { const p = await np(); await p.evaluate(script); return p; };   // setContent keeps the window: the override stays
      return c;
    };
    return b;
  } } };
};

test("an error while building the selector in its real page is ALWAYS reported as not measured, even when the neutral page measures it and passes (the real context is where it fails)", { timeout: BROWSER_TEST_MS }, async () => {
  // ink text on a hero that is ink: unreadable on the real page; on the neutral page (the page background) the same rule reads fine
  const html = `<div class="hero"><p class="bad">Text</p></div>`, css = ".hero{background:var(--c-ink)}.bad{color:var(--c-ink)}";
  const neutral = await run(".bad{color:var(--c-ink)}");
  assert.deepEqual(neutral.problems.filter((p) => p.selector === ".bad"), [], "the fixture passes in the neutral page: that is the gap it proves");
  const real = await onPage(html, css);
  assert.ok(real.problems.some((p) => p.kind === "contrast" && p.selector === ".bad" && p.where === "page"), "without the error the real page fails it: " + JSON.stringify(real.problems.map((p) => [p.kind, p.selector, p.where])));
  const r = await onPage(html, css, { playwright: rejecting(playwright, ".bad") });
  const un = r.problems.filter((p) => p.kind === "unmeasured" && p.selector === ".bad");
  assert.equal(un.length, 1, JSON.stringify(r.problems.map((p) => [p.kind, p.selector, p.where, p.note])));
  assert.equal(un[0].state, "not measured");
  assert.match(un[0].note, /^not measured: .*boom/);
});

test("an error while reading the tone selectors of the page is reported as not measured, never swallowed", { timeout: BROWSER_TEST_MS }, async () => {
  const css = ".chip{background:var(--c);color:var(--on-c);padding:4px}";
  const clean = await onPage(`<span class="chip">Chip</span>`, css);
  assert.ok(!clean.problems.some((p) => p.kind === "unmeasured"), "no error without the sabotage: " + JSON.stringify(clean.problems.map((p) => [p.kind, p.selector, p.note])));
  const r = await onPage(`<span class="chip">Chip</span>`, css, { playwright: rejecting(playwright, ".chip") });
  assert.ok(r.problems.some((p) => p.kind === "unmeasured" && p.selector === ".chip" && /^not measured: .*boom/.test(p.note)), JSON.stringify(r.problems.map((p) => [p.kind, p.selector, p.note])));
});

test("selectorLines: `&` inside :is() / :not() resolves against the parent too (the browser measures the resolved selector)", { timeout: BROWSER_TEST_MS }, () => {
  const got = selectorLines(".a {\n  :is(.b, &.c) { color: red }\n  :not(&) { color: blue }\n}");
  assert.deepEqual(got.map((x) => [x.selector, x.line]), [[".a", 1], [":is(.b, &.c)", 2], [":is(.b, .a.c)", 2], [":not(&)", 3], [":not(.a)", 3]]);
});


test("negated first/last child selectors are built and measured without waivers", { timeout: BROWSER_TEST_MS }, async () => {
  const css = [
    ".w-bars i:not(:first-child){background:var(--c-surface);color:#EEEEEE}",
    ".gov li.on:not(:last-child)::after{content:'Next';background:var(--c-surface);color:#EEEEEE}",
  ].join("\n");
  const r = await run(css);
  const subjects = [".w-bars i:not(:first-child)", ".gov li.on:not(:last-child)::after"];
  for (const subject of subjects) {
    assert.ok(!r.problems.some((p) => p.selector === subject && p.kind === "unmeasured"),
      `selector ${subject} was not positioned for a real browser check: ${why(r)}`);
    assert.ok(r.placedSelectors.includes(subject), `selector ${subject} was not placed: ${JSON.stringify(r.unbuilt)}`);
  }
  assert.ok(has(r, subjects[0]), "bad first-child text contrast must still fail after being positioned");
});


test("negated ancestor selectors position their real parent before descendant measurement", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await onPage('<ul class="list"><li><span class="label">Content</span></li></ul>',
    ".list li:not(:last-child) .label{background:var(--c-surface);color:#EEEEEE}");
  assert.ok(has(r, ".list li:not(:last-child) .label"),
    "bad descendant contrast must be measured on the matched ancestor, not a default style: " + why(r));
  const spaced = await onPage('<ul class="list"><li><span class="label">Content</span></li></ul>',
    ".list li:not( :last-child ) .label{background:var(--c-surface);color:#EEEEEE}");
  assert.ok(has(spaced, ".list li:not(:last-child) .label"),
    "whitespace inside :not() is canonically normalized; the resulting matched selector must still fail contrast: " + why(spaced));
});

test("negated last-child does not break an adjacent sibling combinator", { timeout: BROWSER_TEST_MS }, async () => {
  const selector = ".a:not(:last-child) + .b";
  const r = await run(`${selector}{background:var(--c-surface);color:#EEEEEE}`);
  assert.ok(r.placedSelectors.includes(selector), "adjacent selector must be placed: " + JSON.stringify(r.unbuilt));
  assert.ok(has(r, selector), "the browser must measure failing text contrast on the adjacent element: " + why(r));
  assert.ok(!r.problems.some((p) => p.selector === selector && p.kind === "unmeasured"),
    "an adjacent combinator may not be swallowed as an unmeasurable selector");
});

test("a negation on an EARLIER real-page ancestor is positioned and measured, never replaced by the neutral page", { timeout: BROWSER_TEST_MS }, async () => {
  const selector = ".list li:not(:last-child) .wrap .label";
  const r = await onPage('<section class="dark"><ul class="list"><li><div class="wrap"><span class="label">Text</span></div></li></ul></section>',
    `.dark{background:var(--c-ink)}\n${selector}{background:var(--c-ink);color:var(--c-ink)}`);
  assert.ok(r.placedSelectors.includes(selector), "the full ancestor selector must be measured: " + JSON.stringify(r.unbuilt));
  assert.ok(r.problems.some((p) => p.selector === selector && p.where === "page"),
    "contrast on the real dark page must fail; neutral harness cannot replace the real page: " + why(r));
});


test("following sibling matching ignores a preceding label with the same class", { timeout: BROWSER_TEST_MS }, async () => {
  const selector = ".list li:not(:last-child) .wrap + .label";
  const html = '<div class="dark"><ul class="list"><li><span class="label">Prior</span><div class="wrap">Anchor</div><span class="label">Following</span></li></ul></div>';
  const css = ".dark{background:var(--c-ink)}\n" + selector + "{color:var(--c-ink);background:var(--c-ink)}";
  const r = await onPage(html, css);
  assert.ok(r.problems.some((p) => p.selector === selector && p.where === "page"),
    "only a label following .wrap is a valid measurement: " + why(r));
});

test("a forceable ancestor hover does not discard its real-page positional descendant", { timeout: BROWSER_TEST_MS }, async () => {
  const selector = ".dark:hover li:not(:last-child) .wrap .label";
  const html = '<section class="dark"><ul><li><div class="wrap"><span class="label">Text</span></div></li></ul></section>';
  const css = ".dark{background:var(--c-ink)}\n" + selector + "{color:var(--c-ink);background:var(--c-ink)}";
  const r = await onPage(html, css);
  assert.ok(r.problems.some((p) => p.selector === selector && p.where === "page"),
    "a real-page hover ancestor must still be measured: " + why(r));
});


test("ancestor forced-state normalisation preserves literal :hover inside attribute values", { timeout: BROWSER_TEST_MS }, async () => {
  const selector = '.panel[data-state=":hover"] li:not(:last-child) .wrap .label';
  const html = '<section class="panel" data-state=":hover"><ul><li><div class="wrap"><span class="label">Text</span></div></li></ul></section>';
  const css = '.panel{background:var(--c-ink)}\n' + selector + '{background:var(--c-ink);color:var(--c-ink)}';
  const r = await onPage(html, css);
  assert.ok(r.problems.some((p) => p.selector === selector && p.where === "page"),
    "a quoted :hover is data, not a pseudo-class to strip: " + why(r));
});


test("T0 pixel glyph-mask: sampled text rectangle is NOT the glyph; actual black badge passes and actual white badge fails", { timeout: BROWSER_TEST_MS }, () => {
  const make = (inside) => ({ w: 30, h: 20, px: (x, y) =>
    x >= 7 && x <= 19 && y >= 6 && y <= 15 ? inside : [255, 255, 255] });
  const bgDark = make([11, 11, 11]);
  // Exactly the six actual magenta glyph pixels, not the rest of the text
  // rectangle (which extends over white sibling margins).
  const inkOn = (bg) => ({ w: 30, h: 20, px: (x, y) =>
    x >= 10 && x <= 12 && y >= 9 && y <= 10 ? [255, 0, 255] : bg.px(x, y) });
  const rects = [[0, 0, 30, 20]], clip = { x: 0, y: 0, width: 30, height: 20 };
  const whiteText = [255, 255, 255, 1];
  const good = worstOverGlyphPixels(bgDark, inkOn(bgDark), clip, rects, whiteText);
  assert.ok(good && good.ratio >= 4.5, "white glyphs on the black badge must pass even though the bounding box crosses white");
  const bgLight = make([255, 255, 255]);
  const bad = worstOverGlyphPixels(bgLight, inkOn(bgLight), clip, rects, whiteText);
  assert.ok(bad && bad.ratio < 4.5, "white glyphs really painted over white must still FAIL");
  assert.equal(worstOverGlyphPixels(bgDark, bgDark, clip, rects, whiteText), null,
    "no observable glyph means unverified; must never count as a pass");
});

test("T0 real Chromium preserves a genuine black-on-black failure under the glyph-precise recheck", { timeout: BROWSER_TEST_MS }, async () => {
  const sel = ".actual-bad";
  const r = await run(`${sel}{display:inline-block;background:var(--c-ink);color:var(--c-ink);padding:8px 14px}`);
  assert.ok(r.problems.some((p) => p.selector === sel && p.ratio < 4.5),
    "pixel-mask recheck must retain genuine text contrast failures: " + JSON.stringify(r.problems));
});
