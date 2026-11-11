// Markdown twins: the HTML → Markdown converter, the page twin with front matter, and buildSite writing index.md next to
// every indexable page, linking it, listing it in md-twins.json, honouring the opt-outs and (static-only) llms.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSite, htmlToMarkdown, pageMarkdown, linkTwin, llmsIndex, llmsFullText, writeTwins, TWINS_SCHEMA } from "../src/index.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;
const clone = (x) => structuredClone(x);

test("htmlToMarkdown: headings, paragraphs, lists, links, emphasis, code, quotes and tables", () => {
  const md = htmlToMarkdown(`<h2>Title &amp; more</h2><p>A <strong>bold</strong> and <em>soft</em> word with <code>x_y</code>.</p>
    <ul><li>One</li><li>Two <a href="/b/">link</a></li></ul><ol start="3"><li>Three</li><li>Four</li></ol>
    <blockquote><p>Quoted</p></blockquote><pre>line 1\nline 2</pre>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2 | 3</td></tr></table><hr><p><a href="#top">anchor only</a> <a href="javascript:void(0)">js</a></p>`, { base: "https://example.org/x/" });
  assert.match(md, /^## Title & more$/m);
  assert.match(md, /^A \*\*bold\*\* and _soft_ word with `x_y`\.$/m);
  assert.match(md, /^- One\n- Two \[link\]\(https:\/\/example\.org\/b\/\)$/m);
  assert.match(md, /^3\. Three\n4\. Four$/m);
  assert.match(md, /^> Quoted$/m);
  assert.match(md, /^```\nline 1\nline 2\n```$/m);
  assert.match(md, /^\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \\\| 3 \|$/m);
  assert.match(md, /^---$/m);
  assert.match(md, /^anchor only js$/m, "in-page and javascript: links keep only their text");
});

test("htmlToMarkdown: scripts, styles, svg, hidden and data-md=skip are left out; adjacent labels stay apart", () => {
  const md = htmlToMarkdown(`<p>keep</p><script>alert(1)</script><style>p{}</style><svg><text>svg</text></svg>
    <div hidden>hidden</div><div aria-hidden="true">aria</div><div data-md="skip">skipped</div><select><option>opt</option></select>
    <p><small>Project</small><strong>Example</strong></p><p><span>1</span>Tokens<b>Ready</b></p><p>See <a href="/p">this</a>.</p>`);
  for (const gone of ["alert", "p{}", "svg", "hidden", "aria", "skipped", "opt"]) assert.ok(!md.includes(gone), gone);
  assert.match(md, /^Project \*\*Example\*\*$/m);
  assert.match(md, /^1 Tokens \*\*Ready\*\*$/m);
  assert.match(md, /^See \[this\]\(\/p\)\.$/m, "no space before punctuation");
});

test("htmlToMarkdown: a card link wrapping a heading and a paragraph becomes one link line", () => {
  const md = htmlToMarkdown(`<div><a class="card" href="/sectors/retail/"><h3>Retail</h3><p>Payments in store.</p></a></div>`, { base: "https://example.org" });
  assert.equal(md, "[Retail Payments in store.](https://example.org/sectors/retail/)");
});

test("pageMarkdown: front matter, the page's <main> only, no duplicate h1, RTL text as is", () => {
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><title>تقویم | سایت</title><meta name="description" content="توضیح صفحه"></head>
    <body><header><nav><a href="/">خانه</a></nav></header><main><h1>تقویم مالی</h1><p>روزهای کاری ۱۴۰۵</p></main><footer>© سایت</footer></body></html>`;
  const t = pageMarkdown(html, { url: "https://example.org/calendar/", site: "سایت" });
  assert.equal(t.title, "تقویم | سایت");
  assert.equal(t.lang, "fa");
  assert.match(t.markdown, /^---\ntitle: "تقویم \| سایت"\ndescription: "توضیح صفحه"\nurl: https:\/\/example\.org\/calendar\/\nlang: fa\nsource: "سایت"\n---\n/);
  assert.match(t.markdown, /^# تقویم مالی$/m);
  assert.equal((t.markdown.match(/^# /gm) || []).length, 1);
  assert.match(t.markdown, /^> توضیح صفحه$/m);
  assert.ok(!t.markdown.includes("خانه") && !t.markdown.includes("©"), "header, nav and footer are not content");
  const noH1 = pageMarkdown(`<html><head><title>Plain | Site</title></head><body><p>x</p></body></html>`);
  assert.match(noH1.markdown, /^# Plain$/m, "the page title (without the site suffix) when the page has no h1");
});

test("linkTwin adds one <link rel=alternate type=text/markdown> to the head", () => {
  const h = linkTwin("<html><head><title>x</title></head><body></body></html>", "/a/index.md");
  assert.match(h, /<link rel="alternate" type="text\/markdown" title="Markdown" href="\/a\/index\.md">\n<\/head>/);
  assert.equal(linkTwin(h, "/a/index.md"), h, "idempotent");
  const withLlms = linkTwin('<html><head><link rel="alternate" type="text/markdown" title="llms.txt" href="/llms.txt"></head></html>', "/index.md");
  assert.match(withLlms, /href="\/index\.md"/, "a page that already links llms.txt still gets its twin link");
});

test("buildSite: a twin next to every indexable page, linked from it, listed in md-twins.json", () => {
  const { files, twins, sitemap } = buildSite(clone(sample), { root: SAMPLE });
  assert.equal(twins.length, sitemap.length, "one twin per sitemap page");
  for (const t of twins) {
    const rel = t.md.replace("https://example.org/", "");
    assert.ok(files[rel], rel);
    assert.equal(files[rel], t.markdown);
    const html = files[rel.replace(/\.md$/, ".html")];
    assert.ok(html.includes(`<link rel="alternate" type="text/markdown" title="Markdown" href="/${rel}">`), `${rel} is linked`);
  }
  assert.ok(files["index.md"].startsWith("---\ntitle: "));
  assert.match(files["ar/index.md"], /^lang: ar$/m);
  const manifest = JSON.parse(files["md-twins.json"]);
  assert.equal(manifest.schema, TWINS_SCHEMA);
  assert.equal(manifest.pages.length, twins.length);
  assert.deepEqual(Object.keys(manifest.pages[0]).sort(), ["bytes", "description", "locale", "md", "path", "title", "url"]);
  assert.ok(!files["llms.txt"], "the Worker serves llms.txt unless markdown.llms is set");
});

test("buildSite: markdown: false, page.markdown: false and markdown.exclude opt out", () => {
  const off = buildSite({ ...clone(sample), markdown: false }, { root: SAMPLE });
  assert.equal(off.twins.length, 0);
  assert.ok(!Object.keys(off.files).some((f) => f.endsWith(".md")) && !off.files["md-twins.json"]);
  assert.ok(!off.files["index.html"].includes("text/markdown"));
  const p = clone(sample);
  p.pages.find((x) => x.path === "/lab/").markdown = false;
  p.markdown = { exclude: ["/sectors/"] };
  const some = buildSite(p, { root: SAMPLE });
  assert.ok(!some.files["lab/index.md"] && !some.files["ar/lab/index.md"], "page.markdown: false, every locale");
  assert.ok(!Object.keys(some.files).some((f) => /sectors\/.*\.md$/.test(f)), "exclude covers sub-pages");
  assert.ok(some.files["terminal/index.md"]);
});

test("buildSite: markdown.llms writes llms.txt and llms-full.txt for a static-only site", () => {
  const { files, twins } = buildSite({ ...clone(sample), markdown: { llms: { about: "A sample site." } } }, { root: SAMPLE });
  assert.match(files["llms.txt"], /^# Example Open Finance\n\n> A sample site\.\n/);
  assert.match(files["llms.txt"], /^## Pages \(en\)$/m);
  assert.match(files["llms.txt"], /^## Pages \(ar\)$/m);
  assert.ok(files["llms.txt"].includes("](https://example.org/terminal/index.md)"));
  assert.match(files["llms.txt"], /\[Full text\]\(https:\/\/example\.org\/llms-full\.txt\)/);
  for (const t of twins) assert.ok(files["llms-full.txt"].includes(t.markdown.trim()), t.md);
  assert.equal(llmsFullText({ name: "x" }, []), llmsIndex({ name: "x" }, []));
});

test("writeTwins: twins for every page in an output directory, noindex and excluded pages skipped, idempotent", (t) => {
  const dir = tempDir(t, "kit-twins-");
  const page = (rel, body, head = "") => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), `<!doctype html><html lang="fa"><head><title>${body} | S</title>${head}</head><body><main><h1>${body}</h1><p>متن ${body}</p></main></body></html>`); };
  page("index.html", "Home", '<link rel="alternate" type="text/markdown" title="llms.txt" href="/llms.txt">');
  page("calendar/index.html", "Calendar");
  page("app/index.html", "App", '<meta name="robots" content="noindex, nofollow">');
  page("lab/index.html", "Lab");
  page("404/index.html", "Missing");
  const twins = writeTwins(dir, { url: "https://example.org/", name: "S", exclude: ["/lab/"], llms: { about: "About S." } });
  assert.deepEqual(twins.map((t) => t.path), ["/", "/calendar/"]);
  assert.equal(twins[0].locale, "fa");
  assert.match(readFileSync(join(dir, "calendar/index.md"), "utf8"), /^# Calendar$/m);
  assert.match(readFileSync(join(dir, "index.html"), "utf8"), /href="\/index\.md"/);
  assert.ok(!existsSync(join(dir, "app/index.md")) && !existsSync(join(dir, "lab/index.md")) && !existsSync(join(dir, "404/index.md")));
  assert.equal(JSON.parse(readFileSync(join(dir, "md-twins.json"), "utf8")).pages.length, 2);
  assert.ok(readFileSync(join(dir, "llms.txt"), "utf8").includes("](https://example.org/calendar/index.md)"));
  const before = readFileSync(join(dir, "index.html"), "utf8");
  writeTwins(dir, { url: "https://example.org", name: "S" });
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), before, "idempotent");
});
