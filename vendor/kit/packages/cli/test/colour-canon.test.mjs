// kit check tokens, the colour canon (docs/COLOUR.md): every colour literal outside the token sources fails (hex, rgb()/hsl(),
// a named colour on a colour property, in CSS, HTML, SVG, scripts and JSON), the --c-<role> declaration is the one place a
// literal is written, a reviewed exception is an allow-list entry, a stale entry fails, an undeclared role fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { runCanon } from "../src/canon/index.js";
import { scanColour, cssDeclarations, roleProblems } from "../src/canon/colour.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const lits = (file, text) => scanColour(file, text).map((l) => `${l.kind}:${l.literal}`);

test("css: hex, functions and named colours fail; roles, vars, color-mix and keywords pass", () => {
  assert.deepEqual(lits("a.css", ".a{color:#fff;background:#FF5A00}"), ["hex:#fff", "hex:#FF5A00"]);
  assert.deepEqual(lits("a.css", ".a{background:rgba(0,0,0,.35);border:1px solid hsl(10 20% 30%)}"), ["function:rgba(0,0,0,.35)", "function:hsl(10 20% 30%)"]);
  assert.deepEqual(lits("a.css", ".a{color:white;border-color:red;box-shadow:0 1px 2px black}"), ["named:white", "named:red", "named:black"]);
  assert.deepEqual(lits("a.css", ":root{--c-accent:#FF5A00;--c-on-ink:#fff}.a{color:var(--c-accent);background:color-mix(in srgb,var(--c-accent) 8%,transparent);border-color:currentColor;fill:none;outline:2px solid transparent}"), []);
  assert.deepEqual(lits("a.css", ".a{--c:#fff}"), ["hex:#fff"], "only --c-<role> may hold a literal");
  assert.deepEqual(lits("a.css", "#add{color:var(--c-ink)}.red{width:1px}a:not(.white){color:var(--c-ink)}/* #fff */"), [], "ids, class names, selectors and comments are not colours");
  assert.deepEqual(lits("a.css", "@media (min-width:600px){.a{color:#abc}}@font-face{font-family:x;src:url(a.woff2)}"), ["hex:#abc"]);
  assert.deepEqual(lits("a.css", ".s{background-image:url(\"data:image/svg+xml,%3Csvg stroke='%23FF5A00'/%3E\")}"), ["hex:#FF5A00"], "a colour inside a data: URI counts");
  assert.deepEqual(lits("a.css", ".a{background:url(img.png);content:\"#fff\"}"), [], "paths and strings are not colours");
});

test("html and svg: style attributes, <style>, presentation attributes and inline scripts; theme-color is the browser's", () => {
  assert.deepEqual(lits("a.html", '<i style="--c:#7C3AED">x</i>'), ["hex:#7C3AED"]);
  assert.deepEqual(lits("a.html", '<i style="--c:var(--c-chart3);color:var(--c-ink)">x</i>'), []);
  assert.deepEqual(lits("a.svg", '<path fill="#fff" stroke="red"/><path fill="currentColor" stroke="var(--c-ink)" style="fill:var(--c-surface)"/>'), ["hex:#fff", "named:red"]);
  assert.deepEqual(lits("a.html", '<meta name="theme-color" content="#FF5A00">\n<style>.a{color:#000}</style>'), ["hex:#000"]);
  assert.deepEqual(lits("a.html", '<a href="#add">x</a>'), []);
});

test("scripts: colour strings, canvas styles and CSS text inside strings fail; anchors and role references pass", () => {
  assert.deepEqual(lits("a.js", 'const c = "#FF5A00"; el.style.setProperty("--c", "var(--c-ink)");'), ["hex:#FF5A00"]);
  assert.deepEqual(lits("a.js", "ctx.fillStyle = 'white'; ctx.strokeStyle = \"var(--c-ink)\";"), ["named:white"]);
  assert.deepEqual(lits("a.js", "const css = `.a{background:rgba(0,0,0,.4);color:var(--c-ink)}`;"), ["function:rgba(0,0,0,.4)"]);
  assert.deepEqual(lits("a.js", 'location.hash = "#add"; document.querySelector("#fab"); const s = "rgb(var(--x))";'), []);
  assert.deepEqual(lits("a.js", 'const u = "https://x.org/directory/#cbe"; const p = "/directory/#bdcb";'), [], "a URL's fragment is an anchor");
  assert.deepEqual(lits("a.html", '<script type="application/ld+json">{"@id":"https://x.org/#cbe"}</script><script>el.style.color = "#cbe"</script>'), ["hex:#cbe"], "JSON-LD is data, a script is code");
});

