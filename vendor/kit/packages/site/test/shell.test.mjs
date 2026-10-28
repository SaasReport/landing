// The site shell (src/shell.js, src/shell-markup.js): every page of a built site carries the menu drawer and the global
// search, the static index finds pages by title, heading and body, checkShell catches a page without them, project.menu
// is schema-checked, and the Worker's pages carry the same shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { buildSite, checkProject, checkShell, headerSignature, navReach, searchIndex, searchOptions, shellMarkup, SEARCH_INDEX } from "../src/index.js";
import sample from "../../../examples/site-sample/site.config.js";
import { tempDir, fileTempDir } from "../../core/test/support/temp.mjs";

const MENU = [{ label: "Platform", href: "/platform/", groups: [{ label: "Overview", items: [{ label: "Terminal", href: "/terminal/" }, { label: "Lab", href: "/lab/" }] }] }];
const project = { ...sample, menu: MENU };
const out = fileTempDir("kit-shell-");
const { files } = buildSite(project, { root: new URL("../../../examples/site-sample/", import.meta.url).pathname, outDir: out, write: true });

test("every built page carries the menu button, the drawer with the project's menu, the search and the shell script", () => {
  const { pages, problems } = checkShell(out);
  assert.deepEqual(problems, []);
  assert.ok(pages >= 5);
  for (const f of Object.keys(files).filter((x) => x.endsWith(".html"))) {
    assert.match(files[f], /data-kit-menu/, f);
    assert.match(files[f], /<a href="\/terminal\/">Terminal<\/a>/, `${f}: the menu`);
    assert.match(files[f], /data-kit-sections[^-]/, `${f}: the docked sections control`);
    assert.match(files[f], /<script data-cfasync="false" src="\/shell(\.\w+)?\.js\?v=[a-z0-9]+" defer><\/script>/, f);
  }
  assert.match(files["styles.css"], /\.kshell__drawer\{position:fixed/);
  assert.doesNotMatch(files["styles.css"], /\.totop\{|\.pagex\{/, "no floating back-to-top or sections button");
  new vm.Script(files["shell.js"], { filename: "shell.js" });
});

test("the search index lists every indexable page and finds body words", () => {
  const idx = JSON.parse(readFileSync(join(out, SEARCH_INDEX), "utf8"));
  assert.equal(idx.v, 2, "kit site build writes the version 2 index for every site");
  const urls = idx.pages.map((p) => p[0]);
  assert.ok(urls.includes("/") && urls.includes("/terminal/"), urls.join(" "));
  const some = Object.entries(idx.terms).find(([, a]) => a.length >= 1);
  assert.ok(some, "body terms are indexed");
  assert.deepEqual(idx, searchIndex(out, searchOptions(project, { localePaths: ["/", "/ar/"], homeLabel: "Home" })), "deterministic");
});

test("every page shows the landing's header: the same logo, call to action and shell buttons; no brand-name link in the bar", () => {
  const land = headerSignature(files["index.html"]);
  assert.deepEqual(land.shell.sort(), ["menu", "search", "sections"]);
  assert.ok(land.cta.length, "the landing's call to action");
  for (const f of ["terminal/index.html", "lab/index.html", "sectors/retail/index.html", "directory/index.html"]) {
    assert.deepEqual(headerSignature(files[f]).cta, land.cta, `${f}: the landing's call to action`);
    assert.equal(headerSignature(files[f]).logo, land.logo, f);
    assert.match(files[f], /<header class="nav is-stuck kpage__nav">/, f);
    // a modal call to action opens that modal on the home page
    assert.doesNotMatch(files[f].match(/<header[\s\S]*?<\/header>/)[0], /data-modal=/, `${f}: no modal opener without the modal`);
  }
  // the drawer carries the call to action for phones, where the bar hides it
  assert.match(files["lab/index.html"], /<div class="kshell__cta"><a class="btn btn--/);
});

test("checkShell names a hand-built bar (the shell outside the header) and a header unlike the site's", (t) => {
  const dir = tempDir(t, "kit-shell-hand-");
  writeFileSync(join(dir, SEARCH_INDEX), JSON.stringify({ v: 2, pages: [["/", "Home", "", ""]], terms: {}, sections: [["home", "Home"]], facets: [], synonyms: [], meta: [[0, 20, []]] }));
  const lab = files["lab/index.html"];
  for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.html`), lab);
  // a page whose bar is hand-built: logo and a brand-name link; the shell's buttons only further down
  writeFileSync(join(dir, "hand.html"), lab.replace(/<header[\s\S]*?<\/header>/, '<header class="tpage__bar"><a class="brand" href="/"><img class="brand__logo" src="/x.png" alt=""></a><nav><a href="/">Brand</a></nav></header><div hidden>data-kit-menu data-kit-search data-kit-sections </div>'));
  // a page whose header lost its call to action
  writeFileSync(join(dir, "nocta.html"), lab.replace(/(<div class="nav__cta">)[\s\S]*?(<span class="kshell__btns">)/, "$1$2"));
  const { problems } = checkShell(dir);
  assert.ok(problems.some((p) => p.startsWith("hand.html: the menu, search, sections buttons are not in the page's header")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("nocta.html") && p.includes("a different header: call to action []")), problems.join("\n"));
  assert.equal(problems.length, 2, problems.join("\n"));
});

test("checkShell names a page without the shell and a missing index", () => {
  writeFileSync(join(out, "bare.html"), "<!doctype html><title>Bare</title><main>no shell</main>");
  rmSync(join(out, SEARCH_INDEX));
  const { problems } = checkShell(out);
  assert.ok(problems.some((p) => p.startsWith("bare.html: missing the menu button")), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes(SEARCH_INDEX)));
  assert.deepEqual(checkShell(out, { exempt: ["bare.html"] }).problems.filter((p) => p.startsWith("bare")), []);
});

test("navReach: the menu is click 1, page links are clicks 2 and 3; a page further away is an orphan", (t) => {
  const dir = tempDir(t, "kit-reach-");
  const page = (p, links) => { const f = join(dir, p, "index.html"); mkdirSync(join(dir, p), { recursive: true }); writeFileSync(f, `<main>${links.map((l) => `<a href="${l}">x</a>`).join("")}</main>`); };
  page("a", ["/b/"]); page("b", ["/c/"]); page("c", ["/d/"]); page("d", []);
  const r = navReach(dir, { menu: [{ label: "A", href: "/a/", groups: [] }], urls: ["/a/", "/b/", "/c/", "/d/"] });
  assert.deepEqual(r.orphans, ["/d/"]);
  assert.equal(r.depth.get("/c/"), 3);
});

test("project.menu is schema-checked", () => {
  assert.deepEqual(checkProject(project), []);
  const bad = checkProject({ ...sample, menu: [{ label: "x", groups: [{ items: [{ label: "y" }] }] }] });
  assert.ok(bad.some((p) => p.startsWith("menu")), bad.join("\n"));
});

test("shellMarkup: buttons for the bar, drawer + search dialog + sections panel, escaped", () => {
  const { buttons, panels } = shellMarkup({ menu: [{ label: "A & B", groups: [{ items: [{ label: "x", href: "/x/?a=1&b=2" }] }] }], t: (k) => k });
  assert.match(buttons, /data-kit-search/); assert.match(buttons, /data-kit-menu/); assert.match(buttons, /data-kit-sections[^-]/); assert.doesNotMatch(buttons.match(/<button[^>]*data-kit-sections[^>]*>/)[0], /hidden/, "Sections is docked and shown from the start");
  assert.match(panels, /href="\/x\/\?a=1&amp;b=2"/);
  assert.match(panels, /data-index="\/search-index\.json"/);
});

test("the Worker's pages carry the same shell", async () => {
  const { createKit } = await import("@saasreport/cloudflare").catch((e) => { if (e.code === "ERR_MODULE_NOT_FOUND") return {}; throw e; });
  if (!createKit) return;
  const shell = (await import("../../cloudflare/src/shell.js"));
  const src = readFileSync(new URL("../../cloudflare/src/shell.js", import.meta.url), "utf8");
  assert.match(src, /shellMarkup\(/); assert.match(src, /SHELL_CSS/); assert.ok(shell);
});

test("a project without a menu: the drawer carries the landing's footer columns, anchors pointing at the home page", () => {
  const { files: f2 } = buildSite({ ...sample, menu: undefined }, { root: new URL("../../../examples/site-sample/", import.meta.url).pathname, write: false });
  const cols = sample.content.en.footer.columns;
  const lab = f2["lab/index.html"].match(/<nav class="kshell__menu"[\s\S]*?<\/nav>/)[0];
  for (const c of cols) assert.match(lab, new RegExp(`<summary>${c.title}</summary>`), c.title);
  assert.doesNotMatch(lab, /href="#/, "landing anchors are absolute (/#…) in the drawer");
  assert.match(f2["ar/lab/index.html"].match(/<nav class="kshell__menu"[\s\S]*?<\/nav>/)[0], /<details class="kshell__sec">/, "the Arabic drawer too");
});

test("a fragment call to action (#pricing) points at the locale's home page on inner pages, like a modal one", () => {
  const p = structuredClone(sample);
  for (const c of ["en", "ar"]) p.content[c].nav.cta = [{ label: "Pricing", href: "#pricing" }, ...p.content[c].nav.cta];
  const { files: f } = buildSite(p, { root: new URL("../../../examples/site-sample/", import.meta.url).pathname, write: false });
  const head = (x) => f[x].match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(head("lab/index.html"), /<a class="btn [^"]*" href="\/#pricing">Pricing<\/a>/);
  assert.match(head("ar/lab/index.html"), /<a class="btn [^"]*" href="\/ar\/#pricing">Pricing<\/a>/);
  assert.match(head("index.html"), /href="#pricing">Pricing<\/a>/, "the landing keeps its own anchor");
});
