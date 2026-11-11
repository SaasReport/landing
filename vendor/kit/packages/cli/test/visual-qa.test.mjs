// kit site visual-qa (docs/COLOUR.md): the pieces that need no browser (page list and templates, the local server, PNG decoding,
// the worst contrast over pixels, the report schema) and, when a Chromium is configured (KIT_CHROMIUM + KIT_PLAYWRIGHT), the
// whole gate against a tiny site: a passing page, and a page with every defect the gate exists to catch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { sitePages, serveSite, decodePng, worstOverPixels, visualQa, splitThemeByOwner } from "../src/visual-qa.js";
import { bundled } from "../src/canon/index.js";
import { CHROMIUM, BROWSER_TEST_MS, loadPlaywright } from "./browser-env.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const TMP = fileTempDir("kit-vqa-");
const put = (root, files) => { for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); } return root; };

/** A solid-colour RGB PNG (filter 0), enough to read pixels back. */
function png(w, h, rgb) {
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + x * 3 + i] = v; });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("sitePages: every html file, redirects flagged, pages built from the same stylesheets and scripts share a template", { timeout: BROWSER_TEST_MS }, () => {
  const root = put(join(TMP, "pages"), {
    "index.html": '<html><body class="home"><link rel="stylesheet" href="/a.css?v=1"><script data-cfasync="false" src="/a.js"></script></body></html>',
    "x/index.html": '<html><body class="home"><link rel="stylesheet" href="/a.css?v=2"><script data-cfasync="false" src="/a.js"></script></body></html>',
    "y/index.html": '<html><body><link rel="stylesheet" href="/b.css"></body></html>',
    "old.html": '<meta http-equiv="refresh" content="0;url=/">',
  });
  const p = sitePages(root);
  assert.deepEqual(p.map((x) => x.url), ["/", "/old.html", "/x/", "/y/"]);
  assert.equal(p[0].signature, p[2].signature, "same template");
  assert.notEqual(p[0].signature, p[3].signature);
  assert.equal(p[1].redirect, true);
  assert.deepEqual(sitePages(root, { include: ["x/**"] }).map((x) => x.url), ["/x/"]);
});

test("serveSite: clean URLs, the 404 page, nothing outside the directory", { timeout: BROWSER_TEST_MS }, async () => {
  const root = put(join(TMP, "serve"), { "index.html": "home", "a/index.html": "a", "b.html": "b", "404.html": "gone", "../secret.txt": "no" });
  const s = await serveSite(root);
  try {
    const get = async (p) => { const r = await fetch(s.url + p); return [r.status, await r.text()]; };
    assert.deepEqual(await get("/"), [200, "home"]);
    assert.deepEqual(await get("/a/"), [200, "a"]);
    assert.deepEqual(await get("/b"), [200, "b"]);
    assert.deepEqual(await get("/nope"), [404, "gone"]);
    assert.equal((await get("/..%2fsecret.txt"))[0], 404);
  } finally { await s.close(); }
});

test("decodePng and worstOverPixels: the text colour against the pixels behind it", { timeout: BROWSER_TEST_MS }, () => {
  const img = decodePng(png(8, 4, [255, 90, 0]));
  assert.deepEqual([img.w, img.h, ...img.px(3, 2)], [8, 4, 255, 90, 0]);
  const white = worstOverPixels(png(40, 12, [255, 90, 0]), [255, 255, 255, 1]);   // white on the brand orange: 3.13:1
  assert.ok(Math.abs(white.ratio - 3.13) < 0.05, String(white.ratio));
  const ink = worstOverPixels(png(40, 12, [255, 90, 0]), [11, 11, 11, 1]);
  assert.ok(ink.ratio > 4.5, String(ink.ratio));
});

test("the report schema kit.visual-qa.v1 is bundled and accepts a report", { timeout: BROWSER_TEST_MS }, async () => {
  const kit = bundled();
  const schema = kit.byName("visual-qa");
  assert.ok(schema, "registered in the schema index");
  const ok = { schema: "kit.visual-qa.v1", generated: new Date().toISOString(), outDir: "site", viewports: ["390x844"], schemes: ["light"], pages: 1, views: 1, ok: false, counts: { contrast: 1 }, templates: [{ pages: 1, example: "/", urls: ["/"] }], failures: [{ url: "/", viewport: "390x844", scheme: "light", kind: "contrast", message: "3.13:1" }], notes: [], screenshots: [] };
  const { formatProblems } = await import("@saasreport/core/schema");
  assert.deepEqual(formatProblems(kit.validator.validate(ok, schema)), []);
  assert.ok(formatProblems(kit.validator.validate({ ...ok, schema: "nope" }, schema)).length, "a wrong report is refused");
});