test("json data: a colour value fails, a role name passes", () => {
  assert.deepEqual(lits("a.json", '{ "color": "#1D4ED8", "role": "chart1", "tone": "warn" }'), ["hex:#1D4ED8"]);
});

test("cssDeclarations reads rules, groups and opaque strings and url()", () => {
  const d = cssDeclarations("@media (a){.a{color:red;background:url(\"x;y\")}}.b{--c-x:#fff}");
  assert.deepEqual(d.map((x) => x.prop), ["color", "background", "--c-x"]);
});

test("roleProblems: a var(--c-x) no stylesheet declares", () => {
  const files = [{ file: "a.css", text: ":root{--c-ink:#000}.a{color:var(--c-ink);background:var(--c-nope)}" }];
  assert.deepEqual(roleProblems(files).map((p) => p.name), ["--c-nope"]);
  assert.deepEqual(roleProblems([{ file: "b.css", text: ".a{color:var(--c-x)}" }]), [], "no role declarations in the scanned files: nothing to compare with");
});

const TMP = fileTempDir("kit-colour-");
const SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const ALLOW = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon-allow.schema.json";
function repo(name, files) {
  const root = join(TMP, name);
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`); }
  return root;
}
const canon = { $schema: SCHEMA, project: "kit", tokens: { module: "src/tokens.js", sources: ["src/tokens.js"], paths: ["src"], generated: ["site"] } };
const tokens = "export default { color: { accent: '#FF5A00', ink: '#0B0B0B' } };\n";

test("kit check tokens: source and generated output, allow-list, stale entries", async () => {
  const root = repo("canon", {
    "kit.canon.json": canon, "src/tokens.js": tokens,
    "src/a.css": ".a{color:var(--c-ink)}",
    "site/styles.css": ":root{--c-ink:#0B0B0B}.b{color:var(--c-ink);background:#123456}.c{color:var(--c-missing)}",
    "site/logo.svg": '<svg><path fill="#FF5A00"/></svg>',
    "canon.allow.json": { $schema: ALLOW, entries: [{ file: "site/logo.svg", category: "colour-literal", match: "#FF5A00", context: "fill=\"#FF5A00\"", reason: "Logo artwork, an image file that cannot read custom properties." }, { file: "site/gone.css", category: "colour-literal", match: "#fff", context: "color:#fff", reason: "Stale on purpose: matches nothing at all." }] },
  });
  const r = await runCanon(root, { only: ["tokens"] });
  const p = r.results.tokens.problems.map((x) => `${x.file} ${x.problem}`);
  assert.ok(p.some((x) => x.startsWith("site/styles.css:1 colour literal #123456")), p.join("\n"));
  assert.ok(p.some((x) => /^site\/styles\.css:1 --c-missing is used but no stylesheet declares it/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /stale colour-literal allow-list entry.*site\/gone\.css/.test(x)), p.join("\n"));
  assert.ok(!p.some((x) => x.includes("logo.svg")), "the reviewed exception is honoured");
  assert.ok(!p.some((x) => /colour literal #0B0B0B|is color\.ink/.test(x)), "the --c-ink declaration is the one place a literal is written");
  assert.equal(r.results.tokens.ok, false);
});

test("kit check tokens passes a repository that paints with roles only", async () => {
  const root = repo("clean", { "kit.canon.json": canon, "src/tokens.js": tokens, "site/styles.css": ":root{--c-ink:#0B0B0B;--c-accent:#FF5A00}.a{color:var(--c-ink);border-color:color-mix(in srgb,var(--c-accent) 30%,transparent)}", "site/index.html": '<i style="--c:var(--c-accent)"></i><meta name="theme-color" content="#FF5A00">' });
  const r = await runCanon(root, { only: ["tokens"] });
  assert.equal(r.results.tokens.ok, true, JSON.stringify(r.results.tokens.problems));
});