test("visualQa in a real browser: a good page passes, a page with every defect fails each check", { timeout: BROWSER_TEST_MS }, async () => {
  const playwright = await loadPlaywright();
  const css = `:root{--c-ink:#0B0B0B;--c-bg:#FAFAF7;--c-accent:#FF5A00;--c-on-accent:#0B0B0B;--c-focus:#B64203}body{margin:0;background:var(--c-bg);color:var(--c-ink);font:16px/1.5 sans-serif}.btn{background:var(--c-accent);color:var(--c-on-accent);padding:8px 12px;border:0}:focus-visible{outline:2px solid var(--c-focus)}button,input{font:inherit}input{border:1.5px solid var(--c-ink)}a{color:var(--c-ink)}`;
  const good = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Good</title><link rel="stylesheet" href="/s.css"></head><body><main><p>Read <a href="/x" style="text-decoration:underline">the terms</a> before you go on.</p><button class="btn">Go</button> <label>Name <input placeholder="Your name"></label></main></body></html>`;
  const bad = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bad</title><link rel="stylesheet" href="/s.css"><style>.low{color:#bbb}.wide{width:900px;background:#eee}.lit{color:red}.clip{width:60px;height:20px;overflow:hidden;white-space:nowrap}</style></head><body><main><p class="low">Faint text</p><button class="btn" style="color:#fff">White on orange</button><p>Read <a href="/x" style="color:inherit;text-decoration:none">the terms</a> before.</p><div class="wide">wide</div><img src="/none.png"><p class="lit">literal</p><div class="clip">a very long line that is cut off by its own box</div><input style="border:1px solid #ddd" placeholder="p"><script>console.error("boom")</script></main></body></html>`;
  const root = put(join(TMP, "site"), { "s.css": css, "index.html": good, "bad/index.html": bad });
  const r = await visualQa({ outDir: root, playwright, chromium: CHROMIUM, viewports: [[390, 844]], schemes: ["light"], shots: "none", focus: false, wait: 50 });
  const byPage = (u) => new Set(r.failures.filter((f) => f.url === u).map((f) => f.kind));
  assert.deepEqual([...byPage("/")], [], JSON.stringify(r.failures.filter((f) => f.url === "/")));
  for (const kind of ["contrast", "overflow", "image", "console", "literal", "link", "ui", "clipped"]) assert.ok(byPage("/bad/").has(kind), `${kind} is caught: ${[...byPage("/bad/")]}`);
});

const page = (title, body, css = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;font:16px/1.5 sans-serif;background:#fff;color:#111}a,button,input{font:inherit}${css}</style></head><body><main>${body}</main></body></html>`;
async function gate(name, files, opts = {}) {
  const playwright = await loadPlaywright();
  const root = put(join(TMP, name), files);
  return visualQa({ outDir: root, playwright, chromium: CHROMIUM, viewports: [[390, 844]], schemes: ["light"], shots: "none", wait: 50, perTemplate: 0, ...opts });
}
const kinds = (r, url, scheme) => new Set(r.failures.filter((f) => f.url === url && (!scheme || f.scheme === scheme)).map((f) => f.kind));

test("T0 CSS ownership partitions every generated stylesheet exactly once, preserving Worker and SiteKit verification", { timeout: BROWSER_TEST_MS }, () => {
  const input = ["styles.css", "content.css", "fa/styles.fa.css", "kit/kit.css", "kit/date-picker.css"]
    .map((file) => ({ file, text: "/* sample */" }));
  const { site, workerRuntime } = splitThemeByOwner(input);
  assert.deepEqual(site.map((x) => x.file), ["styles.css", "content.css", "fa/styles.fa.css"]);
  assert.deepEqual(workerRuntime.map((x) => x.file), ["kit/kit.css", "kit/date-picker.css"]);
  assert.equal(new Set([...site, ...workerRuntime]).size, input.length, "no CSS was dropped or measured twice");
});

test("T0 browser contrast never mixes two deployed CSS roots with conflicting --c-* roles", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await gate("owner-root-cascade", {
    "index.html": '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Owner scope</title><link rel="stylesheet" href="/styles.css"></head><body><main>Real page loads only SiteKit</main></body></html>',
    "styles.css": ":root{--c-accent:#FF5A00;--c-on-accent:#0B0B0B}.unmounted-site-chip{background:var(--c-accent);color:var(--c-on-accent);font:700 16px Arial;padding:8px}",
    // This CSS is served only by the Worker. Its global token is valid there,
    // but injecting it into the SiteKit synthetic document paints black text
    // on a blue background the actual site never uses.
    "kit/kit.css": ":root{--c-accent:#2F5BEA}",
  }, { pagesPass: false, shots: "none", theme: true });
  assert.equal(r.failures.filter((f) => f.kind === "theme").length, 0,
    "both CSS sets are still tested, but a Worker-only palette cannot override SiteKit: " + JSON.stringify(r.failures));
});


test("T0: browser QA eagerly inspects even deferred images beyond its bounded scan rather than timing out", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await gate("offscreen-lazy-evidence", {
    "index.html": page("Offscreen deferred asset", '<p>Visible text</p><div style="height:100000px"></div><img loading="lazy" src="/asset.png" width="12" height="12" alt="Loaded asset">'),
    "asset.png": png(12, 12, [11, 11, 11]),
  }, { theme: false, focus: false, wait: 0 });
  assert.ok(!r.failures.some((x) => x.kind === "console" && /could not open the page|Timeout 30000ms/.test(x.message)),
    "real deferred asset loaded before the bounded completeness gate: " + JSON.stringify(r.failures));
  assert.ok(!r.failures.some((x) => x.kind === "image" && x.url === "/"),
    "a valid deep lazy asset is not mistaken for a missing resource");
});

test("a later low-contrast element is not merged with an earlier look-alike: same path, same colour, different background", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await gate("lookalike", { "index.html": page("Rows", '<div class="row" style="background:#fff"><p class="t">Readable on white</p></div><div class="row" style="background:#222"><p class="t">Same path and colour on near black</p></div>', ".t{margin:0;padding:12px;color:#666}") });
  assert.ok(kinds(r, "/").has("contrast"), JSON.stringify(r.failures));
  assert.equal(r.failures.filter((f) => f.kind === "contrast").length, 1, "only the dark row fails");
});

test("dark is decided per page: a later template with a dark theme is inspected even when the first has none", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await gate("perpage", {
    "index.html": page("Light only", "<p>Plain page, no dark theme.</p>"),
    "b/index.html": page("Has dark", '<p class="x">Low contrast in dark</p>', "@media (prefers-color-scheme: dark){body{background:#111}.x{color:#222}}"),
  }, { schemes: ["light", "dark"] });
  assert.ok(kinds(r, "/b/", "dark").has("contrast"), JSON.stringify(r.failures));
  assert.ok(!kinds(r, "/b/", "light").has("contrast"));
  assert.ok(r.notes.some((n) => /have no dark theme and were not inspected in dark/.test(n)), r.notes.join("|"));
});

test("a dark theme driven by an attribute or a class is switched on: [data-theme=dark] and html.dark", { timeout: BROWSER_TEST_MS }, async () => {
  const r = await gate("hooks", {
    "index.html": page("Attribute", '<p class="x">Low contrast in the attribute theme</p>', '[data-theme="dark"] body{background:#111}[data-theme="dark"] .x{color:#222}'),
    "c/index.html": page("Class", '<p class="x">Low contrast in the class theme</p>', "html.dark body{background:#111}html.dark .x{color:#222}"),
  }, { schemes: ["light", "dark"] });
  assert.ok(kinds(r, "/", "dark").has("contrast"), `attribute: ${JSON.stringify(r.failures)}`);
  assert.ok(kinds(r, "/c/", "dark").has("contrast"), `class: ${JSON.stringify(r.failures)}`);
  assert.ok(!kinds(r, "/", "light").has("contrast") && !kinds(r, "/c/", "light").has("contrast"));
});

test("overlapping text far below the first screens is found; a footer's running-text link is checked; a div's font is loaded; every focusable is read", { timeout: BROWSER_TEST_MS }, async () => {
  const filler = '<p style="margin:0;height:900px">space</p>'.repeat(8);
  const controls = Array.from({ length: 24 }, (_, i) => `<a href="#c${i}" class="c">control ${i}</a>`).join(" ");
  const r = await gate("gaps", {
    "index.html": page("Gaps", `${filler}<div style="position:relative;height:60px"><span style="position:absolute;left:0;top:0">Overlap one</span><span style="position:absolute;left:4px;top:2px">Overlap two</span></div>
      <footer><p>Read <a href="/x" style="color:inherit;text-decoration:none">the footer terms</a> carefully.</p></footer>
      <div style="font-family:'Missing Face'">A div in a family nobody declared</div><nav>${controls}</nav>`, ".c{outline:none;margin-right:6px}.c:nth-of-type(22):focus-visible{outline:2px solid #ddd}"),
  });
  const got = kinds(r, "/");
  assert.ok(got.has("clipped"), `overlap below the fold: ${JSON.stringify(r.failures)}`);
  assert.ok(got.has("link"), "the footer's link in running text");
  assert.ok(got.has("font"), "a div's font family");
  assert.ok(r.failures.some((f) => f.kind === "ui" && /focus ring/.test(f.message)), "a ring on the 22nd control is read");
});

test("text that is not on screen does not overlap: a closed <details>, a scroller's hidden rows and an ellipsised label are not findings", { timeout: BROWSER_TEST_MS }, async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<li>Row number ${i}</li>`).join("");
  const r = await gate("notshown", {
    "index.html": page("Not shown", `<details><summary>Question one</summary><p>Answer one that is hidden while closed</p></details><details><summary>Question two</summary><p>Answer two</p></details>
      <ul style="height:90px;overflow:auto;margin:0;padding:0;list-style:none">${rows}</ul><p style="margin:0">Text right after the scroller</p>
      <button style="display:flex;width:120px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:60px">a very long identifier that is cut</span><b>GET</b></button>`),
  });
  assert.ok(!r.failures.some((f) => f.kind === "clipped"), JSON.stringify(r.failures.filter((f) => f.kind === "clipped")));
});

test("M5: no exemption in the page pass: a disabled control and a transparent-fill text with low contrast are failures (an allow entry is the only way out)", { timeout: BROWSER_TEST_MS }, async () => {
  const body = '<button class="d" disabled>Disabled low contrast</button><p class="t">Transparent fill, ink colour on a dark panel</p>';
  const css = ".d{background:#fff;color:#ccc;border:0}.t{background:#111;color:#222;-webkit-text-fill-color:transparent;padding:8px}";
  const r = await gate("noexempt", { "index.html": page("Exempt", body, css) }, { theme: false });
  const failing = r.failures.filter((f) => f.kind === "contrast").map((f) => f.path);
  assert.ok(failing.some((p) => /button/.test(p)), `a disabled control is a pair: ${JSON.stringify(r.failures)}`);
  assert.ok(failing.some((p) => /\bp\b/.test(p) || /\.t/.test(p)), `a transparent-fill text is measured: ${JSON.stringify(r.failures)}`);
});

test("the page pass honours a declared exception (canon.allow.json, category contrast, state base), and --theme-only measures the stylesheets without opening a page", { timeout: BROWSER_TEST_MS }, async () => {
  const body = '<button class="d" disabled>Disabled low contrast</button>';
  const css = ".d{background:#fff;color:#ccc;border:0}";
  const files = { "index.html": page("Exempt", body, css) };
  const failing = await gate("excused-a", files, { theme: false });
  assert.ok(failing.failures.some((f) => f.kind === "contrast"), "without an entry it fails");
  const entry = { category: "contrast", file: "index.html", match: ".d", context: "base", reason: "A reviewed exception used to test that the page pass honours canon.allow.json entries." };
  const ok = await gate("excused-b", files, { theme: false, allow: [entry] });
  assert.ok(!ok.failures.some((f) => f.kind === "contrast"), JSON.stringify(ok.failures));
  const only = await gate("themeonly", { "s.css": ".x{color:#ccc;background:#fff}", "index.html": page("T", "<p class='x'>Low</p>").replace("<style>", '<link rel="stylesheet" href="/s.css"><style>') }, { pagesPass: false });
  assert.equal(only.views, 0, "no page view was opened");
  assert.ok(only.failures.some((f) => f.kind === "theme"), JSON.stringify(only.failures));
});
